import Link from 'next/link';
import { ArrowLeft, CircleCheck, Clock, Download } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatNumber } from '@/lib/format/datetime';
import { loadScope3SupplierBreakdown } from '@/lib/services/scope3-suppliers';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { SupplierUploadForm } from './supplier-upload-form';

export const metadata = { title: 'サプライヤーデータ取込' };

/**
 * Scope3 Cat.1 のサプライヤー一次データ取込。
 *
 * GHG 画面の内訳で「未提出」になっている社の購買実績 CSV をここで取り込む。
 * 確定は算定根拠（data_point_calculations）への版の追記であり、
 * Data Point の確定値は変えない（値の変更は承認フローで行う）。
 */
export default async function GhgSuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const breakdown = await loadScope3SupplierBreakdown(shell.db, shell.ctx, shell.currentPeriod.id);

  const missing = breakdown.suppliers.filter((s) => !s.submitted);
  const canImport = can(shell.ctx, 'enterprise.import.run');
  const submissionRate =
    breakdown.suppliers.length === 0
      ? 0
      : Math.round((breakdown.submittedCount / breakdown.suppliers.length) * 100);

  return (
    <>
      <PageHeader
        title="サプライヤーデータ取込"
        description={`${shell.currentPeriod.label} ／ Scope3 Category 1（購入した製品・サービス）の一次データを取り込む`}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: 'GHG', href: '/enterprise/ghg' },
          { label: 'サプライヤーデータ取込' },
        ]}
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" asChild>
              {/* a 要素にするのは Next の Link だと RSC フェッチになりダウンロードにならないため */}
              <a href={`/api/exports/supplier-template?period=${shell.currentPeriod.id}`} download>
                <Download aria-hidden="true" />
                CSV テンプレート
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/ghg">
                <ArrowLeft aria-hidden="true" />
                GHG へ戻る
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <div className="grid grid-cols-4 gap-2">
          <Card className="space-y-1 p-2.5">
            <p className="text-[11px] text-ink-muted">対象サプライヤー</p>
            <p className="text-[20px] font-semibold leading-none tabular-nums text-ink">
              {breakdown.suppliers.length} 社
            </p>
          </Card>
          <Card className="space-y-1 p-2.5">
            <p className="text-[11px] text-ink-muted">未提出</p>
            <p
              className={`text-[20px] font-semibold leading-none tabular-nums ${
                missing.length > 0 ? 'text-danger' : 'text-ink'
              }`}
            >
              {missing.length} 社
            </p>
          </Card>
          <Card className="space-y-1 p-2.5">
            <p className="text-[11px] text-ink-muted">一次データ合計</p>
            <p className="text-[20px] font-semibold leading-none tabular-nums text-ink">
              {formatNumber(breakdown.primaryTotal)}
              <span className="ml-1 text-[11px] font-normal text-ink-muted">t-CO2e</span>
            </p>
          </Card>
          <Card className="space-y-1.5 p-2.5">
            <p className="text-[11px] text-ink-muted">提出の進捗</p>
            <div className="flex items-center gap-1.5">
              <Progress
                value={submissionRate}
                tone={
                  submissionRate >= 80 ? 'success' : submissionRate >= 50 ? 'warning' : 'danger'
                }
                label={`サプライヤー提出の進捗 ${submissionRate}%`}
              />
              <span className="text-[13px] font-semibold tabular-nums text-ink">
                {submissionRate}%
              </span>
            </div>
          </Card>
        </div>

        <Card className="overflow-hidden">
          <SectionTitle
            title="CSV から取り込む"
            action={
              <span className="text-[11px] text-ink-muted">
                解析・突き合わせは規則ベース（AI 不使用）／ 確定は人が行います
              </span>
            }
          />
          {canImport ? (
            <div className="p-3">
              <SupplierUploadForm reportingPeriodId={shell.currentPeriod.id} />
            </div>
          ) : (
            <p className="px-3 pb-3 text-[12px] text-ink-muted">
              取込には「取込の実行」権限（enterprise.import.run）が必要です。閲覧のみ可能です。
            </p>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`サプライヤー別の提出状況（${breakdown.submittedCount} / ${breakdown.suppliers.length} 社）`}
            action={
              <Link href="/enterprise/ghg" className="text-[12px] text-brand-700 hover:underline">
                内訳の可視化を見る
              </Link>
            }
          />
          <Table>
            <THead>
              <TR>
                <TH>コード</TH>
                <TH>サプライヤー</TH>
                <TH>提出状況</TH>
                {/* TH は uppercase が掛かるため、大小文字に意味がある単位は normal-case で守る */}
                <TH align="right">
                  排出量<span className="normal-case">(t-CO2e)</span>
                </TH>
                <TH align="right">内訳行数</TH>
              </TR>
            </THead>
            <TBody>
              {breakdown.suppliers.map((supplier) => (
                <TR key={supplier.unitId}>
                  <TD className="font-mono text-[11px]">{supplier.code}</TD>
                  <TD className="font-medium text-ink">{supplier.name}</TD>
                  <TD>
                    {supplier.submitted ? (
                      <Badge tone="success">
                        <CircleCheck className="size-3" aria-hidden="true" />
                        提出済み
                      </Badge>
                    ) : (
                      <Badge tone="warning">
                        <Clock className="size-3" aria-hidden="true" />
                        未提出
                      </Badge>
                    )}
                  </TD>
                  <TD align="right">{supplier.submitted ? formatNumber(supplier.total) : '—'}</TD>
                  <TD align="right">{supplier.submitted ? supplier.inputs.length : '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`排出係数コード一覧（${breakdown.factors.length}）`}
            action={<Badge tone="warning">架空値（実係数ではありません）</Badge>}
          />
          <Table>
            <THead>
              <TR>
                <TH>コード</TH>
                <TH>名称</TH>
                <TH align="right">係数</TH>
                <TH>単位</TH>
                <TH align="right">係数年度</TH>
              </TR>
            </THead>
            <TBody>
              {breakdown.factors.map((factor) => (
                <TR key={factor.id}>
                  <TD className="font-mono text-[11px]">{factor.code}</TD>
                  <TD>{factor.name}</TD>
                  <TD align="right">{factor.factorValue}</TD>
                  <TD>{factor.factorUnit}</TD>
                  <TD align="right">{factor.factorYear}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
            CSV の「排出係数コード」列にはこの一覧のコードを記入してください。
          </p>
        </Card>
      </div>
    </>
  );
}
