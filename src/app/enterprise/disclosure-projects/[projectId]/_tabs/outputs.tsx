import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Download,
  FileCode2,
  FileSearch,
  FileText,
  Info,
  Lock,
  Route,
  Share2,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { PageActions } from '@/components/shared/page-actions';
import { RowActions } from '@/components/shared/row-actions';
import { Section } from '@/components/shared/section';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible } from '@/components/ui/collapsible';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { NotFoundError, can } from '@/lib/authorization/can';
import {
  APPLICABILITY_STATUS_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
  EXPORT_ARTIFACT_FORMAT_LABELS,
} from '@/lib/domain/disclosure-status';
import {
  MISMATCH_KIND_LABELS,
  reconciledCountsText,
  reconciliationOutcomeOf,
  reconciliationStateOf,
} from '@/lib/domain/export-reconciliation';
import { diffSnapshots } from '@/lib/domain/snapshot-diff';
import {
  AUDIENCE_DISPLAY,
  INTERNAL_APPROVAL_NOTICE,
  RECONCILIATION_NOTICE,
} from '@/lib/exports/disclosure-report';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  listExportArtifacts,
  listShareTargets,
  listSnapshotShares,
  type ShareTarget,
  type SnapshotShareView,
} from '@/lib/services/disclosure-export';
import {
  listReconciliations,
  loadReconciliation,
  type ReconciliationView,
} from '@/lib/services/export-reconciliation';
import {
  SNAPSHOT_KIND_DISPLAY,
  evaluateReportReadiness,
  listProjectSnapshots,
  type SnapshotListEntry,
} from '@/lib/services/report-snapshot';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import type { MenuActionSpec } from '@/lib/ui/actions';
import type {
  ExportArtifactFormat,
  ExportAudience,
  ExportReconciliationMismatch,
  ReportSnapshotKind,
} from '@/types/domain';
import {
  confirmReportAction,
  createReviewDraftSnapshotAction,
  reconcileUploadedFileAction,
  shareReportAction,
  withdrawSharedReportAction,
} from '../outputs/actions';
import { SnapshotDiffView } from '../outputs/snapshot-diff-view';

/**
 * 開示プロジェクトの「出力」タブ（指示書 §6.10、docs/disclosure-first.md §5「レポート確定」「出力」、plan S1）。
 *
 * - 主操作は「レポートを確定する」（最終承認の権限を持つ人だけ）。取り消せない操作なので確認ダイアログで
 *   範囲（承認済みの版を不変のスナップショットとして固定）を示してから送る（plan §1.16 区分 1）。
 *   「レビュー用草稿を作成」は副操作
 * - 出力する版を「レビュー用草稿」「社内承認済み版」から選ぶ。どちらもスナップショットを作ってから、
 *   そのスナップショットだけを元に DOCX / XLSX / CSV を生成する（ライブの値から組み立てない）。
 * - 確定できない理由は常に並べる。押せない状態の表示は画面だけで、確定の操作でもサーバー（confirmReport）が
 *   同じ判定をやり直す。
 * - ファイルの作成は提出ではない。社内承認は第三者保証ではない（どちらも画面に明記する）。
 * - スナップショット作成後に上流が変わった場合は注意として示すだけで、スナップショットは変えない（§10.3）。
 *
 * トライアル対応（2026-10）で足したもの:
 * - スナップショットの行の「内容とトレースを開く」（NF-14）と「操作 ▾」: 追跡表・突合結果の出力、
 *   保証側へ共有／共有を取り下げる（NF-20。取り消せないため確認ダイアログ）、外部で編集したファイルの照合
 *   （NF-15 の P1）、XBRL（社内確認用。NF-42 の出力への入口）
 * - 出力の記録の「突合」列（NF-15。生成したファイルを読み戻して承認版と照合した結果）と、
 *   不一致で止めた出力・外部ファイルの照合の記録
 * - 承認版どうしの差分（NF-13）
 */

type SearchParams = Record<string, string | string[] | undefined>;

function param(searchParams: SearchParams, key: string): string | null {
  const value = searchParams[key];
  return typeof value === 'string' ? value : null;
}

function exportHref(
  snapshot: { id: string; projectId: string },
  format: ExportArtifactFormat | 'trace_xlsx' | 'reconciliation_xlsx',
  audience: ExportAudience,
  frameworkVersionId?: string,
): string {
  // project は、出力できなかったとき（デモで別のサーバーに当たったなど）に出力タブへ戻して理由を示すため
  const query = new URLSearchParams({ format, audience, project: snapshot.projectId });
  if (frameworkVersionId) query.set('framework', frameworkVersionId);
  return `/api/exports/disclosure-snapshots/${encodeURIComponent(snapshot.id)}?${query.toString()}`;
}

/** XBRL（社内確認用）の出力（スライス T6 の API。ここは入口のリンクだけ） */
function xbrlHref(snapshot: { id: string; projectId: string }, format: string): string {
  const query = new URLSearchParams({ format, audience: 'internal', project: snapshot.projectId });
  return `/api/exports/xbrl/${encodeURIComponent(snapshot.id)}?${query.toString()}`;
}

function SnapshotKindBadge({ kind }: { kind: ReportSnapshotKind }) {
  return kind === 'approved' ? (
    <Badge tone="success">
      <BadgeCheck className="size-3" aria-hidden="true" />
      {SNAPSHOT_KIND_DISPLAY.approved}
    </Badge>
  ) : (
    <Badge tone="outline">
      <FileText className="size-3" aria-hidden="true" />
      {SNAPSHOT_KIND_DISPLAY.review_draft}
    </Badge>
  );
}

function DownloadLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="secondary" size="xs">
      {/* download 属性は付けない（失敗時の出力タブへの戻りをファイルとして保存させない）。
          成功時は Content-Disposition: attachment でダウンロードになる */}
      <a href={href}>
        <Download aria-hidden="true" />
        {children}
      </a>
    </Button>
  );
}

/** ハッシュの先頭 12 文字（全体は読み上げ用に添える。title= には入れない） */
function ShortHash({ value }: { value: string }) {
  return (
    <code className="text-caption">
      {value.slice(0, 12)}
      <span className="sr-only">（全体: {value}）</span>
    </code>
  );
}

function SnapshotDownloads({ entry, canExport }: { entry: SnapshotListEntry; canExport: boolean }) {
  const { snapshot } = entry;
  if (!canExport) {
    return (
      <p className="flex items-center gap-1 text-caption text-ink-muted">
        <Lock className="size-3" aria-hidden="true" />
        出力の権限がありません
      </p>
    );
  }
  if (!entry.integrityOk) {
    return (
      <Badge tone="danger">
        <AlertTriangle className="size-3" aria-hidden="true" />
        内容ハッシュ不一致のため出力できません
      </Badge>
    );
  }
  return (
    <div className="space-y-1">
      {snapshot.frameworkVersions.map((framework) => (
        <div key={framework.frameworkVersionId} className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-caption text-ink-muted">DOCX 原稿（{framework.label}）</span>
          <DownloadLink
            href={exportHref(snapshot, 'docx', 'internal', framework.frameworkVersionId)}
          >
            社内確認用
          </DownloadLink>
          <DownloadLink
            href={exportHref(snapshot, 'docx', 'external', framework.frameworkVersionId)}
          >
            対外用
          </DownloadLink>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-caption text-ink-muted">対応表・数値</span>
        <DownloadLink href={exportHref(snapshot, 'xlsx', 'internal')}>
          XLSX 対応表（社内確認用）
        </DownloadLink>
        <DownloadLink href={exportHref(snapshot, 'csv', 'internal')}>
          CSV 数値（社内確認用）
        </DownloadLink>
        <DownloadLink href={exportHref(snapshot, 'csv', 'external')}>
          CSV 数値（対外用）
        </DownloadLink>
      </div>
    </div>
  );
}

/** 保証側への共有の状態（共有中の案件・取り下げ済みの件数） */
function ShareCell({ shares }: { shares: SnapshotShareView[] }) {
  const active = shares.filter((s) => s.withdrawnAt === null);
  const withdrawn = shares.length - active.length;
  if (shares.length === 0) return <span className="text-ink-muted">未共有</span>;
  return (
    <div className="space-y-0.5">
      {active.map((s) => (
        <div key={s.copyId} className="space-y-0.5">
          <p className="flex flex-wrap items-center gap-1">
            <StatusBadge domain="sharedReport" value="active" />
            <span className="text-caption">{s.engagementCode}</span>
          </p>
          {s.noteCount > 0 && (
            <Link
              href="/enterprise/assurance-comments"
              className="text-caption text-brand-700 hover:underline"
            >
              保証側のコメント {s.noteCount} 件（未回答 {s.unansweredCount}）
            </Link>
          )}
        </div>
      ))}
      {withdrawn > 0 && (
        <p className="flex flex-wrap items-center gap-1">
          <StatusBadge domain="sharedReport" value="withdrawn" />
          <span className="text-caption">{withdrawn} 件</span>
        </p>
      )}
    </div>
  );
}

function snapshotName(entry: SnapshotListEntry): string {
  return `${SNAPSHOT_KIND_DISPLAY[entry.snapshot.snapshotKind]} No.${entry.snapshot.snapshotNo}`;
}

/** スナップショットの行の「操作 ▾」（出力・共有・照合・XBRL） */
function snapshotMenu(input: {
  entry: SnapshotListEntry;
  projectId: string;
  projectPath: string;
  canExport: boolean;
  canShare: boolean;
  targets: ShareTarget[];
  shares: SnapshotShareView[];
}): MenuActionSpec[] {
  const { entry, projectId, projectPath, canExport, canShare, targets, shares } = input;
  const { snapshot } = entry;
  const name = snapshotName(entry);
  const hash12 = snapshot.contentHash.slice(0, 12);
  const active = shares.filter((s) => s.withdrawnAt === null);
  const sharedEngagements = new Set(active.map((s) => s.engagementId));
  const exportDisabled = entry.integrityOk
    ? undefined
    : '内容ハッシュが一致しないため出力できません';
  const items: MenuActionSpec[] = [
    {
      kind: 'link',
      id: `trace-xlsx-${snapshot.id}`,
      label: '追跡表を出力（XLSX・社内確認用）',
      icon: <Download className="size-3.5" aria-hidden="true" />,
      href: exportHref(snapshot, 'trace_xlsx', 'internal'),
      external: true,
      group: 'export',
      hidden: !canExport,
      disabledReason: exportDisabled,
    },
    {
      kind: 'link',
      id: `reconciliation-xlsx-${snapshot.id}`,
      label: '突合結果を出力（XLSX・社内確認用）',
      icon: <Download className="size-3.5" aria-hidden="true" />,
      href: exportHref(snapshot, 'reconciliation_xlsx', 'internal'),
      external: true,
      group: 'export',
      hidden: !canExport,
    },
    {
      kind: 'link',
      id: `xbrl-json-${snapshot.id}`,
      label: 'XBRL（xBRL-JSON・社内確認用）',
      icon: <FileCode2 className="size-3.5" aria-hidden="true" />,
      href: xbrlHref(snapshot, 'xbrl_json'),
      external: true,
      group: 'export',
      hidden: !canExport,
      disabledReason: exportDisabled,
    },
    {
      kind: 'link',
      id: `ixbrl-preview-${snapshot.id}`,
      label: 'インライン XBRL プレビュー（社内確認用）',
      icon: <FileCode2 className="size-3.5" aria-hidden="true" />,
      href: xbrlHref(snapshot, 'ixbrl_html'),
      external: true,
      group: 'export',
      hidden: !canExport,
      disabledReason: exportDisabled,
    },
    {
      kind: 'link',
      id: `xbrl-tab-${snapshot.id}`,
      label: 'XBRL タブを開く（対応付け・検証の結果）',
      icon: <FileCode2 className="size-3.5" aria-hidden="true" />,
      href: `${projectPath}?tab=xbrl&snapshot=${encodeURIComponent(snapshot.id)}`,
      group: 'export',
    },
    {
      kind: 'link',
      id: `reconcile-upload-${snapshot.id}`,
      label: '外部で編集したファイルを照合',
      icon: <FileSearch className="size-3.5" aria-hidden="true" />,
      href: `${projectPath}?tab=outputs&reconcile=1&rs=${encodeURIComponent(snapshot.id)}#external-reconcile`,
      group: 'advanced',
      hidden: !canExport,
      disabledReason: exportDisabled,
    },
  ];
  if (canShare) {
    if (snapshot.snapshotKind !== 'approved') {
      items.push({
        kind: 'link',
        id: `share-${snapshot.id}`,
        label: '保証側へ共有…',
        icon: <Share2 className="size-3.5" aria-hidden="true" />,
        href: '#',
        disabledReason: '社内承認済みのスナップショットだけを共有できます',
      });
    } else if (!entry.integrityOk) {
      items.push({
        kind: 'link',
        id: `share-${snapshot.id}`,
        label: '保証側へ共有…',
        icon: <Share2 className="size-3.5" aria-hidden="true" />,
        href: '#',
        disabledReason: '内容ハッシュが一致しないため共有できません',
      });
    } else {
      const open = targets.filter((t) => !sharedEngagements.has(t.engagementId));
      if (open.length === 0) {
        items.push({
          kind: 'link',
          id: `share-${snapshot.id}`,
          label: '保証側へ共有…',
          icon: <Share2 className="size-3.5" aria-hidden="true" />,
          href: '#',
          disabledReason:
            targets.length === 0
              ? '有効なアクセス許諾のある案件がありません（設定の「アクセス許諾」で付与します）'
              : '許諾のある案件すべてへ共有済みです',
        });
      }
      for (const target of open) {
        items.push({
          kind: 'confirm',
          id: `share-${snapshot.id}-${target.engagementId}`,
          label: `保証側へ共有（${target.code}）…`,
          icon: <Share2 className="size-3.5" aria-hidden="true" />,
          action: shareReportAction,
          fields: { projectId, snapshotId: snapshot.id, engagementId: target.engagementId },
          confirm: {
            tier: 'irreversible',
            title: '開示レポートを保証側へ共有しますか',
            scope: `案件 ${target.code} ${target.name}・${name}・内容ハッシュ ${hash12}`,
            consequences: [
              '共有した写しは変更されません。取り下げると保証側から見えなくなります。',
              '社内コメント・社内向けの確認事項は写しに含めません。非公開資料の名前は対外用と同じく伏せます。',
              `${INTERNAL_APPROVAL_NOTICE}共有は提出ではありません。`,
            ],
            confirmLabel: '共有する',
            destructive: false,
          },
        });
      }
    }
    for (const share of active) {
      items.push({
        kind: 'confirm',
        id: `withdraw-${share.copyId}`,
        label: `共有を取り下げる（${share.engagementCode}）…`,
        icon: <Undo2 className="size-3.5" aria-hidden="true" />,
        action: withdrawSharedReportAction,
        fields: { projectId, copyId: share.copyId },
        destructive: true,
        confirm: {
          tier: 'irreversible',
          title: '保証側への共有を取り下げますか',
          scope: `案件 ${share.engagementCode} ${share.engagementName}・${name}・内容ハッシュ ${hash12}`,
          consequences: [
            '取り下げると保証側から見えなくなります。取り下げは元に戻せません（もう一度共有すると新しい写しになります）。',
            '写しと共有の記録は消えません（追記専用の記録として残ります）。',
          ],
          confirmLabel: '取り下げる',
        },
      });
    }
  }
  return items;
}

/** 突合の結果（出力の記録の列） */
function ReconciliationCell({ artifact }: { artifact: ArtifactRow }) {
  const state = reconciliationStateOf(artifact);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge domain="reconciliation" value={state} />
      {state !== 'not_reconciled' && (
        <span className="text-caption text-ink-muted">
          （
          {reconciledCountsText({
            paragraphs: artifact.reconciledParagraphs,
            numbers: artifact.reconciledNumbers,
            rows: artifact.reconciledRows,
          })}
          ）
        </span>
      )}
    </span>
  );
}

const RECONCILIATION_SOURCE_LABELS: Record<ReconciliationView['source'], string> = {
  generated_blocked: '不一致で止めた出力',
  uploaded: '外部で編集したファイルの照合',
};

function MismatchTable({
  mismatches,
  total,
}: {
  mismatches: ExportReconciliationMismatch[];
  total: number;
}) {
  if (mismatches.length === 0) {
    return <p className="text-small text-ink-muted">不一致はありません。</p>;
  }
  return (
    <div className="space-y-1">
      <div className="t4d-scroll-x">
        <Table>
          <caption className="sr-only">不一致の明細（位置・承認版・ファイル）</caption>
          <THead>
            <TR>
              <TH>区分</TH>
              <TH>位置</TH>
              <TH>承認版（期待値）</TH>
              <TH>ファイル</TH>
            </TR>
          </THead>
          <TBody>
            {mismatches.map((m, index) => (
              <TR key={index}>
                <TD className="whitespace-nowrap text-small">{MISMATCH_KIND_LABELS[m.kind]}</TD>
                <TD className="text-small">{m.location}</TD>
                <TD className="text-small">{m.expected}</TD>
                <TD className="text-small">{m.actual}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      {total > mismatches.length && (
        <p className="text-caption text-ink-muted">
          明細は先頭 {mismatches.length} 件です（全 {total} 件）。
        </p>
      )}
    </div>
  );
}

type ArtifactRow = Awaited<ReturnType<typeof listExportArtifacts>>[number];

export async function OutputsTab({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: SearchParams;
}) {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  if (!can(ctx, 'enterprise.disclosure.read')) {
    return (
      <PermissionDeniedState
        description="出力の確認には開示の閲覧権限が必要です。"
        permission="enterprise.disclosure.read"
      />
    );
  }

  const [readiness, snapshots] = await Promise.all([
    evaluateReportReadiness(db, ctx, projectId),
    listProjectSnapshots(db, ctx, projectId),
  ]);
  const snapshotIds = snapshots.map((s) => s.snapshot.id);
  const [artifacts, reconciliations, shares, targets] = await Promise.all([
    listExportArtifacts(db, ctx, snapshotIds),
    listReconciliations(db, ctx, snapshotIds),
    listSnapshotShares(db, ctx, snapshotIds),
    listShareTargets(db, ctx),
  ]);
  const snapshotNoById = new Map(
    snapshots.map((s) => [
      s.snapshot.id,
      `${SNAPSHOT_KIND_DISPLAY[s.snapshot.snapshotKind]} No.${s.snapshot.snapshotNo}`,
    ]),
  );

  const canDraft = can(ctx, 'enterprise.disclosure.write') || can(ctx, 'enterprise.export.run');
  const canExport = can(ctx, 'enterprise.export.run');
  const canApprove = can(ctx, 'enterprise.disclosure.approve');
  const canShare = can(ctx, 'enterprise.grant.manage');
  // 番号以外が載った URL（手で作られたもの）で「作成しました」と見せない
  const createdParam = param(searchParams, 'snapshotCreated');
  const created = createdParam && /^\d{1,6}$/.test(createdParam) ? createdParam : null;
  const createdKind = param(searchParams, 'kind') === 'approved' ? 'approved' : 'review_draft';
  // 作成したスナップショットが、この一覧（このサーバーのメモリ）にあるか。デモでは作成したサーバーと
  // 一覧を描くサーバーが違うことがあり、無いのに「下の一覧から出力できます」と言わない
  const createdListed =
    created !== null &&
    snapshots.some(
      (s) => s.snapshot.snapshotKind === createdKind && String(s.snapshot.snapshotNo) === created,
    );
  const outputError = param(searchParams, 'outputError');
  const outputNotice = param(searchParams, 'outputNotice');
  const MAX_BLOCKERS = 8;
  const blockerCount = readiness.actorBlockers.length + readiness.blockers.length;
  const projectPath = `/enterprise/disclosure-projects/${projectId}`;
  const includedCount = readiness.frameworks.filter((f) => f.included).length;

  // 照合の結果（外部ファイルの照合・不一致で止めた出力から戻ったとき）
  const reconciliationId = param(searchParams, 'reconciliation');
  let selectedReconciliation: ReconciliationView | null = null;
  let reconciliationMissing = false;
  if (reconciliationId) {
    try {
      selectedReconciliation = await loadReconciliation(db, ctx, reconciliationId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      reconciliationMissing = true;
    }
  }
  // 不一致 0 件でも、照合した段落・数値・行が無ければ「一致」とは示さない
  const selectedOutcome = selectedReconciliation
    ? reconciliationOutcomeOf(selectedReconciliation.mismatchCount, {
        paragraphs: selectedReconciliation.paragraphsChecked,
        numbers: selectedReconciliation.numbersChecked,
        rows: selectedReconciliation.rowsChecked,
      })
    : null;

  // 外部で編集したファイルの照合（作成パネルと同じ置き場所。?reconcile=1&rs=<スナップショット>）
  const reconcileOpen = canExport && isCreatePanelOpen(searchParams, 'reconcile');
  const reconcileTarget = reconcileOpen
    ? (snapshots.find((s) => s.snapshot.id === param(searchParams, 'rs')) ?? null)
    : null;

  // 承認版どうしの差分（?diffFrom=&diffTo=）
  const approvedSnapshots = snapshots.filter((s) => s.snapshot.snapshotKind === 'approved');
  const diffFrom = snapshots.find((s) => s.snapshot.id === param(searchParams, 'diffFrom'));
  const diffTo = snapshots.find((s) => s.snapshot.id === param(searchParams, 'diffTo'));
  const diff = diffFrom && diffTo ? diffSnapshots(diffFrom.snapshot, diffTo.snapshot) : null;
  const diffRequested =
    param(searchParams, 'diffFrom') !== null || param(searchParams, 'diffTo') !== null;

  const sharesBySnapshot = new Map<string, SnapshotShareView[]>();
  for (const share of shares) {
    sharesBySnapshot.set(share.snapshotId, [
      ...(sharesBySnapshot.get(share.snapshotId) ?? []),
      share,
    ]);
  }

  const pageSize = parsePageSize(searchParams.size);
  const page = Math.min(
    parsePage(searchParams.page),
    Math.max(1, Math.ceil(artifacts.length / pageSize)),
  );
  const artifactColumns: DataTableColumn<ArtifactRow>[] = [
    {
      key: 'generatedAt',
      header: '出力日時',
      importance: 'primary',
      lockVisible: true,
      cell: (a) => <span className="whitespace-nowrap text-small">{formatJst(a.generatedAt)}</span>,
    },
    {
      key: 'format',
      header: '形式',
      importance: 'primary',
      cell: (a) => <span className="text-small">{EXPORT_ARTIFACT_FORMAT_LABELS[a.format]}</span>,
    },
    {
      key: 'fileName',
      header: 'ファイル名',
      importance: 'primary',
      width: 'lg',
      cell: (a) => <span className="break-all text-small">{a.fileName}</span>,
    },
    {
      key: 'reconciliation',
      header: '突合',
      importance: 'primary',
      cell: (a) => <ReconciliationCell artifact={a} />,
    },
    {
      key: 'generatedBy',
      header: '出力者',
      importance: 'primary',
      cell: (a) => <span className="text-small">{a.generatedByName}</span>,
    },
    {
      key: 'snapshot',
      header: 'スナップショット',
      importance: 'detail',
      cell: (a) => (
        <span className="text-small">
          {snapshotNoById.get(a.snapshotId) ?? '（このサーバーに無いスナップショット）'}
        </span>
      ),
    },
    {
      key: 'audience',
      header: '区分',
      importance: 'detail',
      cell: (a) => <span className="text-small">{AUDIENCE_DISPLAY[a.audience]}</span>,
    },
    {
      key: 'size',
      header: 'サイズ',
      importance: 'detail',
      align: 'right',
      cell: (a) => <span className="text-small">{formatNumber(a.byteSize)} B</span>,
    },
    {
      key: 'fileHash',
      header: 'ファイルのハッシュ',
      importance: 'detail',
      cell: (a) => <ShortHash value={a.fileSha256} />,
    },
    {
      key: 'contentHash',
      header: '内容ハッシュ',
      importance: 'detail',
      cell: (a) => <ShortHash value={a.contentHash} />,
    },
  ];

  return (
    <div className="space-y-3">
      {outputError && (
        <p
          role="alert"
          className="flex items-center gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-small text-ink"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {outputError}
        </p>
      )}
      {created && createdListed && (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 rounded-t4d border border-success/40 bg-success-soft px-3 py-1.5 text-small text-ink"
        >
          <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden="true" />
          {SNAPSHOT_KIND_DISPLAY[createdKind]}
          のスナップショット No.{created} を作成しました。下の一覧から出力できます。
        </p>
      )}
      {created && !createdListed && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-small text-ink"
          data-testid="snapshot-created-elsewhere"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
          <span>
            {SNAPSHOT_KIND_DISPLAY[createdKind]}のスナップショット No.{created}
            は作成しましたが、この画面を表示したサーバーの一覧にはありません
            {db.mode === 'demo'
              ? '（デモ環境ではスナップショットをこのブラウザの Cookie で持ち回すため、別のブラウザで作成した・古い操作が押し出された・固定した元の行が変わった可能性があります）'
              : ''}
            。一覧に無い場合は、作成し直してから出力してください。
          </span>
        </p>
      )}
      {(outputNotice === 'shared' || outputNotice === 'withdrawn') && (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 rounded-t4d border border-success/40 bg-success-soft px-3 py-1.5 text-small text-ink"
        >
          <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden="true" />
          {outputNotice === 'shared'
            ? '保証側へ共有しました。共有した写しは変更されません（取り下げると保証側から見えなくなります）。'
            : '共有を取り下げました。保証側からは見えません（写しと共有の記録は残ります）。'}
        </p>
      )}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div
          role="note"
          className="min-w-0 flex-1 space-y-0.5 rounded-t4d border border-brand-200 bg-brand-50 px-3 py-2 text-small text-brand-900"
        >
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 size-3.5 shrink-0 text-brand-600" aria-hidden="true" />
            <span>
              ファイル作成は提出ではありません（開示先へ提出・公表したことにはなりません）。
              {SNAPSHOT_KIND_DISPLAY.approved}
              は社内の承認であり、第三者による保証ではありません。
            </span>
          </p>
          {db.mode === 'demo' && (
            <MoreInfo label="デモでのスナップショットの保存" className="pl-5">
              <p>
                デモではスナップショットの目録をこのブラウザの Cookie
                で持ち回します。別のブラウザや、Cookie
                の容量不足で古い操作が押し出された後は一覧から消えることがあります（本番は追記専用の表に保存します）。
              </p>
            </MoreInfo>
          )}
        </div>
        <PageActions
          primary={{
            kind: 'confirm',
            id: 'confirm-report',
            label: 'レポートを確定する',
            icon: <BadgeCheck aria-hidden="true" />,
            action: confirmReportAction,
            fields: { projectId },
            hidden: !canApprove,
            disabledReason: readiness.canConfirm
              ? undefined
              : `確定できない理由が ${blockerCount} 件あります（下の「確定できない理由」を参照）`,
            confirm: {
              tier: 'irreversible',
              title: 'レポートを確定しますか',
              scope:
                '承認済みの版を不変のスナップショットとして固定します。以後の変更は差分として検知されます。',
              consequences: [
                `確定すると「${SNAPSHOT_KIND_DISPLAY.approved}」のスナップショットができ、取り消せません。`,
                'ファイル作成・確定は提出ではありません。社内の承認であり、第三者による保証ではありません。',
                ...(readiness.draftStandardPrep
                  ? ['草案の基準による準備を含みます。確定しても法定準拠の確定にはなりません。']
                  : []),
              ],
              confirmLabel: '確定する',
              destructive: false,
            },
          }}
          secondary={[
            {
              kind: 'submit',
              id: 'create-review-draft',
              label: `${SNAPSHOT_KIND_DISPLAY.review_draft}を作成`,
              icon: <FileText aria-hidden="true" />,
              action: createReviewDraftSnapshotAction,
              fields: { projectId },
              pendingLabel: '作成中…',
              hidden: !canDraft,
            },
          ]}
        />
      </div>

      {/* 照合の結果（外部ファイルの照合・不一致で止めた出力から戻ったとき）。エラー・不一致は閉じない */}
      {reconciliationId && (
        <Section
          id="reconciliation-result"
          title="照合の結果"
          summary={
            selectedReconciliation
              ? `${RECONCILIATION_SOURCE_LABELS[selectedReconciliation.source]}・${formatJst(selectedReconciliation.createdAt)}`
              : undefined
          }
        >
          {selectedReconciliation ? (
            <div className="space-y-1.5" data-testid="reconciliation-result">
              <p className="flex flex-wrap items-center gap-1.5 text-small text-ink">
                <StatusBadge domain="reconciliation" value={selectedOutcome!} />
                {selectedOutcome === 'matched'
                  ? '承認版と一致しました'
                  : selectedOutcome === 'nothing_checked'
                    ? '照合する段落・数値・行がありませんでした（一致の判定はしていません）'
                    : `不一致 ${selectedReconciliation.mismatchCount} 件`}
                <span className="text-caption text-ink-muted">
                  （
                  {reconciledCountsText({
                    paragraphs: selectedReconciliation.paragraphsChecked,
                    numbers: selectedReconciliation.numbersChecked,
                    rows: selectedReconciliation.rowsChecked,
                  })}
                  ・{snapshotNoById.get(selectedReconciliation.snapshotId) ?? 'スナップショット'}・
                  {EXPORT_ARTIFACT_FORMAT_LABELS[selectedReconciliation.format]}・
                  {AUDIENCE_DISPLAY[selectedReconciliation.audience]}）
                </span>
              </p>
              <p className="text-caption text-ink-muted">
                {RECONCILIATION_NOTICE}
                {selectedReconciliation.source === 'uploaded'
                  ? 'アップロードしたファイルは保存していません（ファイルのハッシュと照合の結果だけを記録しました）。'
                  : 'ファイルは渡していません（照合の記録だけを残しました）。'}
              </p>
              <MismatchTable
                mismatches={selectedReconciliation.mismatches}
                total={selectedReconciliation.mismatchCount}
              />
            </div>
          ) : (
            reconciliationMissing && (
              <EmptyState
                kind="not-applicable"
                size="compact"
                title="照合の記録が見つかりません"
                description={
                  db.mode === 'demo'
                    ? 'デモ環境では記録をこのブラウザの Cookie で持ち回すため、別のブラウザで行った照合は表示できません。'
                    : '照合の記録が見つかりません。'
                }
              />
            )
          )}
        </Section>
      )}

      {reconcileOpen && (
        <CreatePanel
          id="external-reconcile"
          title="外部で編集したファイルを照合"
          openParam="reconcile"
          searchParams={searchParams}
          closeHref={createPanelHref(projectPath, searchParams, {
            open: false,
            openParam: 'reconcile',
          })}
          description="Word・Excel で編集した原稿・対応表を承認版と照合し、違う段落・数値を位置付きで示します。ファイルは保存せず、ファイルのハッシュと照合の結果だけを記録します。"
        >
          {!reconcileTarget ? (
            <EmptyState
              kind="not-applicable"
              size="compact"
              title="照合するスナップショットが見つかりません"
              description="スナップショットの行の「操作」から開き直してください。"
            />
          ) : (
            <form action={reconcileUploadedFileAction} className="space-y-2">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="snapshotId" value={reconcileTarget.snapshot.id} />
              <FormSection title="照合するファイル" kind="required">
                <p className="text-small text-ink">
                  対象: {snapshotName(reconcileTarget)}（内容ハッシュ{' '}
                  <ShortHash value={reconcileTarget.snapshot.contentHash} />）
                </p>
                <Field
                  label="ファイル（.docx・.xlsx、10 MB まで）"
                  name="file"
                  id="reconcile-file"
                  required
                >
                  {(p) => (
                    <Input
                      {...p}
                      name="file"
                      type="file"
                      accept=".docx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    />
                  )}
                </Field>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field
                    label="出力区分"
                    name="audience"
                    id="reconcile-audience"
                    required
                    hint="対応表（XLSX）は社内確認用だけです"
                  >
                    {(p) => (
                      <NativeSelect {...p} name="audience" defaultValue="internal">
                        <option value="internal">{AUDIENCE_DISPLAY.internal}</option>
                        <option value="external">{AUDIENCE_DISPLAY.external}</option>
                      </NativeSelect>
                    )}
                  </Field>
                  <Field
                    label="基準（DOCX 原稿のとき）"
                    name="framework"
                    id="reconcile-framework"
                    required
                  >
                    {(p) => (
                      <NativeSelect
                        {...p}
                        name="framework"
                        defaultValue={
                          reconcileTarget.snapshot.frameworkVersions[0]?.frameworkVersionId ?? ''
                        }
                      >
                        {reconcileTarget.snapshot.frameworkVersions.map((f) => (
                          <option key={f.frameworkVersionId} value={f.frameworkVersionId}>
                            {f.label}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                </div>
              </FormSection>
              {/* 見出しの主操作（レポートを確定する）が見えている画面では副操作にする（primary は画面に 1 つ） */}
              <SubmitButton
                size="sm"
                variant={canApprove ? 'secondary' : 'primary'}
                pendingLabel="照合中…"
              >
                照合する
              </SubmitButton>
            </form>
          )}
        </CreatePanel>
      )}

      {/* 出力する版の違いと、確定の条件 */}
      <div className="grid gap-x-4 gap-y-2 lg:grid-cols-2">
        <Section
          title={SNAPSHOT_KIND_DISPLAY.review_draft}
          summary="保存済みの版を固定して出力します（未承認の箇所は出力に明示）"
          divider="none"
        >
          <MoreInfo label="草稿に含めるもの">
            <p>
              保存済みの版をそのまま固定します（自動保存中の本文は含めません）。未承認の節・不足情報は出力に「草稿・未承認箇所あり」として明示します。
            </p>
          </MoreInfo>
          {!canDraft && (
            <p className="flex items-center gap-1 text-caption text-ink-muted">
              <Lock className="size-3" aria-hidden="true" />
              草稿の作成には開示の編集または出力の権限が必要です。
            </p>
          )}
        </Section>

        <Section title={`${SNAPSHOT_KIND_DISPLAY.approved}（レポートの確定）`} divider="none">
          <div className="space-y-2 text-small">
            <p className="text-ink-muted">
              適用する基準の全節が承認済みで阻害条件が無いときだけ確定できます。確定の操作でも、サーバーで同じ条件を確かめ直します。
            </p>
            {!canApprove && (
              <p className="flex items-center gap-1 text-caption text-ink-muted">
                <Lock className="size-3" aria-hidden="true" />
                レポートの確定は最終承認者（開示の承認の権限を持つ人）が行います。
              </p>
            )}
            {readiness.draftStandardPrep && (
              <p className="flex items-start gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1 text-caption text-ink">
                <AlertTriangle
                  className="mt-0.5 size-3 shrink-0 text-warning-ink"
                  aria-hidden="true"
                />
                草案の基準による準備を含みます。確定しても「草案基準による準備」として扱い、法定準拠の確定にはなりません。
              </p>
            )}
            {!readiness.canConfirm && (
              <div>
                <p className="flex items-center gap-1 font-medium text-ink">
                  <AlertTriangle className="size-3.5 text-warning-ink" aria-hidden="true" />
                  確定できない理由（{blockerCount} 件）
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-muted">
                  {readiness.actorBlockers.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                  {readiness.blockers.slice(0, MAX_BLOCKERS).map((blocker, index) => (
                    <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
                  ))}
                </ul>
                {readiness.blockers.length > MAX_BLOCKERS && (
                  <p className="mt-0.5 text-caption text-ink-muted">
                    ほか {readiness.blockers.length - MAX_BLOCKERS} 件
                  </p>
                )}
              </div>
            )}
          </div>
        </Section>
      </div>

      {/* 基準ごとの出力対象（補助表。既定で閉じる） */}
      <Section
        id="output-frameworks"
        collapsible
        title="基準ごとの出力対象"
        summary={`基準 ${readiness.frameworks.length} 件（出力に含める ${includedCount} 件）`}
      >
        <div className="t4d-scroll-x">
          <Table>
            <THead>
              <TR>
                <TH>基準</TH>
                <TH>目的</TH>
                <TH>適用判断</TH>
                <TH>区分</TH>
                <TH align="right">節</TH>
                <TH>出力</TH>
              </TR>
            </THead>
            <TBody>
              {readiness.frameworks.map((f) => (
                <TR key={f.frameworkVersionId}>
                  <TD className="font-medium">{f.label}</TD>
                  <TD>{DISCLOSURE_PURPOSE_LABELS[f.purpose]}</TD>
                  <TD>
                    {APPLICABILITY_STATUS_LABELS[f.applicabilityStatus]}
                    {!f.decided && (
                      <span className="ml-1 text-caption text-ink-muted">（判断未確定）</span>
                    )}
                  </TD>
                  <TD>{f.draftStandardPrep ? '草案基準による準備' : '—'}</TD>
                  <TD align="right">{f.blockCount}</TD>
                  <TD>{f.included ? '含める' : '含めない（対象外と判断）'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Section>

      {/* スナップショット一覧 */}
      <Section title="スナップショット" summary={`${snapshots.length} 件（新しい順）`}>
        {snapshots.length === 0 ? (
          <EmptyState
            kind="no-data"
            size="compact"
            title="まだスナップショットがありません"
            description="上の「レビュー用草稿を作成」か「レポートを確定する」で版を固定すると、ここから出力できます。"
            action={
              <span className="text-small text-ink-muted">
                {canDraft || canApprove
                  ? '見出しの右の操作から作成できます'
                  : '作成担当・最終承認者が作成します'}
              </span>
            }
          />
        ) : (
          <div className="max-h-[70vh] overflow-auto rounded-t4d border border-line">
            <Table>
              <THead className="sticky top-0 z-(--z-sticky) bg-surface">
                <TR>
                  <TH>No.</TH>
                  <TH>種別</TH>
                  <TH>作成</TH>
                  <TH>内容ハッシュ</TH>
                  <TH>上流の変更</TH>
                  <TH>出力</TH>
                  <TH>保証側への共有</TH>
                  <TH align="right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {snapshots.map((entry) => (
                  <TR key={entry.snapshot.id} className="align-top">
                    <TD className="tnum align-top">{entry.snapshot.snapshotNo}</TD>
                    <TD className="align-top">
                      <SnapshotKindBadge kind={entry.snapshot.snapshotKind} />
                      <p className="mt-0.5 text-caption text-ink-muted">{entry.snapshot.label}</p>
                    </TD>
                    <TD className="align-top text-small">
                      {entry.createdByName}
                      <br />
                      <span className="text-ink-muted">{formatJst(entry.snapshot.createdAt)}</span>
                    </TD>
                    <TD className="align-top">
                      <ShortHash value={entry.snapshot.contentHash} />
                    </TD>
                    <TD className="align-top text-small">
                      {entry.upstreamChanges.length === 0 ? (
                        <span className="text-ink-muted">なし</span>
                      ) : (
                        <Collapsible
                          variant="plain"
                          summary={
                            <span className="inline-flex items-center gap-1 text-warning-ink">
                              <AlertTriangle className="size-3" aria-hidden="true" />
                              作成後に上流が更新（{entry.upstreamChanges.length} 件）
                            </span>
                          }
                        >
                          <ul className="list-disc space-y-0.5 pl-4 text-caption text-ink-muted">
                            {entry.upstreamChanges.map((change, index) => (
                              <li key={index}>
                                {change.label}: {change.detail}
                              </li>
                            ))}
                          </ul>
                          <p className="mt-1 text-caption text-ink-muted">
                            このスナップショットの内容は変わりません。最新の内容で出力するには新しいスナップショットを作成してください。
                          </p>
                        </Collapsible>
                      )}
                    </TD>
                    <TD className="align-top">
                      <SnapshotDownloads entry={entry} canExport={canExport} />
                    </TD>
                    <TD className="align-top text-small">
                      <ShareCell shares={sharesBySnapshot.get(entry.snapshot.id) ?? []} />
                    </TD>
                    <TD className="align-top">
                      <RowActions
                        rowLabel={snapshotName(entry)}
                        primary={{
                          kind: 'link',
                          id: `trace-${entry.snapshot.id}`,
                          label: '内容とトレースを開く',
                          icon: <Route aria-hidden="true" />,
                          href: `${projectPath}/snapshots/${entry.snapshot.id}`,
                        }}
                        items={snapshotMenu({
                          entry,
                          projectId,
                          projectPath,
                          canExport,
                          canShare,
                          targets,
                          shares: sharesBySnapshot.get(entry.snapshot.id) ?? [],
                        })}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Section>

      {/* 承認版どうしの差分（NF-13）。比べるときは開いて描く */}
      <Section
        id="snapshot-diff"
        collapsible
        title="承認版どうしの差分"
        summary={
          approvedSnapshots.length >= 2
            ? `社内承認済み版 ${approvedSnapshots.length} 件から 2 つを選んで比べます`
            : '社内承認済み版が 2 つ以上になると比べられます'
        }
        open={diffRequested || undefined}
      >
        {approvedSnapshots.length < 2 ? (
          <EmptyState
            kind="not-applicable"
            size="compact"
            title="比べる承認版がまだありません"
            description="レポートを確定して社内承認済み版が 2 つ以上になると、段落・数値・要求事項の付け替え・判断の変更を比べられます。"
          />
        ) : (
          <div className="space-y-2">
            <form method="get" action={projectPath} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="tab" value="outputs" />
              <Field label="比較元" name="diffFrom" id="diff-from" required>
                {(p) => (
                  <NativeSelect
                    {...p}
                    name="diffFrom"
                    defaultValue={diffFrom?.snapshot.id ?? approvedSnapshots[1]?.snapshot.id ?? ''}
                    className="w-64"
                  >
                    {approvedSnapshots.map((s) => (
                      <option key={s.snapshot.id} value={s.snapshot.id}>
                        {snapshotName(s)}（{formatJst(s.snapshot.createdAt)}）
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="比較先" name="diffTo" id="diff-to" required>
                {(p) => (
                  <NativeSelect
                    {...p}
                    name="diffTo"
                    defaultValue={diffTo?.snapshot.id ?? approvedSnapshots[0]?.snapshot.id ?? ''}
                    className="w-64"
                  >
                    {approvedSnapshots.map((s) => (
                      <option key={s.snapshot.id} value={s.snapshot.id}>
                        {snapshotName(s)}（{formatJst(s.snapshot.createdAt)}）
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <SubmitButton variant="secondary" size="sm">
                差分を見る
              </SubmitButton>
            </form>
            {diff ? (
              <SnapshotDiffView diff={diff} />
            ) : (
              diffRequested && (
                <EmptyState
                  kind="not-applicable"
                  size="compact"
                  title="比べるスナップショットが見つかりません"
                  description="一覧にある社内承認済み版を 2 つ選び直してください。"
                />
              )
            )}
          </div>
        )}
      </Section>

      {/* 出力の記録 */}
      <Section title="出力の記録" summary={`${artifacts.length} 件`}>
        <p className="flex items-start gap-1.5 pb-1 text-caption text-ink-muted">
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>
            {RECONCILIATION_NOTICE}
            出力したファイルは渡す前に読み戻して承認版の本文・数値と照合し、不一致があればファイルを渡しません。
            {INTERNAL_APPROVAL_NOTICE}
          </span>
        </p>
        <MoreInfo label="ハッシュの見方" className="pb-1">
          <p>
            同じスナップショットから再出力すると、内容ハッシュ（本文・数値・参照）は一致します。ファイルのハッシュは生成日時を含むため、DOCX・XLSX
            では出力ごとに変わります。区分（対外用・社内確認用）・サイズ・ハッシュは「列」から表示できます。
          </p>
        </MoreInfo>
        <DataTable
          id="export-artifacts"
          caption="出力の記録"
          columns={artifactColumns}
          rows={artifacts.slice((page - 1) * pageSize, page * pageSize)}
          getRowId={(a) => a.id}
          getRowLabel={(a) => a.fileName}
          searchParams={searchParams}
          basePath={projectPath}
          search={false}
          page={{ page, pageSize, total: artifacts.length, sizes: DEFAULT_PAGE_SIZES }}
          className="rounded-t4d-lg border border-line bg-surface"
          expand={(a) =>
            a.checkerVersion === null ? null : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-caption">
                <dt className="text-ink-muted">照合した段落</dt>
                <dd>{a.reconciledParagraphs ?? 0}</dd>
                <dt className="text-ink-muted">照合した数値</dt>
                <dd>{a.reconciledNumbers ?? 0}</dd>
                <dt className="text-ink-muted">照合した行</dt>
                <dd>{a.reconciledRows ?? 0}</dd>
                <dt className="text-ink-muted">不一致</dt>
                <dd>{a.mismatchCount ?? 0} 件</dd>
                <dt className="text-ink-muted">照合の規則</dt>
                <dd>
                  <code>{a.checkerVersion}</code>
                </dd>
              </dl>
            )
          }
          empty={{
            noData: {
              title: 'まだ出力していません',
              description:
                'スナップショットの「出力」から DOCX・XLSX・CSV を作ると、記録が残ります。',
              action: canExport ? (
                <span className="text-small text-ink-muted">
                  上のスナップショットの一覧から出力できます
                </span>
              ) : (
                <span className="text-small text-ink-muted">
                  出力には出力の権限が必要です。管理者・作成担当・最終承認者に依頼してください。
                </span>
              ),
            },
          }}
        />
      </Section>

      {/* 不一致で止めた出力・外部ファイルの照合の記録（NF-15）。出力の記録の表と列の設定（URL の cols）を
          取り合わないよう、件数の少ない補助の表として描く */}
      <Section
        id="export-reconciliations"
        collapsible
        title="止めた出力・外部ファイルの照合"
        summary={
          reconciliations.length === 0
            ? '記録はありません'
            : `${reconciliations.length} 件（不一致あり ${reconciliations.filter((r) => r.mismatchCount > 0).length} 件）`
        }
        open={reconciliationId !== null || undefined}
      >
        {reconciliations.length === 0 ? (
          <EmptyState
            kind="no-data"
            size="compact"
            title="記録はありません"
            description="出力で不一致が見つかって止めたとき・外部で編集したファイルを照合したときに記録が残ります。"
            action={
              <span className="text-small text-ink-muted">
                {canExport
                  ? 'スナップショットの行の「操作」から「外部で編集したファイルを照合」を選べます'
                  : '照合には出力の権限が必要です。管理者・作成担当・最終承認者に依頼してください。'}
              </span>
            }
          />
        ) : (
          <div className="t4d-scroll-x rounded-t4d-lg border border-line bg-surface">
            <Table>
              <caption className="sr-only">止めた出力・外部ファイルの照合</caption>
              <THead>
                <TR>
                  <TH>日時</TH>
                  <TH>種類</TH>
                  <TH>形式・区分</TH>
                  <TH>突合</TH>
                  <TH>照合した人</TH>
                  <TH>不一致の明細</TH>
                </TR>
              </THead>
              <TBody>
                {reconciliations.map((r) => (
                  <TR key={r.id} className="align-top">
                    <TD className="whitespace-nowrap text-small">{formatJst(r.createdAt)}</TD>
                    <TD className="text-small">{RECONCILIATION_SOURCE_LABELS[r.source]}</TD>
                    <TD className="text-small">
                      {EXPORT_ARTIFACT_FORMAT_LABELS[r.format]}
                      <br />
                      <span className="text-caption text-ink-muted">
                        {AUDIENCE_DISPLAY[r.audience]}・
                        {snapshotNoById.get(r.snapshotId) ??
                          '（このサーバーに無いスナップショット）'}
                      </span>
                    </TD>
                    <TD>
                      <span className="inline-flex flex-wrap items-center gap-1">
                        <StatusBadge
                          domain="reconciliation"
                          value={reconciliationOutcomeOf(r.mismatchCount, {
                            paragraphs: r.paragraphsChecked,
                            numbers: r.numbersChecked,
                            rows: r.rowsChecked,
                          })}
                        />
                        {r.mismatchCount > 0 && (
                          <span className="text-caption text-ink-muted">{r.mismatchCount} 件</span>
                        )}
                      </span>
                    </TD>
                    <TD className="text-small">{r.createdByName}</TD>
                    <TD className="text-small">
                      {r.mismatchCount === 0 ? (
                        <span className="text-ink-muted">なし</span>
                      ) : (
                        <Collapsible
                          variant="plain"
                          summary={`明細を見る（${r.mismatches.length} 件）`}
                          open={r.id === reconciliationId || undefined}
                        >
                          <MismatchTable mismatches={r.mismatches} total={r.mismatchCount} />
                        </Collapsible>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
        {!canShare && shares.length > 0 && (
          <p className="mt-1 flex items-center gap-1 text-caption text-ink-muted">
            <Lock className="size-3" aria-hidden="true" />
            保証側への共有・取り下げは、アクセス許諾の管理の権限を持つ人が行います。
          </p>
        )}
      </Section>
      {canShare && targets.length === 0 && approvedSnapshots.length > 0 && (
        <p className="flex items-center gap-1 text-caption text-ink-muted">
          <SemanticBadge semantic="info" label="共有先なし" />
          保証側へ共有するには、設定の「アクセス許諾」で案件に許諾を付与してください。
          <Link href="/enterprise/settings?tab=grants" className="text-brand-700 underline">
            アクセス許諾を開く
          </Link>
        </p>
      )}
    </div>
  );
}
