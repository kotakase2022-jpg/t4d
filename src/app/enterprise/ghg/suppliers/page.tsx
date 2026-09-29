import Link from 'next/link';
import { ArrowLeft, CircleCheck, Clock, Download, Link2, RotateCcw } from 'lucide-react';
import { DemoSimulationNotice } from '@/components/shared/demo-simulation-notice';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { getAppMode } from '@/lib/config';
import { formatNumber } from '@/lib/format/datetime';
import { buildSupplierDemoFiles } from '@/lib/fixtures/supplier-demo-files';
import { loadScope3SupplierBreakdown } from '@/lib/services/scope3-suppliers';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { relinkSupplierFactorAction, resetSupplierDemoAction } from '../../actions';
import { SupplierUploadForm } from './supplier-upload-form';

export const metadata = { title: 'サプライヤーデータ取込' };

/**
 * Scope3 Cat.1 のサプライヤー一次データ取込。
 *
 * 排出量（t-CO2e）だけでなく、物理量（kWh・m3・L・kg）・金額（千円）の素データを
 * 受け付け、規則ベースで自動仕訳する。物理量・金額の行は排出量原単位（排出係数）と
 * 紐づけて排出量へ換算する。紐づけは取込プレビュー内の選択と、確定後の
 * 「原単位の紐づけ状況」からの再紐づけ（新しい算定版の追記）の 2 か所で行える。
 * Data Point の確定値は変えない（値の変更は承認フロー）。
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

  const factorById = new Map(breakdown.factors.map((f) => [f.id, f]));
  // 紐づけ状況: 活動量を持つ内訳行（金額・物理量の素データ由来）だけが再紐づけの対象
  const linkedRows = breakdown.suppliers
    .flatMap((supplier) =>
      supplier.inputs
        .filter((input) => input.activityAmount !== null && input.activityUnit !== null)
        .map((input) => ({
          supplier,
          input,
          factor: input.factorId ? factorById.get(input.factorId) : undefined,
        })),
    )
    .map((row, index) => ({ ...row, index }));
  const demoFiles = buildSupplierDemoFiles();

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
        {getAppMode() === 'demo' && <DemoSimulationNotice />}

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
            {/* 金額×係数（推計）を含むため「一次データ合計」とは呼ばない（W0 O6） */}
            <p className="text-[11px] text-ink-muted">内訳合計</p>
            <p className="text-[20px] font-semibold leading-none tabular-nums text-ink">
              {formatNumber(breakdown.breakdownTotal)}
              <span className="ml-1 text-[11px] font-normal text-ink-muted">t-CO2e</span>
            </p>
            <p className="text-[10px] text-ink-muted">
              うち一次データ（固有＋活動量ベース） {formatNumber(breakdown.primaryDataTotal)}
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
            title="ファイルから取り込む（排出量・物理量・金額の素データ ／ CSV・Excel）"
            action={
              <span className="text-[11px] text-ink-muted">
                仕訳・原単位の解決は規則ベース（AI 不使用）／ 確定は人が行います
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

        {canImport && (
          <Card className="overflow-hidden">
            <SectionTitle
              title="デモ用サンプルファイル（多様なフォーマット・言語）"
              action={<Badge tone="warning">架空データ</Badge>}
            />
            <ul className="divide-y divide-line">
              {demoFiles.map((file) => (
                <li key={file.key} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div>
                    <p className="text-[13px] font-medium text-ink">{file.title}</p>
                    <p className="text-[11px] text-ink-muted">{file.description}</p>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/exports/supplier-demo-files?file=${file.key}`} download>
                      <Download aria-hidden="true" />
                      ダウンロード
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
            <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
              ダウンロードして、そのまま上の取込へドロップすると自動仕訳を体験できます。
            </p>
          </Card>
        )}

        {canImport && getAppMode() === 'demo' && (
          <Card className="overflow-hidden">
            <SectionTitle
              title="Scope3 Cat.1 デモデータセット（電子部品メーカー・20 ファイル 240 明細）"
              action={<Badge tone="warning">架空データ</Badge>}
            />
            <div className="space-y-2 px-3 pb-3">
              <p className="text-[12px] text-ink-muted">
                架空の電子部品メーカーを想定した Scope3 カテゴリー1（購入した製品・サービス）の
                購買データです。20 ファイル（Excel 14 ／ CSV 6・日英混在）に架空サプライヤー 20 社 ×
                各 12 明細＝240 明細を収録。上の取込へ 20 ファイルまとめてドロップできます。
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="outline" size="sm" asChild>
                  <a href="/demo/murata-scope3-cat1-upload.zip" download>
                    <Download aria-hidden="true" />
                    投入用 ZIP（20 ファイルのみ）
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href="/demo/murata-scope3-cat1-full.zip" download>
                    <Download aria-hidden="true" />
                    一式 ZIP（正解データ・手順書つき）
                  </a>
                </Button>
              </div>
              <p className="text-[11px] text-ink-muted">
                収録の係数コード（DEMO-EF-*）・為替レートはすべて架空の説明用で、実算定には使用できません。
              </p>
            </div>
          </Card>
        )}

        {canImport && getAppMode() === 'demo' && (
          <Card className="overflow-hidden">
            <SectionTitle
              title="デモのリセット（Demo Mode 専用）"
              action={<Badge tone="warning">取り消せません</Badge>}
            />
            <form action={resetSupplierDemoAction} className="space-y-2 px-3 pb-3">
              <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
              <p className="text-[12px] text-ink-muted">
                削除範囲: この組織 × {shell.currentPeriod.label} の Scope3 Cat.1
                に「サプライヤーデータ取込・原単位の再紐づけ」で追記された算定版のみ。
                初期の算定内訳（版 1）・Data Point 本体・承認履歴・他の指標・ログイン情報・
                ブラウザの他の保存領域には触りません。
              </p>
              <label className="flex items-center gap-1.5 text-[12px] text-ink">
                <input
                  type="checkbox"
                  name="confirmScope"
                  required
                  className="size-3.5 accent-brand-600"
                />
                上記の削除範囲を確認しました
              </label>
              <SubmitButton
                size="sm"
                variant="outline"
                icon={<RotateCcw aria-hidden="true" />}
                pendingLabel="リセット中…"
              >
                取込済みの算定版をリセットする
              </SubmitButton>
            </form>
          </Card>
        )}

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
            title={`排出量原単位の紐づけ状況（素データ ${linkedRows.length} 行）`}
            action={
              <span className="text-[11px] text-ink-muted">
                紐づけ直すと新しい算定版を追記します（過去の版は残ります）
              </span>
            }
          />
          {linkedRows.length === 0 ? (
            <p className="px-3 pb-3 text-[12px] text-ink-muted">
              活動量を持つ内訳行がまだありません。物理量・金額の素データを取り込むとここに並びます。
            </p>
          ) : (
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>サプライヤー</TH>
                    <TH>品目</TH>
                    <TH align="right">活動量</TH>
                    <TH>単位</TH>
                    <TH>現在の原単位</TH>
                    <TH align="right">
                      排出量<span className="normal-case">(t-CO2e)</span>
                    </TH>
                    {canImport && <TH>原単位の変更</TH>}
                  </TR>
                </THead>
                <TBody>
                  {linkedRows.map(({ supplier, input, factor, index }) => {
                    const candidates = breakdown.factors.filter(
                      (f) => f.activityUnit === input.activityUnit,
                    );
                    return (
                      <TR key={`${supplier.code}-${input.item}-${index}`}>
                        <TD className="font-medium text-ink">
                          {supplier.name}
                          <span className="ml-1 font-mono text-[11px] font-normal text-ink-muted">
                            {supplier.code}
                          </span>
                        </TD>
                        <TD>{input.item}</TD>
                        <TD align="right">{formatNumber(input.activityAmount)}</TD>
                        <TD className="text-[11px]">{input.activityUnit}</TD>
                        <TD className="text-[11px]">
                          {factor ? (
                            <>
                              {factor.name}
                              <span className="ml-1 font-mono text-ink-muted">{factor.code}</span>
                            </>
                          ) : (
                            <span className="text-ink-muted">不明（旧形式）</span>
                          )}
                        </TD>
                        <TD align="right">{formatNumber(input.value)}</TD>
                        {canImport && (
                          <TD>
                            {candidates.length > 1 ? (
                              <form
                                action={relinkSupplierFactorAction}
                                className="flex items-center gap-1"
                              >
                                <input
                                  type="hidden"
                                  name="reportingPeriodId"
                                  value={shell.currentPeriod.id}
                                />
                                <input type="hidden" name="supplierCode" value={supplier.code} />
                                <input type="hidden" name="item" value={input.item} />
                                <select
                                  name="factorCode"
                                  defaultValue={factor?.code ?? ''}
                                  aria-label={`${supplier.name} ${input.item} の排出量原単位`}
                                  className="h-6 rounded-t4d border border-line bg-surface px-1 text-[11px]"
                                >
                                  {candidates.map((candidate) => (
                                    <option key={candidate.id} value={candidate.code}>
                                      {candidate.name}（{candidate.factorValue}{' '}
                                      {candidate.factorUnit}）
                                    </option>
                                  ))}
                                </select>
                                <SubmitButton
                                  size="sm"
                                  variant="outline"
                                  icon={<Link2 aria-hidden="true" />}
                                  pendingLabel="更新中…"
                                >
                                  更新
                                </SubmitButton>
                              </form>
                            ) : (
                              <span className="text-[11px] text-ink-muted">
                                同じ単位の原単位が他にありません
                              </span>
                            )}
                          </TD>
                        )}
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`排出量原単位（排出係数）マスター（${breakdown.factors.length}）`}
            action={<Badge tone="warning">架空値（実係数ではありません）</Badge>}
          />
          <Table>
            <THead>
              <TR>
                <TH>コード</TH>
                <TH>名称</TH>
                <TH align="right">係数</TH>
                <TH>単位</TH>
                <TH>活動量単位</TH>
                <TH>用途</TH>
                <TH align="right">係数年度</TH>
              </TR>
            </THead>
            <TBody>
              {breakdown.factors.map((factor) => (
                <TR key={factor.id}>
                  <TD className="font-mono text-[11px]">{factor.code}</TD>
                  <TD>{factor.name}</TD>
                  <TD align="right">{factor.factorValue}</TD>
                  <TD className="text-[11px]">{factor.factorUnit}</TD>
                  <TD className="text-[11px]">{factor.activityUnit}</TD>
                  <TD className="text-[11px]">
                    {factor.activityUnit === '千円' ? '金額データ' : '物理データ'}
                  </TD>
                  <TD align="right">{factor.factorYear}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
            CSV
            の「排出係数コード」列にはこの一覧のコードを記入してください（空欄でも単位・過去実績から
            自動解決し、候補が複数のときは取込時に選べます）。
          </p>
        </Card>
      </div>
    </>
  );
}
