import Link from 'next/link';
import { Check, Download, Sparkles } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadSsbjDrafts } from '@/lib/services/ssbj-draft';
import {
  confirmSsbjDraftAction,
  generateSsbjDraftAction,
  saveSsbjDraftAction,
} from '../../../actions';

export const metadata = { title: 'SSBJ 開示ドラフト' };

/**
 * SSBJ 開示ドラフト（plan §2 S20 E22）。
 *
 * - 画面の主操作は「Word で書き出す」1 つ（出力の権限があるときだけ。無ければ primary なし。R3）
 * - 節ごとの「人工知能に草案を作らせる」「この内容で確定」は secondary（ラベルは変えない）。
 *   節が 5 つあるため、節ごとに primary を繰り返さない（plan §1.6）
 * - 「生成されるのは草案」の 1 行は常に見せる（誠実さの注記）
 */
export default async function SsbjDraftPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const overview = await loadSsbjDrafts(shell.db, shell.ctx, shell.currentPeriod);
  const canExport = can(shell.ctx, 'enterprise.export.run');

  if (!overview) {
    return (
      <>
        <PageHeader title="SSBJ 開示ドラフト" autoBreadcrumbs />
        <div className="p-4">
          <EmptyState
            kind="no-data"
            title="SSBJ の要求事項マスターが登録されていません"
            description="草案は要求事項の評価をもとに作ります。要求事項マスターは管理者が登録します。"
            action={
              <Link
                href="/enterprise/disclosures/ssbj"
                className="text-small text-brand-700 hover:underline"
              >
                SSBJ 対応状況を開く
              </Link>
            }
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="SSBJ 開示ドラフト"
        description={`${shell.currentPeriod.label} ／ 節ごとに草案を作り、担当者が直して確定します`}
        autoBreadcrumbs
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'export-docx',
              label: 'Word で書き出す',
              icon: <Download aria-hidden="true" />,
              href: `/api/exports/cdp?framework=ssbj&period=${shell.currentPeriod.id}&format=docx`,
              download: true,
              // 出力の権限が無い役割に、押すと 403 になるリンクを見せない（R3）
              hidden: !canExport,
            }}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 「草案である・人が確認して確定する」は常に見せる（誠実さの注記）。
            何を根拠に書くかの説明は既定で閉じる（docs/disclosure-first.md §10.4） */}
        <Card className="space-y-1 p-3">
          <p className="text-small text-ink">
            生成されるのは草案です。そのまま開示せず、内容を確認し、必要な修正を加えてから確定してください。
          </p>
          <MoreInfo label="人工知能が書ける範囲">
            <p>
              人工知能が書けるのは、
              <span className="font-medium text-ink">
                担当者が確認して「対応済み」または「おおむね対応」とした要求事項
              </span>
              だけです。未確認・未対応の事項は本文に含めず、「書けなかった箇所」として理由とともに示します。
              数値は承認済みのものだけを使います。
            </p>
          </MoreInfo>
        </Card>

        {overview.areas.map((view) => {
          const draft = view.draft;
          return (
            <Card key={view.area} id={`draft-${view.area}`} className="overflow-hidden">
              <SectionTitle
                title={view.areaLabel}
                action={
                  <span className="flex items-center gap-2">
                    <span className="text-caption text-ink-muted">
                      対象 {view.requirementCount} 件 ／ 草案に書ける {view.writableCount} 件
                    </span>
                    {draft?.confirmedAt ? (
                      <Badge tone="success">
                        <Check className="size-3" aria-hidden="true" />
                        確定済み
                      </Badge>
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
                  <p className="text-small text-ink-muted">
                    まだ草案がありません。
                    {view.writableCount === 0 &&
                      '確認済みの要求事項が無いため、いま生成しても本文はほとんど空になります。先に担当者による確認を進めてください。'}
                  </p>
                  {overview.canRunAi && overview.canWrite && (
                    <form action={generateSsbjDraftAction}>
                      <input type="hidden" name="area" value={view.area} />
                      <SubmitButton
                        variant="secondary"
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
                  <div className="flex flex-wrap items-center gap-2 text-caption text-ink-muted">
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
                        <li key={i} className="text-caption text-warning-ink">
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
                        className="w-full text-small leading-relaxed"
                      />
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SubmitButton size="sm" variant="secondary" pendingLabel="保存中…">
                          本文を保存
                        </SubmitButton>
                      </div>
                    </form>
                  ) : (
                    <p className="whitespace-pre-wrap rounded-t4d border border-line px-3 py-2 text-small leading-relaxed text-ink">
                      {draft.body}
                    </p>
                  )}

                  {draft.gaps.length > 0 && (
                    <div className="rounded-t4d border border-line">
                      <p className="border-b border-line px-3 py-1.5 text-small font-medium text-ink">
                        書けなかった箇所（{draft.gaps.length}）
                      </p>
                      <ul className="divide-y divide-line">
                        {draft.gaps.map((gap) => (
                          <li key={gap.itemCode} className="px-3 py-1.5">
                            <Link
                              href={`/enterprise/disclosures/ssbj/requirements?q=${encodeURIComponent(gap.itemCode)}`}
                              className="font-mono text-caption text-brand-700 hover:underline"
                            >
                              {gap.itemCode}
                            </Link>
                            <span className="ml-2 text-caption text-ink-muted">{gap.reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {draft.coveredItemCodes.length > 0 && (
                    <p className="text-caption text-ink-muted">
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
                            variant="secondary"
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
                            variant="secondary"
                            size="sm"
                            icon={<Check aria-hidden="true" />}
                            pendingLabel="確定中…"
                          >
                            この内容で確定
                          </SubmitButton>
                        </form>
                      )}
                      <span className="text-caption text-ink-muted">
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
