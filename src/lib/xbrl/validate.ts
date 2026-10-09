import 'server-only';

import type { AggregationMethod, XbrlTagMapping } from '@/types/domain';
import type { FactBuildInput, FactBuildResult, XbrlFact } from './facts';
import { mappingsInScope } from './facts';
import {
  XBRL_RULES,
  XBRL_RULE_IDS,
  XBRL_VALIDATOR_VERSION,
  finding,
  sortFindings,
  type XbrlFinding,
  type XbrlRuleId,
  type XbrlSeverity,
} from './rules';
import { axesOf, findConcept, findConceptById, isNumericConcept } from './taxonomy';
import { leadingNumber, measureClass, representableAt, shiftDecimal } from './unit-map';

/**
 * XBRL の簡易検査 V01〜V16（plan §3.5）。T4D の構造の確認で、公式の検証ではない。
 *
 * 入力は事実の組み立て（facts.ts）と同じもの＋指標マスターの集計方法（V04 の時点の判定だけに使う）。
 * 組み立ての途中で分かった指摘（事実を出せなかった理由）もここでまとめる。
 * 結果の重大度が「エラー」なら出力を止める（出力 API・画面の両方）。
 */

export interface ValidationExtras {
  /** 指標の集計方法（latest の指標は時点の値。期間の概念に付けると V04） */
  metrics?: ReadonlyArray<{ id: string; aggregationMethod: AggregationMethod; name: string }>;
  /** プロジェクトの基準に設定したパッケージ（違えば V12） */
  assignedPackageId?: string | null;
}

export type XbrlValidationState = 'passed' | 'warning' | 'error';

export interface XbrlValidationResult {
  validatorVersion: string;
  findings: XbrlFinding[];
  counts: Record<XbrlSeverity, number>;
  /** 規則ごとの最も重い結果（指摘が無ければ passed） */
  byRule: Record<XbrlRuleId, XbrlSeverity | 'passed'>;
  state: XbrlValidationState;
  /** エラーがあれば出力を止める */
  blocking: boolean;
}

const RANK: Record<XbrlSeverity | 'passed', number> = { error: 3, warning: 2, note: 1, passed: 0 };

export function worstSeverity(
  findings: ReadonlyArray<Pick<XbrlFinding, 'severity'>>,
): XbrlSeverity | 'passed' {
  let worst: XbrlSeverity | 'passed' = 'passed';
  for (const f of findings) if (RANK[f.severity] > RANK[worst]) worst = f.severity;
  return worst;
}

/** 10 進の文字列どうしが同じ数か（桁の表記の揺れ「1240.50」「1240.5」を同じとみなす） */
function sameNumber(a: string, b: string): boolean {
  return shiftDecimal(a, 0) === shiftDecimal(b, 0);
}

export function validateXbrl(
  input: FactBuildInput,
  built: FactBuildResult,
  extras: ValidationExtras = {},
): XbrlValidationResult {
  const { pkg, snapshot } = input;
  const out: XbrlFinding[] = [...built.findings];
  const scoped = mappingsInScope(input.mappings, {
    packageId: pkg.id,
    projectId: snapshot.projectId,
    frameworkVersionId: built.framework.frameworkVersionId,
  });
  const confirmed = built.confirmedMappings;
  const mappingById = new Map(scoped.map((m) => [m.id, m]));
  const axes = axesOf(pkg);

  // V01: 本文の節が扱う要求事項に、確定した対応付け（要求事項への直接の対応付けか、その節の
  // テキストブロック）が無い
  const coveredItems = new Set<string>();
  for (const m of confirmed) {
    if (m.disclosureItemId) coveredItems.add(m.disclosureItemId);
    if (m.targetKind === 'block') {
      const block = built.blocks.find((b) => b.sectionKey === m.sectionKey);
      for (const r of block?.requirements ?? []) coveredItems.add(r.itemId);
    }
  }
  const reported = new Map<string, string>();
  for (const block of built.blocks) {
    for (const r of block.requirements) if (!reported.has(r.itemId)) reported.set(r.itemId, r.code);
  }
  for (const [itemId, code] of [...reported.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1))) {
    if (!coveredItems.has(itemId)) {
      out.push(finding('V01', `要求事項 ${code} に確定した対応付けがありません。`, { itemId }));
    }
  }

  // 対応付けそのものの検査（確定したもの）
  for (const m of confirmed) {
    const refs = { mappingId: m.id };
    const concept = findConceptById(pkg, m.conceptId);
    if (!concept) continue; // V14 は組み立てで指摘済み
    // V04: 値を持つ概念に期間型が無い・テキストブロックが時点・latest の指標を期間の概念に
    if ((concept.kind === 'item' || concept.kind === 'text_block') && concept.periodType === null) {
      out.push(finding('V04', `概念「${concept.labelJa}」に期間型がありません。`, refs));
    } else if (m.targetKind === 'block' && concept.periodType === 'instant') {
      out.push(
        finding(
          'V04',
          `節（期間の記述）を時点の概念「${concept.labelJa}」に対応付けています。`,
          refs,
        ),
      );
    } else if (m.targetKind === 'metric' && concept.periodType === 'duration') {
      const metric = extras.metrics?.find((x) => x.id === m.metricId);
      if (metric?.aggregationMethod === 'latest') {
        out.push(
          finding(
            'V04',
            `指標「${metric.name}」は時点の値（最新値）ですが、期間の概念「${concept.labelJa}」に対応付けています。`,
            refs,
          ),
        );
      }
    }
    // V05: 数値は decimals が必須、文章は decimals を持たない。scale は単位から自動で決まる
    const numeric = isNumericConcept(concept);
    if (m.targetKind === 'metric' && numeric && m.decimals === null) {
      out.push(finding('V05', '数値の対応付けに精度（decimals）がありません。', refs));
    }
    if (m.targetKind === 'block' && m.decimals !== null) {
      out.push(finding('V05', '文章の対応付けに精度（decimals）が設定されています。', refs));
    }
    if (m.scale !== 0) {
      out.push(
        finding(
          'V05',
          `桁（scale = ${m.scale}）は単位の換算から自動で決まります。0 以外は矛盾として扱います。`,
          refs,
        ),
      );
    }
    // V13: 軸 → メンバーの検査。数値は境界を軸メンバーで明示する（境界の文字列から推測しない）
    const dims = Object.entries(m.dimensions ?? {});
    for (const [axisName, memberName] of dims) {
      const axis = axes.find((a) => a.axis.localName === axisName);
      if (!axis) {
        out.push(finding('V13', `軸「${axisName}」はこのパッケージにありません。`, refs));
        continue;
      }
      if (!axis.members.some((member) => member.localName === memberName)) {
        const member = findConcept(pkg, memberName);
        out.push(
          finding(
            'V13',
            member
              ? `メンバー「${member.labelJa}」は軸「${axis.axis.labelJa}」に属しません。`
              : `メンバー「${memberName}」はこのパッケージにありません。`,
            refs,
          ),
        );
      }
    }
    if (m.targetKind === 'metric' && dims.length === 0 && axes.length > 0) {
      out.push(
        finding(
          'V13',
          `境界${m.boundary ? `（${m.boundary}）` : ''}を表す軸メンバーを指定していません。`,
          refs,
        ),
      );
    }
  }

  // 事実の検査
  for (const fact of built.facts) {
    const refs = { mappingId: fact.mappingId, factId: fact.id };
    const mapping = mappingById.get(fact.mappingId);
    if (fact.source.kind === 'metric') {
      const src = fact.source;
      // V03: 型と単位
      const unitMeasure = fact.unit?.measure ?? '';
      const cls = measureClass(unitMeasure);
      const allowed = pkg.unitRules[fact.concept.localName];
      if (fact.valueClass === 'monetary' && cls !== 'currency') {
        out.push(
          finding(
            'V03',
            `金額の概念「${fact.concept.labelJa}」に通貨以外の単位（${src.unitOfMeasure}）を付けています。`,
            refs,
          ),
        );
      } else if (fact.valueClass === 'percent' && cls !== 'pure') {
        out.push(
          finding(
            'V03',
            `比率の概念「${fact.concept.labelJa}」に比率以外の単位（${src.unitOfMeasure}）を付けています。`,
            refs,
          ),
        );
      } else if (
        (fact.valueClass === 'decimal' || fact.valueClass === 'integer') &&
        cls === 'currency'
      ) {
        out.push(
          finding(
            'V03',
            `数量の概念「${fact.concept.labelJa}」に通貨の単位（${src.unitOfMeasure}）を付けています。`,
            refs,
          ),
        );
      } else if (allowed && !allowed.includes(unitMeasure)) {
        out.push(
          finding(
            'V03',
            `概念「${fact.concept.labelJa}」の単位は ${allowed.join('・')} に限られます（${src.unitOfMeasure} は使えません）。`,
            refs,
          ),
        );
      }
      if (fact.valueClass === 'integer' && fact.value.includes('.')) {
        out.push(
          finding(
            'V03',
            `整数の概念「${fact.concept.labelJa}」に小数の値（${fact.value}）があります。`,
            refs,
          ),
        );
      }
      // V05: 精度が値より粗い（読み手は丸めた値として扱う）
      if (fact.decimals !== null && !representableAt(fact.value, fact.decimals)) {
        out.push(
          finding(
            'V05',
            `精度（decimals = ${mapping?.decimals ?? fact.decimals}）が値 ${src.rawValue} より粗いため、読み手は丸めた値として扱います。`,
            refs,
            'warning',
          ),
        );
      }
      // V07: 本文の表示値（承認時の文字列）と事実の値
      for (const block of built.blocks) {
        for (const p of block.body.paragraphs) {
          for (const inline of p.children) {
            if (inline.t !== 'metric' || inline.dataPointVersionId !== src.dataPointVersionId) {
              continue;
            }
            const shown = leadingNumber(inline.display);
            if (shown === null || !sameNumber(shown, src.rawValue)) {
              out.push(
                finding(
                  'V07',
                  `節「${block.title}」の表示「${inline.display}」が事実の値 ${src.rawValue} ${src.unitOfMeasure} と一致しません。本文を見直してください（出力では書き換えません）。`,
                  refs,
                ),
              );
            }
          }
        }
      }
      // V08: 推計・目標を実績の概念に
      if (src.valueKind !== 'actual' && fact.periodRole !== 'target') {
        out.push(
          finding(
            'V08',
            `「${src.metricName}」の値は${src.valueKind === 'estimate' ? '推計' : '目標'}ですが、実績として対応付けています。`,
            refs,
          ),
        );
      }
      // V09: 未承認の版
      if (!src.versionApproved) {
        out.push(finding('V09', `「${src.metricName}」の版 ${src.versionNo} は未承認です。`, refs));
      }
    } else if (!fact.source.approved) {
      out.push(finding('V10', `節「${fact.source.title}」の版は承認済みではありません。`, refs));
    }
  }

  // V06: 同じ概念・コンテキスト・単位に異なる値
  const groups = new Map<string, XbrlFact[]>();
  for (const fact of built.facts) {
    const key = `${fact.qname}|${fact.contextId}|${fact.unit?.id ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const group of groups.values()) {
    const values = new Set(group.map((f) => f.value));
    if (values.size > 1) {
      for (const fact of group) {
        out.push(
          finding(
            'V06',
            `概念「${fact.concept.labelJa}」・${fact.contextId} に異なる値（${[...values].join('／')}）があります。`,
            { mappingId: fact.mappingId, factId: fact.id },
          ),
        );
      }
    }
  }

  // V11: 提出者の識別子
  if (input.entity === null) {
    out.push(
      pkg.isSample
        ? finding(
            'V11',
            '提出者の識別子がありません（SAMPLE のため警告。仮の識別子で構造だけを示します）。',
            {},
            'warning',
          )
        : finding('V11', '提出者の識別子がありません。', {}),
    );
  } else if (input.entity.isSample) {
    out.push(
      finding(
        'V11',
        `提出者の識別子は架空（${input.entity.value}）です。実在の識別子ではありません。`,
        {},
        'note',
      ),
    );
  }

  // V12: タクソノミと基準の版
  if (pkg.frameworkKey !== built.framework.frameworkKey) {
    out.push(
      finding(
        'V12',
        `パッケージ「${pkg.name}」は基準「${built.framework.label}」用ではありません。`,
        {},
      ),
    );
  }
  if (extras.assignedPackageId !== undefined && extras.assignedPackageId !== pkg.id) {
    out.push(
      finding(
        'V12',
        'プロジェクトの基準に設定したタクソノミと、出力に使うタクソノミが違います。',
        {},
      ),
    );
  }

  // V16: 提出用ではないパッケージ（常に注記）
  if (!pkg.filingReady) {
    out.push(
      finding(
        'V16',
        pkg.isSample
          ? 'SAMPLE（架空）のタクソノミです。提出用のファイルではありません。'
          : '提出用にできないパッケージです（草案・ライセンス未取得など）。',
        {},
      ),
    );
  }

  const findings = sortFindings(out);
  const counts: Record<XbrlSeverity, number> = { error: 0, warning: 0, note: 0 };
  for (const f of findings) counts[f.severity] += 1;
  const byRule = Object.fromEntries(
    XBRL_RULE_IDS.map((rule) => [rule, worstSeverity(findings.filter((f) => f.rule === rule))]),
  ) as Record<XbrlRuleId, XbrlSeverity | 'passed'>;
  const state: XbrlValidationState =
    counts.error > 0 ? 'error' : counts.warning > 0 ? 'warning' : 'passed';
  return {
    validatorVersion: XBRL_VALIDATOR_VERSION,
    findings,
    counts,
    byRule,
    state,
    blocking: counts.error > 0,
  };
}

/** 対応付けごとの最も重い結果（行の「検証」列） */
export function mappingValidationState(
  result: Pick<XbrlValidationResult, 'findings'>,
  mapping: Pick<XbrlTagMapping, 'id'>,
): XbrlSeverity | 'passed' {
  return worstSeverity(result.findings.filter((f) => f.mappingId === mapping.id));
}

/** 出力の記録に残す検証の要約（小さく。Demo の Cookie にも載る） */
export function validationSummaryOf(
  result: XbrlValidationResult,
  trace: { traceable: number; total: number },
): Record<string, unknown> {
  return {
    v: result.validatorVersion,
    e: result.counts.error,
    w: result.counts.warning,
    n: result.counts.note,
    facts: trace.total,
    traced: trace.traceable,
  };
}

export { XBRL_RULES };
