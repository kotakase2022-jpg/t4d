'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileText,
  Loader2,
  Lock,
  PenLine,
  Quote,
  Save,
  ShieldCheck,
  Tag,
  Target,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible } from '@/components/ui/collapsible';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { cn } from '@/lib/utils';
import {
  confirmNarrativeAction,
  createAnchorAction,
  createNarrativeAction,
  loadFragmentsAction,
  saveNarrativeAction,
} from '../actions';
import type {
  AnchorPayload,
  ConflictPayload,
  DocumentPayload,
  FieldDef,
  FragmentPayload,
  UsagePayload,
} from './types';

/**
 * 定性情報の編集（§6.6）。
 *
 * - 左: テンプレート項目（初期表示＋「詳細項目」の展開）と本文。値の無い項目は送らない（空欄を入力済みにしない）。
 * - 右: 資料の該当箇所。箇所を選び、引用する文言を確かめてから根拠に加える（引用文は必須）。
 * - 保存は編集開始時の版を基準にし、他の人が先に保存していれば比較を見せて止める（409 相当）。
 * - 原稿から引用されている場合は、影響する原稿を確認してから保存する。原稿の本文は書き換わらない。
 * - 保存中・保存済み・保存失敗を表示し、失敗しても入力は残す（A35）。
 * - 主操作は「登録する」「版として保存」の 1 つ。競合したときは「差分を確認したうえで…保存」を主操作にし、
 *   通常の保存は副操作へ下げる（主操作を 2 つ並べない。plan §2.26 E44）。
 */

export interface NarrativeEditorProps {
  mode: 'create' | 'edit';
  narrativeId?: string;
  baseVersionId: string | null;
  theme: string;
  themes: Array<{ value: string; label: string }>;
  templateFieldsByTheme: Record<string, FieldDef[]>;
  detailFieldsByTheme: Record<string, FieldDef[]>;
  initial: {
    title: string;
    ownerDepartment: string;
    tags: string;
    reportingPeriodId: string;
    scopeNote: string;
    fields: Record<string, string>;
    body: string;
    anchors: AnchorPayload[];
  };
  periods: Array<{ id: string; code: string }>;
  documents: DocumentPayload[];
  initialDocumentId: string | null;
  usage: UsagePayload[];
  canWrite: boolean;
  noAmountNote: string;
  /** 現在の版が確認済みか（確認ボタンの出し分け） */
  currentConfirmed: boolean;
  isCandidate: boolean;
  /**
   * 基準別の対応状況（NF-06。サーバーで描いた節）。編集画面だけ。引用している原稿の一覧と影響の確認は
   * この節の下に残す（保存の前に影響する原稿を確かめる規則は変えない）
   */
  coverage?: React.ReactNode;
  /** 関連するインパクト・リスク・機会の選択肢（NF-10。リスク・機会／財務的影響のテーマだけ） */
  iroOptions?: Array<{ id: string; label: string }>;
  /** 選択肢の年度（年度を変えたときは選び直しを促す） */
  iroOptionsPeriodId?: string | null;
  /** 現在の版が参照している IRO */
  initialIroRefs?: string[];
  /** IRO を選べるテーマか（選べないテーマは節を出さない） */
  iroSelectable?: boolean;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; message: string }
  | { kind: 'unchanged' }
  | { kind: 'failed'; message: string; fieldErrors: Record<string, string> }
  | { kind: 'needs_confirmation'; usage: UsagePayload[] }
  | { kind: 'conflict'; conflict: ConflictPayload };

function FieldBox({
  id,
  field,
  value,
  onChange,
  missing,
  disabled,
}: {
  id: string;
  field: FieldDef;
  value: string;
  onChange: (value: string) => void;
  missing: boolean;
  disabled: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-1 text-small font-medium text-ink">
        {field.label}
        {missing && (
          <Badge tone="warning">
            <AlertTriangle className="size-3" aria-hidden="true" />
            未記入
          </Badge>
        )}
      </label>
      <Textarea
        id={id}
        rows={2}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5"
      />
    </div>
  );
}

export function NarrativeEditor(props: NarrativeEditorProps) {
  const router = useRouter();
  const isCreate = props.mode === 'create';
  const disabled = !props.canWrite;

  const [theme, setTheme] = React.useState(props.theme);
  const [title, setTitle] = React.useState(props.initial.title);
  const [ownerDepartment, setOwnerDepartment] = React.useState(props.initial.ownerDepartment);
  const [tags, setTags] = React.useState(props.initial.tags);
  const [periodId, setPeriodId] = React.useState(props.initial.reportingPeriodId);
  const [scopeNote, setScopeNote] = React.useState(props.initial.scopeNote);
  const [fields, setFields] = React.useState<Record<string, string>>(props.initial.fields);
  const [body, setBody] = React.useState(props.initial.body);
  const [anchors, setAnchors] = React.useState<AnchorPayload[]>(props.initial.anchors);
  const [iroRefs, setIroRefs] = React.useState<string[]>(props.initialIroRefs ?? []);
  const [changeReason, setChangeReason] = React.useState('');
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [baseVersionId, setBaseVersionId] = React.useState(props.baseVersionId);
  const [saveState, setSaveState] = React.useState<SaveState>({ kind: 'idle' });
  const statusRef = React.useRef<HTMLDivElement>(null);

  const templateFields = props.templateFieldsByTheme[theme] ?? [];
  const detailFields = props.detailFieldsByTheme[theme] ?? [];
  // 「詳細項目」を開いて描くかは、画面を開いたとき・テーマを切り替えたときの値で 1 度だけ決める。
  // 入力中の値から毎回決めると、最後の値を消した瞬間に open が外れ、入力中の欄ごと節が閉じて
  // フォーカスを失っていた
  const hasDetailValue = (forTheme: string) =>
    (props.detailFieldsByTheme[forTheme] ?? []).some((f) => (fields[f.key] ?? '').trim() !== '');
  const [detailsOpen, setDetailsOpen] = React.useState(() => ({
    theme,
    open: hasDetailValue(theme),
  }));
  if (detailsOpen.theme !== theme) setDetailsOpen({ theme, open: hasDetailValue(theme) });
  const snapshot = JSON.stringify({
    theme,
    title,
    ownerDepartment,
    tags,
    periodId,
    scopeNote,
    fields,
    body,
    anchors: anchors.map((a) => a.id),
    iroRefs: [...iroRefs].sort(),
  });
  const initialSnapshot = React.useRef(snapshot);
  const dirty = snapshot !== initialSnapshot.current;
  const missing = templateFields.filter((f) => !(fields[f.key] ?? '').trim());
  const hasCurrentFact = anchors.some((a) => a.isCurrentFact && !a.missing);

  const setField = (key: string, value: string) => setFields((prev) => ({ ...prev, [key]: value }));

  const content = () => ({
    reportingPeriodId: periodId,
    scopeNote,
    // 空欄はキーごと送らない（Service でも捨てるが、送る側でも「入力済み」に見せない）
    fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== '')),
    body,
    sourceAnchorIds: anchors.map((a) => a.id),
  });

  React.useEffect(() => {
    if (saveState.kind !== 'idle' && saveState.kind !== 'saving') statusRef.current?.focus();
  }, [saveState]);

  async function submit(options: { overrideBase?: string | null } = {}) {
    setSaveState({ kind: 'saving' });
    try {
      if (isCreate) {
        const result = await createNarrativeAction({
          ...content(),
          theme,
          title,
          ownerDepartment,
          tags,
        });
        if (result.status === 'created') {
          initialSnapshot.current = snapshot;
          router.push(`/enterprise/narratives/${result.narrativeId}?flash=narrativeCreated`);
          return;
        }
        setSaveState({ kind: 'failed', message: result.message, fieldErrors: result.fieldErrors });
        return;
      }
      const base = options.overrideBase !== undefined ? options.overrideBase : baseVersionId;
      const result = await saveNarrativeAction({
        ...content(),
        narrativeId: props.narrativeId ?? '',
        baseVersionId: base,
        changeReason,
        acknowledgeImpact: acknowledged,
        // 選択肢の年度と同じ年度のときだけ送る。年度を変えたら送らない（サーバーが前の年度の IRO を外す）
        ...(props.iroSelectable && periodId === props.iroOptionsPeriodId ? { iroRefs } : {}),
      });
      switch (result.status) {
        case 'saved':
          initialSnapshot.current = snapshot;
          setSaveState({ kind: 'saved', message: `版 ${result.versionNo} として保存しました。` });
          router.replace(
            `/enterprise/narratives/${props.narrativeId}?flash=narrativeSaved&v=${result.versionNo}`,
          );
          router.refresh();
          return;
        case 'unchanged':
          setSaveState({ kind: 'unchanged' });
          return;
        case 'needs_confirmation':
          setSaveState({ kind: 'needs_confirmation', usage: result.usage });
          return;
        case 'conflict':
          if (options.overrideBase !== undefined) setBaseVersionId(options.overrideBase);
          setSaveState({ kind: 'conflict', conflict: result.conflict });
          return;
        default:
          setSaveState({
            kind: 'failed',
            message: result.message,
            fieldErrors: result.fieldErrors,
          });
      }
    } catch {
      // 通信失敗など。入力はそのまま残る
      setSaveState({
        kind: 'failed',
        message:
          '保存に失敗しました（通信エラーの可能性）。入力内容は残っています。もう一度保存してください。',
        fieldErrors: {},
      });
    }
  }

  const fieldErrors = saveState.kind === 'failed' ? saveState.fieldErrors : {};

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-3 rounded-t4d-lg border border-line bg-surface p-3">
        {props.isCandidate && (
          <p className="flex items-center gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-small text-ink">
            <AlertTriangle className="size-3.5 text-warning-ink" aria-hidden="true" />
            資料の抜粋を並べただけの候補です（AI
            は使っていません）。テンプレート項目は人が記入し、内容を確かめてから保存・確認してください。
          </p>
        )}

        {isCreate && (
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <label htmlFor="nv-theme" className="block text-small font-medium text-ink">
                情報の種別（必須）
              </label>
              <NativeSelect
                id="nv-theme"
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                className="mt-0.5"
              >
                {props.themes.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <label htmlFor="nv-title" className="block text-small font-medium text-ink">
                題名（必須）
              </label>
              <Input
                id="nv-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-invalid={fieldErrors.title ? true : undefined}
                aria-describedby={fieldErrors.title ? 'nv-title-err' : undefined}
                className="mt-0.5"
              />
              {fieldErrors.title && (
                <p id="nv-title-err" className="text-caption text-danger">
                  {fieldErrors.title}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="nv-dept" className="block text-small font-medium text-ink">
                担当部署
              </label>
              <Input
                id="nv-dept"
                value={ownerDepartment}
                onChange={(e) => setOwnerDepartment(e.target.value)}
                className="mt-0.5"
              />
            </div>
            <div>
              <label htmlFor="nv-tags" className="block text-small font-medium text-ink">
                タグ（読点・カンマ区切り）
              </label>
              <Input
                id="nv-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="mt-0.5"
              />
            </div>
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-[160px_minmax(0,1fr)]">
          <div>
            <label htmlFor="nv-period" className="block text-small font-medium text-ink">
              年度
            </label>
            <NativeSelect
              id="nv-period"
              value={periodId}
              disabled={disabled}
              onChange={(e) => setPeriodId(e.target.value)}
              className="mt-0.5"
            >
              {props.periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <label htmlFor="nv-scope" className="block text-small font-medium text-ink">
              対象範囲
            </label>
            <Input
              id="nv-scope"
              value={scopeNote}
              disabled={disabled}
              onChange={(e) => setScopeNote(e.target.value)}
              placeholder="例: 当社及び連結子会社（2026年度）"
              className="mt-0.5"
            />
          </div>
        </div>

        <section aria-labelledby="nv-template" className="space-y-2">
          <h2 id="nv-template" className="text-body font-semibold text-ink">
            テンプレート項目
            {missing.length > 0 && (
              <span className="ml-2 text-caption font-normal text-warning-ink">
                未記入 {missing.length} 項目（空欄のまま保存でき、不足情報として表示されます）
              </span>
            )}
          </h2>
          {theme === 'financial_impact' && (
            <p className="text-caption text-ink-muted">
              影響額が未確定なら「影響額」は空欄のままにし、「影響額を示さない理由」に書いてください。
              {props.noAmountNote}
            </p>
          )}
          <div className="grid gap-2 md:grid-cols-2">
            {templateFields.map((field) => (
              <FieldBox
                key={field.key}
                id={`nv-f-${field.key}`}
                field={field}
                value={fields[field.key] ?? ''}
                onChange={(v) => setField(field.key, v)}
                missing={!(fields[field.key] ?? '').trim()}
                disabled={disabled}
              />
            ))}
          </div>
          {detailFields.length > 0 && (
            <FormSection
              key={theme}
              kind="optional"
              title={`詳細項目（${detailFields.filter((f) => (fields[f.key] ?? '').trim()).length}/${detailFields.length} 記入）`}
              open={detailsOpen.open || undefined}
            >
              <div className="grid gap-2 md:grid-cols-2">
                {detailFields.map((field) => (
                  <FieldBox
                    key={field.key}
                    id={`nv-d-${field.key}`}
                    field={field}
                    value={fields[field.key] ?? ''}
                    onChange={(v) => setField(field.key, v)}
                    missing={false}
                    disabled={disabled}
                  />
                ))}
              </div>
            </FormSection>
          )}
        </section>

        <div>
          <label htmlFor="nv-body" className="block text-body font-semibold text-ink">
            本文
          </label>
          <Textarea
            id="nv-body"
            rows={7}
            value={body}
            disabled={disabled}
            onChange={(e) => setBody(e.target.value)}
            aria-invalid={fieldErrors.body ? true : undefined}
            aria-describedby={fieldErrors.body ? 'nv-body-err' : undefined}
            className="mt-0.5"
          />
          {fieldErrors.body && (
            <p id="nv-body-err" className="text-caption text-danger">
              {fieldErrors.body}
            </p>
          )}
        </div>

        <section aria-labelledby="nv-anchors" className="space-y-1">
          <h2
            id="nv-anchors"
            className="flex items-center gap-1.5 text-body font-semibold text-ink"
          >
            <BookOpen className="size-4" aria-hidden="true" />
            根拠（引用位置 {anchors.length} 件）
          </h2>
          {anchors.length === 0 ? (
            <p className="text-small text-ink-muted">
              根拠がありません。右の「資料の該当箇所」から引用する箇所を選んでください。
            </p>
          ) : (
            <ul className="space-y-1">
              {anchors.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-2 rounded-t4d border border-line px-2 py-1 text-small"
                >
                  <Quote className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-ink">「{a.quoteText}」</p>
                    <p className="text-caption text-ink-muted">
                      {a.fileId ? (
                        <Link href={`/enterprise/evidence/${a.fileId}`} className="underline">
                          {a.fileName}
                        </Link>
                      ) : (
                        a.fileName
                      )}
                      ／{a.locationLabel}
                    </p>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      <Badge tone={a.isCurrentFact ? 'success' : 'warning'}>
                        {a.isCurrentFact ? (
                          <CheckCircle2 className="size-3" aria-hidden="true" />
                        ) : (
                          <AlertTriangle className="size-3" aria-hidden="true" />
                        )}
                        {a.usagePurposeLabel}
                      </Badge>
                      {a.manual && (
                        <Badge tone="neutral">
                          <PenLine className="size-3" aria-hidden="true" />
                          手動の抜粋
                        </Badge>
                      )}
                    </span>
                  </div>
                  {!disabled && (
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`根拠から外す: ${a.fileName} ${a.locationLabel}`}
                      onClick={() => setAnchors((prev) => prev.filter((x) => x.id !== a.id))}
                    >
                      <X aria-hidden="true" />
                      外す
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {anchors.length > 0 && !hasCurrentFact && (
            <p className="flex items-center gap-1 text-caption text-warning-ink">
              <AlertTriangle className="size-3" aria-hidden="true" />
              当年度の根拠として登録された資料からの引用がありません（過年度の記載・文体の参考だけでは当年度の事実の根拠になりません）。
            </p>
          )}
        </section>

        {!isCreate && props.iroSelectable && (
          <section aria-labelledby="nv-iros" className="space-y-1">
            <h2 id="nv-iros" className="flex items-center gap-1.5 text-body font-semibold text-ink">
              <Target className="size-4" aria-hidden="true" />
              関連するインパクト・リスク・機会（{iroRefs.length} 件）
            </h2>
            <p className="text-caption text-ink-muted">
              この定性情報（SSBJ: 企業への影響）が説明する IRO を選びます。CSRD・ESRS-40a
              の「人・環境へのインパクト」とは列を分けて、
              <Link href="/enterprise/disclosures/impacts" className="text-brand-800 underline">
                インパクト・リスク・機会の台帳
              </Link>
              に並びます。
            </p>
            {(props.iroOptions ?? []).length === 0 ? (
              <p className="text-small text-ink-muted">
                この年度の IRO はまだありません（CSRD の設定の事項の画面で登録します）。
              </p>
            ) : periodId !== props.iroOptionsPeriodId ? (
              <p className="text-small text-warning-ink">
                年度を変えると、関連する IRO は外れます。保存した後、新しい年度の IRO
                を選び直してください。
              </p>
            ) : (
              <fieldset className="grid gap-0.5 md:grid-cols-2" disabled={disabled}>
                <legend className="sr-only">関連するインパクト・リスク・機会</legend>
                {(props.iroOptions ?? []).map((option) => (
                  <NativeCheckbox
                    key={option.id}
                    checked={iroRefs.includes(option.id)}
                    onChange={(e) =>
                      setIroRefs((prev) =>
                        e.target.checked
                          ? [...prev, option.id]
                          : prev.filter((id) => id !== option.id),
                      )
                    }
                    label={option.label}
                  />
                ))}
              </fieldset>
            )}
            {fieldErrors.iroRefs && (
              <p className="text-caption text-danger" role="alert">
                {fieldErrors.iroRefs}
              </p>
            )}
          </section>
        )}

        {!isCreate && (
          <section aria-labelledby="nv-usage" className="space-y-1">
            <h2 id="nv-usage" className="text-body font-semibold text-ink">
              基準別の対応状況
            </h2>
            {props.coverage}
            {props.usage.length === 0 ? (
              <p className="text-small text-ink-muted">
                この定性情報を引用している原稿はありません。
              </p>
            ) : (
              <>
                <Collapsible
                  variant="plain"
                  summary={`引用している原稿（${props.usage.length} 節）`}
                >
                  <ul className="space-y-0.5 text-small">
                    {props.usage.map((u) => (
                      <li key={u.blockId} className="flex flex-wrap items-center gap-1">
                        <Link
                          href={`/enterprise/disclosure-projects/${u.projectId}/blocks/${u.blockId}`}
                          className="text-brand-800 hover:underline"
                        >
                          {u.blockTitle}
                        </Link>
                        <Badge tone="neutral">
                          <FileText className="size-3" aria-hidden="true" />
                          {u.blockStatusLabel}
                        </Badge>
                        <span className="text-caption text-ink-muted">
                          {u.projectName}／引用中の版 {u.citedVersionNo ?? '—'}
                          {u.citesCurrent ? '' : '（最新ではない）'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Collapsible>
                <p className="text-caption text-ink-muted">
                  原稿は採用した時点の本文を持っています。ここで保存しても原稿の本文・承認は書き換わらず、原稿側に「再確認が必要」と表示されます。
                </p>
                {props.canWrite && (
                  <NativeCheckbox
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    label="影響する原稿を確認しました"
                  />
                )}
              </>
            )}
          </section>
        )}

        {!isCreate && props.canWrite && (
          <div>
            <label htmlFor="nv-reason" className="block text-small font-medium text-ink">
              変更の理由（版として残ります）
            </label>
            <Input
              id="nv-reason"
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              aria-invalid={fieldErrors.changeReason ? true : undefined}
              aria-describedby={fieldErrors.changeReason ? 'nv-reason-err' : undefined}
              className="mt-0.5"
            />
            {fieldErrors.changeReason && (
              <p id="nv-reason-err" className="text-caption text-danger">
                {fieldErrors.changeReason}
              </p>
            )}
          </div>
        )}

        <div
          ref={statusRef}
          tabIndex={-1}
          role={saveState.kind === 'failed' || saveState.kind === 'conflict' ? 'alert' : 'status'}
          aria-live="polite"
          className="text-small"
        >
          {saveState.kind === 'saving' && (
            <span className="flex items-center gap-1 text-ink-muted">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              保存中…
            </span>
          )}
          {saveState.kind === 'saved' && (
            <span className="flex items-center gap-1 text-success">
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
              {saveState.message}
            </span>
          )}
          {saveState.kind === 'unchanged' && (
            <span className="text-ink-muted">
              内容が保存済みの版と同じため、新しい版は作りませんでした。
            </span>
          )}
          {saveState.kind === 'failed' && (
            <span className="flex items-center gap-1 rounded-t4d border border-danger/40 bg-danger-soft px-2 py-1 text-ink">
              <AlertTriangle className="size-3.5 text-danger" aria-hidden="true" />
              保存失敗: {saveState.message}
            </span>
          )}
          {saveState.kind === 'needs_confirmation' && (
            <span className="flex items-center gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1 text-ink">
              <AlertTriangle className="size-3.5 text-warning-ink" aria-hidden="true" />
              この定性情報は {saveState.usage.length}{' '}
              節の原稿から引用されています。「影響する原稿を確認しました」にチェックしてから保存してください。
            </span>
          )}
        </div>

        {saveState.kind === 'conflict' && (
          <ConflictView
            conflict={saveState.conflict}
            onReload={() => router.refresh()}
            onOverride={() => void submit({ overrideBase: saveState.conflict.latestVersionId })}
          />
        )}

        {props.canWrite && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button
              variant={saveState.kind === 'conflict' ? 'secondary' : 'primary'}
              onClick={() => void submit()}
              disabled={saveState.kind === 'saving'}
              aria-busy={saveState.kind === 'saving'}
            >
              {saveState.kind === 'saving' ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              {isCreate ? '登録する' : '版として保存'}
            </Button>
            {dirty && (
              <span id="nv-dirty" className="text-caption text-ink-muted">
                未保存の変更があります（確認済みにする前に保存してください）
              </span>
            )}
            {!isCreate && props.narrativeId && baseVersionId && (
              <form action={confirmNarrativeAction} className="ml-auto">
                <input type="hidden" name="narrativeId" value={props.narrativeId} />
                <input type="hidden" name="versionId" value={baseVersionId} />
                <SubmitButton
                  variant="secondary"
                  disabled={dirty || props.currentConfirmed}
                  aria-describedby={dirty ? 'nv-dirty' : undefined}
                  icon={<ShieldCheck aria-hidden="true" />}
                >
                  {props.currentConfirmed ? '確認済み' : '内容を確認済みにする（人の確認）'}
                </SubmitButton>
              </form>
            )}
          </div>
        )}
      </div>

      <DocumentPane
        documents={props.documents}
        initialDocumentId={props.initialDocumentId}
        canCite={props.canWrite}
        onCited={(anchor) =>
          setAnchors((prev) => (prev.some((a) => a.id === anchor.id) ? prev : [...prev, anchor]))
        }
      />
    </div>
  );
}

function ConflictView({
  conflict,
  onReload,
  onOverride,
}: {
  conflict: ConflictPayload;
  onReload: () => void;
  onOverride: () => void;
}) {
  return (
    <section
      aria-labelledby="nv-conflict"
      className="space-y-2 rounded-t4d border border-danger/40 bg-danger-soft/40 p-3 text-small"
    >
      <h2 id="nv-conflict" className="flex items-center gap-1 text-body font-semibold text-ink">
        <AlertTriangle className="size-4 text-danger" aria-hidden="true" />
        他の人が先に保存しました（競合）。あなたの内容はまだ保存していません。
      </h2>
      <p className="text-ink-muted">
        最新の版: 版 {conflict.latestVersionNo ?? '—'}（{conflict.latestCreatedByName ?? '—'}・
        {conflict.latestCreatedAt ?? '—'}）
      </p>
      {conflict.fieldDiffs.length > 0 && (
        <table className="w-full text-small">
          <thead>
            <tr className="text-left text-caption text-ink-muted">
              <th scope="col" className="py-0.5 pr-2">
                項目
              </th>
              <th scope="col" className="py-0.5 pr-2">
                最新の版
              </th>
              <th scope="col" className="py-0.5">
                あなたの入力
              </th>
            </tr>
          </thead>
          <tbody>
            {conflict.fieldDiffs.map((d) => (
              <tr key={d.key} className="border-t border-line align-top">
                <th scope="row" className="py-0.5 pr-2 text-left font-medium">
                  {d.label}
                </th>
                <td className="py-0.5 pr-2">{d.latest ?? '（未記入）'}</td>
                <td className="py-0.5">{d.mine ?? '（未記入）'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div>
        <p className="text-caption text-ink-muted">本文の差分（最新の版 → あなたの入力）</p>
        <p className="whitespace-pre-wrap rounded-t4d bg-surface p-2 leading-6">
          {conflict.bodyDiff.map((s, i) =>
            s.op === 'equal' ? (
              <span key={i}>{s.text}</span>
            ) : s.op === 'insert' ? (
              <ins key={i} className="bg-success-soft no-underline">
                <span className="sr-only">追加: </span>
                {s.text}
              </ins>
            ) : (
              <del key={i} className="bg-danger-soft">
                <span className="sr-only">削除: </span>
                {s.text}
              </del>
            ),
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onReload}>
          最新の版を開き直す（あなたの入力は破棄）
        </Button>
        <Button variant="primary" size="sm" onClick={onOverride}>
          差分を確認したうえで、あなたの内容を次の版として保存
        </Button>
      </div>
    </section>
  );
}

function DocumentPane({
  documents,
  initialDocumentId,
  canCite,
  onCited,
}: {
  documents: DocumentPayload[];
  initialDocumentId: string | null;
  canCite: boolean;
  onCited: (anchor: AnchorPayload) => void;
}) {
  const [fileId, setFileId] = React.useState<string | null>(
    initialDocumentId ?? documents[0]?.fileId ?? null,
  );
  const [fragments, setFragments] = React.useState<FragmentPayload[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [quote, setQuote] = React.useState('');
  const [citing, setCiting] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!fileId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);
    loadFragmentsAction(fileId)
      .then((result) => {
        if (cancelled) return;
        if (result.status === 'ok') setFragments(result.fragments);
        else {
          setFragments([]);
          setError(result.message);
        }
      })
      .catch(() => {
        if (!cancelled) setError('資料の該当箇所を読み込めませんでした。もう一度選んでください。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const current = documents.find((d) => d.fileId === fileId);

  async function cite(fragmentId: string) {
    setCiting(true);
    setMessage(null);
    try {
      const result = await createAnchorAction({ fragmentId, quoteText: quote });
      if (result.status === 'ok') {
        onCited(result.anchor);
        setMessage('根拠に加えました（版として保存すると定性情報に記録されます）。');
        setSelected(null);
      } else {
        setMessage(result.message);
      }
    } catch {
      setMessage('引用の登録に失敗しました。もう一度お試しください。');
    } finally {
      setCiting(false);
    }
  }

  return (
    <aside
      aria-labelledby="doc-pane-title"
      className="min-w-0 space-y-2 rounded-t4d-lg border border-line bg-surface p-3"
    >
      <h2
        id="doc-pane-title"
        className="flex items-center gap-1.5 text-body font-semibold text-ink"
      >
        <FileText className="size-4" aria-hidden="true" />
        資料の該当箇所
      </h2>
      {documents.length === 0 ? (
        <p className="text-small text-ink-muted">
          引用できる資料がありません。
          <Link
            href="/enterprise/evidence?purpose=qualitative&new=1#evidence-create"
            className="ml-1 text-brand-800 underline"
          >
            定性情報の資料を登録
          </Link>
        </p>
      ) : (
        <>
          <label htmlFor="doc-select" className="block text-small text-ink">
            資料
          </label>
          <NativeSelect
            id="doc-select"
            value={fileId ?? ''}
            onChange={(e) => setFileId(e.target.value || null)}
            className="text-small"
          >
            {documents.map((d) => (
              <option key={d.fileId} value={d.fileId}>
                {d.name}（{d.usagePurposeLabel}
                {d.periodCode ? `・${d.periodCode}` : ''}）
              </option>
            ))}
          </NativeSelect>
          {current && (
            <p className="flex flex-wrap gap-1 text-caption text-ink-muted">
              <Badge tone={current.usagePurposeLabel === '当年度の根拠' ? 'success' : 'warning'}>
                <Tag className="size-3" aria-hidden="true" />
                {current.usagePurposeLabel}
              </Badge>
              <Badge tone="neutral">
                <Lock className="size-3" aria-hidden="true" />
                {current.confidentialityLabel}
              </Badge>
              <Link href={`/enterprise/evidence/${current.fileId}`} className="underline">
                原文を開く
              </Link>
            </p>
          )}
          <div aria-live="polite" className="text-small">
            {loading && (
              <span className="flex items-center gap-1 text-ink-muted">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                読み込み中…
              </span>
            )}
            {error && <span className="text-danger">{error}</span>}
            {message && <span className="text-ink">{message}</span>}
          </div>
          <ol className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
            {(fragments ?? []).map((f) => (
              <li
                key={f.id}
                className={cn(
                  'rounded-t4d border px-2 py-1.5 text-small',
                  selected === f.id ? 'border-brand-300 bg-brand-50' : 'border-line',
                )}
              >
                <p className="flex items-center gap-1 text-caption font-medium text-ink-muted">
                  {f.locationLabel}
                  {f.manual && (
                    <Badge tone="neutral">
                      <PenLine className="size-3" aria-hidden="true" />
                      手動の抜粋
                    </Badge>
                  )}
                </p>
                <p className="whitespace-pre-wrap text-ink">{f.text}</p>
                {canCite &&
                  (selected === f.id ? (
                    <div className="mt-1 space-y-1">
                      <label htmlFor={`quote-${f.id}`} className="block text-caption text-ink">
                        引用する文言（必須・この箇所の文言から選ぶ）
                      </label>
                      <Textarea
                        id={`quote-${f.id}`}
                        rows={3}
                        value={quote}
                        onChange={(e) => setQuote(e.target.value)}
                      />
                      <div className="flex gap-1">
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => void cite(f.id)}
                          disabled={citing || !quote.trim()}
                          aria-busy={citing}
                        >
                          {citing ? (
                            <Loader2 className="animate-spin" aria-hidden="true" />
                          ) : (
                            <Quote aria-hidden="true" />
                          )}
                          根拠として追加
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setSelected(null)}>
                          やめる
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="xs"
                      variant="secondary"
                      className="mt-1"
                      onClick={() => {
                        setSelected(f.id);
                        setQuote(f.text);
                      }}
                    >
                      この箇所を引用
                    </Button>
                  ))}
              </li>
            ))}
            {fragments !== null && fragments.length === 0 && !loading && !error && (
              <li className="text-small text-ink-muted">
                抽出できた箇所がありません。資料の画面で手動抜粋を登録してください。
              </li>
            )}
          </ol>
        </>
      )}
    </aside>
  );
}
