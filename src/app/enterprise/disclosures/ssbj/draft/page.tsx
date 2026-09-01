import Link from 'next/link';
import { ArrowLeft, Check, Download, Sparkles } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { formatJst } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadSsbjDrafts } from '@/lib/services/ssbj-draft';
import {
  confirmSsbjDraftAction,
  generateSsbjDraftAction,
  saveSsbjDraftAction,
} from '../../../actions';

export const metadata = { title: 'SSBJ 開示ドラフト' };

export default async function SsbjDraftPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const overview = await loadSsbjDrafts(shell.db, shell.ctx, shell.currentPeriod);

  if (!overview) {
    return (
      <>
        <PageHeader
          title="SSBJ 開示ドラフト"
          breadcrumbs={[
            { label: '企業ワークスペース' },
            { label: '開示対応' },
            { label: 'SSBJ', href: '/enterprise/disclosures/ssbj' },
            { label: '開示ドラフト' },
          ]}
        />
        <div className="p-4">
          <EmptyState title="SSBJ の要求事項マスターが登録されていません" />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="SSBJ 開示ドラフト"
        description={`${shell.currentPeriod.label} ／ 節ごとに草案を作り、担当者が直して確定します`}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'SSBJ', href: '/enterprise/disclosures/ssbj' },
          { label: '開示ドラフト' },
        ]}
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/api/exports/cdp?framework=ssbj&period=${shell.currentPeriod.id}&format=docx`}
                download
              >
                <Download aria-hidden="true" />
                Word で書き出す
              </a>
            </Button>
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

        <Card className="p-3">
          <p className="text-[12px] leading-relaxed text-ink">
            人工知能が書けるのは、
            <span className="font-medium">
              担当者が確認して「対応済み」または「おおむね対応」とした要求事項
            </span>
            だけです。未確認・未対応の事項は本文に含めず、「書けなかった箇所」として理由とともに示します。
            数値は承認済みのものだけを使います。
          </p>
          <p className="mt-1 text-[11px] text-ink-muted">
            生成されるのは草案です。そのまま開示せず、内容を確認し、必要な修正を加えてから確定してください。
          </p>
        </Card>

        {overview.areas.map((view) => {
          const draft = view.draft;
          return (
            <Card key={view.area} id={`draft-${view.area}`} className="overflow-hidden">
              <SectionTitle
                title={view.areaLabel}
                action={
                  <span className="flex items-center gap-2">
                    <span className="text-[11px] text-ink-muted">
                      対象 {view.requirementCount} 件 ／ 草案に書ける {view.writableCount} 件
                    </span>
                    {draft?.confirmedAt ? (
                      <Badge tone="success">確定済み</Badge>
                    ) : draft ? (
                      <Badge tone="warning">未確定</Badge>
                    ) : (
                      <Badge tone="neutral">未作成</Badge>
                    )}
                  </span>
                }
              />

              {!draft ? (
                <div className="space-y-2 p-3">
                  <p className="text-[12px] text-ink-muted">
                    まだ草案がありません。
                    {view.writableCount === 0 &&
                      '確認済みの要求事項が無いため、いま生成しても本文はほとんど空になります。先に担当者による確認を進めてください。'}
                  </p>
                  {overview.canRunAi && overview.canWrite && (
                    <form action={generateSsbjDraftAction}>
                      <input type="hidden" name="area" value={view.area} />
                      <SubmitButton
                        size="sm"
                        icon={<Sparkles aria-hidden="true" />}
                        pendingLabel="作成中…"
                      >
                        人工知能に草案を作らせる
                      </SubmitButton>
                    </form>
                  )}
                </div>
              ) : (
                <div className="space-y-2 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
                    {draft.aiGeneratedAt && (
                      <span>人工知能が作成: {formatJst(draft.aiGeneratedAt)}</span>
                    )}
                    {draft.aiConfidence !== null && (
                      <span>確信度 {Math.round(draft.aiConfidence * 100)}%</span>
                    )}
                    {view.edited && <Badge tone="brand">担当者が修正</Badge>}
                    {draft.confirmedAt && <span>確定: {formatJst(draft.confirmedAt)}</span>}
                  </div>

                  {draft.aiWarnings.length > 0 && (
                    <ul className="space-y-0.5 rounded-t4d border border-line bg-surface-muted px-3 py-2">
                      {draft.aiWarnings.map((warning, i) => (
                        <li key={i} className="text-[11px] text-[#8a5d00]">
                          ⚠ {warning}
                        </li>
                      ))}
                    </ul>
                  )}

                  {overview.canWrite ? (
                    <form action={saveSsbjDraftAction} className="space-y-1.5">
                      <input type="hidden" name="draftId" value={draft.id} />
                      <Textarea
                        name="body"
                        defaultValue={draft.body}
                        rows={10}
                        aria-label={`${view.areaLabel}の開示文`}
                        className="w-full text-[12px] leading-relaxed"
                      />
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SubmitButton size="sm" variant="outline" pendingLabel="保存中…">
                          本文を保存
                        </SubmitButton>
                      </div>
                    </form>
                  ) : (
                    <p className="whitespace-pre-wrap rounded-t4d border border-line px-3 py-2 text-[12px] leading-relaxed text-ink">
                      {draft.body}
                    </p>
                  )}

                  {draft.gaps.length > 0 && (
                    <div className="rounded-t4d border border-line">
                      <p className="border-b border-line px-3 py-1.5 text-[12px] font-medium text-ink">
                        書けなかった箇所（{draft.gaps.length}）
                      </p>
                      <ul className="divide-y divide-line">
                        {draft.gaps.map((gap) => (
                          <li key={gap.itemCode} className="px-3 py-1.5">
                            <Link
                              href={`/enterprise/disclosures/ssbj/requirements?q=${encodeURIComponent(gap.itemCode)}`}
                              className="font-mono text-[11px] text-brand-700 hover:underline"
                            >
                              {gap.itemCode}
                            </Link>
                            <span className="ml-2 text-[11px] text-ink-muted">{gap.reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {draft.coveredItemCodes.length > 0 && (
                    <p className="text-[11px] text-ink-muted">
                      根拠にした要求事項: {draft.coveredItemCodes.join('、')}
                    </p>
                  )}

                  {overview.canWrite && (
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
                      {overview.canRunAi && (
                        <form action={generateSsbjDraftAction}>
                          <input type="hidden" name="area" value={view.area} />
                          <SubmitButton
                            size="sm"
                            variant="outline"
                            icon={<Sparkles aria-hidden="true" />}
                            pendingLabel="作成中…"
                          >
                            作り直す
                          </SubmitButton>
                        </form>
                      )}
                      {!draft.confirmedAt && (
                        <form action={confirmSsbjDraftAction}>
                          <input type="hidden" name="draftId" value={draft.id} />
                          <SubmitButton
                            size="sm"
                            icon={<Check aria-hidden="true" />}
                            pendingLabel="確定中…"
                          >
                            この内容で確定
                          </SubmitButton>
                        </form>
                      )}
                      <span className="text-[11px] text-ink-muted">
                        作り直すと本文が置き換わり、確定は取り消されます。
                      </span>
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
