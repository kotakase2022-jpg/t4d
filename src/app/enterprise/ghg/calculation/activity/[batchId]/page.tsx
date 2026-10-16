import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, Trash2 } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { GhgNotice, LoadFactorNotice } from '@/components/shared/ghg-notices';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { StepNav } from '@/components/shared/step-nav';
import { MoreInfo } from '@/components/ui/more-info';
import { NotFoundError } from '@/lib/authorization/can';
import { ACTIVITY_CODE_LABELS, GHG_SCOPE_LABELS, activityLabel } from '@/lib/domain/ghg/calculate';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { activityBatchWriteReason, loadActivityBatch } from '@/lib/services/ghg/activity-import';
import { loadGhgVerificationStatus } from '@/lib/services/ghg/status';
import {
  previewTransportCalculation,
  trialWarningLabel,
  type LineTrial,
} from '@/lib/services/ghg/transport-preview';
import { parsePage, parsePageSize } from '@/lib/table/columns';
import { isUuid } from '@/lib/validation/uuid';
import { GHG_SCOPES, type GhgActivityLine } from '@/types/domain';
import { loadCalcContext } from '../../_components/calc-context';
import { CalcNav, calcTabHref } from '../../_components/calc-nav';
import { confirmActivityBatchAction, discardActivityBatchAction } from '../actions';
import { TrialSteps } from '../_components/trial-steps';
import {
  BATCH_KIND_LABELS,
  carrierKindLabel,
  economyClassLabel,
  monthLabel,
  vehicleUseLabel,
} from '../_lib/labels';

export const metadata = { title: '活動量の取込の詳細' };

type Params = Record<string, string | string[] | undefined>;

interface LineRow {
  line: GhgActivityLine;
  trial: LineTrial | undefined;
}

const PAGE_SIZES = [50, 100, 200] as const;

/**
 * 活動量の取込の詳細（P95。plan §2.4・CR-05・CR-06）: バッチの行と試算。
 *
 * primary は「確定する」（確認中のときだけ。確認ダイアログ・区分 2 一括。件数と警告の内訳を出す）。
 * 破棄は「その他」（区分 1 取り消せない）。輸送の行は展開行で t·km → 原単位（式／見なし表・積載率の出所）
 * → 燃料 L → CO2 の段を出す。試算は算定の記録ではない（固定の注記を折りたたみの外に置く）。
 */
export default async function GhgActivityBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<Params>;
}) {
  const { batchId } = await params;
  const query = await searchParams;
  if (!isUuid(batchId)) notFound();
  const context = await loadCalcContext(query);
  const { shell } = context;
  const { db, ctx } = shell;
  const [detail, preview] = await Promise.all([
    loadActivityBatch(db, ctx, batchId),
    previewTransportCalculation(db, ctx, batchId),
  ]).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const { batch, unit, period, lines } = detail;
  const { trial } = preview;
  const attention =
    period.id === context.period.id
      ? context.status.attention
      : (
          await loadGhgVerificationStatus(db, ctx, {
            periodId: period.id,
            unitIds: context.unitIds,
          })
        ).attention;
  const demo = ctx.demo;
  const transport = batch.kind === 'transport';
  const basePath = `/enterprise/ghg/calculation/activity/${encodeURIComponent(batch.id)}`;
  const writeReason = activityBatchWriteReason(ctx, batch);
  const closed = period.status === 'closed';
  const canWrite = batch.status === 'draft' && writeReason === null;
  const scope = `${unit.name}（${unit.code}）・${BATCH_KIND_LABELS[batch.kind]}・${batch.rowCount} 行（${batch.fileName}）`;
  const trialById = new Map(trial.lines.map((t) => [t.activityLineId, t]));
  const counts = trial.counts;

  // 行の絞り込み・ページ送り（サーバー側）
  const only = typeof query.only === 'string' ? query.only : null;
  const rows: LineRow[] = lines
    .map((line) => ({ line, trial: trialById.get(line.id) }))
    .filter((row) => {
      if (only === 'warnings') return (row.trial?.results ?? []).some((r) => r.warnings.length > 0);
      if (only === 'errors') return Boolean(row.trial?.error);
      return true;
    });
  const pageSize = parsePageSize(query.size, PAGE_SIZES);
  const page = parsePage(query.page);
  const paged = rows.slice((page - 1) * pageSize, page * pageSize);

  const breakdown = [
    `行 ${batch.rowCount}`,
    `試算できない ${counts.errors}`,
    ...(transport
      ? [
          `見なし積載率 ${counts.defaultLoad}`,
          `下限を適用 ${counts.floored}`,
          `最大積載量が範囲外 ${counts.payloadOutOfRange}`,
          `海外拠点の輸送 ${counts.overseas}`,
        ]
      : []),
  ];

  const trialCell = (row: LineRow, basis: 'location' | 'market' | null = null) => {
    if (!row.trial || row.trial.error)
      return <SemanticBadge semantic="error" label="試算できません" />;
    const result =
      basis === null ? row.trial.results[0] : row.trial.results.find((r) => r.basis === basis);
    return (
      <span className="tnum text-small">
        {result ? formatNumber(result.emissionsT, { fraction: 6 }) : '—'}
      </span>
    );
  };

  const notesCell = (row: LineRow) => {
    if (row.trial?.error) {
      return <SemanticBadge semantic="error" label="試算できません" detail={row.trial.error} />;
    }
    const warnings = [...new Set((row.trial?.results ?? []).flatMap((r) => r.warnings))];
    if (warnings.length === 0) return <span className="text-caption text-ink-muted">—</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {warnings.map((w) => (
          <SemanticBadge key={w} semantic="blocked" label={trialWarningLabel(w)} />
        ))}
      </span>
    );
  };

  const firstTransport = (row: LineRow) => row.trial?.results.find((r) => r.transport)?.transport;

  const columns: DataTableColumn<LineRow>[] = [
    {
      key: 'lineNo',
      header: '行',
      importance: 'primary',
      lockVisible: true,
      align: 'right',
      cell: (r) => <span className="tnum text-small">{r.line.lineNo}</span>,
    },
    {
      key: 'month',
      header: '月',
      importance: 'primary',
      cell: (r) => <span className="tnum text-small">{monthLabel(r.line.month)}</span>,
    },
    ...(transport
      ? ([
          {
            key: 'shipment',
            header: '出荷番号',
            importance: 'primary',
            cell: (r) => <span className="text-caption">{r.line.shipmentRef ?? '—'}</span>,
          },
          {
            key: 'carrier',
            header: '区分・燃料',
            importance: 'primary',
            cell: (r) => (
              <span className="text-small">
                {carrierKindLabel(r.line.carrierKind)}・
                {ACTIVITY_CODE_LABELS[r.line.fuelCode ?? ''] ?? r.line.fuelCode ?? '—'}
              </span>
            ),
          },
          {
            key: 'tonKm',
            header: 't·km',
            importance: 'primary',
            align: 'right',
            cell: (r) => {
              const t = firstTransport(r);
              const value =
                t?.tonKm ??
                r.line.tonKm ??
                (r.line.cargoWeightT !== null && r.line.distanceKm !== null
                  ? r.line.cargoWeightT * r.line.distanceKm
                  : null);
              return (
                <span className="tnum text-small">
                  {value === null ? '燃料法' : formatNumber(value, { fraction: 3 })}
                </span>
              );
            },
          },
          {
            key: 'payload',
            header: '最大積載量（kg）',
            importance: 'secondary',
            align: 'right',
            cell: (r) => (
              <span className="tnum text-small">
                {formatNumber(r.line.maxPayloadKg, { fraction: 0 })}
              </span>
            ),
          },
          {
            key: 'load',
            header: '積載率（%）',
            importance: 'primary',
            cell: (r) => {
              const t = firstTransport(r);
              return (
                <span className="inline-flex flex-wrap items-center gap-1">
                  <span className="tnum text-small">
                    {formatNumber(r.line.loadFactorPct, { fraction: 2 })}
                  </span>
                  {t && <StatusBadge domain="ghgLoadFactorSource" value={t.loadFactorSource} />}
                </span>
              );
            },
          },
          {
            key: 'economy',
            header: '燃費の区分',
            importance: 'secondary',
            cell: (r) => (
              <span className="text-small">{economyClassLabel(r.line.fuelEconomyClass)}</span>
            ),
          },
          {
            key: 'use',
            header: '用途',
            importance: 'detail',
            cell: (r) => <span className="text-small">{vehicleUseLabel(r.line.vehicleUse)}</span>,
          },
          {
            key: 'intensity',
            header: '原単位（L/t·km）',
            importance: 'secondary',
            align: 'right',
            cell: (r) => {
              const t = firstTransport(r);
              return <span className="tnum text-small">{t ? t.intensity : '—'}</span>;
            },
          },
          {
            key: 'liters',
            header: '燃料（L）',
            importance: 'secondary',
            align: 'right',
            cell: (r) => {
              const t = firstTransport(r);
              const fuelMethod = r.trial?.results.find((x) => x.method === 'fuel_method');
              const liters =
                t?.fuelLiters ??
                (fuelMethod && fuelMethod.activityUnit === 'L' ? fuelMethod.activityAmount : null);
              return (
                <span className="tnum text-small">
                  {liters === null ? '—' : formatNumber(liters, { fraction: 3 })}
                </span>
              );
            },
          },
          {
            key: 'trial',
            header: '試算 t-CO2（未丸め）',
            importance: 'primary',
            align: 'right',
            cell: (r) => trialCell(r),
          },
        ] satisfies DataTableColumn<LineRow>[])
      : ([
          {
            key: 'activity',
            header: '活動',
            importance: 'primary',
            cell: (r) => (
              <span className="text-small">
                {activityLabel(r.line.activityKind, r.line.activityCode)}
                {r.line.contractCode && (
                  <span className="ml-1 text-caption text-ink-muted">
                    契約 {r.line.contractCode}
                  </span>
                )}
              </span>
            ),
          },
          {
            key: 'amount',
            header: '量',
            importance: 'primary',
            align: 'right',
            cell: (r) => (
              <span className="tnum text-small">
                {formatNumber(r.line.amount, { fraction: 4 })} {r.line.unit ?? ''}
              </span>
            ),
          },
          {
            key: 'trial',
            header: '試算 t-CO2（未丸め）',
            importance: 'primary',
            align: 'right',
            cell: (r) =>
              r.line.activityKind === 'electricity' ? (
                <span className="flex flex-col items-end text-caption">
                  <span>ロケーション {trialCell(r, 'location')}</span>
                  <span>マーケット {trialCell(r, 'market')}</span>
                </span>
              ) : (
                trialCell(r)
              ),
          },
        ] satisfies DataTableColumn<LineRow>[])),
    {
      key: 'notes',
      header: '印',
      importance: 'primary',
      cell: notesCell,
    },
    {
      key: 'note',
      header: '備考',
      importance: 'detail',
      cell: (r) => <span className="text-caption text-ink-muted">{r.line.note || '—'}</span>,
    },
  ];

  const statusSteps =
    batch.status === 'draft'
      ? [
          { key: 'kind', label: '種類と拠点', state: 'done' as const },
          { key: 'file', label: 'ファイル', state: 'done' as const },
          { key: 'mapping', label: '列の対応', state: 'done' as const },
          { key: 'verify', label: '検証', state: 'done' as const },
          { key: 'confirm', label: '確定', state: 'current' as const },
        ]
      : null;

  return (
    <>
      <PageHeader
        title="活動量の取込の詳細"
        breadcrumbsTail={[{ label: batch.fileName || '取込' }]}
        context={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge domain="ghgActivityBatch" value={batch.status} />
            <span>
              {unit.name}（{unit.code}・{unit.countryCode}
              {detail.overseas ? '・海外' : '・国内'}）・{BATCH_KIND_LABELS[batch.kind]}・
              {batch.rowCount} 行・期間 {period.label}
            </span>
            {demo && <HonestyBadge kind="demo-data" />}
            {demo && <HonestyBadge kind="fictional" />}
          </span>
        }
        description={
          <span>
            {batch.fileName}
            {batch.fileSha256 && (
              <span className="ml-1 font-mono text-caption">
                sha256 {batch.fileSha256.slice(0, 12)}…
              </span>
            )}
            ・取込 {formatJst(batch.createdAt)}
            {detail.createdByName && ` ${detail.createdByName}`}
            {batch.confirmedAt &&
              `・確定 ${formatJst(batch.confirmedAt)}${detail.confirmedByName ? ` ${detail.confirmedByName}` : ''}`}
          </span>
        }
        actions={
          <PageActions
            primary={{
              kind: 'confirm',
              id: 'confirm-activity-batch',
              label: '確定する',
              icon: <CheckCircle2 aria-hidden="true" />,
              action: confirmActivityBatchAction,
              fields: { batchId: batch.id },
              hidden: !canWrite,
              // 状態で確定できないとき（締めた期間・差し替える元が既に差し替え済み・行が欠けた）は押せない理由を出す
              disabledReason: closed
                ? `期間「${period.label}」は締めています。`
                : (detail.confirmBlockedReason ?? undefined),
              confirm: {
                tier: 'bulk',
                title: 'この活動量を確定しますか',
                scope,
                consequences: [
                  '確定すると、次の「算定を実行」から使います。確定した行は変更できません（直すときは差し替えのバッチを取り込みます）。',
                  ...(detail.supersedes && detail.supersedes.status === 'confirmed'
                    ? [
                        `確定済みのバッチ「${detail.supersedes.fileName}」（${detail.supersedes.rowCount} 行）を差し替え済みにし、算定に使わなくします。`,
                      ]
                    : detail.overlaps > 0
                      ? [
                          `確定済みの活動量と同じ月・活動（輸送は出荷番号）の行が ${detail.overlaps} 行あります。追加なので両方が算定に入ります。`,
                        ]
                      : []),
                ],
                preview: <p className="text-small text-ink">試算の内訳: {breakdown.join('・')}</p>,
                confirmLabel: '確定する',
              },
            }}
            more={[
              {
                kind: 'link',
                id: 'back-to-activity',
                label: '活動量の一覧へ',
                href: calcTabHref('activity', period.id),
              },
              {
                kind: 'confirm',
                id: 'discard-activity-batch',
                label: '破棄する',
                icon: <Trash2 aria-hidden="true" />,
                action: discardActivityBatchAction,
                fields: { batchId: batch.id },
                hidden: !canWrite,
                destructive: true,
                confirm: {
                  tier: 'irreversible',
                  title: 'この取込を破棄しますか',
                  scope,
                  consequences: [
                    '破棄した取込は確定できません。行は記録として残り、算定には使いません。',
                  ],
                  confirmLabel: '破棄する',
                },
              },
            ]}
          />
        }
      />
      <CalcNav current="activity" periodId={period.id} attention={attention} />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {demo && <GhgNotice id="N9" />}
        {statusSteps && <StepNav ariaLabel="活動量の取込の段階" steps={statusSteps} />}

        {batch.status === 'draft' && writeReason !== null && (
          <Notice tone="info" title="確定・破棄はできません">
            {writeReason}
          </Notice>
        )}
        {batch.status === 'draft' && detail.supersedes && (
          <Notice tone="warning" title="差し替えの取込です">
            確定すると、確定済みのバッチ「{detail.supersedes.fileName}」（
            {detail.supersedes.rowCount} 行）を差し替え済みにし、算定に使わなくします。
            {detail.supersedes.status !== 'confirmed' &&
              ' 差し替える元のバッチは既に確定済みではないため、このままでは確定できません。破棄して取り込み直してください。'}
          </Notice>
        )}
        {batch.status === 'draft' && !detail.supersedes && detail.overlaps > 0 && (
          <Notice tone="warning" title="確定済みの活動量と重なる行があります">
            同じ月・活動（輸送は出荷番号）の確定済みの行が {detail.overlaps}{' '}
            行あります。追加なので、確定すると両方が算定に入ります。
          </Notice>
        )}
        {batch.status === 'superseded' && (
          <Notice tone="info" title="差し替え済みです">
            {detail.supersededBy ? (
              <>
                「
                <Link
                  href={`/enterprise/ghg/calculation/activity/${encodeURIComponent(detail.supersededBy.id)}`}
                  className="text-brand-700 hover:underline"
                >
                  {detail.supersededBy.fileName}
                </Link>
                」で差し替えたため、算定には使いません。
              </>
            ) : (
              '新しいバッチで差し替えたため、算定には使いません。'
            )}
          </Notice>
        )}
        {batch.status === 'discarded' && (
          <Notice tone="info" title="破棄した取込です">
            行は記録として残っていますが、算定には使いません。
          </Notice>
        )}
        {detail.overseas && transport && <GhgNotice id="N5" />}

        <Notice tone="info" title="試算です（算定の記録ではありません）">
          <p className="flex flex-wrap items-center gap-1.5">
            <HonestyBadge kind="estimate" />
            <span>
              いまの算定方針
              {trial.policy ? `（第 ${trial.policy.versionNo} 版）` : ''}
              と係数の割当で行ごとに計算した値です（未丸め。丸めは算定の記録の段で行います）。記録は算定の概要の「算定を実行」で作ります。
            </span>
          </p>
        </Notice>
        {!trial.policy && (
          <Notice tone="warning" title="算定方針がありません">
            この期間の算定方針（丸め・換算・改良トンキロ法の設定）が無いため試算できません。
            <Link
              href={calcTabHref('rules', period.id)}
              className="ml-1 text-brand-700 hover:underline"
            >
              算定ルール
            </Link>
            で保存してください。
          </Notice>
        )}
        {transport && trial.policy && (
          <LoadFactorNotice
            defaultRows={counts.defaultLoad}
            minLoadPct={trial.policy.tonkm.minLoadPct}
            flooredRows={counts.floored}
          />
        )}

        <MetricStrip label="試算の内訳">
          <MetricTile label="行" value={counts.lines} unit="行" />
          <MetricTile
            label="試算できない行"
            value={counts.errors}
            unit="行"
            status={
              counts.errors > 0
                ? { semantic: 'error', label: '係数の割当・算定ルールを確かめてください' }
                : { semantic: 'done', label: 'すべて試算できました' }
            }
            href={counts.errors > 0 ? `${basePath}?only=errors` : undefined}
          />
          {transport && (
            <>
              <MetricTile label="見なし積載率" value={counts.defaultLoad} unit="行" />
              <MetricTile label="下限を適用" value={counts.floored} unit="行" />
              <MetricTile label="最大積載量が範囲外" value={counts.payloadOutOfRange} unit="行" />
            </>
          )}
          {GHG_SCOPES.filter((s) => trial.totalsByProtocolScope[s] !== undefined).map((s) => (
            <MetricTile
              key={s}
              label={`試算の合計 ${GHG_SCOPE_LABELS[s]}（既定区分）`}
              value={formatNumber(trial.totalsByProtocolScope[s]!, { fraction: 3 })}
              unit="t-CO2"
              hint="未丸め。Scope2 の 2 基準は足しません"
            />
          ))}
        </MetricStrip>

        <Section title="行と試算" summary={`${rows.length} 行`}>
          {transport && (
            <MoreInfo label="改良トンキロ法の式と試算の段" className="mb-2">
              <p>
                輸送トンキロ（重量 t × 距離 km）→ 燃料使用原単位（積載率が分かる行は係数セットの式 x
                = A ÷ (y/100)^S ÷ z^B。y は積載率 %、z は最大積載量
                kg。積載率が無い行は見なし積載率の原単位表）→ 燃料使用量（t·km × 原単位）→ CO2（kL ×
                単位発熱量 × 炭素排出係数 × 44/12）の順に計算します。 積載率の下限・100%
                超・最大積載量の範囲・海外拠点の扱い・原単位の丸めは組織の算定方針で決めます。
              </p>
            </MoreInfo>
          )}
          <DataTable
            id="ghg-activity-lines"
            caption="活動量の行と試算"
            columns={columns}
            rows={paged}
            getRowId={(r) => r.line.id}
            getRowLabel={(r) => `${r.line.lineNo} 行目`}
            searchParams={query}
            basePath={basePath}
            search={false}
            filters={[
              {
                key: 'only',
                label: '行',
                options: [
                  { value: 'warnings', label: '印のある行' },
                  { value: 'errors', label: '試算できない行' },
                ],
              },
            ]}
            page={{ page, pageSize, total: rows.length, sizes: PAGE_SIZES }}
            expand={(r) => <TrialSteps line={r.line} trial={r.trial} />}
            empty={{
              noData: {
                title: 'このバッチに行がありません',
                description:
                  'デモでは保存の上限を超えた行が失われることがあります。破棄して取り込み直してください。',
                action: (
                  <Link
                    href={calcTabHref('activity', period.id)}
                    className="text-small text-brand-700 hover:underline"
                  >
                    活動量の一覧へ
                  </Link>
                ),
              },
            }}
          />
        </Section>
      </div>
    </>
  );
}
