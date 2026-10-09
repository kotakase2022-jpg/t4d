import Link from 'next/link';
import { AlertTriangle, FileText, Link2, Plus, Scale, Sparkles, Unlink } from 'lucide-react';
import { CandidateDecision } from '@/components/shared/candidate-decision';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  DRAFT_STANDARD_CAP_NOTE,
  REQUIREMENT_COVERAGE_CATEGORIES,
} from '@/lib/domain/requirement-coverage';
import type { ContentCoverage } from '@/lib/services/content-coverage';
import type {
  LinkableRequirementGroup,
  NarrativeMappingCandidates,
} from '@/lib/services/narrative-requirement-links';
import type { ServerAction } from '@/lib/ui/actions';

/**
 * 定性情報の「基準別の対応状況」（トライアル対応 NF-06。スライド 5「共通本文・根拠と基準別の対応状況」）。
 *
 * - L1: 基準ごとの 5 区分の件数（分母付き）と、定性情報そのものの不足。公開草案・サンプルの基準は
 *   「充足確認済み」にならない旨を出す（誠実さの注記。折りたたまない）
 * - L2: 要求事項の行（コード・区分・不足・節へのリンク）は折りたたみ。直接の対応付けの追加も折りたたみ
 * - AI の候補（NF-11）は CandidateDecision。候補であることは常に見せ、採用は人
 * 区分は要求事項タブと同じ関数で導いた値（ここで計算し直さない）。
 */
export function CoveragePanel({
  narrativeId,
  coverage,
  linkable,
  candidates,
  candidateDecidedBy,
  canWrite,
  canRunAi,
  actions,
}: {
  narrativeId: string;
  coverage: ContentCoverage;
  linkable: LinkableRequirementGroup[];
  candidates: NarrativeMappingCandidates | null;
  candidateDecidedBy: string | null;
  canWrite: boolean;
  canRunAi: boolean;
  actions: {
    add: ServerAction;
    remove: ServerAction;
    suggest: ServerAction;
    adopt: ServerAction;
    reject: ServerAction;
  };
}) {
  const selectable = candidates?.candidates.filter((c) => !c.alreadyLinked) ?? [];
  return (
    <div id="nv-coverage" className="scroll-mt-4 space-y-2" data-coverage-panel="">
      {coverage.narrativeGaps.length > 0 && (
        <p className="flex items-start gap-1 text-caption text-warning-ink">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          この定性情報の不足: {coverage.narrativeGaps.join('・')}
        </p>
      )}

      {coverage.groups.length === 0 ? (
        <EmptyState
          kind="no-data"
          size="compact"
          title="要求事項との対応はまだありません"
          description={
            coverage.projects.length === 0
              ? 'この定性情報の年度の開示プロジェクトがありません。プロジェクトを作ると、基準ごとの対応状況がここに出ます。'
              : '原稿の節でこの定性情報を引用するか、下の「要求事項を直接対応付ける」から結ぶと、基準ごとの区分と不足がここに出ます。'
          }
          action={
            <Link
              href="/enterprise/disclosure-projects"
              className="text-small text-brand-700 hover:underline"
            >
              開示プロジェクトを開く
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2">
          {coverage.groups.map((group) => (
            <li
              key={group.key}
              className="space-y-1 rounded-t4d border border-line px-2 py-1.5"
              data-coverage-group={group.frameworkKey}
            >
              <p className="flex flex-wrap items-center gap-1.5 text-small">
                <span className="font-semibold text-ink">{group.shortLabel}</span>
                <span className="text-caption text-ink-muted">
                  {group.frameworkLabel}（{group.projectName}）
                </span>
                {group.isSample ? (
                  <HonestyBadge kind="sample-master" />
                ) : (
                  <Badge tone="neutral">
                    <Scale className="size-3" aria-hidden="true" />
                    {group.positioning}
                  </Badge>
                )}
              </p>
              <p className="flex flex-wrap items-center gap-1.5 text-small">
                <span className="text-caption text-ink-muted">要求事項 {group.total} 件:</span>
                {REQUIREMENT_COVERAGE_CATEGORIES.filter((c) => group.counts[c] > 0).map((c) => (
                  <span key={c} className="inline-flex items-center gap-0.5">
                    <StatusBadge domain="requirementCoverage" value={c} />
                    <span className="text-caption">{group.counts[c]} 件</span>
                  </span>
                ))}
              </p>
              {group.isPreparationOnly && (
                <p className="text-caption text-ink-muted">
                  {DRAFT_STANDARD_CAP_NOTE}:
                  公開草案・サンプルの基準は「充足確認済み」になりません。
                </p>
              )}
              <Collapsible variant="plain" summary={`要求事項の行（${group.total} 件）`}>
                <Table>
                  <THead>
                    <TR>
                      <TH>要求事項</TH>
                      <TH>区分</TH>
                      <TH>不足</TH>
                      <TH>対応の経路</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {group.rows.map((row) => (
                      <TR key={row.itemId} data-coverage-row={row.code}>
                        <TD className="text-small">
                          <Link
                            href={row.requirementHref}
                            className="text-brand-800 hover:underline"
                          >
                            {row.code}
                          </Link>
                          <span className="block text-caption text-ink-muted">{row.title}</span>
                        </TD>
                        <TD>
                          <StatusBadge
                            domain="requirementCoverage"
                            value={row.category}
                            detail={row.reasons.join(' ')}
                          />
                        </TD>
                        <TD className="text-caption">
                          {row.gapLabels.length > 0 ? row.gapLabels.join('・') : '—'}
                        </TD>
                        <TD className="text-caption">
                          <ul className="space-y-0.5">
                            {row.blocks.map((b) => (
                              <li key={b.id} className="flex items-center gap-1">
                                <FileText className="size-3 shrink-0" aria-hidden="true" />
                                <Link
                                  href={`/enterprise/disclosure-projects/${group.projectId}/blocks/${b.id}`}
                                  className="text-brand-800 hover:underline"
                                >
                                  {b.title}
                                </Link>
                                <span className="text-ink-muted">（{b.statusLabel}）</span>
                              </li>
                            ))}
                            {row.linkId && (
                              <li className="flex flex-wrap items-center gap-1">
                                <Link2 className="size-3 shrink-0" aria-hidden="true" />
                                直接の対応付け
                                {canWrite && (
                                  <form action={actions.remove}>
                                    <input type="hidden" name="narrativeId" value={narrativeId} />
                                    <input type="hidden" name="linkId" value={row.linkId} />
                                    <SubmitButton
                                      variant="ghost"
                                      size="xs"
                                      icon={<Unlink aria-hidden="true" />}
                                      aria-label={`${row.code} との直接の対応付けを外す`}
                                      pendingLabel="外しています…"
                                    >
                                      外す
                                    </SubmitButton>
                                  </form>
                                )}
                              </li>
                            )}
                          </ul>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Collapsible>
            </li>
          ))}
        </ul>
      )}

      {canWrite && linkable.length > 0 && (
        <Collapsible variant="plain" summary="要求事項を直接対応付ける（原稿が無くても不足を出す）">
          <form action={actions.add} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="narrativeId" value={narrativeId} />
            <label className="min-w-0 flex-1 space-y-0.5 text-caption text-ink">
              <span className="block">要求事項（必須）</span>
              <NativeSelect name="itemId" required defaultValue="" className="w-full">
                <option value="" disabled>
                  選択してください
                </option>
                {linkable.map((group) => (
                  <optgroup
                    key={group.frameworkVersionId}
                    label={`${group.shortLabel}: ${group.label}${group.isSample ? '（サンプル・架空）' : ''}`}
                  >
                    {group.items
                      .filter((item) => !item.linked)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.code} {item.title}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </label>
            <SubmitButton
              variant="secondary"
              size="sm"
              icon={<Plus aria-hidden="true" />}
              pendingLabel="追加中…"
            >
              対応付けを追加
            </SubmitButton>
          </form>
        </Collapsible>
      )}

      {canWrite && (canRunAi || candidates) && (
        <section aria-labelledby="nv-coverage-ai" className="space-y-1">
          <h3
            id="nv-coverage-ai"
            className="flex items-center gap-1 text-small font-semibold text-ink"
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            AI の対応付けの候補
          </h3>
          <CandidateDecision
            canWrite={canWrite}
            canRunAi={canRunAi}
            candidate={
              candidates && !candidates.decided
                ? {
                    source: candidates.run.provider,
                    createdAt: candidates.run.createdAt,
                    confidence: candidates.run.confidence,
                    summary: (
                      <div className="space-y-1">
                        {candidates.candidates.length === 0 ? (
                          <p>対応しうる要求事項の候補はありませんでした。</p>
                        ) : (
                          <ul className="space-y-0.5">
                            {candidates.candidates.map((c) => (
                              <li key={c.itemId}>
                                <span className="font-medium">
                                  {c.frameworkShortLabel} {c.code}
                                </span>{' '}
                                {c.title}
                                {c.alreadyLinked && (
                                  <span className="text-caption text-ink-muted">
                                    （対応付け済み）
                                  </span>
                                )}
                                <span className="block text-caption text-ink-muted">
                                  {c.rationale}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {candidates.warnings.map((w) => (
                          <p key={w} className="text-caption text-warning-ink">
                            {w}
                          </p>
                        ))}
                      </div>
                    ),
                  }
                : undefined
            }
            decided={
              candidates?.decided
                ? {
                    by: candidateDecidedBy ?? '—',
                    at:
                      candidates.run.acceptedAt ??
                      candidates.run.rejectedAt ??
                      candidates.run.createdAt,
                    summary:
                      candidates.decided === 'accepted'
                        ? 'AI の候補から選んだ要求事項を対応付けました。'
                        : 'AI の候補を採用しませんでした。',
                  }
                : undefined
            }
            afterDecision={
              canRunAi ? (
                <form action={actions.suggest}>
                  <input type="hidden" name="narrativeId" value={narrativeId} />
                  <SubmitButton
                    variant="secondary"
                    size="xs"
                    icon={<Sparkles aria-hidden="true" />}
                    pendingLabel="候補を作成中…"
                  >
                    もう一度候補を出す
                  </SubmitButton>
                </form>
              ) : undefined
            }
            adopt={
              candidates && selectable.length > 0
                ? { action: actions.adopt, fields: { narrativeId, runId: candidates.run.id } }
                : undefined
            }
            adoptFields={
              selectable.length > 0 ? (
                <fieldset className="space-y-0.5">
                  <legend className="text-caption text-ink">
                    採用する要求事項（必要なものだけ）
                  </legend>
                  {selectable.map((c) => (
                    <NativeCheckbox
                      key={c.itemId}
                      name="itemId"
                      value={c.itemId}
                      defaultChecked
                      className="flex"
                      label={`${c.frameworkShortLabel} ${c.code} ${c.title}`}
                    />
                  ))}
                </fieldset>
              ) : undefined
            }
            reject={
              candidates
                ? { action: actions.reject, fields: { narrativeId, runId: candidates.run.id } }
                : undefined
            }
            run={{ action: actions.suggest, fields: { narrativeId } }}
            labels={{
              adopt: '選んだ候補を採用して対応付ける',
              reject: '採用しない',
              run: 'AI に候補を出させる',
            }}
          />
        </section>
      )}
    </div>
  );
}
