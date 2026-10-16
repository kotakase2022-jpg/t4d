import Link from 'next/link';
import { Download, Link2, RotateCcw } from 'lucide-react';
import { FractionBar } from '@/components/charts/fraction-bar';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { DemoSimulationNotice } from '@/components/shared/demo-simulation-notice';
import { FlashMessage } from '@/components/shared/flash';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { SemanticBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { MoreInfo } from '@/components/ui/more-info';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { PERMISSION_LABELS } from '@/lib/authorization/permission-labels';
import { getAppMode } from '@/lib/config';
import { formatNumber } from '@/lib/format/datetime';
import { buildSupplierDemoFiles } from '@/lib/fixtures/supplier-demo-files';
import {
  cat1FactorIndex,
  loadScope3SupplierBreakdown,
  type SupplierBreakdownEntry,
} from '@/lib/services/scope3-suppliers';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { parsePage, parsePageSize } from '@/lib/table/columns';
import type { MenuActionSpec } from '@/lib/ui/actions';
import { resetSupplierDemoAction } from '../../actions';
import { FactorRelinkDialog } from './factor-relink-dialog';
import { SupplierUploadForm } from './supplier-upload-form';

export const metadata = { title: 'サプライヤーデータ取込' };

/**
 * Scope3 Cat.1 のサプライヤー一次データ取込（plan §2 S5）。
 *
 * 排出量（t-CO2e）だけでなく、物理量（kWh・m3・L・kg）・金額（千円）の素データを
 * 受け付け、規則ベースで自動仕訳する。物理量・金額の行は排出量原単位（排出係数）と
 * 紐づけて排出量へ換算する。紐づけは取込プレビュー内の選択と、確定後の
 * 「原単位の紐づけ状況」からの再紐づけ（新しい算定版の追記）の 2 か所で行える。
 * Data Point の確定値は変えない（値の変更は承認フロー）。
 *
 * 置き場所（plan §1.5）:
 *  - 本文: 取込（段階: ファイルを選ぶ → 解析結果を確認 → 確定。主操作は段階ごとに 1 つ）と提出状況
 *  - 見出しの「その他」: CSV テンプレート（取込の権限のときだけ。R3）・デモ用の ZIP 2 種・
 *    デモを初期状態に戻す（取り消せない操作。確認ダイアログで範囲 1 行と必須チェック）
 *  - 閉じない: デモ表示の注記（DemoSimulationNotice）・架空の係数と為替の注記・架空値のバッジ・空状態
 *  - 既定で閉じる: 見本ファイルの一覧・紐づけ状況の表・原単位マスター（紐づけ直した直後と入力エラーで
 *    戻ったときは紐づけ状況を開いて描く）
 */

type SearchParams = Record<string, string | string[] | undefined>;
type StatusFilter = 'missing' | 'submitted' | 'all';

const BASE_PATH = '/enterprise/ghg/suppliers';

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 提出状況の絞り込み。既定は未提出の社がある限り「未提出」（督促が要る社から見る） */
function statusFilterOf(value: string | undefined, missingCount: number): StatusFilter {
  if (value === 'missing' || value === 'submitted' || value === 'all') return value;
  return missingCount > 0 ? 'missing' : 'all';
}

function statusHref(query: SearchParams, status: StatusFilter): string {
  const params = new URLSearchParams();
  const q = one(query.q);
  if (q) params.set('q', q);
  params.set('status', status);
  return `${BASE_PATH}?${params.toString()}#supplier-status`;
}

const FACTOR_CATEGORY_LABEL: Record<string, string> = {
  purchased_goods: '購入した製品',
  purchased_services: '購入したサービス',
};

const SUPPLIER_COLUMNS: DataTableColumn<SupplierBreakdownEntry>[] = [
  {
    key: 'name',
    header: 'サプライヤー',
    importance: 'primary',
    lockVisible: true,
    cell: (supplier) => <span className="font-medium text-ink">{supplier.name}</span>,
  },
  {
    key: 'status',
    header: '提出状況',
    importance: 'primary',
    cell: (supplier) =>
      supplier.submitted ? (
        <SemanticBadge semantic="done" label="提出済み" />
      ) : (
        <SemanticBadge semantic="pending" label="未提出" />
      ),
  },
  {
    key: 'total',
    header: '排出量（t-CO2e）',
    importance: 'primary',
    align: 'right',
    cell: (supplier) => (
      <span className="tnum">{supplier.submitted ? formatNumber(supplier.total) : '—'}</span>
    ),
  },
  {
    key: 'share',
    header: '構成比',
    importance: 'secondary',
    align: 'right',
    cell: (supplier) => (
      <span className="tnum">
        {supplier.sharePercent === null ? '—' : `${supplier.sharePercent}%`}
      </span>
    ),
  },
  {
    key: 'code',
    header: 'コード',
    importance: 'detail',
    cell: (supplier) => <span className="font-mono text-caption">{supplier.code}</span>,
  },
  {
    key: 'rows',
    header: '内訳行数',
    importance: 'detail',
    align: 'right',
    cell: (supplier) => (
      <span className="tnum">{supplier.submitted ? supplier.inputs.length : '—'}</span>
    ),
  },
];

export default async function GhgSuppliersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const breakdown = await loadScope3SupplierBreakdown(shell.db, shell.ctx, shell.currentPeriod.id);
  const demo = getAppMode() === 'demo';

  const missing = breakdown.suppliers.filter((s) => !s.submitted);
  const canImport = can(shell.ctx, 'enterprise.import.run');
  const importPermission = PERMISSION_LABELS['enterprise.import.run'];
  // 紐づけ直した直後と、入力エラーで戻ったとき（紐づけ直しの失敗もここに戻る）は紐づけ状況を開いて描く
  const openLinks = query.flash === 'factorRelinked' || typeof query.error === 'string';

  const factorById = new Map(breakdown.factors.map((f) => [f.id, f]));
  // 係数の鍵はコード × 年度（同じコードに年度が 2 つ以上あれば「コード@年度」で選ぶ。plan GE-02）
  const factorIndex = cat1FactorIndex(breakdown.factors);
  // 架空値の注記は架空の係数（Fixture）があるときに出す（組織が登録した係数を架空と書かない。plan CR-16）。
  // Demo Mode は係数がすべて架空なので常に出る
  const showFictionalFactors =
    demo || breakdown.factors.some((f) => f.factorSource.startsWith('FIXTURE'));
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

  // 提出状況（50 社）: 未提出／提出済み／すべて・検索・25 件のページ送り
  const statusFilter = statusFilterOf(one(query.status), missing.length);
  const q = (one(query.q) ?? '').trim().toLowerCase();
  const statusRows = breakdown.suppliers.filter(
    (s) =>
      (statusFilter === 'all' || (statusFilter === 'missing' ? !s.submitted : s.submitted)) &&
      (q === '' || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)),
  );
  const sizes = [25, 50, 100] as const;
  const pageSize = parsePageSize(query.size, sizes);
  const lastPage = Math.max(1, Math.ceil(statusRows.length / pageSize));
  const page = Math.min(parsePage(query.page), lastPage);
  const tableQuery = { ...query, status: statusFilter };

  const more: MenuActionSpec[] = [
    {
      kind: 'link',
      id: 'csv-template',
      label: 'CSV テンプレート',
      icon: <Download aria-hidden="true" />,
      // a 要素で落とす（Next の Link だと RSC フェッチになりダウンロードにならない）
      href: `/api/exports/supplier-template?period=${shell.currentPeriod.id}`,
      download: true,
      group: 'export',
      // テンプレートの API は取込の権限を求める。権限の無い役割に 403 になるリンクを出さない（R3）
      hidden: !canImport,
    },
    {
      kind: 'link',
      id: 'demo-zip-upload',
      label: '投入用 ZIP（20 ファイルのみ）',
      icon: <Download aria-hidden="true" />,
      href: '/demo/murata-scope3-cat1-upload.zip',
      download: true,
      group: 'export',
      hidden: !canImport || !demo,
    },
    {
      kind: 'link',
      id: 'demo-zip-full',
      label: '一式 ZIP（正解データ・手順書つき）',
      icon: <Download aria-hidden="true" />,
      href: '/demo/murata-scope3-cat1-full.zip',
      download: true,
      group: 'export',
      hidden: !canImport || !demo,
    },
    {
      kind: 'confirm',
      id: 'reset-supplier-demo',
      label: 'デモを初期状態に戻す',
      icon: <RotateCcw aria-hidden="true" />,
      destructive: true,
      group: 'advanced',
      hidden: !canImport || !demo,
      action: resetSupplierDemoAction,
      fields: { reportingPeriodId: shell.currentPeriod.id },
      confirm: {
        tier: 'irreversible',
        title: 'サプライヤーデモの算定版をリセットしますか',
        // 「上記の削除範囲」が指す 1 行。ダイアログの本文に常に出す（閉じない）
        scope: `削除範囲: この組織 × ${shell.currentPeriod.label} の Scope3 Cat.1 に「サプライヤーデータ取込・原単位の再紐づけ」で追記された算定版のみ。`,
        consequences: [
          '取り消せません（Demo Mode 専用の操作です）。',
          '初期の算定内訳（版 1）は残ります。同じファイルを再投入すると同じ結果になります。',
        ],
        preview: (
          <MoreInfo label="リセットで変わらないもの">
            <p>
              初期の算定内訳（版 1）・Data Point 本体・承認履歴・他の指標・ログイン情報・
              ブラウザの他の保存領域には触りません。
            </p>
          </MoreInfo>
        ),
        acknowledge: { name: 'confirmScope', label: '上記の削除範囲を確認しました' },
        confirmLabel: '取込済みの算定版をリセットする',
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="サプライヤーデータ取込"
        description={`${shell.currentPeriod.label} ／ Scope3 Category 1（購入した製品・サービス）の一次データを取り込む`}
        help={
          <>
            <p>
              排出量（t-CO2e）のほか、物理量（kWh・m3・L・kg）・金額（千円）の素データを受け付け、規則ベースで自動仕訳します。
            </p>
            <p>
              物理量・金額の行は原単位（排出係数）と紐づけて排出量へ換算します。紐づけは取込のプレビューと、確定後の紐づけ状況の表で変えられます（新しい算定版を追記し、過去の版は残ります）。
            </p>
            <p>Data Point の確定値は変えません（値の変更は承認フローで行います）。</p>
          </>
        }
        autoBreadcrumbs
        actions={<PageActions more={more} />}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {demo && <DemoSimulationNotice />}
        {demo && canImport && (
          // 架空の係数・為替で実算定に使えないことは誠実さの注記なので閉じない。
          // データセットの ZIP は見出しの「その他」から取得する
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-muted">
            <HonestyBadge kind="fictional" />
            <span>
              Scope3 Cat.1 デモデータセット（電子部品メーカー・20 ファイル 240
              明細。「その他」から取得）の係数コード（DEMO-EF-*）・為替レートはすべて架空の説明用で、実算定には使用できません。
            </span>
            <MoreInfo label="データセットの内容（20 ファイル・架空サプライヤー 20 社）">
              <p>
                架空の電子部品メーカーを想定した Scope3 カテゴリー1（購入した製品・サービス）の
                購買データです。20 ファイル（Excel 14 ／ CSV 6・日英混在）に架空サプライヤー 20 社 ×
                各 12 明細＝240 明細を収録。下の取込へ 20 ファイルまとめてドロップできます。
              </p>
            </MoreInfo>
          </div>
        )}

        {/* 提出の進捗は「n / N 社」を文字で書き、帯は補助（% や色の段階で良し悪しを示さない） */}
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1.5 rounded-t4d border border-line bg-surface p-2.5">
            <FractionBar
              label="サプライヤー提出"
              numerator={breakdown.submittedCount}
              denominator={breakdown.suppliers.length}
              unit="社"
            />
            <p className="text-caption text-ink">
              未提出 <span className="tabular-nums">{missing.length}</span> 社
            </p>
          </div>
          <div className="space-y-1 rounded-t4d border border-line bg-surface p-2.5">
            {/* 金額×係数（推計）を含むため「一次データ合計」とは呼ばない（W0 O6） */}
            <p className="text-caption text-ink-muted">内訳合計</p>
            <p className="text-figure font-semibold leading-none tabular-nums text-ink">
              {formatNumber(breakdown.breakdownTotal)}
              <span className="ml-1 text-caption font-normal text-ink-muted">t-CO2e</span>
            </p>
            <p className="text-caption text-ink-muted">
              うち一次データ（固有＋活動量ベース） {formatNumber(breakdown.primaryDataTotal)}
            </p>
          </div>
        </div>

        <Section
          title="ファイルから取り込む（排出量・物理量・金額の素データ ／ CSV・Excel）"
          summary="仕訳・原単位の解決は規則ベース（AI 不使用）／ 確定は人が行います"
        >
          {canImport ? (
            <SupplierUploadForm reportingPeriodId={shell.currentPeriod.id} />
          ) : (
            <p className="text-small text-ink-muted">
              取込には「{importPermission.label}」の権限が必要です。{importPermission.holders}
              に依頼してください。この画面では提出状況を確かめられます。
            </p>
          )}
        </Section>

        {canImport && (
          <Section
            id="supplier-demo-files"
            collapsible
            title="デモ用サンプルファイル（多様なフォーマット・言語）"
            summary={`見本 ${demoFiles.length} 件（ダウンロードして上の取込へドロップ）`}
            actions={<Badge tone="warning">架空データ</Badge>}
          >
            <ul className="divide-y divide-line">
              {demoFiles.map((file) => (
                <li key={file.key} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <p className="text-body font-medium text-ink">{file.title}</p>
                    <p className="text-caption text-ink-muted">{file.description}</p>
                  </div>
                  <a
                    href={`/api/exports/supplier-demo-files?file=${file.key}`}
                    download
                    aria-label={`${file.title} をダウンロード`}
                    className="inline-flex shrink-0 items-center gap-1 text-small text-brand-700 hover:underline"
                  >
                    <Download className="size-3.5" aria-hidden="true" />
                    ダウンロード
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section
          id="supplier-status"
          title={`サプライヤー別の提出状況（${breakdown.submittedCount} / ${breakdown.suppliers.length} 社）`}
          actions={
            <Link href="/enterprise/ghg" className="text-small text-brand-700 hover:underline">
              内訳の可視化を見る
            </Link>
          }
        >
          <SegmentedFilter
            ariaLabel="提出状況で絞り込む"
            className="mb-1.5"
            current={statusFilter}
            items={[
              {
                key: 'missing',
                label: '未提出',
                href: statusHref(query, 'missing'),
                count: missing.length,
                attention: missing.length > 0,
              },
              {
                key: 'submitted',
                label: '提出済み',
                href: statusHref(query, 'submitted'),
                count: breakdown.submittedCount,
              },
              {
                key: 'all',
                label: 'すべて',
                href: statusHref(query, 'all'),
                count: breakdown.suppliers.length,
              },
            ]}
          />
          <DataTable<SupplierBreakdownEntry>
            id="supplier-status-table"
            caption="サプライヤーごとの提出状況"
            columns={SUPPLIER_COLUMNS}
            rows={statusRows.slice((page - 1) * pageSize, page * pageSize)}
            getRowId={(s) => s.unitId}
            getRowLabel={(s) => s.name}
            searchParams={tableQuery}
            basePath={BASE_PATH}
            search={{ placeholder: 'サプライヤー名・コードで検索' }}
            page={{ page, pageSize, total: statusRows.length, sizes }}
            empty={{
              noData:
                statusFilter === 'missing'
                  ? {
                      title: '未提出のサプライヤーはありません',
                      action: (
                        <Link
                          href={statusHref(query, 'all')}
                          className="text-small text-brand-700 underline underline-offset-2"
                        >
                          すべてのサプライヤーを見る
                        </Link>
                      ),
                    }
                  : {
                      title: 'サプライヤーが登録されていません',
                      description:
                        'サプライヤーは組織・拠点に種別「サプライヤー」として登録します。',
                      action: (
                        <Link
                          href="/enterprise/organizations?tab=units"
                          className="text-small text-brand-700 underline underline-offset-2"
                        >
                          組織・拠点を開く
                        </Link>
                      ),
                    },
            }}
          />
        </Section>

        {linkedRows.length === 0 ? (
          // 空状態は閉じない
          <Section title={`排出量原単位の紐づけ状況（素データ ${linkedRows.length} 行）`}>
            <p className="text-small text-ink-muted">
              活動量を持つ内訳行がまだありません。物理量・金額の素データを取り込むとここに並びます。
            </p>
          </Section>
        ) : (
          <Section
            id="supplier-factor-links"
            collapsible
            title={`排出量原単位の紐づけ状況（素データ ${linkedRows.length} 行）`}
            summary={`${linkedRows.length} 行の原単位と変更（紐づけ直すと新しい算定版を追記し、過去の版は残ります）`}
            open={openLinks}
          >
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
                          <span className="ml-1 font-mono text-caption font-normal text-ink-muted">
                            {supplier.code}
                          </span>
                        </TD>
                        <TD>{input.item}</TD>
                        <TD align="right">{formatNumber(input.activityAmount)}</TD>
                        <TD className="text-caption">{input.activityUnit}</TD>
                        <TD className="text-caption">
                          {factor ? (
                            <>
                              {factor.name}
                              <span className="ml-1 font-mono text-ink-muted">{factor.code}</span>
                              <span className="ml-1 text-ink-muted">
                                （{factor.factorYear} 年度）
                              </span>
                            </>
                          ) : (
                            <span className="text-ink-muted">不明（旧形式）</span>
                          )}
                        </TD>
                        <TD align="right">{formatNumber(input.value)}</TD>
                        {canImport && (
                          <TD>
                            {candidates.length > 1 ? (
                              <FactorRelinkDialog
                                reportingPeriodId={shell.currentPeriod.id}
                                supplierCode={supplier.code}
                                supplierName={supplier.name}
                                item={input.item}
                                activityAmount={input.activityAmount ?? 0}
                                activityUnit={input.activityUnit ?? ''}
                                currentValue={input.value}
                                currentRef={factor ? factorIndex.refOf(factor) : ''}
                                candidates={candidates.map((candidate) => ({
                                  ref: factorIndex.refOf(candidate),
                                  code: candidate.code,
                                  name: candidate.name,
                                  factorValue: candidate.factorValue,
                                  factorUnit: candidate.factorUnit,
                                  factorYear: candidate.factorYear,
                                }))}
                              />
                            ) : (
                              <span className="inline-flex items-center gap-1 text-caption text-ink-muted">
                                <Link2 className="size-3" aria-hidden="true" />
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
          </Section>
        )}

        {/* 題と架空値のバッジは折りたたみの外（閉じていても見える）。GHG 画面の排出係数マスターもここを指す（T8） */}
        <Section
          id="supplier-emission-factors"
          collapsible
          title={`排出量原単位（排出係数）マスター（${breakdown.factors.length}）`}
          summary={`原単位 ${breakdown.factors.length} 件（CSV の「排出係数コード」列に記入するコード）`}
          actions={
            showFictionalFactors ? (
              <Badge tone="warning">架空値（実係数ではありません）</Badge>
            ) : undefined
          }
        >
          <div className="t4d-scroll-x">
            <Table>
              <THead>
                <TR>
                  <TH>コード</TH>
                  <TH>名称</TH>
                  <TH>区分</TH>
                  <TH align="right">係数</TH>
                  <TH>単位</TH>
                  <TH>活動量単位</TH>
                  <TH>用途</TH>
                  <TH align="right">係数年度</TH>
                  <TH>出典</TH>
                </TR>
              </THead>
              <TBody>
                {breakdown.factors.map((factor) => (
                  <TR key={factor.id}>
                    <TD className="font-mono text-caption">{factor.code}</TD>
                    <TD>{factor.name}</TD>
                    <TD className="text-caption">
                      {FACTOR_CATEGORY_LABEL[factor.category] ?? factor.category}
                    </TD>
                    <TD align="right">{factor.factorValue}</TD>
                    <TD className="text-caption">{factor.factorUnit}</TD>
                    <TD className="text-caption">{factor.activityUnit}</TD>
                    <TD className="text-caption">
                      {factor.activityUnit === '千円' ? '金額データ' : '物理データ'}
                    </TD>
                    <TD align="right">{factor.factorYear}</TD>
                    <TD className="text-caption text-ink-muted">{factor.factorSource}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <p className="pt-1.5 text-caption text-ink-muted">
            CSV
            の「排出係数コード」列にはこの一覧のコードを記入してください（空欄でも単位・過去実績から
            自動解決し、候補が複数のときは取込時に選べます）。
          </p>
        </Section>
      </div>
    </>
  );
}
