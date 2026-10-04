import Link from 'next/link';
import { ArrowLeft, Bot, CircleCheck, Clock, Database, NotebookPen } from 'lucide-react';
import { FractionBar } from '@/components/charts/fraction-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MoreInfo } from '@/components/ui/more-info';
import { getAiProvider } from '@/lib/ai';
import { AuthorizationError } from '@/lib/authorization/can';
import { loadCsrdDrafts, type CsrdDraftOverview } from '@/lib/services/csrd/draft';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { SampleMasterBadge } from '../_components/csrd-badges';
import { CsrdDraftSectionCard } from './_components/draft-section-card';

export const metadata = { title: 'CSRD 開示ドラフト' };

const BREADCRUMBS = [
  { label: '企業ワークスペース' },
  { label: '開示対応' },
  { label: 'CSRD', href: '/enterprise/disclosures/csrd' },
  { label: '開示ドラフト' },
];

/**
 * CSRD 開示ドラフト（docs/disclosure-first.md §9.4）。マスターに要求事項がある節
 * （ESRS 2・E1・E3・E5・S1・G1）ごとに、AI 草案（候補）→ 本文に採用（人）→ 編集・保存（人）→ 確定（人）。
 * 対象外（重要でない）・未判定の節は草案を作れず、その理由を示す。
 * 定性情報は基準をまたいで使う資産なので、右上からも開ける（§9.1 ③。メニューでは §10.1 ① で CSRD の下にも出す）。
 *
 * 文字量を減らす（§10.4）: 件数は分母付きの帯（FractionBar）、AI 草案に書ける範囲は閉じた説明。
 * 「AI 草案は候補・採用と確定は担当者」の 1 行と DMA の注記は常に見せる。
 */
export default async function CsrdDraftPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();

  let overview: CsrdDraftOverview | null;
  try {
    overview = await loadCsrdDrafts(shell.db, shell.ctx, shell.currentPeriod);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader title="CSRD 開示ドラフト" breadcrumbs={BREADCRUMBS} />
          <PermissionDeniedState description="CSRD の開示ドラフトを見るには、開示の閲覧権限が必要です。" />
        </>
      );
    }
    throw error;
  }

  const headerActions = (
    <div className="flex items-center gap-1.5">
      <Button variant="outline" size="sm" asChild>
        <Link href="/enterprise/narratives">
          <NotebookPen aria-hidden="true" />
          定性情報
        </Link>
      </Button>
      <Button variant="outline" size="sm" asChild>
        <Link href="/enterprise/disclosures/csrd/collection">
          <Database aria-hidden="true" />
          データ収集へ戻る
        </Link>
      </Button>
      <Button variant="outline" size="sm" asChild>
        <Link href="/enterprise/disclosures/csrd">
          <ArrowLeft aria-hidden="true" />
          対応状況へ戻る
        </Link>
      </Button>
    </div>
  );

  if (!overview) {
    return (
      <>
        <PageHeader title="CSRD 開示ドラフト" breadcrumbs={BREADCRUMBS} actions={headerActions} />
        <div className="p-4">
          <EmptyState title="CSRD の要求事項マスターが登録されていません" />
        </div>
      </>
    );
  }

  const aiMode = (await getAiProvider()).kind === 'mock' ? 'mock' : 'openai';
  // 草案の出所は、その草案を作った実行の提供元で示す（いまの設定で決めない）。
  // 実行の記録が無い草案（Fixture のデモ生成・押し出された実行）は Mock として示す
  const draftProviders = new Map<string, 'mock' | 'openai'>();
  for (const view of overview.sections) {
    const runId = view.draft?.aiRunId;
    const run = runId ? await shell.db.findById('aiRuns', runId) : null;
    const own = run && run.organizationId === shell.ctx.workspace.organizationId ? run : null;
    draftProviders.set(view.section, own && own.provider !== 'mock' ? 'openai' : 'mock');
  }
  const inScopeCount = overview.sections.filter((s) => s.inScope).length;
  const generatedCount = overview.sections.filter(
    (s) => s.draft !== null && s.draft.aiBody.trim() !== '',
  ).length;
  const confirmedCount = overview.confirmedCount;

  return (
    <>
      <PageHeader
        title="CSRD 開示ドラフト"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{overview.period.label} ／ 節ごとの AI 草案（候補）と担当者の本文</span>
            <SampleMasterBadge />
          </span>
        }
        breadcrumbs={BREADCRUMBS}
        actions={headerActions}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {overview.dmaConfirmed ? (
          <p className="flex items-center gap-1.5 rounded-t4d border border-success/40 bg-success-soft px-3 py-1.5 text-[12px] text-ink">
            <CircleCheck className="size-3.5 text-success" aria-hidden="true" />
            ダブル・マテリアリティ評価（DMA）は確定済みです。節の適用は確定した判断に基づきます。
          </p>
        ) : (
          <p className="flex flex-wrap items-center gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-[12px] text-ink">
            <Clock className="size-3.5 text-[#8a5d00]" aria-hidden="true" />
            ダブル・マテリアリティ評価（DMA）が未確定です。テーマ別の節の適用は暫定（DMA
            確定前）で、節の確定は DMA を確定してからできます。
            <Link href="/enterprise/disclosures/csrd/settings" className="text-brand-700 underline">
              DMA の設定・確定へ
            </Link>
          </p>
        )}

        <Card className="space-y-2 p-3">
          {/* AI 草案は候補で、採用と確定は担当者が行うこと（§0.4）は閉じずに見せる */}
          <p className="flex items-start gap-1.5 text-[12px] text-ink">
            <Bot className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
            AI 草案は候補です。「本文に採用」を押すまで本文には入らず、確定も担当者が行います。
          </p>
          <ul className="grid grid-cols-3 gap-4" aria-label="開示ドラフトの件数">
            <li>
              <FractionBar
                label="評価対象の節"
                numerator={inScopeCount}
                denominator={overview.sections.length}
                unit="節"
              />
            </li>
            <li>
              <FractionBar
                label="AI 草案のある節"
                numerator={generatedCount}
                denominator={overview.sections.length}
                unit="節"
              />
            </li>
            <li>
              <FractionBar
                label="確定済みの節"
                numerator={confirmedCount}
                denominator={overview.sections.length}
                unit="節"
              />
            </li>
          </ul>
          <MoreInfo label="AI 草案に書ける範囲">
            <p>
              AI
              が草案に書けるのは、担当者が確認して「対応済み」または「おおむね対応」とした要求事項だけです。それ以外は本文に含めず、「書けなかった箇所」として理由とともに示します。数値は承認済みのものだけを使います。
            </p>
            <p>
              対象外（重要でない）・未判定の節は草案を作れません。節ドラフトの Word
              出力は未対応です（回答〔版・承認〕の出力は従来の経路のままです）。
            </p>
          </MoreInfo>
        </Card>

        {overview.sections.length === 0 ? (
          <EmptyState title="要求事項のある節がありません" />
        ) : (
          overview.sections.map((view) => (
            <CsrdDraftSectionCard
              key={view.section}
              view={view}
              reportingPeriodId={overview.period.id}
              canWrite={overview.canWrite}
              canRunAi={overview.canRunAi}
              aiMode={aiMode}
              draftProvider={draftProviders.get(view.section) ?? 'mock'}
            />
          ))
        )}
      </div>
    </>
  );
}
