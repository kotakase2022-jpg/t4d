import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  FileSearch,
  ListChecks,
  PencilLine,
  Send,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { auditEventLabel } from '@/app/assurance/_components/labels';
import {
  AvailabilityBadge,
  DataPointStatusBadge,
  SeverityBadge,
  ValueKindBadge,
} from '@/components/shared/badges';
import { CommentBox } from '@/components/shared/comment-box';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FlashMessage } from '@/components/shared/flash';
import { MentionText } from '@/components/shared/mention-text';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { AuthorizationError, can } from '@/lib/authorization/can';
import { COMMENT_MAX_LENGTH } from '@/lib/domain/comment-limits';
import { AGGREGATION_METHOD_LABEL, METRIC_CATEGORY_LABEL } from '@/lib/domain/metrics';
import { formatJst, formatJstDate, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  canDecideStep,
  loadApprovalProgress,
  loadApprovalTimeline,
} from '@/lib/services/approval-route';
import { loadPreviousYearDataPoint } from '@/lib/services/data-entry';
import { loadActiveValidations } from '@/lib/services/validation-store';
import { BLOCK_USAGE_LABELS, listDataPointUsage, type DataPointUsage } from '@/lib/services/impact';
import { hasOption } from '@/lib/services/organization-options';
import { SNAPSHOT_KIND_DISPLAY } from '@/lib/services/report-snapshot';
import { listMentionCandidates } from '@/lib/services/comments';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { summarizeValidations } from '@/lib/validation/data-point-rules';
import { isApprovedNeedingRecheck } from '@/lib/validation/display-state';
import {
  CALCULATION_DATA_CLASS_LABELS,
  classifyCalculationInput,
} from '@/lib/services/scope3-suppliers';
import { loadEvidenceSuggestion } from '@/lib/services/ai-assist';
import { loadAnomalyExplanation } from '@/lib/services/anomaly-explanation';
import type { ActionSpec, MenuActionSpec } from '@/lib/ui/actions';
import { canFor } from '@/lib/ui/home-profile';
import {
  dataPointStateActions,
  type DataPointActionId,
  type StateAction,
} from '@/lib/ui/state-actions';
import { statusLabel } from '@/lib/ui/status/registry';
import {
  decideApprovalStepAction,
  explainAnomaliesAction,
  linkEvidenceAction,
  suggestEvidenceAction,
  transitionDataPointAction,
  updateDataPointAction,
} from '../../actions';
import {
  EvidenceStatusBadge,
  SOURCE_TYPE_LABEL,
  ValidationStatusBadge,
} from '../_components/data-badges';
import { ApprovedValueSaveConfirm } from './approved-value-confirm';
import {
  confirmedMappings,
  usageItemCount,
  usageSectionTitle,
  usageSummaryText,
  visibleMappedItems,
} from './usage';

/**
 * タブの題名は「{指標} — {組織}」（plan S3）。題名の決定で画面を落とさない（権限外・見つからないときは既定の名前）
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ dataPointId: string }>;
}): Promise<{ title: string }> {
  const fallback = { title: '非財務データの詳細' };
  try {
    const { dataPointId } = await params;
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const dataPoint = await db.findById('dataPoints', dataPointId);
    if (!dataPoint || dataPoint.organizationId !== ctx.workspace.organizationId) return fallback;
    const [metric, unit] = await Promise.all([
      db.findById('metrics', dataPoint.metricId),
      db.findById('units', dataPoint.unitId),
    ]);
    return metric && unit ? { title: `${metric.name} — ${unit.name}` } : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 非財務データ（Data Point）の詳細（plan S3）。
 *
 * - 見出しの操作は「状態 × 権限」で決める（src/lib/ui/state-actions.ts の dataPointStateActions）。
 *   primary は 1 つ: 未着手は値の編集の「保存」、入力中・差戻しは「提出」、提出済みは「レビュー開始」、
 *   レビュー中は「承認」。承認の道筋がある組織では、見出しの一発承認を出さず、承認フロー節の
 *   現段階の承認ボタンが primary になる（段階を飛ばした承認は必ず失敗するため）
 * - 差戻しは理由必須の確認ダイアログ（plan §1.16 区分 2。ラベル「差戻し理由」は従来と同じ）
 * - AI の補助（原因の説明・資料候補）と承認済みの値の修正は「その他」（L2）
 * - 本文 L1: 値・検証・根拠資料・コメント。L2（閉じた節）: 値の編集（入力中・差戻しでは開く）・
 *   算定内訳・承認フロー（経路が進行中なら開く）・開示マッピング・履歴（版・承認と修正・監査ログ）
 * - トライアル対応（NF-16）: L2 に「この数値を使っている原稿・レポート」（引用している節・固定した
 *   スナップショット・保証側への共有。読むだけで保存しない）。承認済みの値の修正は、保存の前に
 *   影響（節・承認済みレポート・保証側へ共有中の件数）を確認ダイアログで示す
 * - NF-38: CDP 対応オプションの契約が無い組織では、開示マッピングに CDP の項目を出さない
 */
export default async function DataPointDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ dataPointId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { dataPointId } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  const dataPoint = await db.findById('dataPoints', dataPointId);
  if (
    !dataPoint ||
    dataPoint.organizationId !== ctx.workspace.organizationId ||
    dataPoint.deletedAt
  ) {
    notFound();
  }

  const period =
    shell.periods.find((p) => p.id === dataPoint.reportingPeriodId) ?? shell.currentPeriod;
  const metric = shell.metrics.find((m) => m.id === dataPoint.metricId);
  const unit = shell.units.find((u) => u.id === dataPoint.unitId);
  if (!metric || !unit) notFound();

  // この Data Point の未解消の検証結果だけを取得する（期間全体は読み込まない）
  const validations = await loadActiveValidations(db, ctx.workspace.organizationId, [dataPoint.id]);

  // AI による原因の説明は ?explain=<aiRunId> で読み直す（実行結果は ai_runs に残る）
  const canRunAi = can(ctx, 'enterprise.ai.run');
  const explainRunId = typeof query.explain === 'string' ? query.explain : null;
  const explanation = explainRunId
    ? await loadAnomalyExplanation(db, ctx, explainRunId, dataPoint)
    : null;
  // 候補に出た fileVersionId を表示名へ直す
  const fileNameOf = (fileVersionId: string): string => {
    const version = fileVersions.find((v) => v.id === fileVersionId);
    const file = version ? allFiles.find((f) => f.id === version.fileId) : null;
    return file?.originalName ?? '（資料）';
  };
  const evidenceRunId = typeof query.evidence === 'string' ? query.evidence : null;
  const suggestion = evidenceRunId
    ? await loadEvidenceSuggestion(db, ctx, evidenceRunId, dataPoint.id)
    : null;
  const summary = summarizeValidations(validations).byDataPoint.get(dataPoint.id) ?? {
    errors: 0,
    warnings: 0,
  };
  // 承認済みだが承認後に証跡不足が見つかった（DB の状態は承認済みのまま。W0 O3）
  const needsRecheck = isApprovedNeedingRecheck(dataPoint, validations);
  // 画面上部で選んでいる報告期間と、この記録の期間が違う（アラート等から過年度へ来た。W0 O2）
  const isOtherPeriod = dataPoint.reportingPeriodId !== shell.currentPeriod.id;

  const [
    versions,
    evidenceLinks,
    calculations,
    comments,
    approvals,
    mappings,
    auditEvents,
    allFiles,
  ] = await Promise.all([
    db.select('dataPointVersions', {
      where: { dataPointId: dataPoint.id },
      orderBy: { column: 'versionNo', dir: 'desc' },
    }),
    db.select('evidenceLinks', { where: { targetType: 'data_point', targetId: dataPoint.id } }),
    db.select('calculations', { where: { dataPointId: dataPoint.id } }),
    db.select('comments', {
      where: { targetType: 'data_point', targetId: dataPoint.id },
      orderBy: { column: 'createdAt', dir: 'desc' },
    }),
    db.select('approvals', {
      where: { targetType: 'data_point', targetId: dataPoint.id },
      orderBy: { column: 'decidedAt', dir: 'desc' },
    }),
    db.select('disclosureMappings', {
      where: { organizationId: ctx.workspace.organizationId, metricId: metric.id },
    }),
    db.select('auditEvents', {
      where: { resourceType: 'data_point', resourceId: dataPoint.id },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 20,
    }),
    db.select('files', {
      where: { organizationId: ctx.workspace.organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 50,
    }),
  ]);

  // 承認の道筋（最大 5 階層）と、いつ誰が承認・修正・差し戻したかの履歴
  const [approvalProgress, timeline] = await Promise.all([
    loadApprovalProgress(db, ctx, dataPoint.id),
    loadApprovalTimeline(db, ctx, dataPoint.id),
  ]);
  const canDecideCurrent = Boolean(
    approvalProgress.currentStep && canDecideStep(ctx, approvalProgress.currentStep),
  );
  /** 承認の道筋が進行中（＝一発承認は使えない） */
  const routeActive = approvalProgress.totalCount > 0 && !approvalProgress.complete;
  const inApproval = dataPoint.status === 'submitted' || dataPoint.status === 'in_review';
  /** 自分が現段階を決められる（承認フロー節の承認ボタンが画面の primary） */
  const stageDecidable = routeActive && canDecideCurrent && inApproval;

  const currentVersionNo =
    versions.find((v) => v.id === dataPoint.currentVersionId)?.versionNo ?? null;

  const fileVersionIds = evidenceLinks.map((l) => l.fileVersionId);
  const fileVersions =
    fileVersionIds.length > 0
      ? await db.select('fileVersions', { where: { id: { in: fileVersionIds } } })
      : [];
  const evidenceFileIds = fileVersions.map((v) => v.fileId);
  const evidenceFiles =
    evidenceFileIds.length > 0
      ? await db.select('files', { where: { id: { in: evidenceFileIds } } })
      : [];

  const mappedItems =
    confirmedMappings(mappings).length > 0
      ? await db.select('disclosureItems', {
          where: { id: { in: confirmedMappings(mappings).map((m) => m.itemId) } },
        })
      : [];

  // 開示項目は CDP だけとは限らない（SSBJ にも紐づく）。
  // リンク先を framework から決めるために key を解決する。
  const mappedVersionIds = [...new Set(mappedItems.map((i) => i.frameworkVersionId))];
  const mappedVersions =
    mappedVersionIds.length > 0
      ? await db.select('frameworkVersions', { where: { id: { in: mappedVersionIds } } })
      : [];
  const mappedFrameworkIds = [...new Set(mappedVersions.map((v) => v.frameworkId))];
  const mappedFrameworks =
    mappedFrameworkIds.length > 0
      ? await db.select('frameworks', { where: { id: { in: mappedFrameworkIds } } })
      : [];
  const frameworkKeyByVersionId = new Map(
    mappedVersions.map((v) => [v.id, mappedFrameworks.find((f) => f.id === v.frameworkId)?.key]),
  );
  // CDP 対応オプションの契約が無い組織では、CDP の項目を出さない（NF-38）
  const disclosureItems = visibleMappedItems(mappedItems, frameworkKeyByVersionId, {
    cdpContracted: mappedItems.length > 0 ? await hasOption(db, ctx, 'cdp') : true,
  });

  // この数値を使っている原稿・レポート（NF-16。読むだけ）。データの閲覧権限が無ければ出さない
  let usage: DataPointUsage | null = null;
  try {
    usage = await listDataPointUsage(db, ctx, dataPoint.id);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
  }

  /**
   * 開示項目へのリンク先。
   *
   * 質問単位の詳細画面を持つのは CDP だけ（Phase 1）。
   * それ以外は一覧へ送る。以前は全項目を `/disclosures/cdp/{id}` へ繋いでいたため、
   * SSBJ に紐づく Data Point から辿ると 404 になっていた。
   */
  function disclosureItemHref(frameworkVersionId: string, itemId: string): string {
    const key = frameworkKeyByVersionId.get(frameworkVersionId);
    if (key === 'cdp') return `/enterprise/disclosures/cdp/${itemId}`;
    return key ? `/enterprise/disclosures/${key}` : '/enterprise/disclosures/cdp';
  }

  // 前年は決算日が同じ期間（暦年の期間を年度の前年にしない。plan K10）
  const previousYear = await loadPreviousYearDataPoint(db, ctx, {
    period,
    periods: shell.periods,
    metricId: metric.id,
    unitId: unit.id,
  });
  const previous = previousYear?.dataPoint ?? undefined;

  const canWrite = can(ctx, 'enterprise.data.write');
  const canReview = can(ctx, 'enterprise.data.review');
  const canApprove = can(ctx, 'enterprise.data.approve');
  // 承認済みの値の変更はレビュー・承認の権限が要る（サービスの updateDataPointValue と同じ条件）。
  // 押すと必ず断られる編集欄を出さない
  const canEditValue = canWrite && (dataPoint.status !== 'approved' || canReview || canApprove);
  // メンション候補と、コメント著者名の解決（WF-P0-002）
  const mentionCandidates = await listMentionCandidates(db, ctx);
  const authorNameById = new Map(mentionCandidates.map((m) => [m.userId, m.displayName]));

  // ---- 状態で変わる操作（plan §1.15） ------------------------------------------------
  // 値が入っているか（値の無いことを「対象外」などで記録していれば、それも提出できる値）
  const hasValue =
    dataPoint.value !== null ||
    dataPoint.textValue !== null ||
    dataPoint.availabilityStatus !== 'value_present';
  const statePlan = dataPointStateActions({
    status: dataPoint.status,
    can: canFor(ctx),
    // サーバーの値は常に保存済み。未着手は保存して初めて入力中になる（関数の側で判定する）
    valueSaved: true,
    hasValue,
  });
  // 保存は値の編集の節のボタンそのものが primary（見出しに別のフォームを置かない）。
  // 承認の道筋が進行中なら一発承認は使えないので出さない（段階の承認は承認フロー節）
  const headerPrimary =
    statePlan.primary &&
    statePlan.primary.id !== 'save' &&
    !(statePlan.primary.id === 'approve' && routeActive)
      ? statePlan.primary
      : null;
  const valueSaveIsPrimary = statePlan.primary?.id === 'save';

  const scopeLine = `${metric.name} — ${unit.name}（${period.code}）`;
  const toSpec = (action: StateAction<DataPointActionId>): ActionSpec | null => {
    switch (action.id) {
      case 'submit':
        return {
          kind: 'submit',
          id: action.id,
          label: action.label,
          icon: <Send aria-hidden="true" />,
          action: transitionDataPointAction,
          fields: { dataPointId: dataPoint.id, to: 'submitted' },
          disabledReason: action.disabledReason,
        };
      case 'start-review':
        return {
          kind: 'submit',
          id: action.id,
          label: action.label,
          action: transitionDataPointAction,
          fields: { dataPointId: dataPoint.id, to: 'in_review' },
        };
      case 'approve':
        return {
          kind: 'submit',
          id: action.id,
          label: action.label,
          icon: <Check aria-hidden="true" />,
          action: transitionDataPointAction,
          fields: { dataPointId: dataPoint.id, to: 'approved' },
        };
      case 'return':
        return {
          kind: 'confirm',
          id: action.id,
          label: action.label,
          icon: <Undo2 aria-hidden="true" />,
          action: transitionDataPointAction,
          fields: { dataPointId: dataPoint.id, to: 'returned' },
          confirm: {
            tier: 'bulk',
            title: 'このデータを差し戻しますか',
            scope: scopeLine,
            consequences: ['入力した担当者が値を直して再提出します。理由はコメントにも残ります。'],
            reason: {
              name: 'comment',
              label: '差戻し理由',
              required: true,
              maxLength: COMMENT_MAX_LENGTH,
              placeholder: '例: 検針票の対象期間を確認してください。',
            },
            confirmLabel: '差し戻す',
          },
        };
      default:
        return null;
    }
  };
  const secondary: ActionSpec[] = [];
  // 承認の権限を持つ人には、承認の道筋が進行中なら見出しから承認フローの節へ案内する（見出しに一発承認は
  // 置かない。段階を飛ばせないため）。現段階を決められる人には、節の「「段階」を承認」が primary になる
  if (canApprove && inApproval && routeActive) {
    secondary.push({
      kind: 'link',
      id: 'approval-route',
      label: `承認フローへ（${approvalProgress.approvedCount}/${approvalProgress.totalCount} 段階）`,
      icon: <ListChecks aria-hidden="true" />,
      href: '#承認フロー',
    });
  }
  if (headerPrimary && stageDecidable) {
    // 段階の承認が画面の primary。見出しの主操作（レビュー開始など）は secondary へ下げる
    const spec = toSpec(headerPrimary);
    if (spec) secondary.push(spec);
  }
  for (const action of statePlan.secondary) {
    const spec = toSpec(action);
    if (spec) secondary.push(spec);
  }
  const primary = headerPrimary && !stageDecidable ? toSpec(headerPrimary) : null;

  const editOpen =
    query.edit === '1' ||
    dataPoint.status === 'not_started' ||
    dataPoint.status === 'draft' ||
    dataPoint.status === 'returned';
  const more: MenuActionSpec[] = [
    ...statePlan.more.flatMap((action): MenuActionSpec[] => {
      if (action.id === 'ai-explain') {
        return [
          {
            kind: 'submit',
            id: action.id,
            label: action.label,
            icon: <Sparkles className="size-3.5" aria-hidden="true" />,
            action: explainAnomaliesAction,
            fields: { dataPointId: dataPoint.id },
            group: 'advanced',
            // 検証の指摘が無いデータには、説明させる対象が無い
            hidden: validations.length === 0 || !canRunAi,
          },
        ];
      }
      if (action.id === 'ai-evidence') {
        return [
          {
            kind: 'submit',
            id: action.id,
            label: action.label,
            icon: <FileSearch className="size-3.5" aria-hidden="true" />,
            action: suggestEvidenceAction,
            fields: { dataPointId: dataPoint.id },
            group: 'advanced',
            hidden: !canRunAi,
          },
        ];
      }
      if (action.id === 'edit-approved') {
        return [
          {
            kind: 'link',
            id: action.id,
            label: action.label,
            icon: <PencilLine className="size-3.5" aria-hidden="true" />,
            href: `/enterprise/data/${dataPoint.id}?edit=1#value-edit`,
            hidden: !canEditValue,
          },
        ];
      }
      return [];
    }),
  ];

  return (
    <>
      <PageHeader
        title={`${metric.name} — ${unit.name}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <DataPointStatusBadge status={dataPoint.status} needsRecheck={needsRecheck} />
            <ValidationStatusBadge errorCount={summary.errors} warningCount={summary.warnings} />
            <EvidenceStatusBadge
              evidenceCount={evidenceLinks.length}
              requiresEvidence={metric.requiresEvidence}
            />
            {dataPoint.changedAfterApproval && (
              <SemanticBadge semantic="blocked" label="承認後に変更あり" />
            )}
            <Badge tone={isOtherPeriod ? 'warning' : 'neutral'}>
              <CalendarClock className="size-3" aria-hidden="true" />
              対象期間 {period.code}
            </Badge>
          </span>
        }
        breadcrumbsTail={[{ label: `${metric.name} — ${unit.name}` }]}
        actions={<PageActions primary={primary ?? undefined} secondary={secondary} more={more} />}
      />

      <div className="space-y-2 px-4 pt-3">
        <FlashMessage searchParams={query} />
        {isOtherPeriod && (
          <Notice tone="warning" title="過年度のデータです。">
            表示中の報告期間（{shell.currentPeriod.label}）とは異なる {period.label}{' '}
            のデータを開いています。値・状態・検証結果は {period.label} のものです。
          </Notice>
        )}
        {needsRecheck && (
          <Notice tone="warning" title="承認済み・要再確認">
            承認後に根拠資料の不足（根拠資料が必須の指標に資料が紐付いていない）が見つかりました。
            承認は取り消されていません。資料を紐付けるか、必要なら承認をやり直してください。
          </Notice>
        )}
      </div>

      <div className="grid grid-cols-3 gap-x-4 gap-y-3 px-4 pb-4">
        {/* 左: 値と編集 */}
        <div className="col-span-2 space-y-3">
          <Section title="値">
            <div className="grid grid-cols-2 gap-x-6 text-body">
              <Row label="指標コード" value={metric.code} />
              <Row label="単位（定義）" value={metric.unit} />
              <Row label="定義" value={metric.description} />
              <Row label="組織・拠点" value={`${unit.name}（${unit.code}）`} />
              {/* 実績ゼロ・未入力・対象外などを区別して見せる（空欄を 0 と見せない。§7.1） */}
              <Row
                label="現在値"
                value={
                  dataPoint.availabilityStatus !== 'value_present' ? (
                    <AvailabilityBadge
                      status={dataPoint.availabilityStatus}
                      reason={dataPoint.absenceReason}
                    />
                  ) : dataPoint.value === null ? (
                    (dataPoint.textValue ?? '—')
                  ) : (
                    `${formatNumber(dataPoint.value)} ${dataPoint.unitOfMeasure}`
                  )
                }
              />
              <Row
                label="値の有無・区分"
                value={
                  <span className="inline-flex flex-wrap justify-end gap-1">
                    <AvailabilityBadge status={dataPoint.availabilityStatus} />
                    <ValueKindBadge kind={dataPoint.valueKind} />
                  </span>
                }
              />
              {dataPoint.absenceReason && (
                <Row label="値が無い理由" value={dataPoint.absenceReason} />
              )}
              {/* 前年の値は入力の参考（plan D7）。承認済みかどうかを併記する（未承認の値を正と見せない） */}
              <Row label="前年実績" value={<PreviousValue previous={previous} />} />
            </div>
            <Collapsible
              variant="plain"
              summary="指標と算定の詳細（カテゴリ・集計方法・連結範囲・算定方法・最終更新）"
              className="mt-1"
            >
              <div className="grid grid-cols-2 gap-x-6 text-body">
                <Row label="カテゴリ" value={METRIC_CATEGORY_LABEL[metric.category]} />
                <Row label="集計方法" value={AGGREGATION_METHOD_LABEL[metric.aggregationMethod]} />
                <Row label="根拠資料" value={metric.requiresEvidence ? '必須' : '任意'} />
                <Row
                  label="連結範囲"
                  value={`${dataPoint.boundary} / 持分 ${unit.ownershipPercent}%`}
                />
                <Row label="対象期間" value={period.label} />
                <Row label="算定方法" value={dataPoint.methodology ?? '—'} />
                <Row label="最終更新" value={formatJst(dataPoint.updatedAt)} />
              </div>
            </Collapsible>
          </Section>

          {canEditValue && (
            <Section
              id="value-edit"
              collapsible
              title="値の編集"
              summary="値を編集する（更新すると新しい版が追加されます）"
              open={editOpen}
            >
              <form id="dp-value-form" action={updateDataPointAction} className="space-y-2 pt-1">
                <input type="hidden" name="dataPointId" value={dataPoint.id} />
                <FormSection title="値と変更理由" kind="required">
                  <div className="grid grid-cols-4 gap-2">
                    <Field
                      label="値"
                      name="value"
                      id="dp-value"
                      hint={<PreviousValue previous={previous} prefix="前年 " />}
                    >
                      {(p) => (
                        <Input
                          {...p}
                          name="value"
                          defaultValue={dataPoint.value ?? ''}
                          inputMode="decimal"
                        />
                      )}
                    </Field>
                    <Field
                      label="単位"
                      name="unitOfMeasure"
                      id="dp-unit"
                      hint={
                        dataPoint.unitOfMeasure !== metric.unit
                          ? `指標の単位は ${metric.unit} です（値は換算しません）`
                          : '指標の単位'
                      }
                    >
                      {(p) => (
                        // 指標の単位から選ぶ（自由入力で単位が食い違わないように。plan D5）。
                        // いまの値の単位が違うときは、それも選べるように残す（値の換算はしないため、
                        // 黙って単位だけ書き換えない）
                        <NativeSelect
                          {...p}
                          name="unitOfMeasure"
                          defaultValue={dataPoint.unitOfMeasure}
                        >
                          <option value={metric.unit}>{metric.unit}</option>
                          {dataPoint.unitOfMeasure !== metric.unit && (
                            <option value={dataPoint.unitOfMeasure}>
                              {dataPoint.unitOfMeasure}（指標と異なる）
                            </option>
                          )}
                        </NativeSelect>
                      )}
                    </Field>
                    <Field
                      label="変更理由（履歴に残ります）"
                      name="changeReason"
                      id="dp-change-reason"
                      required
                      className="col-span-2"
                    >
                      {(p) => (
                        <Input
                          {...p}
                          name="changeReason"
                          placeholder="例: 検針票の再集計により修正"
                        />
                      )}
                    </Field>
                  </div>
                </FormSection>
                <FormSection title="算定方法" kind="optional" open={Boolean(dataPoint.methodology)}>
                  <Field label="算定方法" name="methodology" id="dp-methodology">
                    {(p) => (
                      <Textarea
                        {...p}
                        name="methodology"
                        rows={2}
                        defaultValue={dataPoint.methodology ?? ''}
                      />
                    )}
                  </Field>
                </FormSection>
                {dataPoint.status === 'approved' && usage ? (
                  // 承認済みの値の修正は、保存の前に影響を確かめる（NF-16。上書きの確認）
                  <div className="space-y-1">
                    <p className="text-caption text-ink-muted">
                      承認済みの値です。保存の前に影響（
                      {usageSummaryText(usage.counts, {
                        disclosureHidden: usage.disclosureHidden,
                      })}
                      ）を確認します。
                    </p>
                    <ApprovedValueSaveConfirm
                      formId="dp-value-form"
                      scope={scopeLine}
                      impact={usageSummaryText(usage.counts, {
                        disclosureHidden: usage.disclosureHidden,
                      })}
                      variant={valueSaveIsPrimary ? 'primary' : 'secondary'}
                    />
                  </div>
                ) : (
                  <SubmitButton
                    variant={valueSaveIsPrimary ? 'primary' : 'secondary'}
                    size="sm"
                    data-t4d-shortcut="save"
                    pendingLabel="保存中…"
                  >
                    保存
                  </SubmitButton>
                )}
              </form>
            </Section>
          )}

          {calculations.length > 0 && (
            <Section
              id="calculation-breakdown"
              collapsible
              title="算定内訳"
              summary={`算定の内訳（${calculations.length} 式）`}
            >
              {calculations.map((calc) => (
                <div key={calc.id} className="pb-2">
                  <p className="mb-1 font-mono text-small text-ink-muted">{calc.formula}</p>
                  <Table>
                    <THead>
                      <TR>
                        <TH>内訳</TH>
                        <TH align="right">値</TH>
                        <TH>単位</TH>
                        <TH>区分</TH>
                        <TH>根拠</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {calc.inputs.map((inputRow, i) => {
                        // 金額×係数（推計）を一次データと取り違えないよう区分を出す（W0 O6）
                        const dataClass = classifyCalculationInput(inputRow);
                        return (
                          <TR key={i}>
                            <TD>{inputRow.label}</TD>
                            <TD align="right">{formatNumber(inputRow.value)}</TD>
                            <TD>{inputRow.unit}</TD>
                            <TD className="whitespace-nowrap text-caption">
                              {dataClass ? CALCULATION_DATA_CLASS_LABELS[dataClass] : '—'}
                            </TD>
                            <TD className="text-caption text-ink-muted">{inputRow.note}</TD>
                          </TR>
                        );
                      })}
                      <TR>
                        <TD className="font-medium">合計</TD>
                        <TD align="right" className="font-medium">
                          {formatNumber(calc.result)}
                        </TD>
                        <TD>{calc.resultUnit}</TD>
                        <TD />
                        <TD />
                      </TR>
                    </TBody>
                  </Table>
                </div>
              ))}
            </Section>
          )}

          {disclosureItems.length > 0 && (
            <Section
              id="disclosure-mapping"
              collapsible
              title="開示マッピング"
              summary={`この指標を使う開示項目（${disclosureItems.length} 件）`}
            >
              <ul className="divide-y divide-line">
                {disclosureItems.map((item) => (
                  <li key={item.id} className="py-1.5">
                    <Link
                      href={disclosureItemHref(item.frameworkVersionId, item.id)}
                      className="text-small text-brand-700 hover:underline"
                    >
                      {item.code}
                    </Link>
                    <div className="truncate text-caption text-ink-muted">{item.questionText}</div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {usage && <DataPointUsageSection usage={usage} />}
        </div>

        {/* 右: 検証・根拠資料・承認フロー・コメント */}
        <div className="space-y-3">
          <Section title={`検証（${validations.length}）`}>
            {validations.length === 0 ? (
              <p className="flex items-center gap-1 text-small text-ink-muted">
                <Check className="size-3.5 text-success" aria-hidden="true" />
                検証エラー・警告はありません
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {validations.map((v) => (
                  <li key={v.id} className="flex items-start gap-2 py-1.5">
                    <SeverityBadge severity={v.severity} />
                    <span className="text-small text-ink">{v.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {explanation && (
              <div className="mt-1.5 rounded-t4d bg-surface-muted px-2 py-1.5">
                {/* AI は推定・候補。値は変えない（CLAUDE.md §0-4） */}
                <p className="text-caption text-ink-muted">
                  AI の推定（確信度 {Math.round(explanation.run.confidence * 100)}%）。
                  指摘のみで、値は変更されません。
                </p>
                <ul className="mt-1 space-y-1.5">
                  {explanation.findings.map((finding, index) => (
                    <li key={index}>
                      <p className="text-small text-ink">
                        <span className="font-medium">考えられる原因:</span> {finding.likelyCause}
                      </p>
                      <p className="mt-0.5 text-small text-ink-muted">
                        <span className="font-medium">次の一手:</span> {finding.suggestedAction}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          <section
            aria-labelledby="dp-evidence-title"
            data-t4d-shortcut="evidence"
            tabIndex={-1}
            className="scroll-mt-2 border-t border-line pt-2 outline-none"
          >
            <h2 id="dp-evidence-title" className="pb-1.5 text-body font-semibold text-ink">
              根拠資料（{evidenceLinks.length}）
            </h2>
            {evidenceLinks.length === 0 ? (
              <p className="text-small text-ink-muted">
                {metric.requiresEvidence ? (
                  <span className="inline-flex items-start gap-1 text-warning-ink">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    この指標は根拠資料が必須です。承認の前に紐付けてください。
                  </span>
                ) : (
                  '根拠資料はまだ紐付いていません。'
                )}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {evidenceLinks.map((link) => {
                  const version = fileVersions.find((v) => v.id === link.fileVersionId);
                  const file = evidenceFiles.find((f) => f.id === version?.fileId);
                  return (
                    <li key={link.id} className="py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-small font-medium text-ink">
                          {file?.originalName ?? '（ファイル）'}
                        </span>
                        {version && (
                          <a
                            href={`/api/files/signed-url?fileVersionId=${version.id}`}
                            className="shrink-0 text-caption text-brand-700 hover:underline"
                          >
                            開く
                          </a>
                        )}
                      </div>
                      <div className="text-caption text-ink-muted">
                        {link.page ? `p.${link.page}` : ''} {link.cellRef ?? ''}{' '}
                        {link.coveragePeriodStart
                          ? `対象 ${formatJstDate(link.coveragePeriodStart)}〜${formatJstDate(link.coveragePeriodEnd)}`
                          : ''}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {can(ctx, 'enterprise.evidence.write') && (
              <form
                action={linkEvidenceAction}
                className="mt-1.5 space-y-1.5 border-t border-line pt-2"
              >
                <input type="hidden" name="dataPointId" value={dataPoint.id} />
                <label className="block text-caption text-ink-muted" htmlFor="dp-evidence-file">
                  登録済みの資料から紐付ける
                </label>
                <NativeSelect id="dp-evidence-file" name="fileVersionId" required size="xs">
                  <option value="">選択してください</option>
                  {allFiles.map((f) => (
                    <option key={f.id} value={f.currentVersionId ?? ''}>
                      {f.originalName}
                    </option>
                  ))}
                </NativeSelect>
                <div className="flex gap-1.5">
                  <Input
                    name="page"
                    placeholder="ページ"
                    aria-label="ページ"
                    inputMode="numeric"
                    className="w-20"
                  />
                  <Input name="cellRef" placeholder="セル（例 Sheet1!C12）" aria-label="セル" />
                </div>
                <SubmitButton size="xs" variant="secondary" pendingLabel="紐付け中…">
                  紐付ける
                </SubmitButton>
              </form>
            )}
            {suggestion && (
              <div className="mt-1.5 rounded-t4d bg-surface-muted px-2 py-1.5">
                {/* AI の候補。紐付けは人が確定する（CLAUDE.md §0-4） */}
                <p className="text-caption text-ink-muted">
                  AI の候補（確信度 {Math.round(suggestion.run.confidence * 100)}%）。
                  紐付けは上のフォームで確定してください。
                </p>
                <ul className="mt-1 space-y-1">
                  {suggestion.candidates.map((candidate, index) => (
                    <li key={index}>
                      <p className="text-small text-ink">
                        {fileNameOf(candidate.fileVersionId)}
                        {candidate.page !== null ? ` / p.${candidate.page}` : ''}
                      </p>
                      <p className="text-caption text-ink-muted">{candidate.excerpt}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* 承認の道筋（最大 5 階層）。どこまで進んでいて、次が誰かを必ず出す */}
          {approvalProgress.totalCount > 0 && (
            // 承認経路がある組織では閉じない（自分の番か・次が誰かを閉じた中に隠さない。plan S3）
            <Section
              id="承認フロー"
              title={`承認フロー（${approvalProgress.approvedCount} / ${approvalProgress.totalCount} 段階）`}
              summary={
                approvalProgress.round > 1
                  ? `${approvalProgress.round} 巡目（差戻し後の再提出）`
                  : undefined
              }
            >
              <ol className="divide-y divide-line">
                {approvalProgress.steps.map((step) => (
                  <li key={step.id} className="flex items-start gap-2.5 py-2">
                    <span
                      className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-muted text-caption font-semibold text-ink-muted"
                      aria-hidden="true"
                    >
                      {step.stageNo}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-small font-medium text-ink">
                        {step.stageName}
                        <StatusBadge domain="approvalStep" value={step.status} />
                      </p>
                      <p className="text-caption text-ink-muted">
                        {step.department || '担当部署未設定'}
                        {step.decidedAt && (
                          <>
                            {' ・ '}
                            {authorNameById.get(step.decidedBy ?? '') ?? '—'}
                            {' ・ '}
                            {formatJst(step.decidedAt)}
                          </>
                        )}
                      </p>
                      {step.comment && (
                        <p className="mt-0.5 text-caption text-ink">{step.comment}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {approvalProgress.currentStep && (
                <div className="border-t border-line pt-2">
                  {canDecideCurrent ? (
                    <div className="space-y-1.5">
                      <form action={decideApprovalStepAction} className="space-y-1.5">
                        <input type="hidden" name="dataPointId" value={dataPoint.id} />
                        <input type="hidden" name="decision" value="approved" />
                        <Field label="承認のコメント" name="comment" id="dp-stage-comment">
                          {(p) => <Input {...p} name="comment" />}
                        </Field>
                        <SubmitButton
                          variant={stageDecidable ? 'primary' : 'secondary'}
                          size="sm"
                          pendingLabel="承認中…"
                        >
                          「{approvalProgress.currentStep.stageName}」を承認
                        </SubmitButton>
                      </form>
                      <ConfirmDialog
                        tier="bulk"
                        title={`「${approvalProgress.currentStep.stageName}」で差し戻しますか`}
                        scope={scopeLine}
                        consequences={[
                          '承認の道筋は最初の段階からやり直しになります（再提出のあとに次の巡が始まります）。',
                        ]}
                        reason={{ name: 'comment', label: '差戻し理由', required: true }}
                        confirmLabel="差し戻す"
                        action={decideApprovalStepAction}
                        fields={{ dataPointId: dataPoint.id, decision: 'returned' }}
                        trigger={{
                          label: '差し戻す…',
                          variant: 'secondary',
                          size: 'sm',
                          icon: <Undo2 aria-hidden="true" />,
                          actionId: 'stage-return',
                        }}
                      />
                    </div>
                  ) : (
                    <p className="text-caption text-ink-muted">
                      次は「{approvalProgress.currentStep.stageName}」
                      {approvalProgress.currentStep.department &&
                        `（${approvalProgress.currentStep.department}）`}
                      の承認待ちです。あなたはこの段階の承認者ではありません。
                    </p>
                  )}
                </div>
              )}
            </Section>
          )}

          <Section title={`コメント（${comments.length}）`}>
            {canWrite && (
              <CommentBox
                targetType="data_point"
                targetId={dataPoint.id}
                href={`/enterprise/data/${dataPoint.id}`}
                members={mentionCandidates}
              />
            )}
            {comments.length === 0 && approvals.length === 0 ? (
              <p className="text-small text-ink-muted">コメント・承認の記録はまだありません。</p>
            ) : (
              <ul className="divide-y divide-line">
                {approvals.map((a) => (
                  <li key={a.id} className="py-1.5">
                    <SemanticBadge
                      semantic={a.decision === 'approved' ? 'done' : 'returned'}
                      label={`${a.decision === 'approved' ? '承認' : '差戻し'}（${
                        a.stage === 'final' ? '最終承認' : 'レビュー'
                      }）`}
                    />
                    {a.comment && <p className="mt-0.5 text-small text-ink">{a.comment}</p>}
                    <span className="text-caption text-ink-muted">{formatJst(a.decidedAt)}</span>
                  </li>
                ))}
                {comments.map((c) => (
                  <li key={c.id} className="py-1.5">
                    <p className="text-small text-ink">
                      <MentionText body={c.body} />
                    </p>
                    <span className="text-caption text-ink-muted">
                      {authorNameById.get(c.authorUserId) ?? '—'} ・ {formatJst(c.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        {/* 履歴（版・承認と修正・監査ログ）は本文の下に並べ、見出しを残して既定で閉じる（§10.4 B6）。
            コメントより後ろに置く: 差戻し理由はコメントにも履歴にも出るため、見える方を先にする */}
        <div className="col-span-3 grid grid-cols-3 gap-x-4 gap-y-3">
          <Section
            id="version-history"
            collapsible
            title={`版の履歴（${versions.length}）`}
            summary={`版の一覧（${versions.length} 版${
              currentVersionNo !== null ? `・現在 v${currentVersionNo}` : ''
            }）`}
          >
            <Table>
              <THead>
                <TR>
                  <TH>版</TH>
                  <TH align="right">値</TH>
                  <TH>単位</TH>
                  <TH>出所</TH>
                  <TH>変更理由</TH>
                  <TH>作成日時</TH>
                </TR>
              </THead>
              <TBody>
                {versions.map((v) => (
                  <TR key={v.id}>
                    <TD>
                      v{v.versionNo}
                      {v.id === dataPoint.currentVersionId && (
                        <Badge tone="brand" className="ml-1">
                          <Check className="size-3" aria-hidden="true" />
                          現在
                        </Badge>
                      )}
                    </TD>
                    <TD align="right">
                      {v.availabilityStatus !== 'value_present' ? (
                        <AvailabilityBadge status={v.availabilityStatus} reason={v.absenceReason} />
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          {formatNumber(v.value)}
                          {v.valueKind !== 'actual' && <ValueKindBadge kind={v.valueKind} />}
                        </span>
                      )}
                    </TD>
                    <TD>{v.unitOfMeasure}</TD>
                    <TD className="text-caption">
                      {v.sourceReference ?? SOURCE_TYPE_LABEL[v.sourceType]}
                    </TD>
                    <TD className="text-caption text-ink-muted">{v.changeReason ?? '—'}</TD>
                    <TD className="whitespace-nowrap text-caption text-ink-muted">
                      {formatJst(v.createdAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Section>

          {/* いつ・誰が・承認／修正／差し戻し したか。段階と版は別の表に分かれているので、ここで 1 本の流れに混ぜる */}
          <Section
            id="承認履歴"
            collapsible
            title={`承認・修正の履歴（${timeline.length}）`}
            summary="いつ・誰が承認・修正・差し戻したか（新しいものが上）"
          >
            {timeline.length === 0 ? (
              <p className="text-small text-ink-muted">承認・修正の記録はまだありません。</p>
            ) : (
              <ul className="divide-y divide-line">
                {timeline.map((entry, index) => (
                  <li key={`${entry.kind}-${entry.at}-${index}`} className="py-1.5">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <SemanticBadge
                        semantic={
                          entry.kind === 'approved'
                            ? 'done'
                            : entry.kind === 'returned'
                              ? 'returned'
                              : 'draft'
                        }
                        label={
                          entry.kind === 'approved'
                            ? '承認'
                            : entry.kind === 'returned'
                              ? '差戻し'
                              : '修正'
                        }
                      />
                      {entry.stageLabel && (
                        <span className="text-caption text-ink-muted">{entry.stageLabel}</span>
                      )}
                      <span className="text-small font-medium text-ink">{entry.actorName}</span>
                      <span className="text-caption text-ink-muted">{formatJst(entry.at)}</span>
                    </p>
                    <p className="mt-0.5 text-small text-ink">{entry.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="audit-timeline"
            collapsible
            title="監査ログ"
            summary={`この記録の操作（直近 ${auditEvents.length} 件）`}
            // 記録が無いことは空状態として見せる（空状態は閉じない）
            defaultOpen={auditEvents.length === 0}
          >
            {auditEvents.length === 0 ? (
              <EmptyState
                kind="not-applicable"
                size="compact"
                title="監査ログはありません"
                description="値の変更・提出・承認を行うと、ここに記録されます。"
              />
            ) : (
              <ul className="divide-y divide-line">
                {auditEvents.map((e) => (
                  <li key={e.id} className="py-1.5">
                    <div className="text-small text-ink">{auditEventLabel(e.eventType)}</div>
                    {e.afterSummary && (
                      <div className="text-caption text-ink-muted">{e.afterSummary}</div>
                    )}
                    <div className="text-caption text-ink-muted">{formatJst(e.createdAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <span className="shrink-0 text-ink-muted">{label}</span>
      <span className="text-right text-ink">{value}</span>
    </div>
  );
}

/** 前年の値（入力の参考。承認済みかどうかを併記する） */
function PreviousValue({
  previous,
  prefix = '',
}: {
  previous:
    | {
        value: number | null;
        unitOfMeasure: string;
        availabilityStatus: Parameters<typeof AvailabilityBadge>[0]['status'];
        absenceReason: string | null;
        status: Parameters<typeof statusLabel>[1];
      }
    | undefined;
  prefix?: string;
}) {
  if (!previous) return <>{prefix}—（前年データなし）</>;
  if (previous.availabilityStatus !== 'value_present') {
    return (
      <span className="inline-flex items-center gap-1">
        {prefix}
        <AvailabilityBadge status={previous.availabilityStatus} reason={previous.absenceReason} />
      </span>
    );
  }
  return (
    <>
      {prefix}
      {formatNumber(previous.value)} {previous.unitOfMeasure}
      <span className="ml-1 text-caption text-ink-muted">
        （{statusLabel('dataPoint', previous.status)}）
      </span>
    </>
  );
}

/**
 * この数値を使っている原稿・レポート（NF-16）。引用している節（現在の版・作業中の本文・承認済みの版の別）、
 * この数値を固定したスナップショット（保証側へ共有中か）、Data Room で共有中の案件を示す。読むだけ
 */
function DataPointUsageSection({ usage }: { usage: DataPointUsage }) {
  const count = usageItemCount(usage);
  // 開示の閲覧権限が無い人には件数（0）を出さず、理由は折りたたまずに見せる（section.tsx の規則）
  return (
    <Section
      id="data-usage"
      collapsible={!usage.disclosureHidden}
      title={usageSectionTitle('数値', count, usage.disclosureHidden)}
      summary={usageSummaryText(usage.counts, { disclosureHidden: usage.disclosureHidden })}
    >
      {usage.disclosureHidden ? (
        <p className="flex items-start gap-1 text-small text-ink-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          開示の閲覧権限が無いため、引用している原稿・レポートは表示しません（保証側へ共有中{' '}
          {usage.counts.sharedWithAssurance} 件）。
        </p>
      ) : count === 0 && usage.dataRoomEngagementIds.length === 0 ? (
        <EmptyState
          kind="not-applicable"
          size="compact"
          title="この数値を使っている原稿・レポートはありません"
          description="原稿の節が数値を引用すると、ここに影響先として表示します。"
        />
      ) : (
        <div className="space-y-2">
          {usage.blocks.length > 0 && (
            <div>
              <h3 className="text-small font-semibold text-ink">
                原稿の節（{usage.blocks.length}）
              </h3>
              <ul className="divide-y divide-line">
                {usage.blocks.map((b) => (
                  <li key={b.blockId} className="py-1.5">
                    <Link
                      href={`/enterprise/disclosure-projects/${b.projectId}/blocks/${b.blockId}`}
                      className="text-small text-brand-700 hover:underline"
                    >
                      {b.title}
                    </Link>
                    <span className="ml-1 text-caption text-ink-muted">
                      {b.projectName}・{b.statusLabel}・
                      {b.usage.map((u) => BLOCK_USAGE_LABELS[u]).join('・')}
                    </span>
                    <div className="mt-0.5">
                      {b.upToDate ? (
                        <SemanticBadge semantic="done" label="引用中の版は現在の版" />
                      ) : (
                        <SemanticBadge semantic="blocked" label="引用中の版より新しい版あり" />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {usage.snapshots.length > 0 && (
            <div>
              <h3 className="text-small font-semibold text-ink">
                固定したレポート（{usage.snapshots.length}）
              </h3>
              <ul className="divide-y divide-line">
                {usage.snapshots.map((s) => (
                  <li key={s.snapshotId} className="py-1.5 text-small">
                    <Link
                      href={`/enterprise/disclosure-projects/${s.projectId}/snapshots/${s.snapshotId}`}
                      className="text-brand-700 hover:underline"
                    >
                      {SNAPSHOT_KIND_DISPLAY[s.snapshotKind]} No.{s.snapshotNo}
                    </Link>
                    <span className="ml-1 text-caption text-ink-muted">
                      {formatJst(s.createdAt)}
                      {s.sharedEngagementIds.length > 0
                        ? `・保証側へ共有中 ${s.sharedEngagementIds.length} 案件`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-caption text-ink-muted">
                固定したレポートの内容は、この数値を修正しても変わりません。
              </p>
            </div>
          )}
          {usage.dataRoomEngagementIds.length > 0 && (
            <p className="text-small text-ink">
              Data Room（許諾と承認から導いた共有）で保証側へ共有中:{' '}
              {usage.dataRoomEngagementIds.length} 案件
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
