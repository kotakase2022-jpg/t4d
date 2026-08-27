import Link from 'next/link';
import { CircleAlert, Upload } from 'lucide-react';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { buildImportPreview, type ImportPreview } from '@/lib/services/disclosure-import';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { readOwnedFileBytes } from '@/lib/storage';
import { confirmDisclosureImportAction, previewDisclosureImportAction } from '../../../actions';

export const metadata = { title: '過去回答の取込' };

const STATUS_LABEL: Record<
  ImportPreview['rows'][number]['status'],
  { label: string; tone: 'brand' | 'warning' | 'neutral' }
> = {
  matched: { label: '一致', tone: 'brand' },
  unknown_code: { label: '質問コード不明', tone: 'warning' },
  empty_answer: { label: '回答が空', tone: 'neutral' },
};

const PARSED_AS_LABEL: Record<ImportPreview['parsedAs'], string> = {
  table: 'Excel / CSV',
  pdf: 'PDF',
  text: 'テキスト',
  docx: 'Word',
};

export default async function DisclosureImportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const canWrite = can(shell.ctx, 'enterprise.disclosure.write');

  const fileVersionId = typeof params.file === 'string' ? params.file : null;
  const targetPeriodId =
    typeof params.targetPeriodId === 'string' && params.targetPeriodId
      ? params.targetPeriodId
      : null;

  // 当年度は取込先に選べない（過去回答の取込なので）
  const pastPeriods = shell.periods.filter((p) => p.id !== shell.currentPeriod.id);

  let preview: ImportPreview | null = null;
  let error: string | null = null;

  if (canWrite && fileVersionId && targetPeriodId) {
    const stored = await readOwnedFileBytes(shell.db, shell.ctx, fileVersionId);
    if (!stored) {
      error = 'アップロードしたファイルが見つかりません。';
    } else {
      try {
        preview = await buildImportPreview(shell.db, shell.ctx, {
          frameworkKey: 'cdp',
          targetPeriodId,
          fileName: stored.fileName,
          mimeType: stored.mimeType,
          bytes: stored.bytes,
        });
      } catch (e) {
        error = e instanceof Error ? e.message : '解析に失敗しました。';
      }
    }
  }

  const matched = preview?.rows.filter((r) => r.status === 'matched') ?? [];

  return (
    <>
      <PageHeader
        title="過去回答の取込"
        description="過年度の CDP 回答書（Excel / CSV / PDF / Word）を質問単位に分解して取り込みます。"
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'CDP', href: '/enterprise/disclosures/cdp' },
          { label: '過去回答の取込' },
        ]}
      />

      <div className="space-y-3 p-4">
        {!canWrite ? (
          <EmptyState title="この操作を行う権限がありません" />
        ) : (
          <Card className="overflow-hidden">
            <SectionTitle title="ファイルをアップロード" />
            <form action={previewDisclosureImportAction} className="space-y-2 p-4">
              <div className="grid max-w-2xl grid-cols-2 gap-3">
                <label className="block text-[12px] text-ink-muted">
                  取込先の報告期間
                  <select
                    name="targetPeriodId"
                    required
                    defaultValue={targetPeriodId ?? pastPeriods[0]?.id}
                    className="mt-0.5 h-8 w-full rounded-t4d border border-line bg-surface px-2 text-[13px] text-ink"
                  >
                    {pastPeriods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[12px] text-ink-muted">
                  回答書ファイル
                  <Input
                    type="file"
                    name="file"
                    required
                    accept=".csv,.tsv,.txt,.xlsx,.xlsm,.pdf,.docx"
                    className="mt-0.5"
                  />
                </label>
              </div>
              <p className="text-[11px] text-ink-muted">
                「質問コード」「回答」列を持つ表、または「C1.1
                …」のように質問コードで始まる本文に対応します。 取り込んだ内容は
                <strong>この画面で確認してから</strong>保存されます。
              </p>
              <Button type="submit" size="sm">
                <Upload aria-hidden="true" />
                解析する
              </Button>
            </form>
          </Card>
        )}

        {error && (
          <Card className="border-danger/40 bg-danger-soft p-3">
            <p className="flex items-center gap-1.5 text-[13px] text-danger">
              <CircleAlert className="size-4" aria-hidden="true" />
              {error}
            </p>
          </Card>
        )}

        {preview && (
          <Card className="overflow-hidden">
            <SectionTitle
              title={`解析結果（${preview.rows.length} 件 / 取り込める ${matched.length} 件）`}
              action={
                <span className="text-[11px] text-ink-muted">
                  {preview.fileName}（{PARSED_AS_LABEL[preview.parsedAs]} として解析）
                </span>
              }
            />

            {preview.warnings.length > 0 && (
              <ul className="border-b border-line bg-warning-soft px-3 py-1.5 text-[12px] text-[#8a5d00]">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            {preview.rows.length === 0 ? (
              <EmptyState
                title="取り込める回答が見つかりませんでした"
                description="ファイル形式と質問コードの記載を確認してください。"
              />
            ) : (
              <form action={confirmDisclosureImportAction}>
                <input type="hidden" name="targetPeriodId" value={targetPeriodId ?? ''} />
                <input type="hidden" name="currentPeriodId" value={shell.currentPeriod.id} />
                <div className="t4d-scroll-x">
                  <Table>
                    <THead>
                      <TR>
                        <TH className="w-10" aria-label="選択" />
                        <TH>質問コード</TH>
                        <TH>質問</TH>
                        <TH>抽出した回答</TH>
                        <TH>出所</TH>
                        <TH>状態</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {preview.rows.map((row, i) => (
                        <TR key={`${row.itemCode}-${i}`}>
                          <TD>
                            {row.status === 'matched' && row.itemId ? (
                              <>
                                <input
                                  type="checkbox"
                                  name="selected"
                                  value={row.itemId}
                                  defaultChecked
                                  aria-label={`${row.itemCode} を取り込む`}
                                  className="size-3.5"
                                />
                                <input
                                  type="hidden"
                                  name={`answer:${row.itemId}`}
                                  value={row.answerText}
                                />
                              </>
                            ) : null}
                          </TD>
                          <TD className="font-mono text-[11px]">{row.itemCode}</TD>
                          <TD className="max-w-[280px] truncate text-[12px]">
                            {row.questionText ?? '—'}
                          </TD>
                          <TD className="max-w-[360px] text-[12px] text-ink">
                            <span className="line-clamp-2">{row.answerText || '（空）'}</span>
                          </TD>
                          <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                            {row.locator}
                          </TD>
                          <TD>
                            <Badge tone={STATUS_LABEL[row.status].tone}>
                              {STATUS_LABEL[row.status].label}
                            </Badge>
                            {row.existingResponseId && (
                              <span className="ml-1 text-[11px] text-ink-muted">上書き</span>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2">
                  <span className="text-[11px] text-ink-muted">
                    取り込んだ回答は選んだ報告期間に保存され、当年度の回答には前年回答として紐付きます。
                    <strong>当年度の回答本文は変更されません。</strong>
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/enterprise/disclosures/cdp">キャンセル</Link>
                    </Button>
                    <Button type="submit" size="sm" disabled={matched.length === 0}>
                      選択した {matched.length} 件を取り込む
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
