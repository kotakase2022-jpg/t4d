import 'server-only';

import {
  anchorDisplay,
  metricDisplay,
  renderBlockParagraphs,
} from '@/lib/exports/disclosure-report';
import { valueKindMarker } from '@/lib/domain/disclosure-block';
import type { ReportSnapshotDetail } from '@/lib/domain/report-snapshot-content';
import type { BlockInline } from '@/types/domain';
import { escapeXml } from './escape';
import type { FactBuildResult, XbrlContext, XbrlFact } from './facts';
import { XBRL_SEVERITY_LABELS } from './rules';
import {
  NOT_FILING_READY_NOTICE,
  SAMPLE_TAXONOMY_NOTICE,
  SIMPLE_CHECK_NOTICE,
} from './sample-taxonomy';
import type { TaxonomyPackage } from './taxonomy';
import type { XbrlValidationResult } from './validate';
import { MEASURE_NAMESPACES } from './unit-map';
import { entityLabel, type XbrlDocumentMeta } from './xbrl-json';

/**
 * インライン XBRL の HTML プレビュー（社内確認用。plan §3.4 ixbrl.ts）。
 *
 * - 節をテキストブロック（ix:nonNumeric escape="true"）、本文の数値参照を入れ子の ix:nonFraction にする
 * - 先頭に「提出用ではありません」の帯を必ず置く（SAMPLE・簡易検査の注記も）
 * - 利用者の文字列（本文・節名・指標名・資料名・識別子）は必ず escapeXml を通す。本文の `<script>` を
 *   要素にしない（Route Handler は CSP でもスクリプトを止める）
 * - 生成日時を入れない（同じ入力から同じ文書）
 * - XML として整形式に書く（空要素は自己終了）。表示はブラウザの HTML としても読める
 */

const NS = {
  xhtml: 'http://www.w3.org/1999/xhtml',
  ix: 'http://www.xbrl.org/2013/inlineXBRL',
  ixt: 'http://www.xbrl.org/inlineXBRL/transformation/2020-02-12',
  xbrldi: 'http://xbrl.org/2006/xbrldi',
  link: 'http://www.xbrl.org/2003/linkbase',
  xlink: 'http://www.w3.org/1999/xlink',
} as const;

const STYLE = `
body{font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif;margin:0;color:#172033;background:#fff;font-size:14px;line-height:1.7}
main{max-width:880px;margin:0 auto;padding:16px}
.t4d-banner{position:sticky;top:0;background:#fff4d6;border-bottom:2px solid #8a5d00;color:#3d2900;padding:10px 16px;font-weight:600}
.t4d-banner p{margin:2px 0}
.t4d-meta{font-size:12px;color:#4a5568;border:1px solid #d5dbe3;padding:8px 12px;margin:12px 0}
.t4d-meta dt{font-weight:600;float:left;clear:left;width:11em}
.t4d-meta dd{margin:0 0 0 11em}
section.block{border-top:1px solid #d5dbe3;margin-top:16px;padding-top:8px}
section.block h2{font-size:16px;margin:4px 0}
ix\\:nonFraction,.t4d-tagged{background:#e7f0fb;border-bottom:1px dotted #0b57a4}
table{border-collapse:collapse;font-size:12px;width:100%}
th,td{border:1px solid #d5dbe3;padding:4px 6px;text-align:left;vertical-align:top}
.t4d-error{color:#a3121b}
`;

function attr(name: string, value: string | number): string {
  return ` ${name}="${escapeXml(String(value))}"`;
}

function contextXml(context: XbrlContext): string {
  const members = Object.keys(context.dimensions)
    .sort()
    .map(
      (axis) =>
        `<xbrldi:explicitMember${attr('dimension', axis)}>${escapeXml(context.dimensions[axis]!)}</xbrldi:explicitMember>`,
    )
    .join('');
  const segment = members ? `<xbrli:segment>${members}</xbrli:segment>` : '';
  const period =
    context.period.type === 'instant'
      ? `<xbrli:instant>${context.period.instant}</xbrli:instant>`
      : `<xbrli:startDate>${context.period.start}</xbrli:startDate><xbrli:endDate>${context.period.end}</xbrli:endDate>`;
  return `<xbrli:context${attr('id', context.id)}><xbrli:entity><xbrli:identifier${attr('scheme', context.entity.schemeUri)}>${escapeXml(context.entity.value)}</xbrli:identifier>${segment}</xbrli:entity><xbrli:period>${period}</xbrli:period></xbrli:context>`;
}

function nonFraction(fact: XbrlFact): string {
  const raw = fact.source.kind === 'metric' ? fact.source.rawValue : fact.value;
  const negative = raw.startsWith('-');
  const shown = (fact.displayNumber ?? raw).replace(/^-/, '');
  const decimals = fact.decimals === null ? '' : attr('decimals', fact.decimals);
  return `${negative ? '-' : ''}<ix:nonFraction${attr('name', fact.qname)}${attr('contextRef', fact.contextId)}${attr('unitRef', fact.unit?.id ?? '')}${decimals}${attr('scale', fact.exponent)}${attr('format', 'ixt:num-dot-decimal')}${negative ? attr('sign', '-') : ''}${attr('id', fact.id)}>${escapeXml(shown)}</ix:nonFraction>`;
}

/** 段落の中身（数値参照は事実があれば ix:nonFraction で囲む。出典印は社内確認用の表示） */
function inlineHtml(
  inline: BlockInline,
  snapshot: ReportSnapshotDetail,
  factByVersion: ReadonlyMap<string, XbrlFact>,
): string {
  switch (inline.t) {
    case 'text':
      return escapeXml(inline.text);
    case 'narrative':
      return escapeXml(inline.quote);
    case 'cite': {
      const anchor = snapshot.anchors.find((a) => a.sourceAnchorId === inline.sourceAnchorId);
      return escapeXml(
        anchor ? `［出典: ${anchorDisplay(anchor, 'internal')}］` : '［出典: 不明］',
      );
    }
    case 'metric': {
      const mv = snapshot.metricValues.find(
        (m) => m.dataPointVersionId === inline.dataPointVersionId,
      );
      const fact = factByVersion.get(inline.dataPointVersionId);
      if (mv && fact && fact.source.kind === 'metric') {
        return `${nonFraction(fact)}${escapeXml(` ${mv.unitOfMeasure}${valueKindMarker(mv.valueKind)}`)}`;
      }
      return escapeXml(mv ? metricDisplay(mv) : inline.display);
    }
  }
}

function blockHtml(
  result: FactBuildResult,
  snapshot: ReportSnapshotDetail,
  factByVersion: ReadonlyMap<string, XbrlFact>,
): string {
  return result.blocks
    .map((block) => {
      // 出力（DOCX）と同じ段落だけを描く（節名と同じ見出し・空の段落は除く）
      const kept = new Set(
        renderBlockParagraphs(block, snapshot, 'internal').map((p) => p.paragraphId),
      );
      const paragraphs = block.body.paragraphs
        .filter((p) => kept.has(p.id))
        .map((p) => {
          let previousCite: string | null = null;
          const parts: string[] = [];
          for (const inline of p.children) {
            const html = inlineHtml(inline, snapshot, factByVersion);
            if (inline.t === 'cite') {
              if (html === previousCite) continue;
              previousCite = html;
            } else {
              previousCite = null;
            }
            parts.push(html);
          }
          const tag = p.kind === 'heading' ? 'h4' : 'p';
          return `<${tag}>${parts.join('')}</${tag}>`;
        })
        .join('');
      const textBlock = result.facts.find(
        (f) => f.source.kind === 'block' && f.source.blockId === block.blockId,
      );
      const body = textBlock
        ? `<ix:nonNumeric${attr('name', textBlock.qname)}${attr('contextRef', textBlock.contextId)}${attr('escape', 'true')}${attr('id', textBlock.id)}>${paragraphs || '<p />'}</ix:nonNumeric>`
        : paragraphs;
      const tagNote = textBlock
        ? `<p class="t4d-meta">テキストブロック: ${escapeXml(textBlock.concept.labelJa)}（${escapeXml(textBlock.qname)}）</p>`
        : '<p class="t4d-meta">この節はテキストブロックに対応付けていません。</p>';
      return `<section class="block"><h2>${escapeXml(block.title)}</h2>${tagNote}${body}</section>`;
    })
    .join('');
}

function factTable(result: FactBuildResult): string {
  const rows = result.facts
    .map((f) => {
      const value = f.numeric
        ? `${escapeXml(f.displayNumber ?? f.value)}${f.source.kind === 'metric' ? escapeXml(` ${f.source.unitOfMeasure}`) : ''}`
        : `テキストブロック（${f.source.kind === 'block' ? f.source.paragraphCount : 0} 段落）`;
      const source =
        f.source.kind === 'metric'
          ? `数値の版 ${f.source.versionNo}: ${f.source.metricName}（${f.source.unitName}・${f.source.boundary}・${f.source.periodCode}）`
          : `節の版 ${f.source.versionNo ?? '—'}: ${f.source.title}`;
      return `<tr><td>${escapeXml(f.concept.labelJa)}<br />${escapeXml(f.qname)}</td><td>${value}</td><td>${escapeXml(f.contextId)}</td><td>${escapeXml(f.unit?.measure ?? '—')}${f.decimals === null ? '' : escapeXml(` / decimals ${f.decimals}`)}</td><td>${escapeXml(source)}</td><td>${escapeXml(f.requirements.map((r) => r.code).join('・') || '—')}</td><td>${f.traceable ? '遡れる' : '遡れない'}</td></tr>`;
    })
    .join('');
  return `<section class="block"><h2>事実の一覧（${result.facts.length} 件）</h2><table><thead><tr><th>概念</th><th>値</th><th>コンテキスト</th><th>単位・decimals</th><th>出所</th><th>要求事項</th><th>追跡</th></tr></thead><tbody>${rows || '<tr><td colspan="7">事実はありません（確定した対応付けがありません）。</td></tr>'}</tbody></table></section>`;
}

function validationHtml(validation: XbrlValidationResult): string {
  const items = validation.findings
    .map(
      (f) =>
        `<li${f.severity === 'error' ? ' class="t4d-error"' : ''}>${escapeXml(`[${f.rule}・${XBRL_SEVERITY_LABELS[f.severity]}] ${f.message}`)}</li>`,
    )
    .join('');
  return `<section class="block"><h2>簡易検査の結果（エラー ${validation.counts.error}・警告 ${validation.counts.warning}・注記 ${validation.counts.note}）</h2><p>${escapeXml(SIMPLE_CHECK_NOTICE)}</p><ul>${items}</ul></section>`;
}

export interface IxbrlPreviewInput {
  result: FactBuildResult;
  pkg: TaxonomyPackage;
  snapshot: ReportSnapshotDetail;
  meta: XbrlDocumentMeta;
  validation: XbrlValidationResult;
}

export function buildIxbrlPreview({
  result,
  pkg,
  snapshot,
  meta,
  validation,
}: IxbrlPreviewInput): string {
  const factByVersion = new Map<string, XbrlFact>();
  for (const fact of result.facts) {
    if (fact.source.kind === 'metric' && !factByVersion.has(fact.source.dataPointVersionId)) {
      factByVersion.set(fact.source.dataPointVersionId, fact);
    }
  }
  const measureNs = Object.entries(MEASURE_NAMESPACES)
    .map(([prefix, uri]) => attr(`xmlns:${prefix}`, uri))
    .join('');
  const projectName = result.framework.projectName;
  const units = result.units
    .map(
      (u) =>
        `<xbrli:unit${attr('id', u.id)}><xbrli:measure>${escapeXml(u.measure)}</xbrli:measure></xbrli:unit>`,
    )
    .join('');
  const header = `<div style="display:none"><ix:header><ix:references><link:schemaRef${attr('xlink:type', 'simple')}${attr('xlink:href', pkg.entryPoint || pkg.namespaceUri)} /></ix:references><ix:resources>${result.contexts.map(contextXml).join('')}${units}</ix:resources></ix:header></div>`;
  const banner = `<div class="t4d-banner" role="note" data-t4d-not-filing-ready="true"><p>${escapeXml(NOT_FILING_READY_NOTICE)}</p>${pkg.isSample ? `<p>${escapeXml(SAMPLE_TAXONOMY_NOTICE)}</p>` : ''}<p>${escapeXml(SIMPLE_CHECK_NOTICE)}</p></div>`;
  const metaHtml = `<dl class="t4d-meta"><dt>プロジェクト</dt><dd>${escapeXml(projectName)}</dd><dt>基準</dt><dd>${escapeXml(result.framework.label)}</dd><dt>スナップショット</dt><dd>${escapeXml(`${meta.snapshotLabel} No.${meta.snapshotNo}`)}</dd><dt>タクソノミ</dt><dd>${escapeXml(`${pkg.name}（${pkg.versionLabel}）`)}</dd><dt>提出者</dt><dd>${escapeXml(entityLabel(result.entity))}</dd><dt>内容ハッシュ</dt><dd>${escapeXml(meta.contentHash)}</dd></dl>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<html${attr('xmlns', NS.xhtml)}${attr('xmlns:ix', NS.ix)}${attr('xmlns:ixt', NS.ixt)}${attr('xmlns:xbrldi', NS.xbrldi)}${attr('xmlns:link', NS.link)}${attr('xmlns:xlink', NS.xlink)}${measureNs}${attr(`xmlns:${pkg.prefix}`, pkg.namespaceUri)}${attr('xml:lang', 'ja')}${attr('lang', 'ja')}>`,
    `<head><meta${attr('http-equiv', 'Content-Type')}${attr('content', 'text/html; charset=UTF-8')} /><meta${attr('name', 'robots')}${attr('content', 'noindex')} /><title>${escapeXml(`${projectName} XBRL プレビュー（社内確認用・提出用ではありません）`)}</title><style>${STYLE}</style></head>`,
    `<body>${banner}<main>${header}${metaHtml}${blockHtml(result, snapshot, factByVersion)}${factTable(result)}${validationHtml(validation)}</main></body>`,
    '</html>',
    '',
  ].join('\n');
}
