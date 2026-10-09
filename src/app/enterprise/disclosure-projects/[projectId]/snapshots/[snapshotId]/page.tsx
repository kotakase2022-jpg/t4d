import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Download, FileSearch, Route, Search } from 'lucide-react';
import { FractionBar } from '@/components/charts/fraction-bar';
import { FlashMessage } from '@/components/shared/flash';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { SegmentedFilter, type NavTabItem } from '@/components/shared/nav-tabs';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { SemanticBadge } from '@/components/shared/status-badge';
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/shared/states';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { AuthorizationError, NotFoundError, can } from '@/lib/authorization/can';
import type { TraceUnit } from '@/lib/domain/report-trace';
import { formatJst } from '@/lib/format/datetime';
import { SNAPSHOT_KIND_DISPLAY } from '@/lib/services/report-snapshot';
import {
  loadSnapshotTrace,
  parseTraceCodes,
  type SnapshotTraceView,
  type TraceUnitDetail,
} from '@/lib/services/report-trace';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { cn } from '@/lib/utils';

export const metadata = { title: 'スナップショットの内容とトレース' };

type SearchParams = Record<string, string | string[] | undefined>;

function param(sp: SearchParams, key: string): string | null {
  const value = sp[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * スナップショットの内容とトレース（トライアル対応 NF-14。スライド 10 の評価 #1）。
 *
 * - 左: 基準を切り替えて、出力（社内確認用）と同じ文字列で本文を示す。段落・数値を選べる
 * - 右: 選んだ段落・数値の要求事項・承認版（節・版・承認者・日時・依頼）・根拠（資料・版・位置・引用文）・
 *   数値（指標・組織・期間・境界・値・版・承認）・定性情報。追跡できない理由を必ず出す
 * - 上: 追跡率（分母付き。選定ケースで分母が変わる）と「追跡できない要素」の絞込、出力物の文・数値・
 *   追跡番号からの検索
 * - 閲覧画面なので primary は置かない。副操作は「追跡表を出力（XLSX）」（出力の権限があるときだけ）
 * - 判定はスナップショット（固定した写し）だけから行う。何も書き込まない
 * - 社内承認は第三者保証ではない・ファイル作成は提出ではない（注記は閉じない）
 */
export default async function SnapshotTracePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; snapshotId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { projectId, snapshotId } = await params;
  const sp = await searchParams;
  const { db, ctx } = await loadEnterpriseShell();
  const projectPath = `/enterprise/disclosure-projects/${projectId}`;
  const basePath = `${projectPath}/snapshots/${snapshotId}`;

  let view: SnapshotTraceView;
  try {
    view = await loadSnapshotTrace(db, ctx, {
      projectId,
      snapshotId,
      frameworkVersionId: param(sp, 'framework'),
      codes: parseTraceCodes(param(sp, 'codes')),
      caseMode: param(sp, 'case') === 'all' ? 'all' : 'default',
      unit: param(sp, 'unit'),
      query: param(sp, 'q'),
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader
            title="スナップショットの内容とトレース"
            breadcrumbs={[
              { label: 'ホーム', href: '/enterprise/dashboard' },
              { label: '開示プロジェクト', href: '/enterprise/disclosure-projects' },
              { label: 'スナップショット' },
            ]}
          />
          <div className="p-4">
            <PermissionDeniedState
              description="スナップショットの内容とトレースを見るには、開示の閲覧権限が必要です。"
              permission="enterprise.disclosure.read"
            />
          </div>
        </>
      );
    }
    throw error;
  }

  const { snapshot, framework, summary } = view;
  const snapshotName = `${SNAPSHOT_KIND_DISPLAY[snapshot.snapshotKind]} No.${snapshot.snapshotNo}`;
  const canExport = can(ctx, 'enterprise.export.run');
  const untraceableOnly = param(sp, 'filter') === 'untraceable';
  const untraceableCount = view.units.filter((u) => !u.traceable).length;

  /** 今の条件を保ったまま一部を変えた URL */
  const hrefWith = (changes: Record<string, string | null>, hash?: string) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(sp)) {
      if (typeof value === 'string' && value !== '') query.set(key, value);
    }
    for (const key of ['flash', 'error', 'et']) query.delete(key);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) query.delete(key);
      else query.set(key, value);
    }
    const text = query.toString();
    return `${basePath}${text ? `?${text}` : ''}${hash ? `#${hash}` : ''}`;
  };

  const traceXlsxHref = (() => {
    const query = new URLSearchParams({ format: 'trace_xlsx', project: projectId });
    if (framework) query.set('framework', framework.frameworkVersionId);
    if (summary.selectedCodes) query.set('codes', summary.selectedCodes.join(','));
    return `/api/exports/disclosure-snapshots/${encodeURIComponent(snapshot.id)}?${query.toString()}`;
  })();

  const frameworkTabs: NavTabItem[] = view.frameworks.map((f) => ({
    key: f.frameworkVersionId,
    label: f.label,
    href: hrefWith({ framework: f.frameworkVersionId, unit: null }),
  }));
  const caseTabs: NavTabItem[] = [
    ...(view.trialCaseCodes
      ? [
          {
            key: 'trial_program',
            label: `選定ケース（トライアル計画・要求事項 ${view.trialCaseCodes.length} 件）`,
            href: hrefWith({ case: null, codes: null, unit: null }),
          },
        ]
      : []),
    ...(view.caseSource === 'query'
      ? [
          {
            key: 'query',
            label: `指定した要求事項（${summary.selectedCodes?.length ?? 0} 件）`,
            href: hrefWith({}),
          },
        ]
      : []),
    { key: 'all', label: '全件', href: hrefWith({ case: 'all', codes: null, unit: null }) },
  ];
  const filterTabs: NavTabItem[] = [
    { key: 'all', label: 'すべて', href: hrefWith({ filter: null }) },
    {
      key: 'untraceable',
      label: '追跡できない要素',
      count: untraceableCount,
      attention: untraceableCount > 0,
      href: hrefWith({ filter: 'untraceable' }),
    },
  ];

  return (
    <>
      <PageHeader
        title="スナップショットの内容とトレース"
        context={
          <span className="flex flex-wrap items-center gap-1.5">
            <span>{view.project.name}</span>
            <span aria-hidden="true">・</span>
            <span>{snapshotName}</span>
            <span aria-hidden="true">・</span>
            <span>
              内容ハッシュ <code className="text-caption">{snapshot.contentHash.slice(0, 12)}</code>
              <span className="sr-only">（全体: {snapshot.contentHash}）</span>
            </span>
          </span>
        }
        description={`作成 ${view.createdByName}・${formatJst(snapshot.createdAt)}`}
        breadcrumbs={[
          { label: 'ホーム', href: '/enterprise/dashboard' },
          { label: '開示プロジェクト', href: '/enterprise/disclosure-projects' },
          { label: view.project.name, href: projectPath },
          { label: '出力', href: `${projectPath}?tab=outputs` },
          { label: snapshotName },
        ]}
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'trace-xlsx',
                label: '追跡表を出力（XLSX）',
                icon: <Download aria-hidden="true" />,
                href: traceXlsxHref,
                external: true,
                hidden: !canExport || !view.integrityOk,
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={sp} />
        {/* 誠実さの注記（閉じない） */}
        <Notice tone="info">
          <span className="flex flex-wrap items-center gap-1.5">
            {snapshot.snapshotKind === 'approved' && <HonestyBadge kind="internal-approval" />}
            {view.frameworks.some((f) => f.coverageStatus === 'sample') && (
              <HonestyBadge kind="sample-master" />
            )}
            <span>
              ファイル作成は提出ではありません。{SNAPSHOT_KIND_DISPLAY.approved}
              は社内の承認であり、第三者による保証ではありません。本文はスナップショットに固定した版です（以後の変更は反映しません）。
            </span>
          </span>
        </Notice>
        {framework?.draftStandardPrep && (
          <Notice tone="warning">
            {framework.label} は草案の基準による準備です。法定準拠の確定ではありません。
          </Notice>
        )}

        {!view.integrityOk ? (
          <div className="space-y-2">
            <ErrorState
              what="スナップショットの内容を表示できません"
              why="保存された内容が作成時の内容ハッシュと一致しません（内容が変わった可能性があります）。"
              how="出力タブで新しいスナップショットを作成してください。続く場合は管理者へ連絡してください。"
            />
            <p className="text-center">
              <Link
                href={`${projectPath}?tab=outputs`}
                className="text-small text-brand-800 underline"
              >
                出力タブへ戻る
              </Link>
            </p>
          </div>
        ) : (
          <>
            {/* 追跡率（分母付き）と絞込 */}
            <section
              aria-labelledby="trace-summary-title"
              className="space-y-2 rounded-t4d-lg border border-line bg-surface px-3 py-2"
            >
              <h2 id="trace-summary-title" className="sr-only">
                追跡率
              </h2>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="space-y-1">
                  <FractionBar
                    label={`追跡できる要素（${framework?.label ?? '基準なし'}）`}
                    numerator={summary.all.traceable}
                    denominator={summary.all.total}
                    showPercent
                  />
                  <p className="text-caption text-ink-muted" data-testid="trace-rate">
                    追跡率 {summary.label}
                  </p>
                </div>
                <div className="space-y-1">
                  <SegmentedFilter
                    ariaLabel="選定ケース"
                    items={caseTabs}
                    current={view.caseSource}
                  />
                  <p className="text-caption text-ink-muted">
                    {summary.selectedCodes
                      ? `分母は選定ケースの要求事項（${summary.selectedCodes.join('、')}）に対応する節の段落・数値です。`
                      : '分母はこの基準の全節の、本文のある段落と数値です（見出しは数えません）。'}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-2">
                {view.frameworks.length > 1 && (
                  <SegmentedFilter
                    ariaLabel="基準"
                    items={frameworkTabs}
                    current={framework?.frameworkVersionId ?? ''}
                  />
                )}
                <SegmentedFilter
                  ariaLabel="表示する要素"
                  items={filterTabs}
                  current={untraceableOnly ? 'untraceable' : 'all'}
                />
              </div>
              <form
                method="get"
                action={basePath}
                className="flex flex-wrap items-end gap-2"
                role="search"
                aria-label="出力物から段落を探す"
              >
                {framework && (
                  <input type="hidden" name="framework" value={framework.frameworkVersionId} />
                )}
                {view.caseSource === 'all' && <input type="hidden" name="case" value="all" />}
                {view.caseSource === 'query' && summary.selectedCodes && (
                  <input type="hidden" name="codes" value={summary.selectedCodes.join(',')} />
                )}
                <Field
                  label="出力物の文・数値・追跡番号から段落を探す"
                  name="q"
                  id="trace-search"
                  className="min-w-[280px] flex-1"
                >
                  {(p) => (
                    <Input
                      {...p}
                      name="q"
                      defaultValue={param(sp, 'q') ?? ''}
                      placeholder="例: T-G-1／出力した原稿の一文／1,240.5 t-CO2e"
                    />
                  )}
                </Field>
                <SubmitButton variant="secondary" size="sm">
                  <Search aria-hidden="true" />
                  探す
                </SubmitButton>
              </form>
              {view.search && (
                <div className="space-y-1" data-testid="trace-search-results">
                  <p className="text-small text-ink">
                    「{view.search.query}」に当たる要素: {view.search.hits.length} 件
                  </p>
                  {view.search.hits.length === 0 ? (
                    <EmptyState
                      kind="filtered"
                      size="compact"
                      title="当たる段落・数値がありません"
                      description="出力物の文は句読点まで同じ文字列で、数値は単位を含めて入力してください。"
                      resetHref={hrefWith({ q: null })}
                    />
                  ) : (
                    <ul className="flex flex-wrap gap-1.5">
                      {view.search.hits.map((u) => (
                        <li key={u.traceId}>
                          <Link
                            href={hrefWith({ unit: u.traceId }, 'trace-detail')}
                            className="inline-flex items-center gap-1 rounded-t4d border border-line px-1.5 py-0.5 text-small text-brand-800 hover:bg-brand-50"
                          >
                            <code>{u.traceId}</code>
                            <span className="max-w-[24ch] truncate">{u.blockTitle}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

            <div className="grid gap-x-4 gap-y-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              {/* 左: 本文（出力と同じ文字列） */}
              <Section title="本文（出力と同じ文字列）" summary={framework?.label} divider="none">
                {view.blocks.length === 0 ? (
                  <EmptyState
                    kind="not-applicable"
                    size="compact"
                    title="この基準の節はありません"
                    description="スナップショットに固定した節がありません。"
                  />
                ) : (
                  <div className="space-y-3">
                    {view.blocks.map((blockView) => (
                      <TraceBlock
                        key={blockView.block.blockId}
                        view={blockView}
                        selected={view.selected?.unit.traceId ?? null}
                        untraceableOnly={untraceableOnly}
                        hrefFor={(unit) => hrefWith({ unit: unit.traceId }, 'trace-detail')}
                      />
                    ))}
                  </div>
                )}
              </Section>

              {/* 右: 選んだ要素のトレース */}
              <Section
                id="trace-detail"
                title="トレース"
                summary={view.selected ? view.selected.unit.traceId : '段落・数値を選んでください'}
                divider="none"
                className="lg:sticky lg:top-2 lg:self-start"
              >
                {view.selected ? (
                  <TraceDetail detail={view.selected} projectId={projectId} />
                ) : (
                  <EmptyState
                    kind="not-applicable"
                    size="compact"
                    icon={<Route className="size-5" aria-hidden="true" />}
                    title="段落・数値を選ぶと、遡り先を表示します"
                    description="要求事項・承認版（承認者・日時）・根拠・数値の版を、選んだ要素ごとに示します。"
                  />
                )}
              </Section>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function TraceableBadge({ unit }: { unit: TraceUnit }) {
  return unit.traceable ? (
    <SemanticBadge semantic="done" label="追跡できる" />
  ) : (
    <SemanticBadge semantic="blocked" label="追跡できない" />
  );
}

function TraceBlock({
  view,
  selected,
  untraceableOnly,
  hrefFor,
}: {
  view: SnapshotTraceView['blocks'][number];
  selected: string | null;
  untraceableOnly: boolean;
  hrefFor: (unit: TraceUnit) => string;
}) {
  const { block } = view;
  const paragraphs = untraceableOnly
    ? view.paragraphs.filter(
        (p) => (p.unit && !p.unit.traceable) || p.numbers.some((n) => !n.traceable),
      )
    : view.paragraphs;
  if (untraceableOnly && paragraphs.length === 0) return null;
  return (
    <article
      aria-labelledby={`trace-block-${block.blockId}`}
      className={cn(
        'rounded-t4d border border-line bg-surface px-3 py-2',
        !view.inScope && 'border-dashed',
      )}
    >
      <h3
        id={`trace-block-${block.blockId}`}
        className="flex flex-wrap items-center gap-1.5 text-body font-semibold text-ink"
      >
        {block.title}
        <span className="text-caption font-normal text-ink-muted">
          版 {block.versionNo ?? '—'}・要求事項{' '}
          {block.requirements.map((r) => r.code).join('、') || 'なし'}
        </span>
        {!block.isApprovedVersion && <SemanticBadge semantic="draft" label="未承認の版" />}
      </h3>
      {!view.inScope && (
        <p className="text-caption text-ink-muted">
          選定ケースの対象外の節です（追跡率には数えません）。
        </p>
      )}
      {paragraphs.length === 0 ? (
        <p className="mt-1 text-small text-ink-muted">（本文なし）</p>
      ) : (
        <ol className="mt-1 space-y-1.5">
          {paragraphs.map((p) => {
            if (p.kind === 'heading') {
              return (
                <li key={p.paragraphId} className="text-small font-semibold text-ink">
                  {p.text}
                </li>
              );
            }
            const isSelected =
              p.unit?.traceId === selected || p.numbers.some((n) => n.traceId === selected);
            return (
              <li
                key={p.paragraphId}
                className={cn(
                  'rounded-t4d px-1.5 py-1',
                  isSelected ? 'bg-brand-50 ring-1 ring-brand-300' : 'hover:bg-surface-muted',
                )}
              >
                {p.unit ? (
                  <Link
                    href={hrefFor(p.unit)}
                    data-trace-id={p.unit.traceId}
                    aria-current={p.unit.traceId === selected ? 'true' : undefined}
                    className="block text-small text-ink hover:underline"
                  >
                    {p.text}
                  </Link>
                ) : (
                  <p className="text-small text-ink">{p.text}</p>
                )}
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {p.unit && (
                    <>
                      <code className="text-caption text-ink-muted">{p.unit.traceId}</code>
                      <TraceableBadge unit={p.unit} />
                    </>
                  )}
                  {p.numbers.map((n) => (
                    <Link
                      key={n.traceId}
                      href={hrefFor(n)}
                      data-trace-id={n.traceId}
                      aria-current={n.traceId === selected ? 'true' : undefined}
                      className="inline-flex items-center gap-1 rounded-t4d border border-line px-1 text-caption text-brand-800 hover:bg-brand-50"
                    >
                      <span>数値 {n.text || n.traceId}</span>
                      <span className="text-ink-muted">
                        （{n.traceable ? '追跡できる' : '追跡できない'}）
                      </span>
                    </Link>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2 border-b border-line py-1 last:border-b-0">
      <dt className="text-caption text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-small text-ink">{children}</dd>
    </div>
  );
}

function TraceDetail({ detail, projectId }: { detail: TraceUnitDetail; projectId: string }) {
  const { unit, block, approval } = detail;
  const projectPath = `/enterprise/disclosure-projects/${projectId}`;
  return (
    <div className="space-y-2" data-testid="trace-detail">
      <p className="flex flex-wrap items-center gap-1.5 text-small text-ink">
        <code className="font-medium">{unit.traceId}</code>
        <span>{unit.kind === 'paragraph' ? '段落' : '数値'}</span>
        <TraceableBadge unit={unit} />
      </p>
      {detail.reasonLabels.length > 0 && (
        <Notice tone="warning" title="追跡できない理由">
          <ul className="list-disc pl-4">
            {detail.reasonLabels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </Notice>
      )}
      <dl>
        <DetailRow label="要求事項">
          {detail.requirements.length === 0 ? (
            <span className="text-ink-muted">対応付けなし</span>
          ) : (
            <ul className="space-y-0.5">
              {detail.requirements.map((r) => (
                <li key={r.itemId}>
                  <Link
                    href={`${projectPath}/requirements/${r.itemId}`}
                    className="text-brand-800 underline"
                  >
                    {r.code}
                  </Link>{' '}
                  <span className="text-caption text-ink-muted">{r.text}</span>
                </li>
              ))}
            </ul>
          )}
        </DetailRow>
        <DetailRow label="承認版">
          <Link
            href={`${projectPath}/blocks/${block.blockId}`}
            className="text-brand-800 underline"
          >
            {block.title}
          </Link>{' '}
          版 {approval.versionNo ?? '—'}（
          {approval.isApprovedVersion ? '承認済みの版' : '未承認の版'}）
        </DetailRow>
        <DetailRow label="最終承認者">{approval.approvedByName ?? '—'}</DetailRow>
        <DetailRow label="承認日時">
          {approval.approvedAt ? formatJst(approval.approvedAt) : '—'}
        </DetailRow>
        <DetailRow label="レビュー担当">{approval.reviewedByName ?? '—'}</DetailRow>
        <DetailRow label="承認の依頼">
          {approval.reviewRequestId ? (
            <Link href={`${projectPath}?tab=reviews`} className="text-brand-800 underline">
              レビュー・承認の記録を開く
            </Link>
          ) : (
            '—'
          )}
        </DetailRow>
        <DetailRow label="根拠">
          {detail.evidence.length === 0 &&
          detail.narratives.filter((n) => n.hasEvidence).length === 0 &&
          detail.metrics.every((m) => m.evidence.length === 0) ? (
            <span className="text-ink-muted">なし</span>
          ) : (
            <ul className="space-y-1">
              {detail.evidence.map((e) => (
                <li key={e.label}>
                  {e.fileId ? (
                    <Link
                      href={`/enterprise/evidence/${e.fileId}${e.page !== null ? `?page=${e.page}` : ''}`}
                      className="inline-flex items-center gap-1 text-brand-800 underline"
                    >
                      <FileSearch className="size-3" aria-hidden="true" />
                      {e.label}
                    </Link>
                  ) : (
                    e.label
                  )}
                  {e.quote && <p className="text-caption text-ink-muted">「{e.quote}」</p>}
                </li>
              ))}
              {detail.metrics.flatMap((m) =>
                m.evidence.map((e, index) => (
                  <li key={`${m.metric.dataPointVersionId}-${index}`}>
                    {e.fileId ? (
                      <Link
                        href={`/enterprise/evidence/${e.fileId}`}
                        className="inline-flex items-center gap-1 text-brand-800 underline"
                      >
                        <FileSearch className="size-3" aria-hidden="true" />
                        {e.label}
                      </Link>
                    ) : (
                      e.label
                    )}
                    <span className="text-caption text-ink-muted">
                      （{m.metric.metricName} の根拠資料）
                    </span>
                  </li>
                )),
              )}
            </ul>
          )}
        </DetailRow>
        <DetailRow label="数値">
          {detail.metrics.length === 0 ? (
            <span className="text-ink-muted">
              {unit.kind === 'number' ? '参照なし（本文に直接書いた数値）' : 'なし'}
            </span>
          ) : (
            <ul className="space-y-1">
              {detail.metrics.map((m) => (
                <li key={m.metric.dataPointVersionId}>
                  <Link
                    href={`/enterprise/data/${m.metric.dataPointId}`}
                    className="text-brand-800 underline"
                  >
                    {m.metric.metricName}
                  </Link>{' '}
                  {m.display}
                  <p className="text-caption text-ink-muted">
                    {m.metric.unitName}・{m.metric.periodCode}・境界 {m.metric.boundary || '—'}・版{' '}
                    {m.metric.versionNo}（{m.metric.versionApproved ? '承認済み' : '未承認'}）
                  </p>
                </li>
              ))}
            </ul>
          )}
        </DetailRow>
        <DetailRow label="定性情報">
          {detail.narratives.length === 0 ? (
            <span className="text-ink-muted">なし</span>
          ) : (
            <ul className="space-y-0.5">
              {detail.narratives.map((n) => (
                <li key={n.versionId}>
                  {n.title}（版 {n.versionNo ?? '—'}）
                  <span className="text-caption text-ink-muted">
                    {n.hasEvidence ? '・根拠あり' : '・根拠なし'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailRow>
      </dl>
    </div>
  );
}
