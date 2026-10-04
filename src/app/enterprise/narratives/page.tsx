import Link from 'next/link';
import {
  Banknote,
  BookText,
  Check,
  CircleDot,
  Compass,
  FilePlus2,
  FileText,
  History,
  Landmark,
  Quote,
  RefreshCcw,
  Search,
  Tag,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { AuthorizationError, can } from '@/lib/authorization/can';
import { NARRATIVE_STATUS_LABELS, NARRATIVE_THEME_LABELS } from '@/lib/domain/disclosure-status';
import { formatJst } from '@/lib/format/datetime';
import {
  isNarrativeStatus,
  isNarrativeTheme,
  listNarratives,
  type NarrativeListRow,
} from '@/lib/services/narrative';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { cn } from '@/lib/utils';
import {
  NARRATIVE_STATUSES,
  NARRATIVE_THEMES,
  type NarrativeStatus,
  type NarrativeTheme,
} from '@/types/domain';
import { carryForwardNarrativeAction } from './actions';
import { CandidateBadge, NarrativeStatusBadge } from './_components/narrative-badges';

export const metadata = { title: '定性情報' };

/** 内訳の帯のアイコン（状態は状態バッジと同じもの。色だけで区別しない） */
const NARRATIVE_STATUS_ICONS: Record<NarrativeStatus, LucideIcon> = {
  draft: CircleDot,
  confirmed: Check,
  needs_recheck: RefreshCcw,
};
const NARRATIVE_THEME_ICONS: Record<NarrativeTheme, LucideIcon> = {
  risk_opportunity: TriangleAlert,
  financial_impact: Banknote,
  governance: Landmark,
  strategy: Compass,
  policy_other: FileText,
};

/**
 * 定性情報の一覧（§6.5）。原稿とは別の、再利用できる記録。
 * 列: 題名・年度と対象範囲・情報種別・責任者・最新確認日・根拠件数・利用先原稿・状態。
 * 操作: 新しく登録／前年から引継ぎ（新年度の下書き。確認は引き継がない）／資料から候補を作成。
 */
export default async function NarrativesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const theme = isNarrativeTheme(query.theme) ? query.theme : null;
  const status = isNarrativeStatus(query.status) ? query.status : null;
  const q = typeof query.q === 'string' ? query.q : '';

  let rows: NarrativeListRow[];
  try {
    rows = await listNarratives(db, ctx, { theme, status, q });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader
            title="定性情報"
            breadcrumbs={[{ label: '企業ワークスペース' }, { label: '定性情報' }]}
          />
          <PermissionDeniedState description="定性情報を見るには、開示の閲覧権限が必要です。" />
        </>
      );
    }
    throw error;
  }
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const target = shell.currentPeriod;
  // 状態別・種別の内訳は絞り込みに関係なく全件で数える（絞り込むと内訳が 1 区分だけになるため）
  const filtered = theme !== null || status !== null || q !== '';
  const allRows = filtered ? await listNarratives(db, ctx, {}) : rows;

  const hrefWith = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged = { theme, status, q: q || null, ...patch };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    const s = params.toString();
    return s ? `/enterprise/narratives?${s}` : '/enterprise/narratives';
  };

  return (
    <>
      <PageHeader
        title="定性情報"
        description="原稿とは別に管理する、再利用できる定性情報の記録"
        help={
          <p>
            リスク・機会、ガバナンス、戦略・対応策、方針などを、原稿とは別の再利用できる記録として管理します。原稿は引用した時点の版を持ち、ここを更新しても原稿は自動では書き換わりません。
          </p>
        }
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '定性情報' }]}
        actions={
          canWrite ? (
            <>
              <Button size="sm" asChild>
                <Link href="/enterprise/narratives/new">
                  <FilePlus2 aria-hidden="true" />
                  新しく登録
                </Link>
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link href="/enterprise/narratives/new?mode=documents">
                  <Quote aria-hidden="true" />
                  資料から候補を作成
                </Link>
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {allRows.length > 0 && (
          <Card className="grid gap-3 px-3 py-2 md:grid-cols-2">
            {/* ラベルは絞り込みの選択肢と同じ文言。リンクにはしない（同じ名前のリンクを重ねない） */}
            <StatusBreakdown
              label={`状態別（全 ${allRows.length} 件）`}
              items={NARRATIVE_STATUSES.map((s) => ({
                key: s,
                label: NARRATIVE_STATUS_LABELS[s],
                count: allRows.filter((row) => row.record.status === s).length,
                icon: NARRATIVE_STATUS_ICONS[s],
              }))}
            />
            <StatusBreakdown
              label={`情報種別別（全 ${allRows.length} 件）`}
              items={NARRATIVE_THEMES.map((t) => ({
                key: t,
                label: NARRATIVE_THEME_LABELS[t],
                count: allRows.filter((row) => row.record.theme === t).length,
                icon: NARRATIVE_THEME_ICONS[t],
              }))}
            />
          </Card>
        )}

        <Card>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <nav aria-label="情報種別で絞り込む" className="flex flex-wrap gap-1">
              <FilterLink href={hrefWith({ theme: null })} active={theme === null}>
                すべての種別
              </FilterLink>
              {NARRATIVE_THEMES.map((t) => (
                <FilterLink key={t} href={hrefWith({ theme: t })} active={theme === t}>
                  {NARRATIVE_THEME_LABELS[t]}
                </FilterLink>
              ))}
            </nav>
            <nav aria-label="状態で絞り込む" className="flex flex-wrap gap-1">
              <FilterLink href={hrefWith({ status: null })} active={status === null}>
                すべての状態
              </FilterLink>
              {NARRATIVE_STATUSES.map((s) => (
                <FilterLink key={s} href={hrefWith({ status: s })} active={status === s}>
                  {NARRATIVE_STATUS_LABELS[s]}
                </FilterLink>
              ))}
            </nav>
            <form
              method="get"
              action="/enterprise/narratives"
              role="search"
              className="ml-auto flex items-center gap-1"
            >
              {theme && <input type="hidden" name="theme" value={theme} />}
              {status && <input type="hidden" name="status" value={status} />}
              <label htmlFor="narrative-q" className="sr-only">
                題名・タグ・本文で検索
              </label>
              <Input
                id="narrative-q"
                name="q"
                defaultValue={q}
                placeholder="題名・タグ・本文で検索"
                className="w-56"
              />
              <Button type="submit" size="icon" variant="outline" aria-label="検索">
                <Search aria-hidden="true" />
              </Button>
            </form>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title={`定性情報（${rows.length}）`} />
          {rows.length === 0 ? (
            <EmptyState
              title="該当する定性情報はありません"
              description="新しく登録するか、登録した資料の抜粋から候補を作成してください。"
              icon={<BookText className="size-5" aria-hidden="true" />}
            />
          ) : (
            <div className="t4d-scroll-x max-h-[70vh] overflow-y-auto">
              <Table>
                <THead className="sticky top-0 z-10 bg-surface">
                  <TR>
                    <TH>題名</TH>
                    <TH>年度・対象範囲</TH>
                    <TH>情報種別</TH>
                    <TH>責任者</TH>
                    <TH>最新確認日</TH>
                    <TH align="right">根拠件数</TH>
                    <TH>利用先原稿</TH>
                    <TH>状態</TH>
                    {canWrite && <TH className="w-40">操作</TH>}
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => {
                    const canCarry =
                      canWrite &&
                      row.currentVersion !== null &&
                      row.period !== null &&
                      row.period.startDate < target.startDate;
                    return (
                      <TR key={row.record.id}>
                        <TD className="min-w-[220px] align-top">
                          <Link
                            href={`/enterprise/narratives/${row.record.id}`}
                            className="font-medium text-brand-800 hover:underline"
                          >
                            {row.record.title}
                          </Link>
                          <span className="mt-0.5 flex flex-wrap gap-1">
                            {row.isCandidate && <CandidateBadge />}
                            {row.carried && (
                              <Badge tone="neutral">
                                <History className="size-3" aria-hidden="true" />
                                前年から引継ぎ
                              </Badge>
                            )}
                            {row.record.tags.map((t) => (
                              <Badge key={t} tone="outline">
                                <Tag className="size-3" aria-hidden="true" />
                                {t}
                              </Badge>
                            ))}
                          </span>
                          {row.missingFieldCount > 0 && (
                            <span className="mt-0.5 block text-[11px] text-[#8a5d00]">
                              未記入の項目 {row.missingFieldCount} 件
                            </span>
                          )}
                        </TD>
                        <TD className="min-w-[160px] align-top text-[12px]">
                          {row.period?.code ?? '—'}
                          <span className="block text-[11px] text-ink-muted">
                            {row.scopeNote || '（対象範囲の記載なし）'}
                          </span>
                          {row.currentVersion === null && row.record.currentVersionId !== null && (
                            <span className="block text-[11px] text-danger">
                              版が見つかりません（デモ環境の再起動で失われた可能性）
                            </span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap align-top text-[12px]">
                          {row.themeLabel}
                        </TD>
                        <TD className="align-top text-[12px]">
                          {row.ownerName ?? '—'}
                          {row.record.ownerDepartment && (
                            <span className="block text-[11px] text-ink-muted">
                              {row.record.ownerDepartment}
                            </span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap align-top text-[12px]">
                          {row.confirmedAt ? formatJst(row.confirmedAt) : '未確認'}
                          {row.confirmedAt && !row.confirmedIsCurrent && (
                            <span className="block text-[11px] text-ink-muted">
                              （前の版を確認）
                            </span>
                          )}
                        </TD>
                        <TD align="right" className="align-top text-[12px]">
                          {row.evidenceCount}
                        </TD>
                        <TD className="min-w-[200px] align-top text-[12px]">
                          {row.usage.length === 0 ? (
                            <span className="text-ink-muted">なし</span>
                          ) : (
                            <ul className="space-y-0.5">
                              {row.usage.map((u) => (
                                <li key={u.blockId}>
                                  <Link
                                    href={`/enterprise/disclosure-projects/${u.projectId}/blocks/${u.blockId}`}
                                    className="text-brand-800 hover:underline"
                                  >
                                    {u.blockTitle}
                                  </Link>
                                  <span className="text-[11px] text-ink-muted">
                                    （{u.blockStatusLabel}）
                                  </span>
                                  {!u.citesCurrent && (
                                    <span className="block text-[11px] text-[#8a5d00]">
                                      引用中の版 {u.citedVersionNo ?? '—'} は最新ではありません
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </TD>
                        <TD className="align-top">
                          <NarrativeStatusBadge status={row.record.status} />
                        </TD>
                        {canWrite && (
                          <TD className="align-top">
                            {canCarry && (
                              <form action={carryForwardNarrativeAction}>
                                <input type="hidden" name="narrativeId" value={row.record.id} />
                                <input type="hidden" name="targetPeriodId" value={target.id} />
                                <SubmitButton size="xs" variant="outline" pendingLabel="作成中…">
                                  前年から引継ぎ（{target.code} へ）
                                </SubmitButton>
                              </form>
                            )}
                          </TD>
                        )}
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
        <MoreInfo label="前年から引継ぎについて">
          <p>
            前年から引継ぎは {target.code}{' '}
            の下書きの版を作ります。前年の確認（承認）や前年の資料の引用は引き継がず、当年度の根拠を改めて付けます。
          </p>
        </MoreInfo>
      </div>
    </>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-t4d border px-2 py-0.5 text-[12px]',
        active
          ? 'border-brand-300 bg-brand-50 font-semibold text-brand-900'
          : 'border-line bg-surface text-ink',
      )}
    >
      {children}
    </Link>
  );
}
