import Link from 'next/link';
import { ArrowLeft, Bot, CircleAlert, ClipboardList } from 'lucide-react';
import { FilterBar, type FilterGroup } from '@/components/shared/filter-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  APPLICABILITY_LABEL,
  AREA_LABEL,
  COVERAGE_LABEL,
  COVERAGE_TONE,
  MATERIALITY_LABEL,
  PRIORITY_LABEL,
} from '@/lib/domain/ssbj';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { filterRequirements, loadSsbjRequirementViews } from '@/lib/services/ssbj-gap';

export const metadata = { title: 'SSBJ 要求事項一覧' };

/** クエリを配列にする（FilterBar は同じキーを複数回付ける） */
function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
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
          title="SSBJ 要求事項一覧"
          breadcrumbs={[{ label: '企業ワークスペース' }, { label: '開示対応' }, { label: 'SSBJ' }]}
        />
        <div className="p-4">
          <EmptyState title="SSBJ の要求事項マスターが登録されていません" />
        </div>
      </>
    );
  }

  const filtered = filterRequirements(loaded.views, {
    area: toList(query.area),
    coverage: toList(query.coverage),
    materiality: toList(query.materiality),
    priority: toList(query.priority),
    department: toList(query.department),
    search: typeof query.q === 'string' ? query.q : undefined,
  });

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

  return (
    <>
      <PageHeader
        title="SSBJ 要求事項一覧"
        description={`${loaded.versionLabel} ／ ${shell.currentPeriod.label} ／ 全 ${loaded.views.length} 要求事項`}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'SSBJ', href: '/enterprise/disclosures/ssbj' },
          { label: '要求事項一覧' },
        ]}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/enterprise/disclosures/ssbj">
              <ArrowLeft aria-hidden="true" />
              対応状況へ戻る
            </Link>
          </Button>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

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
