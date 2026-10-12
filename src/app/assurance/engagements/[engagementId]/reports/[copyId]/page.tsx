import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MessageSquarePlus, Search } from 'lucide-react';
import { FractionBar } from '@/components/charts/fraction-bar';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { PreservingForm } from '@/components/shared/preserving-form';
import { FlashMessage } from '@/components/shared/flash';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { requireAssuranceContext } from '@/lib/auth/session';
import { AuthorizationError, can, NotFoundError } from '@/lib/authorization/can';
import { findTraceUnits, TRACE_REASON_LABELS, type TraceUnit } from '@/lib/domain/report-trace';
import {
  anchorDisplay,
  blocksOfFramework,
  metricDisplay,
  renderBlockParagraphs,
  type RenderedParagraph,
} from '@/lib/exports/disclosure-report';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  describeReportNoteTarget,
  loadEngagementOr404,
  loadSharedReportView,
  recordSharedReportView,
  sharedReportTrace,
  type SharedReportView,
} from '@/lib/services/assurance';
import { noteBodyLimit, type FirmNoteEntry } from '@/lib/services/assurance-notes';
import type { ReportSnapshotDetail, SnapshotBlock } from '@/lib/services/report-snapshot';
import { assuranceLevelLabel, frameworkLabel } from '../../../../_components/labels';
import { createReportNoteAction } from '../../../../actions';
import { SharedReportHonesty } from '../_components/report-honesty';

export const metadata = { title: '開示レポートの内容' };

type SearchParams = Record<string, string | string[] | undefined>;

function param(query: SearchParams, key: string): string | null {
  const value = query[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** コメントの対象の選択肢の値（actions.ts の reportNoteTargetOf と同じ形） */
function targetValueOf(unit: TraceUnit): string | null {
  if (unit.kind === 'paragraph') return `paragraph|${unit.blockId}|${unit.paragraphId}`;
  return unit.dataPointVersionId ? `metric|${unit.dataPointVersionId}` : null;
}

/** 段落・数値（追跡番号）にコメントが付いているか */
function notesForUnit(notes: readonly FirmNoteEntry[], unit: TraceUnit): FirmNoteEntry[] {
  return notes.filter(({ note }) =>
    unit.kind === 'paragraph'
      ? note.targetType === 'report_paragraph' &&
        note.targetBlockId === unit.blockId &&
        note.targetParagraphId === unit.paragraphId
      : note.targetType === 'report_metric' &&
        unit.dataPointVersionId !== null &&
        note.targetDataPointVersionId === unit.dataPointVersionId,
  );
}

/**
 * 開示レポートの内容（トライアル対応 NF-20・NF-21 の保証側。NF-14 のトレース画面の保証側版・閲覧のみ）。
 *
 * 企業が共有した写しだけを描く（企業原本・ライブの値は読まない）。本文は出力と同じ文字列
 * （renderBlockParagraphs。対外用と同じ伏せ字）。段落・数値を選ぶと、要求事項・承認版・根拠・数値と
 * 追跡できない理由を右に出す。主操作は「コメントを追加」（段落・数値にコメントし、既定は法人内部限定）。
 */
export default async function SharedReportContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string; copyId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { engagementId, copyId } = await params;
  const query = await searchParams;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const listPath = `/assurance/engagements/${engagementId}/reports`;
  const basePath = `${listPath}/${copyId}`;

  let view: SharedReportView;
  try {
    view = await loadSharedReportView(db, ctx, { engagementId, copyId });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthorizationError) {
      return (
        <PermissionDeniedState
          description="開示レポートを見るには、案件の閲覧権限が必要です。"
          permission="assurance.engagement.read"
        />
      );
    }
    throw error;
  }
  // 閲覧の記録（1 画面 1 件・要約だけ。監査法人の監査ログに残る。企業側の監査ログには出ない）
  await recordSharedReportView(db, ctx, { engagementId, copyId, label: view.label });

  const { content, integrityOk, notes } = view;
  const frameworks = content.frameworkVersions;
  const framework =
    frameworks.find((f) => f.frameworkVersionId === param(query, 'fw')) ?? frameworks[0] ?? null;
  const all = sharedReportTrace(content);
  const trace = sharedReportTrace(content, {
    frameworkVersionId: framework?.frameworkVersionId ?? null,
  });
  const filter = param(query, 'view') === 'untraceable' ? 'untraceable' : 'document';
  const untraceable = trace.units.filter((u) => !u.traceable);
  const search = param(query, 'q')?.trim() ?? '';
  const matches = search ? findTraceUnits(all.units, search) : [];
  const selected = all.units.find((u) => u.traceId === param(query, 'unit')) ?? null;

  const canWrite = can(ctx, 'assurance.review.write') && integrityOk;
  const panelOpen = canWrite && isCreatePanelOpen(query);
  const limit = noteBodyLimit(ctx);

  // 担当の候補は案件のメンバー（法人内）。氏名は自法人のプロフィールから
  const members = await db.select('engagementMembers', {
    where: { engagementId, removedAt: { isNull: true } },
  });
  const profileIds = [
    ...new Set([...members.map((m) => m.userId), ...notes.map((n) => n.note.raisedBy)]),
  ];
  const profiles =
    profileIds.length > 0 ? await db.select('profiles', { where: { id: { in: profileIds } } }) : [];
  const nameOf = (id: string | null) =>
    id ? (profiles.find((p) => p.id === id)?.displayName ?? '—') : '—';

  // 描画は出力と同じ関数（renderBlockParagraphs）。写しは伏せ字を当て済みのため、追加で伏せる名前は無い。
  // 関数が読むのは数値と出典（metricValues・anchors）だけで、写しはスナップショットと同じ形を持つ
  const snapshotLike = content as unknown as ReportSnapshotDetail;
  const blocks = framework ? blocksOfFramework(snapshotLike, framework.frameworkVersionId) : [];

  const hrefWith = (patch: Record<string, string | null>, hash?: string) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== 'string' || ['new', 'error', 'et', 'result'].includes(key)) continue;
      next.set(key, value);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const qs = next.toString();
    return `${basePath}${qs ? `?${qs}` : ''}${hash ? `#${hash}` : ''}`;
  };
  const unitHref = (unit: TraceUnit) => hrefWith({ unit: unit.traceId }, 'trace-detail');
  // 同じ数値の版を複数の段落が引用していても、コメントの対象は 1 つ（数値の版）。手書きの数値は対象にできない
  const options = [
    ...new Map(
      all.units
        .map((unit) => ({ unit, value: targetValueOf(unit) }))
        .filter((o): o is { unit: TraceUnit; value: string } => o.value !== null)
        .map((o) => [o.value, o] as const),
    ).values(),
  ];
  const selectedValue = selected ? targetValueOf(selected) : null;

  return (
    <>
      <PageHeader
        title="開示レポートの内容"
        context={
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="font-mono font-medium" data-engagement-code="">
              {context.engagement.code}
            </span>
            <span className="font-medium">{context.clientName}</span>
            <span className="text-ink-muted">
              ／ {view.label} ／ 共有 {formatJst(view.copy.sharedAt)} ／{' '}
              {assuranceLevelLabel(context.engagement.assuranceLevel)} ／{' '}
              {frameworkLabel(context.engagement.frameworkKey)}
            </span>
          </span>
        }
        breadcrumbs={[
          { label: '案件ホーム', href: '/assurance/dashboard' },
          { label: '保証契約', href: '/assurance/engagements' },
          {
            label: context.engagement.code,
            href: `/assurance/engagements/${engagementId}/overview`,
          },
          { label: '開示レポート', href: listPath },
          { label: view.label },
        ]}
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'create-report-note',
              shortcut: 'new',
              label: 'コメントを追加',
              icon: <MessageSquarePlus aria-hidden="true" />,
              href: `${createPanelHref(basePath, query, { open: true })}#create-report-note`,
              hidden: !canWrite || panelOpen,
            }}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {param(query, 'result') === 'note-created' && (
          <Notice tone="success" role="status">
            コメントを追加しました。「クライアントへ共有」にしたコメントだけが企業側に表示されます。
          </Notice>
        )}
        {/* 誠実さの注記（社内承認・提出ではない・閲覧のみ）。折りたたまない */}
        <SharedReportHonesty />

        {!integrityOk ? (
          <Notice tone="danger" role="alert" title="写しを表示できません">
            保存された写しの内容ハッシュが共有時と一致しないため、内容を表示しません。クライアントに再共有を依頼してください。
          </Notice>
        ) : (
          <>
            {canWrite && (
              <CreatePanel
                id="create-report-note"
                title="コメントを追加"
                searchParams={query}
                closeHref={createPanelHref(basePath, query, { open: false })}
                description="段落・数値を選んでコメントします。既定は法人内部限定で、「クライアントへ共有」にしたものだけが企業側に表示されます。"
              >
                <PreservingForm action={createReportNoteAction} className="space-y-2">
                  <input type="hidden" name="engagementId" value={engagementId} />
                  <input type="hidden" name="copyId" value={copyId} />
                  {selected && <input type="hidden" name="unit" value={selected.traceId} />}
                  <div className="grid grid-cols-6 gap-2">
                    <Field label="対象（段落・数値）" name="target" required className="col-span-4">
                      {(p) => (
                        <NativeSelect {...p} name="target" defaultValue={selectedValue ?? ''}>
                          <option value="" disabled>
                            （選んでください）
                          </option>
                          {options.map(({ unit, value }) => (
                            <option key={value} value={value}>
                              {unit.traceId} {unit.kind === 'paragraph' ? '段落' : '数値'}：
                              {unit.blockTitle} — {unit.text.slice(0, 30)}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </Field>
                    <Field label="担当" name="assignedTo" className="col-span-2">
                      {(p) => (
                        <NativeSelect {...p} name="assignedTo" defaultValue="">
                          <option value="">（未割当）</option>
                          {members.map((m) => (
                            <option key={m.id} value={m.userId}>
                              {nameOf(m.userId)}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </Field>
                  </div>
                  <Field
                    label="コメント"
                    name="body"
                    required
                    hint={`${limit} 字まで。企業原本は変わりません（コメントは監査法人の記録です）。`}
                  >
                    {(p) => <Textarea {...p} name="body" rows={3} maxLength={limit} />}
                  </Field>
                  <NativeCheckbox
                    name="sharedWithClient"
                    label="クライアントへ共有する（既定は内部限定。共有すると企業が回答できます）"
                  />
                  <div>
                    <SubmitButton
                      variant="primary"
                      size="sm"
                      icon={<MessageSquarePlus aria-hidden="true" />}
                      pendingLabel="追加中…"
                    >
                      追加
                    </SubmitButton>
                  </div>
                </PreservingForm>
              </CreatePanel>
            )}

            <Section
              title="追跡率"
              summary={trace.summary.label}
              actions={
                <form method="get" action={basePath} className="flex items-center gap-1">
                  {framework && (
                    <input type="hidden" name="fw" value={framework.frameworkVersionId} />
                  )}
                  <label htmlFor="trace-search" className="sr-only">
                    本文の文・数値・追跡番号で探す
                  </label>
                  <Input
                    id="trace-search"
                    name="q"
                    defaultValue={search}
                    placeholder="文・数値・追跡番号で探す"
                    className="h-7 w-field-sm"
                  />
                  <SubmitButton size="xs" variant="secondary" icon={<Search aria-hidden="true" />}>
                    探す
                  </SubmitButton>
                </form>
              }
            >
              <div className="grid grid-cols-3 gap-3">
                <FractionBar
                  label="追跡できる要素（段落＋数値）"
                  numerator={trace.summary.all.traceable}
                  denominator={trace.summary.all.total}
                  showPercent
                />
                <FractionBar
                  label="段落"
                  numerator={trace.summary.paragraphs.traceable}
                  denominator={trace.summary.paragraphs.total}
                />
                <FractionBar
                  label="数値"
                  numerator={trace.summary.numbers.traceable}
                  denominator={trace.summary.numbers.total}
                />
              </div>
              <p className="mt-1 text-caption text-ink-muted">
                追跡できる＝節に要求事項があり、固定した版が承認済みで承認日時が写しにあり、根拠（出典・数値の参照）がある段落と、承認済みで値と根拠資料のある数値。本文に直接書いた数値は追跡できません。
              </p>
              {trace.narrativeEvidenceUnknown && (
                <p className="mt-0.5 text-caption text-warning-ink">
                  定性情報の引用の根拠（引用位置）は写しに含まれないため、定性情報の引用だけを根拠とする段落は「根拠なし」と数えます（企業側の追跡率と異なることがあります）。
                </p>
              )}
              {search && (
                <div className="mt-2" data-trace-search="">
                  <p className="text-small font-medium text-ink">
                    「{search}」に当たる要素（{matches.length}）
                  </p>
                  {matches.length === 0 ? (
                    <EmptyState
                      kind="filtered"
                      size="compact"
                      title="当たる段落・数値はありません"
                      resetHref={hrefWith({ q: null })}
                    />
                  ) : (
                    <ul className="divide-y divide-line">
                      {matches.map((unit) => (
                        <li
                          key={unit.traceId}
                          className="flex items-baseline gap-2 py-1 text-small"
                        >
                          <Link
                            href={hrefWith(
                              { unit: unit.traceId, fw: unit.frameworkVersionId, q: null },
                              'trace-detail',
                            )}
                            className="font-mono text-brand-700 hover:underline"
                          >
                            {unit.traceId}
                          </Link>
                          <span className="text-ink-muted">{unit.blockTitle}</span>
                          <span className="truncate text-ink">{unit.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Section>

            <div className="flex flex-wrap items-center gap-2">
              {frameworks.length > 1 && (
                <SegmentedFilter
                  ariaLabel="基準を切り替える"
                  current={framework?.frameworkVersionId ?? ''}
                  items={frameworks.map((f) => ({
                    key: f.frameworkVersionId,
                    label: f.frameworkName,
                    href: hrefWith({ fw: f.frameworkVersionId, unit: null }),
                  }))}
                />
              )}
              <SegmentedFilter
                ariaLabel="表示する要素"
                current={filter}
                items={[
                  { key: 'document', label: '本文', href: hrefWith({ view: null }) },
                  {
                    key: 'untraceable',
                    label: '追跡できない要素',
                    href: hrefWith({ view: 'untraceable' }),
                    count: untraceable.length,
                    attention: untraceable.length > 0,
                  },
                ]}
              />
            </div>

            <div className="grid grid-cols-5 gap-3">
              <div className="col-span-3 min-w-0 space-y-3">
                {filter === 'untraceable' ? (
                  <UntraceableList units={untraceable} unitHref={unitHref} />
                ) : blocks.length === 0 ? (
                  <EmptyState
                    kind="not-applicable"
                    size="compact"
                    title="この基準の節はありません"
                    description="写しに含まれる節がありません。"
                  />
                ) : (
                  blocks.map((block) => (
                    <BlockView
                      key={block.blockId}
                      block={block}
                      paragraphs={renderBlockParagraphs(block, snapshotLike, 'external', [])}
                      units={trace.units.filter((u) => u.blockId === block.blockId)}
                      notes={notes}
                      selectedId={selected?.traceId ?? null}
                      unitHref={unitHref}
                    />
                  ))
                )}
              </div>
              <aside
                id="trace-detail"
                aria-label="選んだ段落・数値の遡り"
                className="col-span-2 min-w-0 self-start rounded-t4d-lg border border-line bg-surface p-3"
              >
                {selected ? (
                  <UnitDetail
                    unit={selected}
                    view={view}
                    notes={notesForUnit(notes, selected)}
                    commentHref={
                      canWrite
                        ? `${createPanelHref(basePath, { ...query, unit: selected.traceId }, { open: true })}#create-report-note`
                        : null
                    }
                  />
                ) : (
                  <EmptyState
                    kind="not-applicable"
                    size="compact"
                    title="段落・数値を選んでください"
                    description="本文の追跡番号を押すと、要求事項・承認版・根拠・数値と、追跡できない理由をここに表示します。"
                  />
                )}
              </aside>
            </div>
          </>
        )}

        <Section id="report-notes" title={`コメント（${notes.length}）`}>
          {notes.length === 0 ? (
            <EmptyState
              kind="not-applicable"
              size="compact"
              title="この開示レポートへのコメントはありません"
              description="段落・数値を選んで「コメントを追加」から起票します。"
            />
          ) : (
            <ul className="divide-y divide-line rounded-t4d border border-line">
              {notes.map((entry) => (
                <NoteItem
                  key={entry.note.id}
                  entry={entry}
                  view={view}
                  units={all.units}
                  nameOf={nameOf}
                  unitHref={(traceId) => hrefWith({ unit: traceId }, 'trace-detail')}
                />
              ))}
            </ul>
          )}
          <p className="mt-1 text-caption text-ink-muted">
            対応内容の記録とクリアは
            <Link
              href={`/assurance/engagements/${engagementId}/review-notes`}
              // 文中のリンクは色だけで区別しない（下線。WCAG 1.4.1）
              className="mx-0.5 text-brand-700 underline underline-offset-2"
            >
              レビューNote
            </Link>
            で行います。
          </p>
        </Section>
      </div>
    </>
  );
}

function BlockView({
  block,
  paragraphs,
  units,
  notes,
  selectedId,
  unitHref,
}: {
  block: SnapshotBlock;
  paragraphs: RenderedParagraph[];
  units: TraceUnit[];
  notes: readonly FirmNoteEntry[];
  selectedId: string | null;
  unitHref: (unit: TraceUnit) => string;
}) {
  return (
    <section
      aria-labelledby={`block-${block.blockId}`}
      className="rounded-t4d-lg border border-line bg-surface p-3"
      data-report-block=""
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`block-${block.blockId}`} className="text-body font-semibold text-ink">
          {block.title}
        </h2>
        <span className="text-caption text-ink-muted">
          {block.requirements.length > 0
            ? `要求事項 ${block.requirements.map((r) => r.code).join('・')}`
            : '要求事項の対応付けなし'}
          {block.approval ? ` ／ 承認 ${formatJstDate(block.approval.approvedAt)}` : ''}
        </span>
      </div>
      <ol className="mt-1.5 space-y-1.5">
        {paragraphs.map((p) => {
          if (p.kind === 'heading') {
            return (
              <li key={p.paragraphId}>
                <h3 className="text-small font-semibold text-ink">{p.text}</h3>
              </li>
            );
          }
          const unit = units.find((u) => u.kind === 'paragraph' && u.paragraphId === p.paragraphId);
          const numbers = units.filter(
            (u) => u.kind === 'number' && u.paragraphId === p.paragraphId,
          );
          const noteCount = unit
            ? [unit, ...numbers].reduce((n, u) => n + notesForUnit(notes, u).length, 0)
            : 0;
          const isSelected =
            unit !== undefined &&
            (selectedId === unit.traceId || numbers.some((n) => n.traceId === selectedId));
          return (
            <li
              key={p.paragraphId}
              className={
                isSelected
                  ? 'rounded-t4d border border-brand-300 bg-selected px-2 py-1'
                  : 'rounded-t4d border border-transparent px-2 py-1'
              }
              data-paragraph-id={p.paragraphId}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                {unit ? (
                  <Link
                    href={unitHref(unit)}
                    className="font-mono text-caption font-medium text-brand-700 hover:underline"
                    aria-label={`${unit.traceId}（${block.title} 段落 ${unit.paragraphNo}）を選ぶ`}
                    data-trace-id={unit.traceId}
                  >
                    {unit.traceId}
                  </Link>
                ) : null}
                {unit &&
                  (unit.traceable ? (
                    <SemanticBadge semantic="done" label="追跡できる" />
                  ) : (
                    <SemanticBadge semantic="blocked" label="追跡できない" />
                  ))}
                {noteCount > 0 && <SemanticBadge semantic="info" label={`コメント ${noteCount}`} />}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-body text-ink">{p.text}</p>
              {numbers.length > 0 && (
                <ul className="mt-0.5 flex flex-wrap gap-1" aria-label="この段落の数値">
                  {numbers.map((n) => (
                    <li key={n.traceId}>
                      <Link
                        href={unitHref(n)}
                        data-trace-id={n.traceId}
                        className="inline-flex items-center gap-1 rounded-t4d border border-line px-1.5 py-0.5 text-caption text-ink hover:border-brand-300"
                      >
                        <span className="font-mono text-brand-700">{n.traceId}</span>
                        <span className="tnum">{n.text}</span>
                        <span className="sr-only">
                          {n.traceable ? '（追跡できる）' : '（追跡できない）'}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function UntraceableList({
  units,
  unitHref,
}: {
  units: TraceUnit[];
  unitHref: (unit: TraceUnit) => string;
}) {
  if (units.length === 0) {
    return (
      <EmptyState
        kind="done"
        size="compact"
        title="追跡できない要素はありません"
        description="この基準の段落・数値は、すべて要求事項・承認版・根拠へ遡れます。"
      />
    );
  }
  return (
    <ul className="divide-y divide-line rounded-t4d-lg border border-line bg-surface">
      {units.map((unit) => (
        <li key={unit.traceId} className="space-y-0.5 px-3 py-1.5" data-untraceable="">
          <div className="flex flex-wrap items-center gap-1.5 text-small">
            <Link
              href={unitHref(unit)}
              className="font-mono font-medium text-brand-700 hover:underline"
            >
              {unit.traceId}
            </Link>
            <span className="text-ink-muted">
              {unit.blockTitle}・{unit.kind === 'paragraph' ? '段落' : '数値'}
            </span>
            <span className="truncate text-ink">{unit.text}</span>
          </div>
          <ul className="text-caption text-warning-ink">
            {unit.reasons.map((reason) => (
              <li key={reason}>・{TRACE_REASON_LABELS[reason]}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function UnitDetail({
  unit,
  view,
  notes,
  commentHref,
}: {
  unit: TraceUnit;
  view: SharedReportView;
  notes: FirmNoteEntry[];
  commentHref: string | null;
}) {
  const { content } = view;
  const block = content.blocks.find((b) => b.blockId === unit.blockId) ?? null;
  const paragraph = block?.body.paragraphs.find((p) => p.id === unit.paragraphId) ?? null;
  const citedAnchorIds = new Set(
    (paragraph?.children ?? []).flatMap((c) => (c.t === 'cite' ? [c.sourceAnchorId] : [])),
  );
  const anchors = content.anchors.filter((a) => citedAnchorIds.has(a.sourceAnchorId));
  const metricVersionIds =
    unit.kind === 'number'
      ? unit.dataPointVersionId
        ? [unit.dataPointVersionId]
        : []
      : (paragraph?.children ?? []).flatMap((c) =>
          c.t === 'metric' ? [c.dataPointVersionId] : [],
        );
  const metrics = content.metricValues.filter((m) =>
    metricVersionIds.includes(m.dataPointVersionId),
  );
  const narrativeQuotes = (paragraph?.children ?? []).filter((c) => c.t === 'narrative').length;

  return (
    <div className="space-y-2 text-small" data-trace-detail={unit.traceId}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono font-semibold text-ink">{unit.traceId}</span>
        <span className="text-ink-muted">{unit.kind === 'paragraph' ? '段落' : '数値'}</span>
        {unit.traceable ? (
          <SemanticBadge semantic="done" label="追跡できる" />
        ) : (
          <SemanticBadge semantic="blocked" label="追跡できない" />
        )}
      </div>
      <p className="rounded-t4d bg-surface-muted px-2 py-1 text-ink">{unit.text}</p>

      {unit.reasons.length > 0 && (
        <DetailBlock title="追跡できない理由">
          <ul className="text-warning-ink">
            {unit.reasons.map((reason) => (
              <li key={reason}>・{TRACE_REASON_LABELS[reason]}</li>
            ))}
          </ul>
        </DetailBlock>
      )}

      <DetailBlock title={`要求事項（${block?.requirements.length ?? 0}）`}>
        {block && block.requirements.length > 0 ? (
          <ul className="space-y-0.5">
            {block.requirements.map((r) => (
              <li key={r.itemId}>
                <span className="font-mono">{r.code}</span>
                <span className="ml-1 text-ink-muted">{r.text.slice(0, 80)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">この節に要求事項は対応付けられていません。</p>
        )}
      </DetailBlock>

      <DetailBlock title="承認版">
        {block ? (
          <dl className="space-y-0.5">
            <DetailRow label="節">
              {block.title}（版 {block.versionNo ?? '—'}）
            </DetailRow>
            <DetailRow label="承認">
              {!block.isApprovedVersion
                ? '承認済みの版ではありません'
                : block.approval
                  ? `社内の最終承認 ${formatJst(block.approval.approvedAt)}（承認の記録あり）`
                  : '承認の記録が写しにありません'}
            </DetailRow>
            <DetailRow label="レビュー">
              {block.approval?.reviewedBy ? '第 1 段のレビューの記録あり' : '記録なし'}
            </DetailRow>
          </dl>
        ) : (
          <p className="text-ink-muted">節が写しに見つかりません。</p>
        )}
        <p className="mt-0.5 text-caption text-ink-muted">
          承認者の氏名は写しに含めません（対外用と同じ扱い）。社内承認は第三者保証ではありません。
        </p>
      </DetailBlock>

      <DetailBlock title={`根拠（出典 ${anchors.length}・定性情報の引用 ${narrativeQuotes}）`}>
        {anchors.length === 0 ? (
          <p className="text-ink-muted">この段落に出典印はありません。</p>
        ) : (
          <ul className="space-y-1">
            {anchors.map((a) => (
              <li key={a.sourceAnchorId}>
                <span>{anchorDisplay(a, 'external')}</span>
                {a.quoteText && (
                  <span className="block text-caption text-ink-muted">
                    「{a.quoteText.slice(0, 120)}」
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-0.5 text-caption text-ink-muted">
          非公開資料は「社内資料」と表示し、引用文は含めません。資料の実体は、許諾が Evidence
          を含むときだけ開けます。
        </p>
      </DetailBlock>

      <DetailBlock title={`数値（${metrics.length}）`}>
        {metrics.length === 0 ? (
          <p className="text-ink-muted">数値の参照はありません。</p>
        ) : (
          <ul className="space-y-1">
            {metrics.map((m) => (
              <li key={m.dataPointVersionId}>
                <span className="font-medium">{m.metricName}</span>
                <span className="ml-1 text-ink-muted">
                  {m.unitName} ／ {m.periodCode} ／ {m.boundary}
                </span>
                <span className="block tnum">
                  {metricDisplay(m)}（版 {m.versionNo}・{m.versionApproved ? '承認済み' : '未承認'}
                  ・根拠資料{' '}
                  {m.evidenceFileVersionIds ? `${m.evidenceFileVersionIds.length} 件` : '記録なし'}
                  ）
                </span>
              </li>
            ))}
          </ul>
        )}
      </DetailBlock>

      <DetailBlock title={`コメント（${notes.length}）`}>
        {notes.length === 0 ? (
          <p className="text-ink-muted">この要素へのコメントはありません。</p>
        ) : (
          <ul className="space-y-1">
            {notes.map(({ note, state }) => (
              <li key={note.id} className="flex flex-wrap items-center gap-1">
                {note.sharedWithClient ? (
                  <StatusBadge domain="clientNote" value={state} />
                ) : (
                  <SemanticBadge semantic="excluded" label="法人内部限定" />
                )}
                <span className="truncate">{note.body}</span>
              </li>
            ))}
          </ul>
        )}
        {commentHref && (
          <Link href={commentHref} className="mt-1 inline-block text-brand-700 hover:underline">
            この{unit.kind === 'paragraph' ? '段落' : '数値'}にコメントする
          </Link>
        )}
      </DetailBlock>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-1.5">
      <h3 className="mb-0.5 text-small font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function NoteItem({
  entry,
  view,
  units,
  nameOf,
  unitHref,
}: {
  entry: FirmNoteEntry;
  view: SharedReportView;
  units: TraceUnit[];
  nameOf: (id: string | null) => string;
  unitHref: (traceId: string) => string;
}) {
  const { note, responses, state } = entry;
  const target = describeReportNoteTarget(note, view.content, units);
  return (
    <li className="space-y-1 p-3" data-t4d-record="" data-report-note="">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge domain="reviewNote" value={note.status} />
        {note.sharedWithClient ? (
          <StatusBadge domain="clientNote" value={state} />
        ) : (
          <SemanticBadge semantic="excluded" label="法人内部限定" />
        )}
        {target && (
          <span className="text-small text-ink-muted">
            対象:{' '}
            {target.traceId ? (
              <Link
                href={unitHref(target.traceId)}
                className="font-mono text-brand-700 hover:underline"
              >
                {target.traceId}
              </Link>
            ) : null}{' '}
            {target.place}
          </span>
        )}
        <span className="ml-auto text-caption text-ink-muted">
          {nameOf(note.raisedBy)} ／ {formatJst(note.createdAt)}
        </span>
      </div>
      <p className="text-small text-ink">{note.body}</p>
      {note.assignedTo && (
        <p className="text-caption text-ink-muted">担当: {nameOf(note.assignedTo)}</p>
      )}
      {responses.length > 0 && (
        <ul className="space-y-0.5 border-l-2 border-line pl-2" aria-label="クライアントの回答">
          {responses.map((r) => (
            <li key={r.id} className="text-small">
              <span className="text-caption font-medium text-ink">クライアントの回答</span>
              <span className="ml-1 text-caption text-ink-muted">{formatJst(r.respondedAt)}</span>
              <p className="text-ink">{r.body}</p>
            </li>
          ))}
        </ul>
      )}
      {note.resolutionComment && (
        <p className="text-small text-success">対応: {note.resolutionComment}</p>
      )}
    </li>
  );
}
