import Link from 'next/link';
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  ClipboardList,
  Database,
  FileText,
  Scale,
  Settings2,
  Target,
  UserCheck,
} from 'lucide-react';
import { runSsbjGapAnalysisBulkAction } from '@/app/enterprise/actions';
import { FilterBar, type FilterGroup } from '@/components/shared/filter-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import {
  APPLICABILITY_LABEL,
  AREA_LABEL,
  COVERAGE_LABEL,
  COVERAGE_TONE,
  MATERIALITY_LABEL,
  PRIORITY_LABEL,
} from '@/lib/domain/ssbj';
import {
  CATEGORY_LABEL,
  MATERIALITY_LABEL as MATERIALITY_LEVEL_LABEL,
} from '@/lib/services/materiality';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  filterRequirements,
  loadSsbjRequirementViews,
  loadSsbjScopeMapping,
} from '@/lib/services/ssbj-gap';

export const metadata = { title: 'SSBJ 要求事項の評価' };

/** クエリを配列にする（FilterBar は同じキーを複数回付ける） */
function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** マッピング表のセル。●／— の形で示し、読み上げには言葉を渡す（色に頼らない） */
function MappingCell({ active }: { active: boolean }) {
  return (
    <span className={active ? 'font-semibold text-brand-700' : 'text-ink-muted'}>
      <span aria-hidden="true">{active ? '●' : '—'}</span>
      <span className="sr-only">{active ? '対象' : '対象外'}</span>
    </span>
  );
}

export default async function SsbjRequirementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();

  const loaded = await loadSsbjRequirementViews(shell.db, shell.ctx, shell.currentPeriod);
  if (!loaded) {
    return (
      <>
        <PageHeader
          title="SSBJ 要求事項の評価"
          breadcrumbs={[{ label: '企業ワークスペース' }, { label: '開示対応' }, { label: 'SSBJ' }]}
        />
        <div className="p-4">
          <EmptyState title="SSBJ の要求事項マスターが登録されていません" />
        </div>
      </>
    );
  }

  const mapping = await loadSsbjScopeMapping(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    loaded.views,
  );
  const canRunAi = can(shell.ctx, 'enterprise.ai.run');

  const filtered = filterRequirements(loaded.views, {
    area: toList(query.area),
    coverage: toList(query.coverage),
    materiality: toList(query.materiality),
    priority: toList(query.priority),
    department: toList(query.department),
    linkage: toList(query.linkage),
    search: typeof query.q === 'string' ? query.q : undefined,
  });

  // 工程チップの件数は、リンク先の絞り込みと同じ関数で数える（数字とリンク先がズレない）
  const stages = [
    {
      step: '工程 1',
      title: '対象判定・重要性判断',
      icon: Scale,
      count: filterRequirements(loaded.views, { materiality: ['not_assessed'] }).length,
      countLabel: '重要性が未判定',
      query: 'materiality=not_assessed',
      description: '適用の有無と重要性を判断します。',
    },
    {
      step: '工程 2',
      title: '人工知能によるギャップ分析',
      icon: Bot,
      count: filterRequirements(loaded.views, { linkage: ['unanalyzed'] }).length,
      countLabel: '未分析',
      query: 'linkage=unanalyzed',
      description: '既存資料と突き合わせて判定の候補を作ります。',
    },
    {
      step: '工程 3',
      title: '担当者による確認',
      icon: UserCheck,
      count: filterRequirements(loaded.views, { coverage: ['unconfirmed'] }).length,
      countLabel: '確認待ち',
      query: 'coverage=unconfirmed',
      description: '候補を確認・修正して最終判定を入れます。',
    },
    {
      step: '工程 4',
      title: 'ギャップの優先順位付け',
      icon: Target,
      count: filterRequirements(loaded.views, { priority: ['high'] }).length,
      countLabel: '優先度「高」',
      query: 'priority=high',
      description: '重要性・期限・データの有無から着手順を決めます。',
    },
  ];

  // 担当部署は自由入力なので、実際に使われている値から選択肢を作る
  const departments = [
    ...new Set(loaded.views.map((v) => v.assessment.ownerDepartment).filter((d) => d !== '')),
  ].sort();

  const groups: FilterGroup[] = [
    {
      key: 'area',
      label: '領域',
      options: [
        { value: 'governance', label: 'ガバナンス' },
        { value: 'strategy', label: '戦略' },
        { value: 'risk', label: 'リスク管理' },
        { value: 'metrics', label: '指標及び目標' },
        { value: 'other', label: 'その他' },
      ],
    },
    {
      key: 'coverage',
      label: '対応状況',
      options: [
        { value: 'covered', label: '対応済み' },
        { value: 'mostly_covered', label: 'おおむね対応' },
        { value: 'partial', label: '一部対応' },
        { value: 'not_covered', label: '未対応' },
        { value: 'unconfirmed', label: '未確認' },
      ],
    },
    {
      key: 'materiality',
      label: '重要性',
      options: [
        { value: 'material', label: '重要性あり' },
        { value: 'not_material', label: '重要性なし' },
        { value: 'not_assessed', label: '未判定' },
      ],
    },
    {
      key: 'priority',
      label: '優先度',
      options: [
        { value: 'high', label: '高' },
        { value: 'medium', label: '中' },
        { value: 'low', label: '低' },
      ],
    },
    {
      key: 'linkage',
      label: '紐づけ',
      options: [
        { value: 'document', label: '資料と紐づけ済み' },
        { value: 'data', label: 'データあり' },
        { value: 'unanalyzed', label: '未分析' },
        { value: 'none', label: '紐づけできず' },
      ],
    },
    ...(departments.length > 0
      ? [
          {
            key: 'department',
            label: '担当部署',
            options: departments.map((d) => ({ value: d, label: d })),
          },
        ]
      : []),
  ];

  const appliedStandards = [
    { label: '一般開示基準', applied: mapping.applied.general },
    { label: '気候関連開示基準', applied: mapping.applied.climate },
    { label: '実務対応（第1号）', applied: mapping.applied.practical },
  ];

  return (
    <>
      <PageHeader
        title="SSBJ 要求事項の評価"
        description={`${loaded.versionLabel} ／ ${shell.currentPeriod.label} ／ 対象判定から優先順位付けまでをこの画面で進めます`}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'SSBJ', href: '/enterprise/disclosures/ssbj' },
          { label: '要求事項の評価' },
        ]}
        actions={
          <div className="flex items-center gap-1.5">
            {/* 133 項目を 1 件ずつ分析するのは現実的でないため、まとめ実行を用意する。
                判定はあくまで候補。最終判定は工程 3 の担当者確認で入る */}
            {canRunAi && stages[1] && stages[1].count > 0 && (
              <form action={runSsbjGapAnalysisBulkAction}>
                <SubmitButton size="sm" icon={<Bot aria-hidden="true" />} pendingLabel="分析中…">
                  未分析をまとめて分析（最大 20 件）
                </SubmitButton>
              </form>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/disclosures/ssbj">
                <ArrowLeft aria-hidden="true" />
                対応状況へ戻る
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 旧・工程③〜⑥を 1 画面に統合。どの工程に何件残っているかを先頭で示す */}
        <ul className="grid grid-cols-4 gap-2">
          {stages.map((stage) => (
            <li key={stage.title}>
              <Link
                href={`/enterprise/disclosures/ssbj/requirements?${stage.query}`}
                className="block h-full rounded-t4d-lg border border-line bg-surface p-3 shadow-[0_1px_2px_rgba(23,32,51,0.04)] transition-colors hover:border-brand-300 hover:bg-brand-50"
              >
                <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                  <stage.icon className="size-3.5" aria-hidden="true" />
                  {stage.step}
                </p>
                <p className="mt-1 text-[13px] font-semibold text-ink">{stage.title}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                  {stage.description}
                </p>
                <p className="mt-1.5 text-[12px]">
                  <span
                    className={`font-semibold tabular-nums ${stage.count > 0 ? 'text-brand-700' : 'text-ink-muted'}`}
                  >
                    {stage.countLabel} {stage.count} 件
                  </span>
                </p>
              </Link>
            </li>
          ))}
        </ul>

        {/* ③ 必要な要求項目のみが正しく表示されているか（SSBJ 要求事項とのマッピング） */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="SSBJ 要求事項とのマッピング"
            action={
              <Button variant="outline" size="xs" asChild>
                <Link href="/enterprise/disclosures/ssbj/settings">
                  <Settings2 aria-hidden="true" />
                  マテリアリティ・分析条件を変更する
                </Link>
              </Button>
            }
          />

          {/* 件数の流れ。「なぜこの件数なのか」を画面上で検算できるようにする */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12px] text-ink">
            <span className="rounded-t4d border border-line bg-surface-muted px-2 py-1">
              正式基準マスター{' '}
              <strong className="tabular-nums">{mapping.counts.masterTotal}</strong> 項目
            </span>
            <span aria-hidden="true">→</span>
            <span className="rounded-t4d border border-line bg-surface-muted px-2 py-1">
              適用基準で <strong className="tabular-nums">{mapping.counts.afterStandards}</strong>{' '}
              項目
            </span>
            <span aria-hidden="true">→</span>
            <span className="rounded-t4d border border-line bg-surface-muted px-2 py-1">
              対象外 <strong className="tabular-nums">{mapping.counts.notApplicable}</strong>{' '}
              件・重要性なし <strong className="tabular-nums">{mapping.counts.notMaterial}</strong>{' '}
              件を除外
            </span>
            <span aria-hidden="true">→</span>
            <span className="rounded-t4d border border-brand-300 bg-brand-50 px-2 py-1 font-medium text-brand-800">
              評価対象 <strong className="tabular-nums">{mapping.counts.inScope}</strong> 項目
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <span className="text-[11px] text-ink-muted">適用中の基準:</span>
            {appliedStandards.map((s) => (
              <Badge key={s.label} tone={s.applied ? 'brand' : 'outline'}>
                {s.label} {s.applied ? '適用' : '適用外'}
              </Badge>
            ))}
            {!mapping.configured && (
              <Badge tone="warning">
                <CircleAlert className="size-3" aria-hidden="true" />
                分析条件が未設定のため既定（一般・気候）で表示中
              </Badge>
            )}
          </div>

          {mapping.rows.length === 0 ? (
            <EmptyState
              title="マテリアリティが未登録です"
              description="「①マテリアリティ・分析条件の設定」で自社の重要課題を登録すると、要求事項との対応がここに表示されます。"
              action={
                <Button size="sm" asChild>
                  <Link href="/enterprise/disclosures/ssbj/settings">
                    <Target aria-hidden="true" />
                    登録しに行く
                  </Link>
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>マテリアリティ</TH>
                  <TH>区分</TH>
                  <TH>評価</TH>
                  <TH align="center">一般開示基準</TH>
                  <TH align="center">気候関連開示基準</TH>
                  <TH align="right">項目（対象指標）</TH>
                  <TH align="right">紐づく要求事項</TH>
                </TR>
              </THead>
              <TBody>
                {mapping.rows.map((row) => (
                  <TR key={row.title}>
                    <TD className="font-medium text-ink">
                      <span className="flex items-center gap-1.5">
                        <Target className="size-3.5 text-ink-muted" aria-hidden="true" />
                        {row.title}
                      </span>
                    </TD>
                    <TD>{CATEGORY_LABEL[row.category]}</TD>
                    <TD>
                      <Badge tone={row.materiality === 'high' ? 'danger' : 'neutral'}>
                        {MATERIALITY_LEVEL_LABEL[row.materiality]}
                      </Badge>
                    </TD>
                    {/* 一般開示基準はサステナビリティ課題すべてが対象。
                        気候関連開示基準は、気候に関わる課題だけが対象になる */}
                    <TD align="center">
                      <MappingCell active={mapping.applied.general} />
                    </TD>
                    <TD align="center">
                      <MappingCell active={mapping.applied.climate && row.climate} />
                    </TD>
                    <TD align="right" className="tabular-nums">
                      {row.metricCount}
                    </TD>
                    <TD align="right" className="tabular-nums">
                      {row.linkedItemCount > 0 ? (
                        row.linkedItemCount
                      ) : (
                        <span className="text-ink-muted">0</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            ● = 開示対象になりやすい基準／— = 対象になりにくい基準。区分の判定は登録時と同じ規則
            （名前・内容・リスク・機会の記述に含まれる語）で行っています。「紐づく要求事項」は、
            マテリアリティの項目（対象指標）を要求する評価対象の要求事項の数です。
          </p>
        </Card>

        {/* ③ 必要な要求項目のうち、取込資料・データによって紐づけ可能／不可 */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="取込資料・データとの紐づけ"
            action={
              <span className="text-[11px] text-ink-muted">
                対象外を除く {mapping.counts.afterStandards - mapping.counts.notApplicable}{' '}
                件で集計。選ぶと一覧を絞り込みます
              </span>
            }
          />
          <ul className="grid grid-cols-4 gap-2 p-3">
            {[
              {
                label: '資料と紐づけ済み',
                count: mapping.linkage.document,
                query: 'linkage=document',
                icon: FileText,
                note: '人工知能の分析で、取込資料に該当箇所が見つかった要求事項',
              },
              {
                label: 'データあり',
                count: mapping.linkage.data,
                query: 'linkage=data',
                icon: Database,
                note: '要求する指標に当期の値が登録されている要求事項',
              },
              {
                label: '未分析',
                count: mapping.linkage.unanalyzed,
                query: 'linkage=unanalyzed',
                icon: Bot,
                note: '人工知能の分析を実行していない要求事項',
              },
              {
                label: '紐づけできず',
                count: mapping.linkage.none,
                query: 'linkage=none',
                icon: CircleAlert,
                note: '分析済みだが、資料にもデータにも紐づかなかった要求事項',
              },
            ].map((tile) => (
              <li key={tile.label}>
                <Link
                  href={`/enterprise/disclosures/ssbj/requirements?${tile.query}`}
                  className="block h-full rounded-t4d border border-line p-2.5 transition-colors hover:border-brand-300 hover:bg-brand-50"
                >
                  <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                    <tile.icon className="size-3.5 text-ink-muted" aria-hidden="true" />
                    {tile.label}
                  </p>
                  <p className="mt-1 text-[20px] font-semibold leading-none tabular-nums text-ink">
                    {tile.count}
                    <span className="ml-0.5 text-[12px] font-normal text-ink-muted">件</span>
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{tile.note}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <FilterBar
          groups={groups}
          searchPlaceholder="要求事項番号・見出し・担当部署で検索"
          total={filtered.length}
          savedViews={[
            {
              label: '未対応のみ',
              query: 'coverage=not_covered',
              description: '対応できていない要求事項',
            },
            {
              label: '優先度「高」',
              query: 'priority=high',
              description: '初年度対応を優先する項目',
            },
            {
              label: '確認待ち',
              query: 'coverage=unconfirmed',
              description: '担当者の確認が済んでいない項目',
            },
            {
              label: '紐づけできず',
              query: 'linkage=none',
              description: '資料にもデータにも紐づかない項目',
            },
          ]}
        />

        <Card className="overflow-hidden">
          <SectionTitle
            title={`要求事項（${filtered.length} 件）`}
            action={
              <span className="text-[11px] text-ink-muted">
                行を選ぶと、要求事項と現在の開示内容を並べて確認できます
              </span>
            }
          />
          {filtered.length === 0 ? (
            <EmptyState
              title="該当する要求事項がありません"
              description="絞り込み条件を変更してください。"
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>要求事項</TH>
                  <TH>領域</TH>
                  <TH>適用区分</TH>
                  <TH>重要性</TH>
                  <TH>人工知能による判定</TH>
                  <TH>紐づけ</TH>
                  <TH>最終判定</TH>
                  <TH>優先度</TH>
                  <TH>担当部署</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((view) => {
                  const a = view.assessment;
                  return (
                    <TR key={view.item.id}>
                      <TD className="max-w-[360px]">
                        <Link
                          href={`/enterprise/disclosures/ssbj/requirements/${view.item.id}`}
                          className="font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          <span className="font-mono text-[11px]">{view.item.code}</span>{' '}
                          {view.item.questionText}
                        </Link>
                        {view.plans.length > 0 && (
                          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                            <ClipboardList className="size-3" aria-hidden="true" />
                            対応計画 {view.plans.length} 件
                          </span>
                        )}
                      </TD>
                      <TD>{AREA_LABEL[view.area]}</TD>
                      <TD>
                        <Badge tone={a.applicability === 'applicable' ? 'neutral' : 'outline'}>
                          {APPLICABILITY_LABEL[a.applicability]}
                        </Badge>
                      </TD>
                      <TD>
                        <Badge tone={a.materiality === 'material' ? 'brand' : 'neutral'}>
                          {MATERIALITY_LABEL[a.materiality]}
                        </Badge>
                      </TD>
                      <TD>
                        {a.aiStatus === null ? (
                          <span className="text-[11px] text-ink-muted">未実施</span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <Bot className="size-3 text-ink-muted" aria-hidden="true" />
                            <span className="text-[12px]">{COVERAGE_LABEL[a.aiStatus]}</span>
                          </span>
                        )}
                      </TD>
                      <TD>
                        {!view.analyzed ? (
                          <span className="text-[11px] text-ink-muted">未分析</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {view.hasDocumentLink && (
                              <Badge tone="neutral">
                                <FileText className="size-3" aria-hidden="true" />
                                資料
                              </Badge>
                            )}
                            {view.hasDataLink && (
                              <Badge tone="neutral">
                                <Database className="size-3" aria-hidden="true" />
                                データ
                              </Badge>
                            )}
                            {!view.hasDocumentLink && !view.hasDataLink && (
                              <Badge tone="warning">
                                <CircleAlert className="size-3" aria-hidden="true" />
                                なし
                              </Badge>
                            )}
                          </span>
                        )}
                      </TD>
                      <TD>
                        {a.finalStatus === null ? (
                          <Badge tone="warning">
                            <CircleAlert className="size-3" aria-hidden="true" />
                            確認待ち
                          </Badge>
                        ) : (
                          <Badge tone={COVERAGE_TONE[a.finalStatus]}>
                            {COVERAGE_LABEL[a.finalStatus]}
                          </Badge>
                        )}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            view.priority.priority === 'high'
                              ? 'danger'
                              : view.priority.priority === 'medium'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {PRIORITY_LABEL[view.priority.priority]}
                        </Badge>
                      </TD>
                      <TD className="text-[11px]">{a.ownerDepartment || '未設定'}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
