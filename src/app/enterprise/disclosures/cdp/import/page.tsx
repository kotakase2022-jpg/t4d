import Link from 'next/link';
import { Upload } from 'lucide-react';
import { Notice } from '@/components/shared/notice';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { StepNav, type StepItem } from '@/components/shared/step-nav';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { isFrameworkAvailable } from '@/lib/services/disclosure';
import { buildImportPreview, type ImportPreview } from '@/lib/services/disclosure-import';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { readOwnedFileBytes } from '@/lib/storage';
import { confirmDisclosureImportAction, previewDisclosureImportAction } from '../../../actions';
import { CdpNotContracted } from '../_components/cdp-not-contracted';

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

/**
 * 過去回答の取込（plan §2.26 E34）。段階は ① ファイルを選ぶ → ② 解析結果を確認して選ぶ → ③ 取り込む。
 * 主操作は段階ごとに 1 つ（解析前は「解析する」、解析後は「選択した n 件を取り込む」）。
 * 取込先の期間は、当期の直前の報告期間を既定にする（plan D1。過去回答の取込なので当期は選べない）。
 * 権限の無い利用者には、誰に頼めばよいかを添えて権限なしを出す（EmptyState で代用しない）。
 */
export default async function DisclosureImportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  // CDP は組織ごとに契約するオプション（トライアル対応 NF-38）。契約が無ければ取込の入口も出さない
  if (!(await isFrameworkAvailable(shell.db, shell.ctx, 'cdp'))) {
    return <CdpNotContracted title="過去回答の取込" />;
  }
  const canWrite = can(shell.ctx, 'enterprise.disclosure.write');

  const fileVersionId = typeof params.file === 'string' ? params.file : null;
  const targetPeriodId =
    typeof params.targetPeriodId === 'string' && params.targetPeriodId
      ? params.targetPeriodId
      : null;

  // 当年度は取込先に選べない（過去回答の取込なので）。新しい年度から並べ、直前の年度を既定にする
  const pastPeriods = shell.periods
    .filter((p) => p.id !== shell.currentPeriod.id)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  const defaultPeriodId =
    pastPeriods.find((p) => p.startDate < shell.currentPeriod.startDate)?.id ?? pastPeriods[0]?.id;

  let preview: ImportPreview | null = null;
  let error: string | null = null;

  if (canWrite && fileVersionId && targetPeriodId) {
    const stored = await readOwnedFileBytes(shell.db, shell.ctx, fileVersionId);
    if (!stored) {
      error =
        'アップロードしたファイルが見つかりません。もう一度ファイルを選んで解析してください。';
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
  const steps: StepItem[] = [
    { key: 'file', label: 'ファイルを選ぶ', state: preview ? 'done' : 'current' },
    {
      key: 'review',
      label: '解析結果を確認して選ぶ',
      state: preview ? 'current' : 'todo',
    },
    { key: 'import', label: '取り込む', state: 'todo' },
  ];

  return (
    <>
      <PageHeader
        title="過去回答の取込"
        description="過年度の CDP 回答書（Excel / CSV / PDF / Word）を質問単位に分解して取り込みます。"
        breadcrumbsTail={[{ label: '過去回答の取込' }]}
      />

      <div className="space-y-3 p-4">
        {!canWrite ? (
          <PermissionDeniedState
            permission="enterprise.disclosure.write"
            description="この操作を行う権限がありません。過去回答の取込は、開示の編集を担当する人が行います。"
          />
        ) : (
          <>
            <StepNav ariaLabel="取込の段階" steps={steps} />
            <Section title="ファイルをアップロード" divider="none">
              <form action={previewDisclosureImportAction} className="space-y-2">
                <div className="grid max-w-2xl grid-cols-2 gap-3">
                  <label className="block text-small text-ink-muted">
                    取込先の報告期間
                    <NativeSelect
                      name="targetPeriodId"
                      required
                      size="md"
                      defaultValue={targetPeriodId ?? defaultPeriodId}
                      className="mt-0.5"
                    >
                      {pastPeriods.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className="block text-small text-ink-muted">
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
                <p className="text-caption text-ink-muted">
                  「質問コード」「回答」列を持つ表、または「C1.1
                  …」のように質問コードで始まる本文に対応します。 取り込んだ内容は
                  <strong>この画面で確認してから</strong>保存されます。
                </p>
                <SubmitButton
                  variant={preview ? 'secondary' : 'primary'}
                  size="sm"
                  icon={<Upload aria-hidden="true" />}
                  pendingLabel="解析中…"
                >
                  解析する
                </SubmitButton>
              </form>
            </Section>
          </>
        )}

        {error && (
          <Notice tone="danger" role="alert" title="解析できませんでした">
            {error}
          </Notice>
        )}

        {preview && (
          <Section
            title={`解析結果（${preview.rows.length} 件 / 取り込める ${matched.length} 件）`}
            actions={
              <span className="text-caption text-ink-muted">
                {preview.fileName}（{PARSED_AS_LABEL[preview.parsedAs]} として解析）
              </span>
            }
          >
            {preview.warnings.length > 0 && (
              <Notice tone="warning">
                <ul>
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Notice>
            )}

            {preview.rows.length === 0 ? (
              <EmptyState
                kind="no-data"
                title="取り込める回答が見つかりませんでした"
                description="ファイル形式と質問コードの記載を確認し、ファイルを選び直してください。"
                action={
                  <Link
                    href="/enterprise/disclosures/cdp/import"
                    className="inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
                  >
                    <Upload className="size-3.5" aria-hidden="true" />
                    別のファイルを選ぶ
                  </Link>
                }
              />
            ) : (
              <form action={confirmDisclosureImportAction}>
                <input type="hidden" name="targetPeriodId" value={targetPeriodId ?? ''} />
                <input type="hidden" name="currentPeriodId" value={shell.currentPeriod.id} />
                <div className="t4d-scroll-x">
                  <Table>
                    <THead>
                      <TR>
                        <TH className="w-10">
                          <span className="sr-only">選択</span>
                        </TH>
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
                                <NativeCheckbox
                                  name="selected"
                                  value={row.itemId}
                                  defaultChecked
                                  aria-label={`${row.itemCode} を取り込む`}
                                />
                                <input
                                  type="hidden"
                                  name={`answer:${row.itemId}`}
                                  value={row.answerText}
                                />
                              </>
                            ) : null}
                          </TD>
                          <TD className="font-mono text-caption">{row.itemCode}</TD>
                          <TD className="max-w-col-lg truncate text-small">
                            {row.questionText ?? '—'}
                          </TD>
                          <TD className="max-w-col-xl text-small text-ink">
                            <span className="line-clamp-2">{row.answerText || '（空）'}</span>
                          </TD>
                          <TD className="whitespace-nowrap text-caption text-ink-muted">
                            {row.locator}
                          </TD>
                          <TD>
                            <Badge tone={STATUS_LABEL[row.status].tone}>
                              {STATUS_LABEL[row.status].label}
                            </Badge>
                            {row.existingResponseId && (
                              <span className="ml-1 text-caption text-ink-muted">上書き</span>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-line py-2">
                  <span className="text-caption text-ink-muted">
                    取り込んだ回答は選んだ報告期間に保存され、当年度の回答には前年回答として紐付きます。
                    <strong>当年度の回答本文は変更されません。</strong>
                  </span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href="/enterprise/disclosures/cdp">キャンセル</Link>
                    </Button>
                    <SubmitButton
                      variant="primary"
                      size="sm"
                      pendingLabel="取り込み中…"
                      disabled={matched.length === 0}
                    >
                      選択した {matched.length} 件を取り込む
                    </SubmitButton>
                  </div>
                </div>
              </form>
            )}
          </Section>
        )}
      </div>
    </>
  );
}
