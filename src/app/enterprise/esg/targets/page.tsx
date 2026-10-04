import Link from 'next/link';
import { CheckCircle2, Lock, Target } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
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
 */

function one(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
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
        metricId: '',
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
        ownerUserId: '',
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
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: 'ESG 経営', href: '/enterprise/esg' },
          { label: '目標' },
        ]}
      />
      <div className="grid gap-3 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        <div className="space-y-3">
          {saved && (
            <p
              role="status"
              aria-live="polite"
              className="flex items-center gap-1.5 rounded-t4d border border-success/40 bg-success-soft px-3 py-1.5 text-[12px] text-ink"
            >
              <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
              {savedLabel}の版 {savedVersion ?? '—'} を登録しました。
            </p>
          )}
          {histories.length === 0 ? (
            <p className="rounded-t4d border border-line bg-surface px-3 py-4 text-[12px] text-ink-muted">
              目標はまだ登録されていません。
            </p>
          ) : (
            histories.map((history) => (
              <Card key={history.targetKey} className="overflow-hidden">
                <CardHeader>
                  <CardTitle className="flex items-center gap-1.5">
                    <Target className="size-4 text-brand-600" aria-hidden="true" />
                    {history.metric?.name ?? '（指標不明）'}
                    {history.versions[0] && (
                      <span className="text-[11px] font-normal text-ink-muted">
                        {kpiTargetLabel({
                          metricName: history.metric?.name ?? null,
                          targetYear: history.versions[0].targetYear,
                          direction: history.versions[0].direction,
                        })}
                      </span>
                    )}
                  </CardTitle>
                  {canManage && (
                    <Link
                      href={`/enterprise/esg/targets?revise=${encodeURIComponent(history.targetKey)}`}
                      className="text-[12px] text-brand-700 hover:underline"
                    >
                      改訂する
                    </Link>
                  )}
                </CardHeader>
                <div className="t4d-scroll-x">
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
                          <TD align="right" className="tnum text-[12px]">
                            {t.baseYear !== null ? `${t.baseYear} 年` : '—'}
                          </TD>
                          <TD align="right" className="tnum text-[12px]">
                            {t.baseValue !== null
                              ? `${formatNumber(t.baseValue)} ${history.metric?.unit ?? ''}`.trim()
                              : '—'}
                          </TD>
                          <TD align="right" className="tnum text-[12px]">
                            {t.targetYear} 年
                          </TD>
                          <TD align="right" className="tnum text-[12px]">
                            {`${formatNumber(t.targetValue)} ${history.metric?.unit ?? ''}`.trim()}
                          </TD>
                          <TD className="text-[12px]">
                            {t.boundary}
                            {t.scopeNote && (
                              <span className="block text-[11px] text-ink-muted">
                                {t.scopeNote}
                              </span>
                            )}
                          </TD>
                          <TD className="text-[12px]">
                            {KPI_TARGET_TYPE_LABELS[t.targetType]}・
                            {KPI_DIRECTION_LABELS[t.direction]}
                          </TD>
                          <TD className="text-[12px]">{t.ownerName ?? '—'}</TD>
                          <TD className="text-[12px]">{t.revisionReason ?? '—'}</TD>
                          <TD className="text-[12px]">
                            {formatJst(t.createdAt)}
                            {t.createdByName && (
                              <span className="block text-[11px] text-ink-muted">
                                {t.createdByName}
                              </span>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>
              {revisingHistory && revisingHistory.versions[0]
                ? `目標を改訂（${kpiTargetLabel({
                    metricName: revisingHistory.metric?.name ?? null,
                    targetYear: revisingHistory.versions[0].targetYear,
                    direction: revisingHistory.versions[0].direction,
                  })}）`
                : '目標を登録'}
            </CardTitle>
            {revisingHistory && (
              <Link
                href="/enterprise/esg/targets"
                className="text-[12px] text-brand-700 hover:underline"
              >
                新規登録に戻る
              </Link>
            )}
          </CardHeader>
          <CardContent>
            {canManage && options ? (
              <KpiTargetForm
                key={revisingHistory?.targetKey ?? 'new'}
                metrics={options.metrics.map((m) => ({
                  id: m.id,
                  label: `${m.name}（${m.unit}）`,
                }))}
                members={options.members}
                methodologies={options.methodologies}
                defaults={defaults}
                revising={
                  revisingHistory && latest
                    ? { targetKey: revisingHistory.targetKey, versionNo: latest.versionNo }
                    : null
                }
              />
            ) : (
              <p className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                <Lock className="size-3.5" aria-hidden="true" />
                目標の登録・改訂には、指標マスターの管理権限が必要です（経営管理の設定のため）。
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
