'use client';

import * as React from 'react';
import Link from 'next/link';
import * as Popover from '@radix-ui/react-popover';
import { AlertTriangle, BarChart3, CheckCircle2, FileText, Quote, X } from 'lucide-react';
import type { RefInline } from './editor-model';

/** 数値参照の詳細（引用中の版・挿入候補のどちらからでも作れる形） */
export interface MetricDetail {
  metricName: string;
  unitName: string;
  boundary: string;
  periodLabel: string;
  unitOfMeasure: string;
  versionNo: number;
  display: string;
  approved: boolean;
  methodology: string | null;
  evidenceCount: number | null;
  sourceReference: string | null;
  /** 引用中の版より新しい版があれば、その表示 */
  newer: { versionNo: number; display: string; changeReason: string | null } | null;
}

export interface NarrativeDetail {
  title: string;
  versionNo: number;
  periodLabel: string;
  confirmed: boolean;
  stale: boolean;
  statusLabel: string;
}

export interface AnchorDetail {
  fileName: string;
  usageLabel: string;
  locator: string | null;
  quoteText: string;
  fileDeleted: boolean;
  fileId: string | null;
}

export interface RefLookup {
  metric(versionId: string): MetricDetail | null;
  narrative(versionId: string): NarrativeDetail | null;
  anchor(anchorId: string): AnchorDetail | null;
  canReadEvidence: boolean;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 py-0.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="break-words text-ink">{children}</dd>
    </div>
  );
}

/**
 * 本文中の参照（数値・定性情報の引用・出典印）。読みやすい値＋アイコンで示し、
 * 押すと指標・期間・範囲・単位・版・承認状態・根拠を開く。状態は色だけでなく文言でも示す。
 */
export function RefChip({
  token,
  inline,
  lookup,
}: {
  token: string;
  inline: RefInline;
  lookup: RefLookup;
}) {
  const [open, setOpen] = React.useState(false);

  let icon: React.ReactNode;
  let label: string;
  let flag: string | null = null;
  let details: React.ReactNode;

  if (inline.t === 'metric') {
    const d = lookup.metric(inline.dataPointVersionId);
    icon = <BarChart3 className="size-3" aria-hidden="true" />;
    label = inline.display;
    if (d?.newer) flag = '新版あり';
    else if (d && !d.approved) flag = '未承認';
    details = d ? (
      <dl className="text-small">
        <Row label="指標">{d.metricName}</Row>
        <Row label="期間">{d.periodLabel}</Row>
        <Row label="範囲">
          {d.unitName}・{d.boundary}
        </Row>
        <Row label="単位">{d.unitOfMeasure}</Row>
        <Row label="版">
          版 {d.versionNo}（{inline.display}）
        </Row>
        <Row label="承認状態">
          {d.approved ? (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="size-3 text-success" aria-hidden="true" />
              承認済みの版
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="size-3 text-warning-ink" aria-hidden="true" />
              未承認の版
            </span>
          )}
        </Row>
        {d.methodology && <Row label="計算">{d.methodology}</Row>}
        <Row label="根拠">
          {d.evidenceCount === null
            ? '—'
            : d.evidenceCount > 0
              ? `資料・証跡 ${d.evidenceCount} 件`
              : '資料・証跡の紐付けなし'}
          {d.sourceReference ? `（出所: ${d.sourceReference}）` : ''}
        </Row>
        {d.newer && (
          <p className="mt-1 rounded-t4d border border-warning/40 bg-warning-soft p-1.5 text-ink">
            新しい版があります: 版 {d.newer.versionNo}（{d.newer.display}）
            {d.newer.changeReason ? ` ／ 理由: ${d.newer.changeReason}` : ''}
          </p>
        )}
      </dl>
    ) : (
      <p className="text-small text-ink-muted">この数値の詳細を読み込めませんでした。</p>
    );
  } else if (inline.t === 'narrative') {
    const d = lookup.narrative(inline.narrativeVersionId);
    icon = <Quote className="size-3" aria-hidden="true" />;
    label = d ? `${d.title}（版 ${d.versionNo}）` : '定性情報の引用';
    if (d?.stale) flag = '新版あり';
    else if (d && !d.confirmed) flag = '未確認';
    details = (
      <div className="text-small">
        {d && (
          <dl>
            <Row label="定性情報">{d.title}</Row>
            <Row label="版">版 {d.versionNo}</Row>
            <Row label="期間">{d.periodLabel}</Row>
            <Row label="確認状態">
              {d.confirmed ? '確認済みの版' : `未確認（${d.statusLabel}）`}
            </Row>
          </dl>
        )}
        <blockquote className="mt-1 border-l-2 border-brand-200 pl-2 text-ink">
          {inline.quote}
        </blockquote>
        {d?.stale && (
          <p className="mt-1 text-warning-ink">
            台帳に新しい版があります。本文は引用した時点の文言のままです（黙って書き換えません）。
          </p>
        )}
      </div>
    );
  } else {
    const d = lookup.anchor(inline.sourceAnchorId);
    icon = <FileText className="size-3" aria-hidden="true" />;
    label = '出典';
    if (d?.fileDeleted) flag = '根拠失効';
    details = !lookup.canReadEvidence ? (
      <p className="text-small text-ink-muted">この資料を閲覧する権限がありません。</p>
    ) : d ? (
      <div className="text-small">
        <dl>
          <Row label="資料">{d.fileName}</Row>
          <Row label="利用目的">{d.usageLabel}</Row>
          <Row label="位置">{d.locator ?? '—'}</Row>
        </dl>
        <blockquote className="mt-1 border-l-2 border-brand-200 pl-2 text-ink">
          {d.quoteText}
        </blockquote>
        {d.fileId && !d.fileDeleted && (
          <Link
            href={`/enterprise/evidence/${d.fileId}`}
            className="mt-1 inline-block text-brand-700 underline-offset-2 hover:underline"
          >
            原文を開く
          </Link>
        )}
      </div>
    ) : (
      <p className="text-small text-ink-muted">引用位置が見つかりません。</p>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1 rounded-t4d border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-small text-brand-900 hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          aria-label={`${token} ${label}${flag ? `（${flag}）` : ''} の詳細を開く`}
        >
          <span className="font-mono text-caption text-ink-muted">{token}</span>
          {icon}
          <span className="truncate">{label}</span>
          {flag && (
            <span className="inline-flex items-center gap-0.5 rounded bg-warning-soft px-1 text-caption text-warning-ink">
              <AlertTriangle className="size-2.5" aria-hidden="true" />
              {flag}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={16}
          className="z-(--z-popover) w-[min(360px,calc(100vw-32px))] rounded-t4d-lg border border-line bg-surface p-3 shadow-overlay focus:outline-none"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-small font-semibold text-ink">
              {inline.t === 'metric'
                ? '数値の参照'
                : inline.t === 'narrative'
                  ? '定性情報の引用'
                  : '出典'}
            </span>
            <Popover.Close
              aria-label="詳細を閉じる"
              className="rounded-t4d p-0.5 text-ink-muted hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <X className="size-3.5" aria-hidden="true" />
            </Popover.Close>
          </div>
          {details}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
