import Link from 'next/link';
import { CheckCircle2, Plus, Target } from 'lucide-react';
import { CreatePanel } from '@/components/shared/create-panel';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { PERMISSION_LABELS } from '@/lib/authorization/permission-labels';
import {
  KPI_DIRECTION_LABELS,
  KPI_TARGET_TYPE_LABELS,
  kpiTargetLabel,
} from '@/lib/domain/disclosure-status';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { listKpiTargets, loadTargetFormOptions } from '@/lib/services/kpi';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { KpiTargetForm, type TargetFormDefaults } from './target-form';

export const metadata = { title: 'ESG 経営の目標' };

/**
 * KPI 目標の一覧と登録（指示書 §6.11: 指標定義・基準年・対象年・基準値・目標値・対象範囲・
 * 総量／原単位・増加／削減・責任者）。目標は追記専用の版で、改訂は理由付きの新しい版として足す。
 *
 * plan §2 S24: 版の履歴の一覧を主にし、登録・改訂のフォームは常設せず作成パネル（?new=1・?revise=）で開く。
 * 既定値: 責任者＝登録する本人（D4）、基準年＝直近の締めた年度、改訂は前の版の値（既存）。
 * ESG経営の未登録の KPI からは ?new=1&metric= で指標を選んだ状態で開く。
 */

const BASE_PATH = '/enterprise/esg/targets';

function one(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** 年度コード（FY2025 など）の西暦。読めなければ空 */
function yearOfCode(code: string): string {
  return /(\d{4})/.exec(code)?.[1] ?? '';
}

export default async function KpiTargetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const canManage = can(ctx, 'enterprise.metric.manage');
  const [histories, options] = await Promise.all([
    listKpiTargets(db, ctx),
    canManage ? loadTargetFormOptions(db, ctx) : Promise.resolve(null),
  ]);

  const reviseKey = one(query.revise);
  const revisingHistory = reviseKey ? histories.find((h) => h.targetKey === reviseKey) : undefined;
  const latest = revisingHistory?.versions[0];
  const panelOpen = canManage && (one(query.new) === '1' || Boolean(revisingHistory));

  // 基準年の候補は直近の締めた年度（無ければ空。人が決める）。基準年と基準値は対で入れる規則のため
  // （サービスが片方だけを拒む）、既定では入れずに候補として示す（片方だけ入った状態で送らせない）
  const closedYear = yearOfCode(
    [...shell.periods]
      .filter((p) => p.status === 'closed')
      .sort((a, b) => b.startDate.localeCompare(a.startDate))[0]?.code ?? '',
  );
  const requestedMetric = one(query.metric);
  const me = options?.members.some((m) => m.userId === ctx.userId) ? ctx.userId : '';
  const defaults: TargetFormDefaults = latest
    ? {
        targetKey: latest.targetKey,
        metricId: latest.metricId,
        boundary: latest.boundary,
        scopeNote: latest.scopeNote,
        baseYear: latest.baseYear === null ? '' : String(latest.baseYear),
        baseValue: latest.baseValue === null ? '' : String(latest.baseValue),
        targetYear: String(latest.targetYear),
        targetValue: String(latest.targetValue),
        targetType: latest.targetType,
        direction: latest.direction,
        methodologyNote: latest.methodologyNote,
        actualMethodology: latest.actualMethodology ?? '',
        ownerUserId: latest.ownerUserId ?? '',
      }
    : {
        targetKey: '',
        metricId:
          requestedMetric && options?.metrics.some((m) => m.id === requestedMetric)
            ? requestedMetric
            : '',
        boundary: '連結',
        scopeNote: '',
        baseYear: '',
        baseValue: '',
        targetYear: '',
        targetValue: '',
        targetType: 'absolute',
        direction: 'reduce',
        methodologyNote: '',
        actualMethodology: '',
        ownerUserId: me,
      };

  const saved = one(query.saved);
  const savedVersion = one(query.version);
  // 保存の知らせは内部のキー（scope1_reduce_2030 など）ではなく、指標・目標年・向きの表示名で示す
  const savedHistory = saved ? histories.find((h) => h.targetKey === saved) : undefined;
  const savedLabel = savedHistory?.versions[0]
    ? kpiTargetLabel({
        metricName: savedHistory.metric?.name ?? null,
        targetYear: savedHistory.versions[0].targetYear,
        direction: savedHistory.versions[0].direction,
      })
    : '目標';
  const permission = PERMISSION_LABELS['enterprise.metric.manage'];

  return (
    <>
      <PageHeader
        title="ESG 経営の目標"
        description="目標は版として追記します（以前の版は残ります）"
        help={
          <p>
            目標は版として追記します。改訂しても以前の版は残り、過去の開示で示した目標と比べられます。
          </p>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'register-target',
              shortcut: 'new',
              label: '目標を登録',
              icon: <Plus aria-hidden="true" />,
              href: `${BASE_PATH}?new=1#target-form`,
              // 作成パネルを開いている間は、パネルの送信が主操作（同時に 2 つ出さない）
              hidden: !canManage || panelOpen,
            }}
            secondary={[
              { kind: 'link', id: 'back-to-esg', label: 'ESG 経営へ', href: '/enterprise/esg' },
            ]}
          />
        }
      />
      <div className="space-y-3 p-4">
        {saved && (
          <p
            role="status"
            aria-live="polite"
            className="flex items-center gap-1.5 rounded-t4d border border-success/40 bg-success-soft px-3 py-1.5 text-small text-ink"
          >
            <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
            {savedLabel}の版 {savedVersion ?? '—'} を登録しました。
          </p>
        )}
        {!canManage && (
          <Notice tone="info">
            目標の登録・改訂には「{permission.label}」の権限が必要です（経営管理の設定のため）。
            {permission.holders}に依頼してください。
          </Notice>
        )}

        {panelOpen && options && (
          <CreatePanel
            id="target-form"
            title={
              revisingHistory && revisingHistory.versions[0]
                ? `目標を改訂（${kpiTargetLabel({
                    metricName: revisingHistory.metric?.name ?? null,
                    targetYear: revisingHistory.versions[0].targetYear,
                    direction: revisingHistory.versions[0].direction,
                  })}）`
                : '目標を登録'
            }
            searchParams={{ new: '1' }}
            closeHref={BASE_PATH}
          >
            <KpiTargetForm
              key={revisingHistory?.targetKey ?? 'new'}
              metrics={options.metrics.map((m) => ({
                id: m.id,
                label: `${m.name}（${m.unit}）`,
              }))}
              members={options.members}
              methodologies={options.methodologies}
              defaults={defaults}
              baseYearSuggestion={latest ? null : closedYear || null}
              revising={
                revisingHistory && latest
                  ? { targetKey: revisingHistory.targetKey, versionNo: latest.versionNo }
                  : null
              }
            />
          </CreatePanel>
        )}

        {histories.length === 0 ? (
          <EmptyState
            kind="no-data"
            title="目標はまだ登録されていません"
            description="KPI ごとに基準年・目標年・目標値を登録すると、ESG経営の画面に進捗率が出ます。"
            action={
              canManage ? (
                <Link
                  href={`${BASE_PATH}?new=1#target-form`}
                  className="text-small text-brand-700 underline underline-offset-2"
                >
                  最初の目標を登録する
                </Link>
              ) : (
                <span className="text-small text-ink-muted">
                  目標は{permission.holders}が登録します。
                </span>
              )
            }
          />
        ) : (
          histories.map((history) => (
            <Section
              key={history.targetKey}
              title={
                <span className="flex items-center gap-1.5">
                  <Target className="size-4 text-brand-600" aria-hidden="true" />
                  {history.metric?.name ?? '（指標不明）'}
                  {history.versions[0] && (
                    <span className="text-caption font-normal text-ink-muted">
                      {kpiTargetLabel({
                        metricName: history.metric?.name ?? null,
                        targetYear: history.versions[0].targetYear,
                        direction: history.versions[0].direction,
                      })}
                    </span>
                  )}
                </span>
              }
              actions={
                canManage ? (
                  <Link
                    href={`${BASE_PATH}?revise=${encodeURIComponent(history.targetKey)}#target-form`}
                    className="text-small text-brand-700 hover:underline"
                  >
                    改訂する
                  </Link>
                ) : undefined
              }
            >
              <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
                <Table>
                  <THead>
                    <TR>
                      <TH align="right">版</TH>
                      <TH align="right">基準年</TH>
                      <TH align="right">基準値</TH>
                      <TH align="right">目標年</TH>
                      <TH align="right">目標値</TH>
                      <TH>範囲</TH>
                      <TH>区分</TH>
                      <TH>責任者</TH>
                      <TH>改訂の理由</TH>
                      <TH>登録</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {history.versions.map((t) => (
                      <TR key={t.id} className="align-top">
                        <TD align="right">{t.versionNo}</TD>
                        {/* 数値は右寄せ・単位併記（§4.2）。基準値にも単位を付ける（原単位の目標で読み違えない） */}
                        <TD align="right" className="tnum text-small">
                          {t.baseYear !== null ? `${t.baseYear} 年` : '—'}
                        </TD>
                        <TD align="right" className="tnum text-small">
                          {t.baseValue !== null
                            ? `${formatNumber(t.baseValue)} ${history.metric?.unit ?? ''}`.trim()
                            : '—'}
                        </TD>
                        <TD align="right" className="tnum text-small">
                          {t.targetYear} 年
                        </TD>
                        <TD align="right" className="tnum text-small">
                          {`${formatNumber(t.targetValue)} ${history.metric?.unit ?? ''}`.trim()}
                        </TD>
                        <TD className="text-small">
                          {t.boundary}
                          {t.scopeNote && (
                            <span className="block text-caption text-ink-muted">{t.scopeNote}</span>
                          )}
                        </TD>
                        <TD className="text-small">
                          {KPI_TARGET_TYPE_LABELS[t.targetType]}・
                          {KPI_DIRECTION_LABELS[t.direction]}
                        </TD>
                        <TD className="text-small">{t.ownerName ?? '—'}</TD>
                        <TD className="text-small">{t.revisionReason ?? '—'}</TD>
                        <TD className="text-small">
                          {formatJst(t.createdAt)}
                          {t.createdByName && (
                            <span className="block text-caption text-ink-muted">
                              {t.createdByName}
                            </span>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </Section>
          ))
        )}
      </div>
    </>
  );
}
