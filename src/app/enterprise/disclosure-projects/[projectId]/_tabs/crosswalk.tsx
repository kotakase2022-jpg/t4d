import Link from 'next/link';
import { FileSpreadsheet, GitCompareArrows, Scale, Sparkles } from 'lucide-react';
import { CandidateDecision } from '@/components/shared/candidate-decision';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { PageActions } from '@/components/shared/page-actions';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import { AI_FEEDBACK_REASON_MAX, AI_FEEDBACK_REASON_MAX_DEMO } from '@/lib/ai/feedback';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import {
  filterCrosswalkRows,
  loadCrosswalk,
  loadCrosswalkSuggestion,
  type CrosswalkRow,
  type CrosswalkSide,
  type CrosswalkSuggestion,
} from '@/lib/services/crosswalk';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { statusLabel } from '@/lib/ui/status/registry';
import { CROSSWALK_RELATIONS, type CrosswalkRelation } from '@/types/domain';
import {
  rejectCrosswalkCandidatesAction,
  suggestCrosswalkCandidatesAction,
} from '../requirements/actions';

function isRelation(value: unknown): value is CrosswalkRelation {
  return typeof value === 'string' && (CROSSWALK_RELATIONS as readonly string[]).includes(value);
}

/** 片側の要求事項（コード・題名・区分）。プロジェクトに無い基準・対応先なしは区分を出さない */
function SideCell({ side, projectId }: { side: CrosswalkSide; projectId: string }) {
  if (!side.code) {
    return <span className="text-small text-ink-muted">（対応先なし）</span>;
  }
  return (
    <span className="text-small">
      {side.inProject && side.itemId ? (
        <Link
          href={`/enterprise/disclosure-projects/${projectId}/requirements/${side.itemId}`}
          className="text-brand-800 hover:underline"
        >
          <span className="font-mono">{side.code}</span> {side.title}
        </Link>
      ) : (
        <span>
          <span className="font-mono">{side.code}</span> {side.title}
        </span>
      )}
      <span className="mt-0.5 block">
        {side.category ? (
          <StatusBadge domain="requirementCoverage" value={side.category} />
        ) : (
          <span className="text-caption text-ink-muted">
            {side.inProject ? '—' : 'プロジェクトに無い基準（区分は算定しない）'}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * 開示プロジェクトの「横断対応表」タブ（K3: 要求事項の右。トライアル対応 NF-09）。
 *
 * SSBJ の要求事項と ESRS・ESRS-40a の要求事項の対応（テナント横断のマスター）を、基準ごとの区分（5 区分）・
 * 共通本文（同じ定性情報の版を両側が引用）と並べる。閲覧の画面（主操作なし）。
 *  - 絞り込み: 関係（同等・一部・関連・対応なし）、片側だけ充足（もう一方は追加確認が必要）
 *  - 出力: 要求事項・情報対応表の XLSX（「基準横断」のシートを含む。出力の権限があるときだけ）
 *  - AI の対応候補（NF-11）は「その他」から。候補は「Suslab の確認待ちの候補」として表示するだけで、
 *    横断対応表（マスター）には書かない。採用しない理由は記録できる
 * サンプル（架空の整理）の対応はサンプルと示す（公表資料に基づくものではない）。
 */
export async function CrosswalkTab({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { db, ctx } = await loadEnterpriseShell();
  const view = await loadCrosswalk(db, ctx, { projectId });
  const base = `/enterprise/disclosure-projects/${projectId}`;
  const relation = isRelation(searchParams.relation) ? searchParams.relation : null;
  const side = searchParams.side === 'one_sided' ? 'one_sided' : null;
  const canExport = can(ctx, 'enterprise.export.run');
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const canRunAi = can(ctx, 'enterprise.ai.run') && canWrite;
  const aiPanelOpen = canRunAi && isCreatePanelOpen(searchParams, 'ai');
  const runId = typeof searchParams.run === 'string' ? searchParams.run : null;
  const suggestion: CrosswalkSuggestion | null = runId
    ? await loadCrosswalkSuggestion(db, ctx, { projectId, runId }).catch(() => null)
    : null;

  const hrefFor = (params: { relation?: string | null; side?: string | null }) => {
    const search = new URLSearchParams({ tab: 'crosswalk' });
    const nextRelation = params.relation === undefined ? relation : params.relation;
    const nextSide = params.side === undefined ? side : params.side;
    if (nextRelation) search.set('relation', nextRelation);
    if (nextSide) search.set('side', nextSide);
    return `${base}?${search.toString()}`;
  };
  const panelBase = `${base}`;
  const tabQuery = { ...searchParams, tab: 'crosswalk' };

  if (!view.ssbjFramework) {
    return (
      <EmptyState
        kind="not-applicable"
        icon={<GitCompareArrows className="size-6" aria-hidden="true" />}
        title="SSBJ の基準が無いため、横断対応表はありません"
        description="横断対応表は、SSBJ の要求事項と ESRS・ESRS-40a の要求事項の対応を並べます。基準は「設定」タブで確認できます。"
      />
    );
  }

  const rows = filterCrosswalkRows(view.rows, { relation, side });
  const pageSize = parsePageSize(searchParams.size);
  const page = Math.min(
    parsePage(searchParams.page),
    Math.max(1, Math.ceil(rows.length / pageSize)),
  );
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  const hasSample = view.rows.some((r) => r.sample);
  const counterpartWithItems = view.counterpartFrameworks.filter((f) => f.itemCount > 0);

  const columns: DataTableColumn<CrosswalkRow>[] = [
    {
      key: 'ssbj',
      header: 'SSBJ の要求事項',
      importance: 'primary',
      lockVisible: true,
      width: 'lg',
      cell: (row) => <SideCell side={row.ssbj} projectId={projectId} />,
    },
    {
      key: 'relation',
      header: '関係',
      importance: 'primary',
      cell: (row) => (
        <span className="text-small">
          <StatusBadge domain="crosswalkRelation" value={row.relation} />
          {row.sample && <HonestyBadge kind="sample-master" className="mt-0.5" />}
        </span>
      ),
    },
    {
      key: 'counterpart',
      header: '対応先（基準・要求事項）',
      importance: 'primary',
      width: 'lg',
      cell: (row) => (
        <span className="text-small">
          <span className="block text-caption text-ink-muted">
            {row.counterpart.frameworkLabel}
          </span>
          <SideCell side={row.counterpart} projectId={projectId} />
        </span>
      ),
    },
    {
      key: 'oneSided',
      header: '片側だけ充足',
      importance: 'secondary',
      cell: (row) =>
        row.oneSided ? (
          <Badge tone="warning">
            <Scale className="size-3" aria-hidden="true" />
            片側だけ充足（もう一方は追加確認が必要）
          </Badge>
        ) : (
          <span className="text-small text-ink-muted">—</span>
        ),
    },
    {
      key: 'shared',
      header: '共通本文（定性情報）',
      importance: 'secondary',
      cell: (row) =>
        row.sharedNarratives.length === 0 ? (
          <span className="text-small text-ink-muted">—</span>
        ) : (
          <span className="text-small">
            {row.sharedNarratives.map((n) => (
              <span key={`${n.title}-${n.versionNo}`} className="block">
                {n.title}（版 {n.versionNo}）
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'blocks',
      header: '節',
      importance: 'detail',
      cell: (row) => {
        const blocks = [...row.ssbj.blocks, ...row.counterpart.blocks];
        return blocks.length === 0 ? (
          <span className="text-small text-ink-muted">—（原稿なし）</span>
        ) : (
          <span className="text-small">
            {blocks.map((b) => (
              <Link
                key={b.blockId}
                href={`${base}/blocks/${b.blockId}`}
                className="block text-brand-800 hover:underline"
              >
                {b.title}（{b.statusLabel}）
              </Link>
            ))}
          </span>
        );
      },
    },
    {
      key: 'rationale',
      header: '根拠・説明',
      importance: 'detail',
      width: 'lg',
      cell: (row) => <span className="text-small">{row.rationale || '—'}</span>,
    },
    {
      key: 'source',
      header: '出所',
      importance: 'detail',
      cell: (row) => (
        <span className="text-small text-ink-muted">
          {row.sample ? 'サンプル（架空の整理）' : (row.sourceRef ?? '—')}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-[760px] text-small text-ink">
          SSBJ
          の要求事項と、プロジェクトの他の基準（ESRS・ESRS-40a）の要求事項の対応です。区分は基準ごとに要求事項タブと同じ規則で導きます。
          同じ本文を再利用できても、相手の基準を満たすとは限りません（片側だけ充足の行は、もう一方の追加確認が必要です）。
        </p>
        <PageActions
          secondary={[
            {
              kind: 'link',
              id: 'export-crosswalk-xlsx',
              label: '対応表を出力（XLSX）',
              icon: <FileSpreadsheet aria-hidden="true" />,
              href: `/api/exports/requirement-matrix?project=${projectId}&format=xlsx`,
              download: true,
              hidden: !canExport,
            },
          ]}
          more={[
            {
              // インパクト・リスク・機会の台帳（T8 の画面。plan 付録 D の入口）
              kind: 'link',
              id: 'open-impact-ledger',
              label: 'インパクト・リスク・機会の台帳を開く',
              href: '/enterprise/disclosures/impacts',
            },
            {
              kind: 'link',
              id: 'crosswalk-ai-candidates',
              label: 'AI に対応候補を出させる…',
              icon: <Sparkles aria-hidden="true" />,
              href: `${createPanelHref(panelBase, tabQuery, { open: true, openParam: 'ai' })}#crosswalk-ai`,
              hidden: !canRunAi || aiPanelOpen,
              group: 'advanced',
            },
          ]}
        />
      </div>

      {/* 誠実さの注記は折りたたまない */}
      {hasSample && (
        <p className="flex flex-wrap items-center gap-1.5 text-small text-ink">
          <HonestyBadge kind="sample-master" />
          対応はトライアル用の架空の整理です。公表資料に基づくものではありません（ESRS-40a
          の要求事項もサンプルで、条文ではありません）。
        </p>
      )}

      {canRunAi && (
        <CreatePanel
          id="crosswalk-ai"
          title="AI に対応候補を出させる"
          openParam="ai"
          searchParams={tabQuery}
          closeHref={createPanelHref(panelBase, tabQuery, { open: false, openParam: 'ai' })}
          description="選んだ SSBJ の要求事項について、プロジェクトの他の基準の要求事項から対応の候補を出します。候補は表示するだけで、横断対応表には書きません。"
        >
          {counterpartWithItems.length === 0 ? (
            <p className="text-small text-ink-muted">
              要求事項が収録された対応先の基準がありません（候補を出せません）。
            </p>
          ) : (
            <form action={suggestCrosswalkCandidatesAction} className="space-y-2">
              <input type="hidden" name="projectId" value={projectId} />
              {counterpartWithItems.map((f) => (
                <input
                  key={f.version.id}
                  type="hidden"
                  name="frameworkVersionId"
                  value={f.version.id}
                />
              ))}
              <Field label="SSBJ の要求事項" id="crosswalk-ai-item" required>
                {(control) => (
                  <NativeSelect
                    {...control}
                    name="itemId"
                    defaultValue={view.rows[0]?.ssbj.itemId ?? ''}
                  >
                    {[...new Map(view.rows.map((r) => [r.ssbj.itemId, r.ssbj])).values()].map(
                      (s) => (
                        <option key={s.itemId ?? ''} value={s.itemId ?? ''}>
                          {s.code} {s.title}
                        </option>
                      ),
                    )}
                  </NativeSelect>
                )}
              </Field>
              <SubmitButton
                variant="primary"
                size="sm"
                icon={<Sparkles aria-hidden="true" />}
                pendingLabel="候補を作っています…"
              >
                候補を出させる
              </SubmitButton>
            </form>
          )}
        </CreatePanel>
      )}

      {suggestion && (
        <section
          aria-labelledby="crosswalk-suggestion-title"
          className="space-y-2 rounded-t4d border border-line bg-surface p-3"
        >
          <h2 id="crosswalk-suggestion-title" className="text-body font-semibold text-ink">
            {suggestion.source.code} の対応候補（Suslab の確認待ちの候補・表示のみ）
          </h2>
          <p className="text-caption text-ink-muted">
            AI
            の候補は横断対応表に書きません。対応の採用は、提供者（Suslab）が公表資料で確認してからマスターに登録します。
          </p>
          <CandidateDecision
            candidate={{
              summary:
                suggestion.candidates.length === 0 ? (
                  <span>対応しうる要求事項は見つかりませんでした。</span>
                ) : (
                  <ul className="space-y-1">
                    {suggestion.candidates.map((c) => (
                      <li key={c.itemId} className="flex flex-wrap items-center gap-1.5">
                        {c.relation && (
                          <StatusBadge domain="crosswalkRelation" value={c.relation} />
                        )}
                        <span className="font-mono">{c.code}</span>
                        <span>{c.title}</span>
                        <span className="text-caption text-ink-muted">
                          {c.frameworkLabel}・{c.rationale}
                        </span>
                      </li>
                    ))}
                    {suggestion.warnings.map((w) => (
                      <li key={w} className="text-caption text-ink-muted">
                        {w}
                      </li>
                    ))}
                  </ul>
                ),
              source: suggestion.run.provider,
              createdAt: suggestion.run.createdAt,
              confidence: suggestion.run.confidence,
            }}
            reject={
              suggestion.decided
                ? undefined
                : {
                    action: rejectCrosswalkCandidatesAction,
                    fields: { projectId, runId: suggestion.run.id },
                  }
            }
            rejectReasonMaxLength={ctx.demo ? AI_FEEDBACK_REASON_MAX_DEMO : AI_FEEDBACK_REASON_MAX}
            canWrite={canWrite}
            canRunAi={canRunAi}
            labels={{ reject: '候補を採用しない' }}
          />
          {suggestion.decided && (
            <p className="text-caption text-ink-muted">この候補は採否を記録済みです。</p>
          )}
        </section>
      )}

      <SegmentedFilter
        ariaLabel="関係の絞り込み"
        current={relation ?? 'all'}
        items={[
          {
            key: 'all',
            label: '関係: すべて',
            href: hrefFor({ relation: null }),
            count: view.rows.length,
          },
          ...CROSSWALK_RELATIONS.map((key) => ({
            key,
            label: statusLabel('crosswalkRelation', key),
            href: hrefFor({ relation: key }),
            count: view.relationCounts[key],
          })),
        ]}
      />
      <SegmentedFilter
        ariaLabel="充足の絞り込み"
        current={side ?? 'all'}
        items={[
          { key: 'all', label: '充足: すべて', href: hrefFor({ side: null }) },
          {
            key: 'one_sided',
            label: '片側だけ充足',
            href: hrefFor({ side: 'one_sided' }),
            count: view.oneSidedCount,
          },
        ]}
      />

      {view.rows.length === 0 ? (
        <EmptyState
          kind="not-applicable"
          size="compact"
          icon={<GitCompareArrows className="size-6" aria-hidden="true" />}
          title="横断対応はまだ登録されていません"
          description="対応は提供者が公表資料で確認して登録します（顧客の画面からは書き換えません）。"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          kind="filtered"
          size="compact"
          title="絞り込みに当たる対応はありません"
          resetHref={hrefFor({ relation: null, side: null })}
        />
      ) : (
        <DataTable
          id="project-crosswalk"
          caption={`横断対応表（${rows.length} 件）`}
          columns={columns}
          rows={pageRows}
          getRowId={(row) => row.id}
          getRowLabel={(row) => `${row.ssbj.code ?? ''} → ${row.counterpart.code ?? '対応なし'}`}
          getRowStatus={(row) => row.relation}
          searchParams={searchParams}
          basePath={base}
          search={false}
          page={{ page, pageSize, total: rows.length, sizes: DEFAULT_PAGE_SIZES }}
          className="rounded-t4d-lg border border-line bg-surface"
          rowActions={(row) =>
            row.ssbj.itemId
              ? {
                  rowLabel: `${row.ssbj.code ?? ''} → ${row.counterpart.code ?? '対応なし'}`,
                  primary: {
                    kind: 'link',
                    id: `crosswalk-detail-${row.id}`,
                    label: 'SSBJ 側の詳細',
                    href: `${base}/requirements/${row.ssbj.itemId}`,
                  },
                  items:
                    row.counterpart.inProject && row.counterpart.itemId
                      ? [
                          {
                            kind: 'link',
                            id: `crosswalk-counterpart-${row.id}`,
                            label: '対応先の詳細を開く',
                            href: `${base}/requirements/${row.counterpart.itemId}`,
                          },
                        ]
                      : [],
                }
              : null
          }
          empty={{
            noData: {
              title: '横断対応はまだ登録されていません',
              action: (
                <Link
                  href={`${base}?tab=requirements`}
                  className="text-small text-brand-800 underline"
                >
                  要求事項タブを開く
                </Link>
              ),
            },
          }}
        />
      )}
    </div>
  );
}
