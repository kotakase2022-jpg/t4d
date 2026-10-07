import Link from 'next/link';
import { Calendar, FileText, Info, Quote, Tag } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
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
    { label: 'ホーム', href: '/enterprise/dashboard' },
    { label: '定性情報', href: '/enterprise/narratives' },
    { label: mode === 'documents' ? '資料から候補を作成' : '新しく登録' },
  ];

  if (!can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="定性情報の登録" breadcrumbs={breadcrumbs} />
        <PermissionDeniedState
          description="定性情報を登録するには、開示の編集権限が必要です。"
          permission="enterprise.disclosure.write"
        />
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

  // 登録の 2 つのしかたは URL（?mode=）で切り替える（plan §2.26 E43: SegmentedFilter）
  const tabs = (
    <SegmentedFilter
      ariaLabel="登録のしかた"
      current={mode}
      items={[
        { key: 'manual', label: '新しく登録', href: '/enterprise/narratives/new' },
        {
          key: 'documents',
          label: '資料から候補を作成',
          href: '/enterprise/narratives/new?mode=documents',
        },
      ]}
    />
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
          description="根拠の無い影響額・頻度・委員会名などは自動で補いません"
          help={<p>文章で自然に書き、構造化した項目（テンプレート）は必要な部分だけ記入します。</p>}
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
        description="資料の抜粋から出典つきの下書き（候補）を作ります（AI は使いません）"
        help={
          <p>
            資料の抜粋を選ぶと、その文言を出典つきで並べた下書き（候補）を作ります。AI
            は使いません。テンプレート項目は埋めないので、内容を確かめて人が記入してください。
          </p>
        }
        breadcrumbs={breadcrumbs}
      />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {tabs}
        {documents.length === 0 ? (
          <EmptyState
            kind="no-data"
            title="抜粋を選べる資料がありません"
            description="定性情報の資料を登録すると、抽出した段落・ページから候補を作れます。"
            icon={<FileText className="size-5" aria-hidden="true" />}
            action={
              <Button variant="secondary" size="sm" asChild>
                <Link href="/enterprise/evidence?purpose=qualitative&new=1#evidence-create">
                  定性情報の資料を登録
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
            <Section title="資料" divider="none">
              <ul className="space-y-1">
                {documents.map((d) => (
                  <li key={d.fileId}>
                    <Link
                      href={`/enterprise/narratives/new?mode=documents&fileId=${d.fileId}`}
                      aria-current={d.fileId === fileId ? 'page' : undefined}
                      className={cn(
                        'block rounded-t4d border px-2 py-1 text-small',
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
            </Section>

            <Section
              title={selectedDoc ? `抜粋を選ぶ: ${selectedDoc.name}` : '抜粋を選ぶ'}
              divider="none"
            >
              {!selected ? (
                <EmptyState
                  kind="not-applicable"
                  size="compact"
                  title="資料を選んでください"
                  description="左の一覧から、抜粋を使う資料を選びます。"
                />
              ) : (
                <form action={createNarrativeCandidateAction} className="space-y-3">
                  <input type="hidden" name="fileId" value={selected.file.id} />
                  {selectedDoc && selectedDoc.usagePurposeLabel !== '当年度の根拠' && (
                    <p className="flex items-center gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1 text-small">
                      <Info className="size-3.5 text-warning-ink" aria-hidden="true" />
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
                    <Field label="情報の種別" id="cand-theme" required>
                      {(control) => (
                        <NativeSelect {...control} name="theme" defaultValue="governance">
                          {themes.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </Field>
                    <Field label="題名" id="cand-title" required>
                      {(control) => <Input {...control} name="title" />}
                    </Field>
                    <Field
                      label="年度"
                      id="cand-period"
                      hint="既定はヘッダーで選んでいる報告期間です"
                    >
                      {(control) => (
                        <NativeSelect
                          {...control}
                          name="reportingPeriodId"
                          defaultValue={shell.currentPeriod.id}
                        >
                          {shell.periods.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.code}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </Field>
                  </div>
                  <SubmitButton variant="primary" pendingLabel="作成中…">
                    候補（下書き）を作成
                  </SubmitButton>
                </form>
              )}
            </Section>
          </div>
        )}
      </div>
    </>
  );
}
