import {
  Check,
  CircleDot,
  Equal,
  FileSpreadsheet,
  FlaskConical,
  PenLine,
  Plus,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible } from '@/components/ui/collapsible';
import { MoreInfo } from '@/components/ui/more-info';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { getAppMode } from '@/lib/config';
import { AVAILABILITY_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import { formatJst } from '@/lib/format/datetime';
import {
  MAX_STANDARD_CSV_BYTES,
  MAX_STANDARD_CSV_ROWS,
  NUMBER_NOTATION_LABELS,
  NUMBER_NOTATIONS,
  STANDARD_COLUMNS,
  STANDARD_FIELD_LABELS,
  type StandardColumn,
} from '@/lib/imports/standard-csv';
import { importHistoryBreakdown } from '@/lib/imports/history-breakdown';
import { listQuantitativeImportBatches } from '@/lib/services/quantitative-import';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { QuantitativeImportDiffKind, QuantitativeImportStatus } from '@/types/domain';
import { StandardImport } from './standard-import';

export const metadata = { title: '数値を登録' };

/** 標準列の必須区分と説明（画面の「列の約束」に出す） */
const COLUMN_NOTES: Record<StandardColumn, { required: string; note: string }> = {
  metric_code: { required: '必須', note: '指標定義のコード（例: scope1）' },
  period_start: { required: '必須', note: '報告期間の開始日（YYYY-MM-DD）' },
  period_end: { required: '必須', note: '報告期間の終了日。年度の途中の期間は登録しません' },
  entity_code: { required: '必須', note: '組織コード（例: HQ）' },
  boundary_code: { required: '任意', note: '空欄は組織の連結区分から（連結／単体）' },
  value: {
    required: '値か値の有無のどちらか',
    note: '数字だけ。空欄は「未入力」の候補（0 にしない）',
  },
  unit: { required: '値があれば必須', note: '指標定義の単位と同じもの。換算はしません' },
  value_kind: { required: '任意', note: 'actual／estimate／target（実績／推計／目標）' },
  availability_status: {
    required: '値か値の有無のどちらか',
    // 記号だけでは 未入力・未取得・対象外・未算定 を区別できないため、意味を添える（A07）
    note: (Object.entries(AVAILABILITY_STATUS_LABELS) as Array<[string, string]>)
      .map(([code, label]) => `${code}（${label}）`)
      .join('／'),
  },
  absence_reason: { required: '未取得・対象外・未算定は必須', note: '値が無い理由' },
  methodology_code: { required: '任意', note: '算定方法' },
  breakdown_key: { required: '任意', note: '内訳別の値は現在は登録しません（合計の行で登録）' },
  source_reference: { required: '任意', note: '出所（資料名・シート・セルなど）' },
};

const BREAKDOWN_ICON: Record<QuantitativeImportDiffKind, LucideIcon> = {
  new: Plus,
  changed: PenLine,
  unchanged: Equal,
  error: TriangleAlert,
};

const BATCH_STATUS_META: Record<
  QuantitativeImportStatus,
  { tone: 'outline' | 'success' | 'neutral'; Icon: typeof Check }
> = {
  validated: { tone: 'outline', Icon: CircleDot },
  committed: { tone: 'success', Icon: Check },
  rejected: { tone: 'neutral', Icon: XCircle },
};

export default async function StandardImportPage() {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const allowed = can(ctx, 'enterprise.import.run') && can(ctx, 'enterprise.data.write');
  const demo = getAppMode() === 'demo';

  const history = allowed ? await listQuantitativeImportBatches(db, ctx, 10) : [];
  const breakdown = importHistoryBreakdown(history);

  const scope = ctx.workspace.unitScopeIds;
  const units = shell.units
    .filter((u) => u.unitType !== 'supplier' && (scope.length === 0 || scope.includes(u.id)))
    .map((u) => ({ code: u.code, name: u.name }));
  const metrics = shell.metrics
    .filter((m) => m.dataType !== 'text' && m.dataType !== 'boolean')
    .map((m) => ({ code: m.code, name: m.name, unit: m.unit }));
  const periods = shell.periods.map((p) => ({
    id: p.id,
    label: p.label,
    startDate: p.startDate,
    endDate: p.endDate,
  }));

  return (
    <>
      <PageHeader
        title="数値を登録（CSV・手入力）"
        description="検証 → 差分の確認 → 登録確定。確定するまで台帳は変わりません"
        help={
          <p>
            標準 CSV・貼り付け・手入力で数値を登録します。列の書き方は「標準 CSV
            の列」を開くと確認できます。
          </p>
        }
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: 'データ取込', href: '/enterprise/imports' },
          { label: '数値を登録' },
        ]}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <a href="/templates/standard-metrics.csv" download="standard-metrics.csv">
                <FileSpreadsheet aria-hidden="true" />
                標準 CSV のテンプレート
              </a>
            </Button>
            {/* 単位違い・重複・未提出・曖昧な数値などを含む確認用（架空）。デモで検証の理由表示を見せる */}
            <Button variant="ghost" size="sm" asChild>
              <a
                href="/templates/standard-metrics-sample-with-errors.csv"
                download="standard-metrics-sample-with-errors.csv"
              >
                <FileSpreadsheet aria-hidden="true" />
                確認用サンプル（エラーを含む・架空）
              </a>
            </Button>
          </>
        }
      />

      <div className="space-y-3 p-4">
        {/* 架空である旨は常に見せる。保存のしくみ（技術的な説明）だけを既定で閉じる（§10.4 B6） */}
        {demo && (
          <div className="rounded-t4d border border-brand-200 bg-brand-50 px-3 py-1.5 text-[11px] text-brand-900">
            <p className="flex items-start gap-1.5">
              <FlaskConical
                className="mt-0.5 size-3.5 shrink-0 text-brand-600"
                aria-hidden="true"
              />
              <span>デモデータ｜組織・指標・値はすべて架空です。</span>
            </p>
            <MoreInfo label="デモでの検証と確定のしくみ" className="mt-0.5 pl-5">
              <p>
                検証結果（取込バッチ）はサーバーのメモリにだけ置き、「登録を確定」では画面が検証した元の入力をもう一度送り、サーバーが検証し直してから確定します（別のサーバーへ振り分けられても確定できます）。検証の後に台帳が変わっていれば、確定を止めて差分を示します。
              </p>
            </MoreInfo>
          </div>
        )}

        {!allowed ? (
          <Card>
            <PermissionDeniedState description="数値の登録には、取込とデータ入力の権限が必要です。必要な場合は管理者へ依頼してください。" />
          </Card>
        ) : (
          <>
            <Collapsible
              summary={`標準 CSV の列（見出し 1 行目に書く列名・${STANDARD_COLUMNS.length} 列）`}
            >
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>列名</TH>
                      <TH>項目</TH>
                      <TH>必須</TH>
                      <TH>書き方</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {STANDARD_COLUMNS.map((column) => (
                      <TR key={column}>
                        <TD className="font-mono text-[12px]">{column}</TD>
                        <TD>{STANDARD_FIELD_LABELS[column]}</TD>
                        <TD className="whitespace-nowrap">{COLUMN_NOTES[column].required}</TD>
                        <TD className="text-[12px] text-ink-muted">{COLUMN_NOTES[column].note}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p className="mt-2 text-ink-muted">
                既存テンプレート（拠点・項目・値・単位・期間）もそのまま読み、標準列の「候補」として対応付けます。
                同じ指標・組織・期間・集計範囲の値は、ファイル名に関係なく同じ値として扱います（同じ内容の再登録は「変更なし」）。
              </p>
            </Collapsible>

            <StandardImport
              periods={periods}
              defaultPeriodId={shell.currentPeriod.id}
              metrics={metrics}
              units={units}
              notations={NUMBER_NOTATIONS.map((value) => ({
                value,
                label: NUMBER_NOTATION_LABELS[value],
              }))}
              limitsLabel={`${Math.round(MAX_STANDARD_CSV_BYTES / 1024 / 1024)}MB・${MAX_STANDARD_CSV_ROWS} 行まで`}
            />
          </>
        )}

        {allowed && (
          <Card className="overflow-hidden">
            <SectionTitle title={`取込の履歴（直近 ${history.length} 件）`} />
            {history.length === 0 ? (
              <EmptyState
                title="まだ取込はありません"
                description={
                  demo
                    ? '検証した取込がここに並びます（デモでは、このサーバーで検証したものと、このブラウザで確定したもの）。'
                    : '検証した取込がここに並びます。'
                }
              />
            ) : (
              <div className="space-y-2 px-3 pb-3">
                {/* 確定した取込の行を区分ごとに合計した帯（重ならない区分だけ）。検証のみの取込は
                    台帳に書いていないため数えない。取込ごとの数は既定で閉じた表に置く（§10.4 B6） */}
                {breakdown.committedBatches === 0 ? (
                  <p className="text-[12px] text-ink-muted">
                    確定した取込はまだありません（検証のみ・未確定の {breakdown.otherBatches}{' '}
                    件は行数を合計しません）。
                  </p>
                ) : (
                  <>
                    <StatusBreakdown
                      label={`直近 ${history.length} 件のうち確定した ${breakdown.committedBatches} 件の取込の行の内訳`}
                      unit="行"
                      items={breakdown.items.map((item) => ({
                        ...item,
                        icon: BREAKDOWN_ICON[item.key],
                      }))}
                    />
                    <p className="text-[11px] text-ink-muted">
                      確定した取込の {breakdown.totalRows} 行の内訳です。エラーの{' '}
                      {breakdown.excludedRows} 行は登録せずに除外しました。
                      {breakdown.otherBatches > 0 &&
                        ` 検証のみ・未確定の ${breakdown.otherBatches} 件は台帳に書いていないため数えていません。`}
                    </p>
                  </>
                )}
                <Collapsible
                  variant="plain"
                  summary={`取込ごとの内訳（${history.length} 件・確定 ${breakdown.committedBatches} 件）`}
                >
                  <div className="overflow-x-auto">
                    <Table>
                      <THead>
                        <TR>
                          <TH>ファイル</TH>
                          <TH>状態</TH>
                          <TH align="right">新規</TH>
                          <TH align="right">変更</TH>
                          <TH align="right">変更なし</TH>
                          <TH align="right">エラー</TH>
                          <TH align="right">除外（未登録）</TH>
                          <TH>検証</TH>
                          <TH>確定</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {history.map((item) => {
                          const meta = BATCH_STATUS_META[item.status];
                          return (
                            <TR key={item.id}>
                              <TD className="max-w-[260px] truncate" title={item.fileName}>
                                {item.fileName}
                              </TD>
                              <TD>
                                <Badge tone={meta.tone}>
                                  <meta.Icon className="size-3" aria-hidden="true" />
                                  {item.statusLabel}
                                </Badge>
                              </TD>
                              <TD align="right">{item.counts.new}</TD>
                              <TD align="right">{item.counts.changed}</TD>
                              <TD align="right">{item.counts.unchanged}</TD>
                              <TD align="right">{item.counts.error}</TD>
                              <TD align="right">{item.excludedCount}</TD>
                              <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                                {formatJst(item.createdAt)}
                              </TD>
                              <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                                {item.committedAt ? formatJst(item.committedAt) : '—'}
                              </TD>
                            </TR>
                          );
                        })}
                      </TBody>
                    </Table>
                  </div>
                </Collapsible>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
