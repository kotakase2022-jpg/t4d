import Link from 'next/link';
import { ArrowLeft, CircleCheck, Clock, Database, NotebookPen } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
 * 定性情報は基準をまたいで使う資産なので CSRD の下には置かず、右上から開く（§9.1 ③）。
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
  const inScopeCount = overview.sections.filter((s) => s.inScope).length;
  const generatedCount = overview.sections.filter(
    (s) => s.draft !== null && s.draft.aiBody.trim() !== '',
  ).length;
  const confirmedCount = overview.sections.filter((s) => s.draft?.confirmedAt).length;

  return (
    <>
      <PageHeader
        title="CSRD 開示ドラフト"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {overview.period.label} ／ 節ごとに AI
              草案（候補）を作り、担当者が本文に採用・編集して確定します
            </span>
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

        <Card className="space-y-1 p-3">
          <p className="text-[12px] leading-relaxed text-ink">
            AI が草案に書けるのは、
            <span className="font-medium">
              担当者が確認して「対応済み」または「おおむね対応」とした要求事項
            </span>
            だけです。それ以外は本文に含めず、「書けなかった箇所」として理由とともに示します。数値は承認済みのものだけを使います。
          </p>
          <p className="text-[11px] text-ink-muted">
            AI 草案は候補です。「本文に採用」を押すまで本文には入らず、確定も担当者が行います。
            対象外（重要でない）・未判定の節は草案を作れません。節ドラフトの Word
            出力は未対応です（回答〔版・承認〕の出力は従来の経路のままです）。
          </p>
        </Card>

        <ul className="grid grid-cols-3 gap-2" aria-label="開示ドラフトの件数">
          <li>
            <Card className="space-y-1 p-2.5">
              <p className="text-[11px] text-ink-muted">評価対象の節</p>
              <p className="text-[20px] font-semibold leading-none tabular-nums text-ink">
                {inScopeCount}
                <span className="ml-1 text-[11px] font-normal text-ink-muted">
                  / {overview.sections.length} 節
                </span>
              </p>
            </Card>
          </li>
          <li>
            <Card className="space-y-1 p-2.5">
              <p className="text-[11px] text-ink-muted">AI 草案のある節</p>
              <p className="text-[20px] font-semibold leading-none tabular-nums text-ink">
                {generatedCount}
                <span className="ml-1 text-[11px] font-normal text-ink-muted">
                  / {overview.sections.length} 節
                </span>
              </p>
            </Card>
          </li>
          <li>
            <Card className="space-y-1 p-2.5">
              <p className="text-[11px] text-ink-muted">確定済みの節</p>
              <p className="text-[20px] font-semibold leading-none tabular-nums text-ink">
                {confirmedCount}
                <span className="ml-1 text-[11px] font-normal text-ink-muted">
                  / {overview.sections.length} 節
                </span>
              </p>
            </Card>
          </li>
        </ul>

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
            />
          ))
        )}
      </div>
    </>
  );
}
