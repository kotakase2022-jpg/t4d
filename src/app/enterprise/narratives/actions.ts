'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { EVIDENCE_USAGE_PURPOSE_LABELS } from '@/lib/domain/disclosure-status';
import { isUserFacingError, withUserFacingError } from '@/lib/errors/user-facing';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { FieldValidationError } from '@/lib/services/disclosure-project';
import {
  carryForwardNarrative,
  confirmNarrative,
  createNarrative,
  createNarrativeCandidateFromFragments,
  saveNarrative,
  type NarrativeUsage,
} from '@/lib/services/narrative';
import {
  createAnchorFromFragment,
  loadAnchorViews,
  loadDocumentFragments,
} from '@/lib/services/source-anchor';
import type {
  AnchorPayload,
  ConflictPayload,
  FragmentPayload,
  UsagePayload,
} from './_components/types';

/**
 * 定性情報の Server Actions。入力の取り出しと結果の整形だけを行い、規則は Service に置く。
 * 組織・実行者はセッションから導出し、クライアントから受け取った ID は Service で所有を確かめる。
 */

const BASE = '/enterprise/narratives';

function usagePayload(usage: readonly NarrativeUsage[]): UsagePayload[] {
  return usage.map((u) => ({
    blockId: u.blockId,
    blockTitle: u.blockTitle,
    blockStatusLabel: u.blockStatusLabel,
    projectId: u.projectId,
    projectName: u.projectName,
    citedVersionNo: u.citedVersionNo,
    citesCurrent: u.citesCurrent,
  }));
}

export type ActionFailure = {
  status: 'error';
  message: string;
  fieldErrors: Record<string, string>;
};

function failure(error: unknown): ActionFailure {
  if (error instanceof FieldValidationError) {
    return {
      status: 'error',
      message: '入力内容を確認してください。',
      fieldErrors: error.fieldErrors,
    };
  }
  if (isUserFacingError(error)) return { status: 'error', message: error.message, fieldErrors: {} };
  throw error;
}

export interface NarrativeContentInput {
  reportingPeriodId: string;
  scopeNote: string;
  fields: Record<string, string>;
  body: string;
  sourceAnchorIds: string[];
}

export type SaveNarrativeActionResult =
  | { status: 'saved'; versionNo: number }
  | { status: 'unchanged' }
  | { status: 'needs_confirmation'; usage: UsagePayload[] }
  | { status: 'conflict'; conflict: ConflictPayload }
  | ActionFailure;

/** 版の保存（§12.2 saveNarrative）。競合は保存せず比較情報を返す */
export async function saveNarrativeAction(
  input: NarrativeContentInput & {
    narrativeId: string;
    baseVersionId: string | null;
    changeReason: string;
    acknowledgeImpact: boolean;
  },
): Promise<SaveNarrativeActionResult> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  try {
    const result = await saveNarrative(db, ctx, {
      narrativeId: String(input.narrativeId),
      baseVersionId: input.baseVersionId ? String(input.baseVersionId) : null,
      reportingPeriodId: String(input.reportingPeriodId),
      scopeNote: String(input.scopeNote ?? ''),
      fields: Object.fromEntries(
        Object.entries(input.fields ?? {}).map(([k, v]) => [String(k), String(v ?? '')]),
      ),
      body: String(input.body ?? ''),
      sourceAnchorIds: (input.sourceAnchorIds ?? []).map(String),
      changeReason: String(input.changeReason ?? ''),
      acknowledgeImpact: input.acknowledgeImpact === true,
    });
    if (result.status === 'saved') {
      revalidatePath(BASE);
      revalidatePath(`${BASE}/${input.narrativeId}`);
      return { status: 'saved', versionNo: result.version.versionNo };
    }
    if (result.status === 'unchanged') return { status: 'unchanged' };
    if (result.status === 'needs_confirmation') {
      return { status: 'needs_confirmation', usage: usagePayload(result.usage) };
    }
    const c = result.conflict;
    return {
      status: 'conflict',
      conflict: {
        latestVersionId: c.latestVersion?.id ?? null,
        latestVersionNo: c.latestVersion?.versionNo ?? null,
        latestCreatedByName: c.latestCreatedByName,
        latestCreatedAt: c.latestVersion ? formatJst(c.latestVersion.createdAt) : null,
        latestBody: c.latestVersion?.body ?? '',
        fieldDiffs: c.fieldDiffs.filter((d) => d.differs),
        bodyDiff: c.bodyDiff,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** 「新しく登録」 */
export async function createNarrativeAction(
  input: NarrativeContentInput & {
    theme: string;
    title: string;
    ownerDepartment: string;
    tags: string;
  },
): Promise<{ status: 'created'; narrativeId: string } | ActionFailure> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  try {
    const { record } = await createNarrative(db, ctx, {
      theme: String(input.theme),
      title: String(input.title ?? ''),
      ownerDepartment: String(input.ownerDepartment ?? ''),
      tags: String(input.tags ?? '')
        .split(/[,、，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      reportingPeriodId: String(input.reportingPeriodId),
      scopeNote: String(input.scopeNote ?? ''),
      fields: Object.fromEntries(
        Object.entries(input.fields ?? {}).map(([k, v]) => [String(k), String(v ?? '')]),
      ),
      body: String(input.body ?? ''),
      sourceAnchorIds: (input.sourceAnchorIds ?? []).map(String),
    });
    revalidatePath(BASE);
    return { status: 'created', narrativeId: record.id };
  } catch (error) {
    return failure(error);
  }
}

/** 右の資料ペイン: 選んだ資料の抽出結果（手動抜粋を含む） */
export async function loadFragmentsAction(
  fileId: string,
): Promise<
  | { status: 'ok'; fileName: string; usagePurposeLabel: string; fragments: FragmentPayload[] }
  | ActionFailure
> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const loaded = await loadDocumentFragments(db, ctx, String(fileId));
  if (!loaded) return { status: 'error', message: '資料が見つかりません。', fieldErrors: {} };
  return {
    status: 'ok',
    fileName: loaded.file.originalName,
    usagePurposeLabel: loaded.file.usagePurpose
      ? EVIDENCE_USAGE_PURPOSE_LABELS[loaded.file.usagePurpose]
      : '未設定',
    fragments: loaded.fragments.map((f) => ({
      id: f.fragment.id,
      locationLabel: f.locationLabel,
      text: f.fragment.text,
      manual: f.manual,
    })),
  };
}

/** 選んだ箇所を引用位置として登録する（版の保存までは定性情報に紐付かない） */
export async function createAnchorAction(input: {
  fragmentId: string;
  quoteText: string;
}): Promise<{ status: 'ok'; anchor: AnchorPayload } | ActionFailure> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  try {
    const anchor = await createAnchorFromFragment(db, ctx, {
      fragmentId: String(input.fragmentId),
      quoteText: String(input.quoteText ?? ''),
    });
    const [view] = await loadAnchorViews(db, ctx, [anchor.id]);
    if (!view) return { status: 'error', message: '引用位置が見つかりません。', fieldErrors: {} };
    return {
      status: 'ok',
      anchor: {
        id: view.anchor.id,
        fileId: view.fileId,
        fileName: view.fileName,
        locationLabel: view.locationLabel,
        quoteText: view.anchor.quoteText,
        usagePurposeLabel: view.usagePurposeLabel,
        isCurrentFact: view.usagePurpose === 'current_fact',
        manual: view.anchor.acquiredBy === 'manual',
        missing: view.missing,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** 人が確認する（確認済みにする） */
export async function confirmNarrativeAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const narrativeId = String(formData.get('narrativeId') ?? '');
  const back = `${BASE}/${narrativeId}`;
  await withUserFacingError(back, async () => {
    await confirmNarrative(db, ctx, {
      narrativeId,
      versionId: String(formData.get('versionId') ?? ''),
    });
  });
  revalidatePath(BASE);
  revalidatePath(back);
  redirect(`${back}?flash=narrativeConfirmed`);
}

/** 前年から引継ぎ（新しい年度の下書きの版を作る。確認は引き継がない） */
export async function carryForwardNarrativeAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const narrativeId = String(formData.get('narrativeId') ?? '');
  const targetPeriodId = String(formData.get('targetPeriodId') ?? '');
  await withUserFacingError(BASE, async () => {
    await carryForwardNarrative(db, ctx, { narrativeId, targetPeriodId });
  });
  revalidatePath(BASE);
  redirect(`${BASE}/${narrativeId}?flash=narrativeCarried`);
}

/** 資料から候補を作成（規則ベース。抜粋を引用として並べた下書き） */
export async function createNarrativeCandidateAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const fileId = String(formData.get('fileId') ?? '');
  const back = `${BASE}/new?mode=documents${fileId ? `&fileId=${encodeURIComponent(fileId)}` : ''}`;
  let createdId = '';
  let warnings = 0;
  await withUserFacingError(back, async () => {
    const result = await createNarrativeCandidateFromFragments(db, ctx, {
      theme: String(formData.get('theme') ?? ''),
      title: String(formData.get('title') ?? ''),
      reportingPeriodId: String(formData.get('reportingPeriodId') ?? ''),
      fragmentIds: formData.getAll('fragmentIds').map(String),
    });
    createdId = result.record.id;
    warnings = result.warnings.length;
  });
  revalidatePath(BASE);
  redirect(`${BASE}/${createdId}?flash=narrativeCandidate&warnings=${warnings}`);
}
