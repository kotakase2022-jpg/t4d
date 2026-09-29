'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Asterisk,
  BarChart3,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Equal,
  FileText,
  Hash,
  History,
  Lock,
  MessageSquare,
  Minus,
  PencilLine,
  Plus,
  Quote,
  Tag,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatJst } from '@/lib/format/datetime';
import type { BlockEditorData } from '@/lib/services/disclosure-block';
import { addReviewCommentAction, resolveReviewCommentAction } from '../actions';
import { DiffText } from './diff-text';
import type { RefInline } from './editor-model';

export type PaneTab = 'requirements' | 'evidence' | 'metrics' | 'prior' | 'comments';

export interface RightPaneProps {
  data: BlockEditorData;
  projectId: string;
  /** 本文へ参照を差し込めるか（編集できる状態か） */
  canEdit: boolean;
  /** AI に渡す根拠の選択（kind:id） */
  selected: ReadonlySet<string>;
  onToggleSelect: (key: string) => void;
  canSelectForAi: boolean;
  onInsert: (inline: RefInline, label: string) => void;
  onJump: (paragraphId: string) => void;
  /** 段落の表示名（本文の中の位置。内部の段落 ID は出さない） */
  paragraphLabel: (paragraphId: string) => string;
  paragraphOptions: Array<{ id: string; label: string }>;
  tab: PaneTab;
  onTabChange: (tab: PaneTab) => void;
  onAnnounce: (message: string) => void;
}

function AiCheckbox({
  id,
  checked,
  disabled,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
      <input
        id={id}
        type="checkbox"
        className="size-3.5 accent-brand-700"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
      />
      AI の根拠に使う
    </label>
  );
}

function JumpLinks({
  ids,
  onJump,
  label,
}: {
  ids: string[];
  onJump: (id: string) => void;
  label: (id: string) => string;
}) {
  if (ids.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-ink-muted">
      引用箇所:
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onJump(id)}
          className="rounded-t4d px-1 text-brand-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          {label(id)}
        </button>
      ))}
    </span>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1 mt-3 text-[12px] font-semibold text-ink first:mt-0">{children}</h3>;
}

export function RightPane(props: RightPaneProps) {
  const { data } = props;
  return (
    <Tabs
      value={props.tab}
      onValueChange={(v) => props.onTabChange(v as PaneTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList aria-label="根拠パネル" className="shrink-0 overflow-x-auto px-2">
        <TabsTrigger value="requirements">要求事項</TabsTrigger>
        <TabsTrigger value="evidence">根拠資料</TabsTrigger>
        <TabsTrigger value="metrics">関連数値</TabsTrigger>
        <TabsTrigger value="prior">前年</TabsTrigger>
        <TabsTrigger value="comments">
          コメント
          {data.statusBar.unresolvedComments.count > 0 && (
            <span className="ml-1 rounded bg-warning-soft px-1 text-[10px] text-[#8a5d00]">
              未解決 {data.statusBar.unresolvedComments.count}
            </span>
          )}
        </TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[12px]">
        <TabsContent value="requirements">
          <RequirementsTab {...props} />
        </TabsContent>
        <TabsContent value="evidence">
          <EvidenceTab {...props} />
        </TabsContent>
        <TabsContent value="metrics">
          <MetricsTab {...props} />
        </TabsContent>
        <TabsContent value="prior">
          <PriorTab {...props} />
        </TabsContent>
        <TabsContent value="comments">
          <CommentsTab {...props} />
        </TabsContent>
      </div>
    </Tabs>
  );
}

// ----------------------------------------------------------------------
// 要求事項
// ----------------------------------------------------------------------

function RequirementsTab({ data, selected, onToggleSelect, canSelectForAi }: RightPaneProps) {
  return (
    <div>
      <p className="mb-2 text-ink-muted">
        {data.framework.label}
        {data.framework.legalStatusLabel ? `（${data.framework.legalStatusLabel}）` : ''}
        {data.framework.coverageLabel ? ` ／ ${data.framework.coverageLabel}` : ''}
      </p>
      {data.framework.isDraftStandard && (
        <p className="mb-2 flex items-start gap-1 rounded-t4d border border-warning/40 bg-warning-soft p-2 text-ink">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#8a5d00]" aria-hidden="true" />
          草案の基準です。この節の承認は草案に基づく社内の準備であり、正式な基準への準拠を示すものではありません。
        </p>
      )}
      {data.requirements.length === 0 ? (
        <p className="text-ink-muted">
          この節に紐付いた要求事項はありません（要求事項が未収録の基準では空になります）。
        </p>
      ) : (
        <ul className="space-y-2">
          {data.requirements.map((r) => (
            <li key={r.id} className="rounded-t4d border border-line p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="outline" className="font-mono">
                  <Hash className="size-3" aria-hidden="true" />
                  {r.code}
                </Badge>
                <span className="text-ink-muted">{r.section}</span>
                <Badge tone={r.required ? 'brand' : 'neutral'}>
                  {r.required ? (
                    <Asterisk className="size-3" aria-hidden="true" />
                  ) : (
                    <CircleDashed className="size-3" aria-hidden="true" />
                  )}
                  {r.required ? '必須' : '任意'}
                </Badge>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-ink">{r.text}</p>
              {canSelectForAi && (
                <AiCheckbox
                  id={`ai-req-${r.id}`}
                  checked={selected.has(`requirement:${r.id}`)}
                  onChange={() => onToggleSelect(`requirement:${r.id}`)}
                  label={`要求事項 ${r.code} を AI の根拠に使う`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// 根拠資料（定性情報・資料の引用位置）
// ----------------------------------------------------------------------

function EvidenceTab({
  data,
  canEdit,
  selected,
  onToggleSelect,
  canSelectForAi,
  onInsert,
  onJump,
  paragraphLabel,
}: RightPaneProps) {
  const narratives = [...data.narratives].sort(
    (a, b) => Number(b.paragraphIds.length > 0) - Number(a.paragraphIds.length > 0),
  );
  const anchors = [...data.anchors].sort(
    (a, b) => Number(b.paragraphIds.length > 0) - Number(a.paragraphIds.length > 0),
  );
  return (
    <div>
      <SectionHeading>定性情報（台帳の版）</SectionHeading>
      {narratives.length === 0 ? (
        <p className="text-ink-muted">定性情報が登録されていません。</p>
      ) : (
        <ul className="space-y-2">
          {narratives.map((n) => {
            const stale = n.paragraphIds.length > 0 && n.currentVersionId !== n.versionId;
            return (
              <li key={n.versionId} className="rounded-t4d border border-line p-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Quote className="size-3.5 text-brand-700" aria-hidden="true" />
                  <span className="font-medium text-ink">{n.title}</span>
                  <Badge tone="outline">
                    <History className="size-3" aria-hidden="true" />版 {n.versionNo}
                  </Badge>
                  <Badge tone={n.confirmed ? 'success' : 'warning'}>
                    {n.confirmed ? (
                      <CheckCircle2 className="size-3" aria-hidden="true" />
                    ) : (
                      <CircleDot className="size-3" aria-hidden="true" />
                    )}
                    {n.confirmed ? '確認済みの版' : `未確認（${n.statusLabel}）`}
                  </Badge>
                  {stale && (
                    <Badge tone="warning">
                      <AlertTriangle className="size-3" aria-hidden="true" />
                      台帳に新しい版あり
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-ink-muted">
                  {n.themeLabel} ／ {n.periodLabel}
                </p>
                <p className="mt-1 line-clamp-4 text-ink">{n.body}</p>
                {n.missingFieldLabels.length > 0 && (
                  <p className="mt-1 text-[#8a5d00]">
                    未記入の項目: {n.missingFieldLabels.join('、')}
                  </p>
                )}
                {n.notQuantifiedNote && (
                  <p className="mt-1 text-ink-muted">{n.notQuantifiedNote}</p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <JumpLinks ids={n.paragraphIds} onJump={onJump} label={paragraphLabel} />
                  {canEdit && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onInsert(
                          { t: 'narrative', narrativeVersionId: n.versionId, quote: n.body },
                          `定性情報「${n.title}」の引用`,
                        )
                      }
                    >
                      <Plus aria-hidden="true" />
                      引用を挿入
                    </Button>
                  )}
                  {canSelectForAi && (
                    <AiCheckbox
                      id={`ai-nv-${n.versionId}`}
                      checked={selected.has(`narrative_version:${n.versionId}`)}
                      onChange={() => onToggleSelect(`narrative_version:${n.versionId}`)}
                      label={`定性情報「${n.title}」を AI の根拠に使う`}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <SectionHeading>資料の引用位置</SectionHeading>
      {!data.canReadEvidence ? (
        <p className="flex items-center gap-1 text-ink-muted">
          <Lock className="size-3.5" aria-hidden="true" />
          資料・証跡を閲覧する権限がありません。
        </p>
      ) : anchors.length === 0 ? (
        <p className="text-ink-muted">
          引用位置が登録されていません。資料・証跡の画面で該当箇所を登録してください。
        </p>
      ) : (
        <ul className="space-y-2">
          {anchors.map((a) => (
            <li key={a.id} className="rounded-t4d border border-line p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <FileText className="size-3.5 text-brand-700" aria-hidden="true" />
                <span className="break-all font-medium text-ink">{a.fileName}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <Badge tone={a.usagePurpose === 'current_fact' ? 'brand' : 'neutral'}>
                  <Tag className="size-3" aria-hidden="true" />
                  {a.usageLabel}
                </Badge>
                {a.fileDeleted && (
                  <Badge tone="danger">
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    根拠失効（資料が削除済み）
                  </Badge>
                )}
                <span className="text-ink-muted">{a.locator ?? '位置の記録なし'}</span>
              </div>
              <blockquote className="mt-1 line-clamp-4 border-l-2 border-brand-200 pl-2 text-ink">
                {a.quoteText}
              </blockquote>
              {a.usagePurpose !== 'current_fact' && (
                <p className="mt-1 text-ink-muted">
                  当年度の事実の根拠にはしません（前年の記載・文体の参考として扱います）。
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <JumpLinks ids={a.paragraphIds} onJump={onJump} label={paragraphLabel} />
                {canEdit && !a.fileDeleted && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onInsert({ t: 'cite', sourceAnchorId: a.id }, `出典印（${a.fileName}）`)
                    }
                  >
                    <Plus aria-hidden="true" />
                    出典印を付ける
                  </Button>
                )}
                {a.fileId && !a.fileDeleted && (
                  <Link
                    href={`/enterprise/evidence/${a.fileId}`}
                    className="text-brand-700 underline-offset-2 hover:underline"
                  >
                    原文を開く
                  </Link>
                )}
                {canSelectForAi && (
                  <AiCheckbox
                    id={`ai-sa-${a.id}`}
                    checked={selected.has(`source_anchor:${a.id}`)}
                    disabled={a.fileDeleted}
                    onChange={() => onToggleSelect(`source_anchor:${a.id}`)}
                    label={`${a.fileName} ${a.locator ?? ''} を AI の根拠に使う`}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// 関連数値
// ----------------------------------------------------------------------

function MetricsTab({
  data,
  projectId,
  canEdit,
  selected,
  onToggleSelect,
  canSelectForAi,
  onInsert,
  onJump,
  paragraphLabel,
}: RightPaneProps) {
  const [query, setQuery] = React.useState('');
  const q = query.trim();
  const candidates = data.metricCandidates.filter(
    (c) => !q || `${c.metricName} ${c.unitName} ${c.boundary}`.includes(q),
  );
  const recheckHref = `/enterprise/disclosure-projects/${projectId}/blocks/${data.block.id}/recheck`;
  return (
    <div>
      <SectionHeading>本文が引用している数値</SectionHeading>
      {data.metricRefs.length === 0 ? (
        <p className="text-ink-muted">数値の参照はありません。</p>
      ) : (
        <ul className="space-y-2">
          {data.metricRefs.map((m) => (
            <li key={m.dataPointVersionId} className="rounded-t4d border border-line p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <BarChart3 className="size-3.5 text-brand-700" aria-hidden="true" />
                <span className="font-medium text-ink">{m.metricName}</span>
                <span className="text-ink-muted">
                  {m.unitName}・{m.boundary}・{m.periodLabel}
                </span>
              </div>
              <p className="tnum mt-1 text-[13px] text-ink">
                {m.referenced?.display ?? '—'}
                <span className="ml-1 text-[11px] text-ink-muted">
                  版 {m.referenced?.versionNo ?? '—'}
                </span>
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge tone={m.referenced?.approved ? 'success' : 'warning'}>
                  {m.referenced?.approved ? (
                    <CheckCircle2 className="size-3" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="size-3" aria-hidden="true" />
                  )}
                  {m.referenced?.approved ? '承認済みの版' : '未承認の版'}
                </Badge>
                {m.stale && (
                  <Badge tone="warning">
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    新しい版あり: 版 {m.current?.versionNo}（{m.current?.display}）
                  </Badge>
                )}
              </div>
              {m.stale && m.current?.changeReason && (
                <p className="mt-1 text-ink-muted">変更理由: {m.current.changeReason}</p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <JumpLinks ids={m.paragraphIds} onJump={onJump} label={paragraphLabel} />
                {m.stale && (
                  <Link
                    href={recheckHref}
                    className="text-brand-700 underline-offset-2 hover:underline"
                  >
                    再確認する
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <SectionHeading>本文へ挿入できる数値（{data.project.periodLabel}）</SectionHeading>
      <label htmlFor="metric-filter" className="sr-only">
        数値を絞り込む
      </label>
      <Input
        id="metric-filter"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="指標名・組織・範囲で絞り込み"
        className="mb-2"
      />
      {candidates.length === 0 ? (
        <p className="text-ink-muted">該当する数値がありません。</p>
      ) : (
        <ul className="divide-y divide-line rounded-t4d border border-line">
          {candidates.slice(0, 60).map((c) => (
            <li key={c.key} className="flex flex-wrap items-center gap-2 p-2">
              {/*
                指標名と組織・範囲は 1 行を占めて折り返す（切り詰めない）。狭い根拠パネルで
                「Scope2 排出量（マーケット基準）」と「（ロケーション基準）」が同じ「Scope2 排出量…」に
                見えて、どちらを挿入するか分からなくなっていた（§4.2・A08）
              */}
              <div className="min-w-0 basis-full">
                <div className="break-words text-ink">{c.metricName}</div>
                <div className="break-words text-[11px] text-ink-muted">
                  {c.unitName}・{c.boundary}・版 {c.versionNo}
                </div>
              </div>
              <span className="tnum ml-auto text-right text-ink">{c.display}</span>
              <Badge tone={c.approved ? 'success' : 'warning'}>
                {c.approved ? (
                  <CheckCircle2 className="size-3" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="size-3" aria-hidden="true" />
                )}
                {c.approved ? '承認済み' : '未承認'}
              </Badge>
              {canEdit && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onInsert(c.inline, `${c.metricName}（${c.display}）`)}
                  aria-label={`${c.metricName}（${c.unitName}）${c.display} を本文へ挿入`}
                >
                  <Plus aria-hidden="true" />
                  挿入
                </Button>
              )}
              {canSelectForAi && (
                <AiCheckbox
                  id={`ai-mv-${c.key}`}
                  checked={selected.has(`metric_version:${c.inline.dataPointVersionId}`)}
                  onChange={() => onToggleSelect(`metric_version:${c.inline.dataPointVersionId}`)}
                  label={`${c.metricName}（${c.unitName}）を AI の根拠に使う`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 60 && (
        <p className="mt-1 text-ink-muted">
          先頭の 60 件を表示しています（{candidates.length} 件）。絞り込んでください。
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// 前年（本文の差分 ／ 前提の差分）
// ----------------------------------------------------------------------

function PriorTab({ data, onJump, paragraphLabel }: RightPaneProps) {
  const [view, setView] = React.useState<'text' | 'meta'>('text');
  const prior = data.priorYear;
  if (!prior) {
    return (
      <p className="text-ink-muted">前の報告期間に同じ節（同じ節のキー・言語）がありません。</p>
    );
  }
  return (
    <div>
      <p className="text-ink">
        {prior.projectName}「{prior.blockTitle}」版 {prior.versionNo}
        {prior.approved ? '（承認済みの版）' : '（未承認の版）'}
      </p>
      <p className="text-ink-muted">{prior.periodLabel}</p>
      <div
        role="group"
        aria-label="前年比較の表示"
        className="mt-2 inline-flex rounded-t4d border border-line"
      >
        {(
          [
            ['text', '本文の差分'],
            ['meta', '数値・範囲・基準の差分'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={`px-2 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
              view === key
                ? 'bg-brand-100 font-medium text-brand-900'
                : 'text-ink-muted hover:bg-brand-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'text' ? (
        <ol className="mt-2 space-y-2">
          {prior.paragraphDiff.map((d) => (
            <li key={`${d.kind}-${d.paragraphId}`} className="rounded-t4d border border-line p-2">
              <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
                <span>{d.kind === 'removed' ? '前年の段落' : paragraphLabel(d.paragraphId)}</span>
                <Badge
                  tone={
                    d.kind === 'unchanged'
                      ? 'neutral'
                      : d.kind === 'added'
                        ? 'success'
                        : d.kind === 'removed'
                          ? 'danger'
                          : 'warning'
                  }
                >
                  {d.kind === 'unchanged' ? (
                    <Equal className="size-3" aria-hidden="true" />
                  ) : d.kind === 'added' ? (
                    <Plus className="size-3" aria-hidden="true" />
                  ) : d.kind === 'removed' ? (
                    <Minus className="size-3" aria-hidden="true" />
                  ) : (
                    <PencilLine className="size-3" aria-hidden="true" />
                  )}
                  {d.kind === 'unchanged'
                    ? '変更なし'
                    : d.kind === 'added'
                      ? '当年に追加'
                      : d.kind === 'removed'
                        ? '前年のみ'
                        : '変更あり'}
                </Badge>
                {d.kind !== 'removed' && (
                  <button
                    type="button"
                    onClick={() => onJump(d.paragraphId)}
                    className="text-brand-700 underline-offset-2 hover:underline"
                  >
                    本文へ移動
                  </button>
                )}
              </div>
              {d.kind === 'changed' ? (
                <DiffText segments={d.segments} />
              ) : d.kind === 'removed' ? (
                <del className="text-ink-muted">{d.text}</del>
              ) : (
                <p className="whitespace-pre-wrap text-ink">{d.text}</p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <p className="mb-1 text-ink-muted">
            単語の差分だけでは前提の変化（対象範囲・算定方法・基準の版）を見落とすため、別に示します。
          </p>
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-ink-muted">
                <th scope="col" className="py-1 pr-2 font-medium">
                  項目
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  前年
                </th>
                <th scope="col" className="py-1 font-medium">
                  当年
                </th>
              </tr>
            </thead>
            <tbody>
              {prior.metadata.map((row) => (
                <tr key={row.label} className="border-b border-line align-top">
                  <th scope="row" className="py-1 pr-2 text-left font-normal text-ink">
                    {row.label}
                    {row.changed && (
                      <span className="mt-0.5 flex items-center gap-0.5 text-[10px] text-[#8a5d00]">
                        <AlertTriangle className="size-2.5" aria-hidden="true" />
                        変更あり
                      </span>
                    )}
                  </th>
                  <td className="break-words py-1 pr-2 text-ink-muted">{row.prior}</td>
                  <td className="break-words py-1 text-ink">{row.current}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// コメント（版・段落に紐付く）
// ----------------------------------------------------------------------

/** コメントの送信・解決で通信そのものが失敗したとき。入力は残り、もう一度押せる */
export const COMMENT_NETWORK_ERROR_MESSAGE =
  'サーバーに接続できませんでした。入力したコメントは残っています。通信を確認して、もう一度押してください。';

function CommentsTab({
  data,
  projectId,
  onJump,
  paragraphLabel,
  paragraphOptions,
  onAnnounce,
}: RightPaneProps) {
  const router = useRouter();
  const canComment = data.permissions.canWrite || data.permissions.canApprove;
  const [body, setBody] = React.useState('');
  const [severity, setSeverity] = React.useState<'info' | 'major'>('info');
  const [paragraphId, setParagraphId] = React.useState<string>('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const comments = [...data.comments].sort((a, b) => Number(a.resolved) - Number(b.resolved));
  const canPostOnVersion = Boolean(data.block.currentVersionId || data.block.submittedVersionId);

  // 通信そのものが失敗しても（接続断・5xx）ボタンを押せないまま止めない。入力したコメントは残す
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await addReviewCommentAction({
        projectId,
        blockId: data.block.id,
        paragraphId: paragraphId || null,
        body,
        severity,
      });
      if (result.status === 'error') {
        setError(result.message);
        return;
      }
      setBody('');
      onAnnounce('コメントを追加しました。');
      router.refresh();
    } catch {
      setError(COMMENT_NETWORK_ERROR_MESSAGE);
      onAnnounce(COMMENT_NETWORK_ERROR_MESSAGE);
    } finally {
      setPending(false);
    }
  };

  const resolve = async (commentId: string) => {
    setPending(true);
    setError(null);
    try {
      const result = await resolveReviewCommentAction({
        projectId,
        blockId: data.block.id,
        commentId,
        note: notes[commentId] ?? '',
      });
      if (result.status === 'error') {
        setError(result.message);
        return;
      }
      onAnnounce('コメントを解決済みにしました。');
      router.refresh();
    } catch {
      setError(COMMENT_NETWORK_ERROR_MESSAGE);
      onAnnounce(COMMENT_NETWORK_ERROR_MESSAGE);
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      {error && (
        <p
          role="alert"
          className="mb-2 rounded-t4d border border-danger/40 bg-danger-soft p-2 text-ink"
        >
          {error}
        </p>
      )}
      {comments.length === 0 ? (
        <p className="text-ink-muted">コメントはありません。</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-t4d border border-line p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={c.resolved ? 'neutral' : c.severity === 'major' ? 'danger' : 'brand'}>
                  {c.resolved ? (
                    <CheckCircle2 className="size-3" aria-hidden="true" />
                  ) : c.severity === 'major' ? (
                    <AlertTriangle className="size-3" aria-hidden="true" />
                  ) : (
                    <MessageSquare className="size-3" aria-hidden="true" />
                  )}
                  {c.severityLabel}
                  {c.resolved ? '・解決済み' : '・未解決'}
                </Badge>
                {c.paragraphId && (
                  <button
                    type="button"
                    onClick={() => onJump(c.paragraphId as string)}
                    className="text-[11px] text-brand-700 underline-offset-2 hover:underline"
                  >
                    {paragraphLabel(c.paragraphId)}
                  </button>
                )}
                <span className="text-[11px] text-ink-muted">
                  版 {c.versionNo ?? '—'} ／ {c.authorName} ／ {formatJst(c.createdAt)}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-ink">{c.body}</p>
              {c.resolved ? (
                <p className="mt-1 text-[11px] text-ink-muted">
                  {c.resolvedByName} が {formatJst(c.resolvedAt)} に解決
                  {c.resolutionNote ? `: ${c.resolutionNote}` : ''}
                </p>
              ) : (
                canComment && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <label htmlFor={`resolve-${c.id}`} className="sr-only">
                      解決のメモ
                    </label>
                    <Input
                      id={`resolve-${c.id}`}
                      value={notes[c.id] ?? ''}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      placeholder="対応内容（任意）"
                      className="h-7 flex-1"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => resolve(c.id)}
                    >
                      解決済みにする
                    </Button>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      {canComment && (
        <form onSubmit={submit} className="mt-3 space-y-1.5 rounded-t4d border border-line p-2">
          <h3 className="text-[12px] font-semibold text-ink">コメントを追加</h3>
          {!canPostOnVersion ? (
            <p className="text-ink-muted">
              版が無い節にはコメントできません。先に版として保存してください。
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="text-[11px] text-ink-muted">
                  対象の段落
                  <select
                    value={paragraphId}
                    onChange={(e) => setParagraphId(e.target.value)}
                    className="mt-0.5 h-7 w-full rounded-t4d border border-line bg-surface px-1 text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    <option value="">節全体</option>
                    {paragraphOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-[11px] text-ink-muted">
                  区分
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value === 'major' ? 'major' : 'info')}
                    className="mt-0.5 h-7 w-full rounded-t4d border border-line bg-surface px-1 text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    <option value="info">参考</option>
                    <option value="major">要対応（解決するまで承認できません）</option>
                  </select>
                </label>
              </div>
              <label htmlFor="new-comment" className="sr-only">
                コメント本文
              </label>
              <Textarea
                id="new-comment"
                rows={3}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
                placeholder="指摘・確認事項を入力"
              />
              <p className="text-[11px] text-ink-muted">
                コメントは、レビュー中は依頼された版、それ以外は現在の版に紐付きます。
              </p>
              <Button type="submit" size="sm" disabled={pending || !body.trim()}>
                コメントする
              </Button>
            </>
          )}
        </form>
      )}
    </div>
  );
}
