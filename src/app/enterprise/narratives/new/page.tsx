import Link from 'next/link';
import { Calendar, FileText, Info, Quote, Tag } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import { NARRATIVE_TEMPLATE_FIELDS } from '@/lib/domain/narrative-template';
import { NARRATIVE_THEME_LABELS } from '@/lib/domain/disclosure-status';
import { NARRATIVE_DETAIL_FIELDS, NO_AMOUNT_NOTE } from '@/lib/services/narrative';
import { listDocumentsForCitation, loadDocumentFragments } from '@/lib/services/source-anchor';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { cn } from '@/lib/utils';
import { NARRATIVE_THEMES } from '@/types/domain';
import { createNarrativeCandidateAction } from '../actions';
import { NarrativeEditor } from '../_components/narrative-editor';
import { FragmentPicker } from './fragment-picker';
import type { DocumentPayload, FieldDef } from '../_components/types';

export const metadata = { title: '定性情報の登録' };

/**
 * 定性情報の新規登録（§6.5「新しく登録」「資料から候補を作成」）。
 * 候補の作成は規則ベース（選んだ抜粋を引用として並べるだけ）で、AI は使わない。
 */
export default async function NewNarrativePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const mode = query.mode === 'documents' ? 'documents' : 'manual';
  const breadcrumbs = [
    { label: '企業ワークスペース' },
    { label: '定性情報', href: '/enterprise/narratives' },
    { label: mode === 'documents' ? '資料から候補を作成' : '新しく登録' },
  ];

  if (!can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="定性情報の登録" breadcrumbs={breadcrumbs} />
        <PermissionDeniedState description="定性情報を登録するには、開示の編集権限が必要です。" />
      </>
    );
  }

  const docs = await listDocumentsForCitation(db, ctx);
  const periodCode = (id: string | null) => shell.periods.find((p) => p.id === id)?.code ?? null;
  const documents: DocumentPayload[] = docs.map((d) => ({
    fileId: d.file.id,
    name: d.file.originalName,
    usagePurposeLabel: d.usagePurposeLabel,
    confidentialityLabel: d.confidentialityLabel,
    fragmentCount: d.fragmentCount,
    periodCode: periodCode(d.periodId),
  }));
  const themes = NARRATIVE_THEMES.map((t) => ({ value: t, label: NARRATIVE_THEME_LABELS[t] }));

  const tabs = (
    <nav aria-label="登録のしかた" className="flex gap-1">
      {(
        [
          ['manual', '新しく登録', '/enterprise/narratives/new'],
          ['documents', '資料から候補を作成', '/enterprise/narratives/new?mode=documents'],
        ] as const
      ).map(([key, label, href]) => (
        <Link
          key={key}
          href={href}
          aria-current={mode === key ? 'page' : undefined}
          className={cn(
            'rounded-t4d border px-2.5 py-1 text-[12px]',
            mode === key
              ? 'border-brand-300 bg-brand-50 font-semibold text-brand-900'
              : 'border-line bg-surface text-ink',
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );

  if (mode === 'manual') {
    const templateFieldsByTheme: Record<string, FieldDef[]> = {};
    const detailFieldsByTheme: Record<string, FieldDef[]> = {};
    for (const t of NARRATIVE_THEMES) {
      templateFieldsByTheme[t] = NARRATIVE_TEMPLATE_FIELDS[t].map((f) => ({
        key: f.key,
        label: f.label,
      }));
      detailFieldsByTheme[t] = NARRATIVE_DETAIL_FIELDS[t].map((f) => ({
        key: f.key,
        label: f.label,
      }));
    }
    return (
      <>
        <PageHeader
          title="定性情報を新しく登録"
          description="文章で自然に書き、構造化した項目は必要な部分だけ記入します。根拠の無い影響額・頻度・委員会名などは自動で補いません。"
          breadcrumbs={breadcrumbs}
        />
        <div className="space-y-3 p-4">
          <FlashMessage searchParams={query} />
          {tabs}
          <NarrativeEditor
            mode="create"
            baseVersionId={null}
            theme="governance"
            themes={themes}
            templateFieldsByTheme={templateFieldsByTheme}
            detailFieldsByTheme={detailFieldsByTheme}
            initial={{
              title: '',
              ownerDepartment: '',
              tags: '',
              reportingPeriodId: shell.currentPeriod.id,
              scopeNote: '',
              fields: {},
              body: '',
              anchors: [],
            }}
            periods={shell.periods.map((p) => ({ id: p.id, code: p.code }))}
            documents={documents}
            initialDocumentId={null}
            usage={[]}
            canWrite
            noAmountNote={NO_AMOUNT_NOTE}
            currentConfirmed={false}
            isCandidate={false}
          />
        </div>
      </>
    );
  }

  // 資料から候補を作成
  const fileId = typeof query.fileId === 'string' ? query.fileId : (documents[0]?.fileId ?? null);
  const selected = fileId ? await loadDocumentFragments(db, ctx, fileId) : null;
  const selectedDoc = documents.find((d) => d.fileId === fileId);

  return (
    <>
      <PageHeader
        title="資料から候補を作成"
        description="資料の抜粋を選ぶと、その文言を出典つきで並べた下書き（候補）を作ります。AI は使いません。テンプレート項目は埋めないので、内容を確かめて人が記入してください。"
        breadcrumbs={breadcrumbs}
      />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {tabs}
        {documents.length === 0 ? (
          <Card>
            <EmptyState
              title="抜粋を選べる資料がありません"
              description="定性情報の資料を登録すると、抽出した段落・ページから候補を作れます。"
              icon={<FileText className="size-5" aria-hidden="true" />}
              action={
                <Link
                  href="/enterprise/evidence?purpose=qualitative"
                  className="text-[12px] text-brand-800 underline"
                >
                  定性情報の資料を登録
                </Link>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
            <Card>
              <SectionTitle title="資料" />
              <ul className="space-y-1 px-3 pb-3">
                {documents.map((d) => (
                  <li key={d.fileId}>
                    <Link
                      href={`/enterprise/narratives/new?mode=documents&fileId=${d.fileId}`}
                      aria-current={d.fileId === fileId ? 'page' : undefined}
                      className={cn(
                        'block rounded-t4d border px-2 py-1 text-[12px]',
                        d.fileId === fileId ? 'border-brand-300 bg-brand-50' : 'border-line',
                      )}
                    >
                      {d.name}
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        <Badge
                          tone={d.usagePurposeLabel === '当年度の根拠' ? 'success' : 'warning'}
                        >
                          <Tag className="size-3" aria-hidden="true" />
                          {d.usagePurposeLabel}
                        </Badge>
                        {d.periodCode && (
                          <Badge tone="neutral">
                            <Calendar className="size-3" aria-hidden="true" />
                            {d.periodCode}
                          </Badge>
                        )}
                        <Badge tone="neutral">
                          <Quote className="size-3" aria-hidden="true" />
                          {d.fragmentCount} 箇所
                        </Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <SectionTitle
                title={selectedDoc ? `抜粋を選ぶ: ${selectedDoc.name}` : '抜粋を選ぶ'}
              />
              {!selected ? (
                <EmptyState title="資料を選んでください" />
              ) : (
                <form action={createNarrativeCandidateAction} className="space-y-3 px-3 pb-3">
                  <input type="hidden" name="fileId" value={selected.file.id} />
                  {selectedDoc && selectedDoc.usagePurposeLabel !== '当年度の根拠' && (
                    <p className="flex items-center gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1 text-[12px]">
                      <Info className="size-3.5 text-[#8a5d00]" aria-hidden="true" />
                      この資料は「{selectedDoc.usagePurposeLabel}
                      」です。候補の本文でもその旨を示し、当年度の事実としては扱いません。
                    </p>
                  )}
                  <FragmentPicker
                    fragments={selected.fragments.map((f) => ({
                      id: f.fragment.id,
                      locationLabel: f.locationLabel,
                      manual: f.manual,
                      text: f.fragment.text,
                    }))}
                  />
                  <div className="grid gap-2 md:grid-cols-3">
                    <div>
                      <label
                        htmlFor="cand-theme"
                        className="block text-[12px] font-medium text-ink"
                      >
                        情報の種別（必須）
                      </label>
                      <select
                        id="cand-theme"
                        name="theme"
                        required
                        defaultValue="governance"
                        className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                      >
                        {themes.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor="cand-title"
                        className="block text-[12px] font-medium text-ink"
                      >
                        題名（必須）
                      </label>
                      <Input id="cand-title" name="title" required className="mt-0.5" />
                    </div>
                    <div>
                      <label
                        htmlFor="cand-period"
                        className="block text-[12px] font-medium text-ink"
                      >
                        年度
                      </label>
                      <select
                        id="cand-period"
                        name="reportingPeriodId"
                        defaultValue={shell.currentPeriod.id}
                        className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                      >
                        {shell.periods.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.code}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <SubmitButton pendingLabel="作成中…">候補（下書き）を作成</SubmitButton>
                </form>
              )}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
