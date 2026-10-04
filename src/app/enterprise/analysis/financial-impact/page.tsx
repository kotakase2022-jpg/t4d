import { CalendarOff } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Card } from '@/components/ui/card';
import { can } from '@/lib/authorization/can';
import { isDemoMode } from '@/lib/config';
import { loadFinancialImpact } from '@/lib/services/analysis/financial-impact';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { ImpactNotices, ParamNotices } from './_components/impact-badges';
import { ReadyView } from './_components/ready-view';

export const metadata = { title: '財務影響分析' };

/**
 * 財務影響分析（docs/disclosure-first.md §10.3）。閲覧専用。
 *
 * 承認済みの非財務データ（基準年度の確定値）× 画面に示した仮定（URL）による決定論的な試算。
 * 予測・保証ではなく、統計的な推定（回帰・弾性値・因果推定）は行わない。この注記・架空の前提（Demo Mode）・
 * データの厚みは折りたたまない（§10.4）。仮定・シナリオは URL にだけ載せ、Cookie・DB に保存しない。
 * 定性情報・IRO は経路との関連を示すだけで、円に換算しない。良し悪しを色で示さない（矢印＋符号＋文字）。
 */

type SearchParams = Record<string, string | string[] | undefined>;

export default async function FinancialImpactPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const header = (
    <PageHeader
      title="財務影響分析"
      description="非財務データと仮定から、財務への影響を経路ごとに試算します"
      help={
        <>
          <p>
            基準年度は、ヘッダーの年度（{shell.currentPeriod.code}
            ）以前で締めた（closed）最新の報告期間です。起点はその年度の確定値（全拠点承認済みの連結値）だけで、当年度の途中の値・推計・前年値の補完は使いません。
          </p>
          <p>
            試算期間は基準年度の翌年度から 10 年間です。年度は画面上部のヘッダーで切り替えます。
          </p>
          <p>
            金額は基準年度の費用構造からの営業利益の増減（＋増益・−減益）で、百万円・小数 1
            桁で示します。合計は定量化できた経路だけです。
          </p>
          <p>仮定とシナリオは URL に載せて共有できます（保存はしません）。</p>
        </>
      }
      breadcrumbs={[{ label: '企業ワークスペース' }, { label: '分析' }, { label: '財務影響分析' }]}
    />
  );
  if (!can(ctx, 'enterprise.data.read')) {
    return (
      <>
        {header}
        <div className="p-4">
          <PermissionDeniedState description="財務影響分析は、データの閲覧権限を持つ利用者のみ閲覧できます。" />
        </div>
      </>
    );
  }

  // 仮定の既定値・財務ベースラインは Demo Mode のときだけ（架空）。Supabase モードは既定値を持たない
  const view = await loadFinancialImpact(db, ctx, {
    period: shell.currentPeriod,
    source: isDemoMode() ? 'demo' : 'none',
    params: query,
  });

  return (
    <>
      {header}
      <div className="space-y-3 p-4">
        <ImpactNotices
          source={view.source}
          dataDepthYears={view.status === 'ready' ? view.dataDepthYears : null}
        />
        <ParamNotices notices={view.params.notices} />
        {view.status === 'ready' ? (
          <ReadyView view={view} />
        ) : (
          <Card>
            <EmptyState
              icon={<CalendarOff className="size-5" aria-hidden="true" />}
              title="基準年度がありません"
              description={`ヘッダーの年度（${view.period.code}）以前に、締めた（closed）報告期間がありません。起点の確定値を決められないため試算しません。`}
            />
          </Card>
        )}
      </div>
    </>
  );
}
