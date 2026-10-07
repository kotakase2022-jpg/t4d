import Link from 'next/link';
import { ArrowLeft, GitCompare, Target } from 'lucide-react';
import { AttentionStrip } from '@/components/shared/attention-strip';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { MoreInfo } from '@/components/ui/more-info';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { cn } from '@/lib/utils';
import {
  KPI_KEYS,
  KPI_SPECS,
  loadEsgDashboard,
  loadKpiSnapshotComparison,
  type KpiSnapshotComparison,
} from '@/lib/services/kpi';
import { listOrganizationSnapshots, SNAPSHOT_KIND_DISPLAY } from '@/lib/services/report-snapshot';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { can, NotFoundError } from '@/lib/authorization/can';
import { EsgKpiTile, signed } from './kpi-card';

export const metadata = { title: 'ESG 経営' };

/**
 * ESG 経営ダッシュボード（指示書 §6.11）。
 *
 * - 最新承認値モード: 開示業務で承認された値だけで KPI を示す（別のデータコピーを作らない）。
 * - スナップショット照合モード: 選んだレポートのスナップショットが引用した版の値と、
 *   最新承認値との差・更新理由を並べる。最新値が過去のレポートを変えたようには見せない。
 *
 * plan §2 S24: 年度はヘッダーの報告期間が既定（D1）。画面の中の年度の切替は「比較年度」としてだけ残す。
 * 先頭に注意（目標が未登録・比較条件の確認が必要・集計中）→ KPI のタイル。照合は頻度が低いので
 * 見出しの「その他」から入る（L2）。目標が未登録の KPI には、その場で「目標を登録」を出す（指標の管理の権限）。
 */

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function SnapshotComparisonView({ comparison }: { comparison: KpiSnapshotComparison }) {
  const { snapshot } = comparison;
  return (
    <div className="space-y-3">
      <div
        role="note"
        className="rounded-t4d border border-brand-200 bg-brand-50 px-3 py-2 text-small text-brand-900"
      >
        <p className="font-medium">
          照合中: {snapshot.projectName} ／ {snapshot.kindLabel} No.{snapshot.snapshotNo}（作成{' '}
          {formatJst(snapshot.createdAt)}・内容ハッシュ {snapshot.contentHash.slice(0, 12)}）
        </p>
        <MoreInfo label="照合の見方" className="mt-0.5">
          <p>
            左はスナップショットに固定した版の値です。最新承認値と違う場合は、更新理由とともに並べます。最新の値が変わっても、このスナップショットと、そこから出力したレポートの値は変わりません。
          </p>
        </MoreInfo>
      </div>
      {KPI_KEYS.map((key) => {
        const rows = comparison.rows[key];
        return (
          <Section key={key} title={KPI_SPECS[key].label}>
            {rows.length === 0 ? (
              <p className="py-1 text-small text-ink-muted">
                このスナップショットは、この KPI の指標を引用していません。
              </p>
            ) : (
              <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
                <Table>
                  <THead>
                    <TR>
                      <TH>指標・組織・期間</TH>
                      <TH align="right">スナップショットの値（版）</TH>
                      <TH align="right">最新承認値（版）</TH>
                      <TH align="right">差</TH>
                      <TH>更新理由</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((row) => {
                      return (
                        <TR key={`${row.dataPointId}-${row.snapshotVersionNo}`}>
                          <TD className="text-small">
                            {row.metricName}
                            <span className="block text-caption text-ink-muted">
                              {row.unitName}・{row.periodCode}
                            </span>
                          </TD>
                          <TD align="right" className="text-small">
                            {formatNumber(row.snapshotValue)} {row.unitOfMeasure}
                            <span className="block text-caption text-ink-muted">
                              版 {row.snapshotVersionNo}
                            </span>
                          </TD>
                          <TD align="right" className="text-small">
                            {row.latestApproved ? (
                              <>
                                {formatNumber(row.latestApproved.value)}{' '}
                                {row.latestApproved.unitOfMeasure}
                                <span className="block text-caption text-ink-muted">
                                  版 {row.latestApproved.versionNo}
                                </span>
                              </>
                            ) : (
                              <span className="text-ink-muted">承認済みの版なし</span>
                            )}
                          </TD>
                          <TD align="right" className="text-small">
                            {!row.differs ? (
                              <span className="text-ink-muted">同じ版</span>
                            ) : row.unitMismatch ? (
                              <span className="text-ink-muted">単位が異なるため差を出しません</span>
                            ) : row.diff === null ? (
                              '—'
                            ) : row.diff === 0 ? (
                              '値は同じ（版が異なる）'
                            ) : (
                              `${signed(row.diff)} ${row.diffUnit ?? ''}`.trim()
                            )}
                          </TD>
                          <TD className="text-small">
                            {row.reasons.length > 0 ? (
                              <ul className="list-disc pl-4">
                                {row.reasons.map((reason) => (
                                  <li key={reason}>{reason}</li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-ink-muted">—</span>
                            )}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            )}
          </Section>
        );
      })}
    </div>
  );
}

export default async function EsgPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  // スナップショット（開示プロジェクト名・版）は開示の情報。開示の閲覧権限が無い人には照合モードを出さない
  const canCompareSnapshots = can(ctx, 'enterprise.disclosure.read');
  const canManageTargets = can(ctx, 'enterprise.metric.manage');
  const mode =
    one(query.mode) === 'snapshot' && canCompareSnapshots ? 'snapshot' : ('latest' as const);

  // 照合モードでは KPI の計算は要らない（スナップショットの値と最新承認値の比較だけ）
  const dashboard =
    mode === 'latest'
      ? await loadEsgDashboard(db, ctx, { periodId: one(query.period) ?? shell.currentPeriod.id })
      : null;
  const snapshotOptions = mode === 'snapshot' ? await listOrganizationSnapshots(db, ctx) : [];
  const selectedSnapshotId = one(query.snapshot) ?? snapshotOptions[0]?.id ?? null;
  let comparison: KpiSnapshotComparison | null = null;
  let comparisonMissing = false;
  if (mode === 'snapshot' && selectedSnapshotId) {
    try {
      comparison = await loadKpiSnapshotComparison(db, ctx, selectedSnapshotId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      comparisonMissing = true;
    }
  }

  // 注意（放置すると数値を読み違える事実）。0 件の項目は出さない（AttentionStrip が省く）
  const cards = dashboard?.cards ?? [];
  const noTarget = cards.filter((c) => !c.target);
  const needsCheck = cards.filter(
    (c) =>
      c.yoy.status === 'needs_check' ||
      (c.progress.status !== 'ok' && c.progress.code === 'not_comparable'),
  );
  const aggregating = cards.filter(
    (c) =>
      c.current &&
      c.current.computable &&
      !c.current.complete &&
      c.current.period.id !== c.confirmed?.period.id,
  );
  const anchor = (list: typeof cards) => (list[0] ? `#kpi-${list[0].spec.key}` : '#');

  return (
    <>
      <PageHeader
        title="ESG 経営"
        description="開示業務で承認した数値で計算した KPI"
        help={
          <>
            <p>
              KPI
              用のデータの写しは作らず、開示業務で承認した数値をそのまま使います。年度は画面上部の報告期間が既定で、ほかの年度と比べるときは「比較年度」で切り替えます。
            </p>
            <p>
              「スナップショットと照合」（その他）では、レポートに固定した値と最新承認値の差と更新理由を並べます（過去のレポートの値は変わりません）。
            </p>
          </>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'targets',
                label: '目標の登録・改訂',
                icon: <Target aria-hidden="true" />,
                href: '/enterprise/esg/targets',
              },
            ]}
            more={[
              {
                kind: 'link',
                id: 'snapshot-compare',
                label: 'スナップショットと照合',
                icon: <GitCompare aria-hidden="true" />,
                href: '/enterprise/esg?mode=snapshot',
                hidden: !canCompareSnapshots || mode === 'snapshot',
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        {dashboard ? (
          <>
            <AttentionStrip
              label="確認が必要な KPI"
              items={[
                {
                  key: 'no-target',
                  label: '目標が未登録',
                  count: noTarget.length,
                  href: anchor(noTarget),
                  semantic: 'todo',
                },
                {
                  key: 'needs-check',
                  label: '比較条件の確認が必要',
                  count: needsCheck.length,
                  href: anchor(needsCheck),
                  semantic: 'blocked',
                },
                {
                  key: 'aggregating',
                  label: '集計中（承認済み分のみ）',
                  count: aggregating.length,
                  href: anchor(aggregating),
                  semantic: 'pending',
                },
              ]}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <nav aria-label="比較年度" className="flex flex-wrap items-center gap-1 text-small">
                <span className="text-ink-muted">比較年度:</span>
                {[...dashboard.periods].reverse().map((period) => (
                  <Link
                    key={period.id}
                    href={`/enterprise/esg?period=${period.id}`}
                    aria-current={period.id === dashboard.selectedPeriod.id ? 'page' : undefined}
                    className={cn(
                      'rounded-t4d border px-2 py-0.5',
                      period.id === dashboard.selectedPeriod.id
                        ? 'border-brand-600 bg-brand-100 text-brand-900'
                        : 'border-line bg-surface hover:bg-brand-50',
                    )}
                  >
                    {period.code}
                  </Link>
                ))}
              </nav>
              <MoreInfo label="実績・進捗率・前年差の数え方">
                <p>
                  実績は、対象の全拠点が承認済みの最新年度の値です（GHG
                  画面と同じ連結値）。未承認の値・承認後の訂正で未承認の値は含めず、集計中の年度は承認済み分の途中集計として別に示します。進捗率・前年差は、目標・前年と範囲や算定方法が同じときだけ計算します。
                </p>
              </MoreInfo>
            </div>
            <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {dashboard.cards.map((card) => (
                <EsgKpiTile
                  key={card.spec.key}
                  card={card}
                  detailHref={`/enterprise/esg/${card.spec.key}?period=${dashboard.selectedPeriod.id}`}
                  registerTargetHref={
                    canManageTargets && card.metric
                      ? `/enterprise/esg/targets?new=1&metric=${card.metric.id}#target-form`
                      : undefined
                  }
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-body font-semibold text-ink">スナップショットと照合</h2>
              <Link
                href={`/enterprise/esg?period=${shell.currentPeriod.id}`}
                className="inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                最新承認値の KPI に戻る
              </Link>
            </div>
            {snapshotOptions.length > 0 && (
              <form
                method="get"
                action="/enterprise/esg"
                className="flex flex-wrap items-end gap-1.5"
              >
                <input type="hidden" name="mode" value="snapshot" />
                <label className="text-small text-ink-muted">
                  照合するスナップショット
                  <NativeSelect
                    name="snapshot"
                    defaultValue={selectedSnapshotId ?? ''}
                    className="mt-0.5 max-w-[420px]"
                  >
                    {snapshotOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {`${option.projectName} ／ ${SNAPSHOT_KIND_DISPLAY[option.snapshotKind]} No.${option.snapshotNo}（${formatJst(option.createdAt)}）`}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <SubmitButton
                  size="sm"
                  variant="secondary"
                  icon={<GitCompare aria-hidden="true" />}
                >
                  照合する
                </SubmitButton>
              </form>
            )}
            {snapshotOptions.length === 0 ? (
              <EmptyState
                kind="no-data"
                title="照合できるスナップショットがありません"
                description="開示プロジェクトの「出力」タブでレビュー用草稿または社内承認済み版を作成すると、ここで照合できます。"
                action={
                  <Link
                    href="/enterprise/disclosure-projects"
                    className="text-small text-brand-700 underline underline-offset-2"
                  >
                    開示プロジェクトを開く
                  </Link>
                }
              />
            ) : comparisonMissing || !comparison ? (
              <p
                role="alert"
                className="rounded-t4d border border-warning/40 bg-warning-soft px-3 py-2 text-small text-ink"
              >
                選んだスナップショットが見つかりません（デモではスナップショットをこのブラウザの
                Cookie
                で持ち回すため、別のブラウザや、古い操作が押し出された後は消えている場合があります）。
              </p>
            ) : (
              <SnapshotComparisonView comparison={comparison} />
            )}
          </>
        )}
      </div>
    </>
  );
}
