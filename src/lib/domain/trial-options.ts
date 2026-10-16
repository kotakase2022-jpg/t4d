import {
  GHG_ACTIVITY_KINDS,
  GHG_SCOPES,
  type GhgActivityKind,
  type GhgScope,
  type IsoDate,
  type Uuid,
} from '@/types/domain';

/**
 * トライアル計画の任意の設定（trial_programs.options。移行なし。plan K9・CR-20〜CR-26）。純関数。
 *
 *  - ghgVerification: 算定の検証範囲（期間・算定の検証拠点・Scope・活動）。拠点が空なら計画の includedUnitIds を使う
 *  - rollout: 将来の展開対象（総拠点数とメモ）。総拠点数は検証拠点数以上
 *  - freeScope: 無償の範囲の目安（PDF 等の一次データの件数。0〜100,000）
 *  - disposal: 返却・削除の予定日
 * 既存のキー（cdp・reductionTarget など）は触らない（読むときも書くときも残す）。
 */

export interface GhgVerificationOptions {
  periodId: Uuid | null;
  unitIds: Uuid[];
  scopes: GhgScope[];
  activityKinds: GhgActivityKind[];
}

export interface RolloutOptions {
  totalSites: number | null;
  note: string;
}

export interface FreeScopeOptions {
  pdfFiles: number | null;
}

export interface DisposalOptions {
  plannedOn: IsoDate | null;
}

export interface TrialOptions {
  ghgVerification: GhgVerificationOptions | null;
  rollout: RolloutOptions | null;
  freeScope: FreeScopeOptions | null;
  disposal: DisposalOptions | null;
}

/** 将来の展開対象のメモの上限（Demo Mode。Cookie の都合） */
export const ROLLOUT_NOTE_MAX = 100;
/** PDF 等の一次データの目安の上限 */
export const FREE_SCOPE_PDF_MAX = 100_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** 保存された options を読む（形の違う値は無いものとして扱い、推測で埋めない） */
export function parseTrialOptions(
  options: Record<string, unknown> | null | undefined,
): TrialOptions {
  const o = options ?? {};
  const ghg = isRecord(o.ghgVerification) ? o.ghgVerification : null;
  const rollout = isRecord(o.rollout) ? o.rollout : null;
  const free = isRecord(o.freeScope) ? o.freeScope : null;
  const disposal = isRecord(o.disposal) ? o.disposal : null;
  return {
    ghgVerification: ghg
      ? {
          periodId: typeof ghg.periodId === 'string' ? ghg.periodId : null,
          unitIds: isStringArray(ghg.unitIds) ? ghg.unitIds : [],
          scopes: isStringArray(ghg.scopes)
            ? (ghg.scopes.filter((s) =>
                (GHG_SCOPES as readonly string[]).includes(s),
              ) as GhgScope[])
            : [],
          activityKinds: isStringArray(ghg.activityKinds)
            ? (ghg.activityKinds.filter((k) =>
                (GHG_ACTIVITY_KINDS as readonly string[]).includes(k),
              ) as GhgActivityKind[])
            : [],
        }
      : null,
    rollout: rollout
      ? {
          totalSites: isCount(rollout.totalSites) ? rollout.totalSites : null,
          note: typeof rollout.note === 'string' ? rollout.note : '',
        }
      : null,
    freeScope: free ? { pdfFiles: isCount(free.pdfFiles) ? free.pdfFiles : null } : null,
    disposal: disposal
      ? { plannedOn: isDate(disposal.plannedOn) ? disposal.plannedOn : null }
      : null,
  };
}

/** 算定の検証拠点（ghgVerification.unitIds が空なら計画の対象拠点） */
export function verificationUnitIds(
  options: TrialOptions,
  includedUnitIds: readonly Uuid[],
): Uuid[] {
  const own = options.ghgVerification?.unitIds ?? [];
  return own.length > 0 ? [...own] : [...includedUnitIds];
}

export interface TrialOptionsPatchContext {
  organizationPeriodIds: ReadonlySet<string>;
  organizationUnitIds: ReadonlySet<string>;
  /** 計画の対象拠点（算定の検証拠点が空のときの数え方に使う） */
  includedUnitIds: readonly Uuid[];
  /** Demo Mode（メモの上限を Cookie の都合で小さくする） */
  demo: boolean;
}

/**
 * 保存する前の検査。エラーの文の一覧を返す（空なら保存してよい）。期間・拠点は組織のもの、
 * 総拠点数は検証拠点数以上（展開対象は検証対象を含む全体の数）、メモ 100 字（Demo）、PDF の目安 0〜100,000
 */
export function validateTrialOptionsPatch(
  patch: Partial<TrialOptions>,
  ctx: TrialOptionsPatchContext,
): string[] {
  const errors: string[] = [];
  const ghg = patch.ghgVerification;
  if (ghg) {
    if (ghg.periodId !== null && !ctx.organizationPeriodIds.has(ghg.periodId)) {
      errors.push('算定の検証期間が見つかりません。');
    }
    if (!ghg.unitIds.every((id) => ctx.organizationUnitIds.has(id))) {
      errors.push('算定の検証拠点に、組織の拠点ではないものがあります。');
    }
    if (new Set(ghg.unitIds).size !== ghg.unitIds.length) {
      errors.push('算定の検証拠点が重複しています。');
    }
    if (!ghg.scopes.every((s) => (GHG_SCOPES as readonly string[]).includes(s))) {
      errors.push('検証の Scope に知らない値があります。');
    }
    if (!ghg.activityKinds.every((k) => (GHG_ACTIVITY_KINDS as readonly string[]).includes(k))) {
      errors.push('検証の活動に知らない値があります。');
    }
  }
  const rollout = patch.rollout;
  if (rollout) {
    if (rollout.totalSites !== null && !isCount(rollout.totalSites)) {
      errors.push('将来の展開対象の拠点数は 0 以上の整数で入れてください。');
    }
    const verifying =
      (ghg?.unitIds.length ?? 0) > 0 ? ghg!.unitIds.length : ctx.includedUnitIds.length;
    if (rollout.totalSites !== null && rollout.totalSites < verifying) {
      errors.push(
        `将来の展開対象の拠点数（${rollout.totalSites}）が検証対象の拠点数（${verifying}）より少なくなっています。展開対象は検証対象を含む全体の数です。`,
      );
    }
    const max = ctx.demo ? ROLLOUT_NOTE_MAX : 1000;
    if (rollout.note.length > max) errors.push(`展開対象のメモは ${max} 字までです。`);
  }
  const free = patch.freeScope;
  if (
    free &&
    free.pdfFiles !== null &&
    (!isCount(free.pdfFiles) || free.pdfFiles > FREE_SCOPE_PDF_MAX)
  ) {
    errors.push(
      `PDF 等の一次データの目安は 0〜${FREE_SCOPE_PDF_MAX.toLocaleString('ja-JP')} 件で入れてください。`,
    );
  }
  const disposal = patch.disposal;
  if (disposal && disposal.plannedOn !== null && !isDate(disposal.plannedOn)) {
    errors.push('返却・削除の予定日を読めません。');
  }
  return errors;
}

/** options に書き戻す（既存のキーは残す） */
export function mergeTrialOptions(
  options: Record<string, unknown> | null | undefined,
  patch: Partial<TrialOptions>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(options ?? {}) };
  for (const key of ['ghgVerification', 'rollout', 'freeScope', 'disposal'] as const) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  return out;
}
