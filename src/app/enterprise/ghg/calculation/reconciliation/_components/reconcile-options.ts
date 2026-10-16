import { DEFAULT_ATTRIBUTION_ORDER } from '@/lib/domain/ghg/attribution';
import { statusLabel } from '@/lib/ui/status/registry';
import { GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { GHG_SCOPES, type GhgAttributionCause, type ReconciliationTolerance } from '@/types/domain';
import { CALC_DETAIL_HREF } from '../../_components/calc-nav';

/**
 * 照合の画面（P97・P98）とその Server Action が共通に使う選択肢。純粋なモジュール（server-only なし）。
 *
 * 原因を揃える順序は寄与の配分を変える（固定文 N4）。任意の並べ替えは入力の項目が多くなるため、
 * 代表的な順序を選ぶ形にする（既定は plan §2.2 の順）。
 */

export const RECONCILIATION_BASE_PATH = '/enterprise/ghg/calculation/reconciliation';

export const ATTRIBUTION_ORDER_PRESET_KEYS = [
  'default',
  'factor-first',
  'conversion-first',
] as const;
export type AttributionOrderPreset = (typeof ATTRIBUTION_ORDER_PRESET_KEYS)[number];

function moveFirst(cause: GhgAttributionCause): GhgAttributionCause[] {
  return [cause, ...DEFAULT_ATTRIBUTION_ORDER.filter((c) => c !== cause)];
}

export const ATTRIBUTION_ORDER_PRESETS: Readonly<
  Record<AttributionOrderPreset, readonly GhgAttributionCause[]>
> = {
  default: DEFAULT_ATTRIBUTION_ORDER,
  'factor-first': moveFirst('factor'),
  'conversion-first': moveFirst('conversion'),
};

export function orderLabel(order: readonly GhgAttributionCause[]): string {
  return order.map((cause) => statusLabel('ghgCause', cause)).join(' → ');
}

export function orderPresetLabel(preset: AttributionOrderPreset): string {
  const head =
    preset === 'default'
      ? '既定の順'
      : preset === 'factor-first'
        ? '排出係数を先に'
        : '単位換算を先に';
  return `${head}（${orderLabel(ATTRIBUTION_ORDER_PRESETS[preset])}）`;
}

export function isOrderPreset(value: unknown): value is AttributionOrderPreset {
  return (
    typeof value === 'string' &&
    (ATTRIBUTION_ORDER_PRESET_KEYS as readonly string[]).includes(value)
  );
}

/** 期間を引き継いだ一覧・詳細の行き先 */
export function reconciliationListHref(
  periodId: string | null,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  if (periodId) params.set('period', periodId);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return query ? `${RECONCILIATION_BASE_PATH}?${query}` : RECONCILIATION_BASE_PATH;
}

export function reconciliationDetailHref(
  id: string,
  periodId: string | null,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  if (periodId) params.set('period', periodId);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  const path = CALC_DETAIL_HREF.reconciliation(id);
  return query ? `${path}?${query}` : path;
}

/**
 * 許容差の入力（0 以上の数。全角・桁区切りの「,」は読む。空は null）。
 * 許容差は人が入れる値で、既定値を置かない（plan K8）
 */
export function parseToleranceInput(raw: FormDataEntryValue | null): number | null | 'invalid' {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFKC').trim().replace(/,/g, '');
  if (text === '') return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return 'invalid';
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : 'invalid';
}

/** 許容差の要約（区分ごとの絶対値・相対値。利用者が入れた値のまま） */
export function toleranceSummary(tolerance: ReconciliationTolerance): string {
  return GHG_SCOPES.filter((scope) => tolerance[scope])
    .map((scope) => {
      const t = tolerance[scope]!;
      const parts = [
        t.absoluteT !== null ? `${t.absoluteT} t` : null,
        t.relativePct !== null ? `${t.relativePct}%` : null,
      ].filter(Boolean);
      return `${GHG_SCOPE_LABELS[scope]} ${parts.join(' または ')}`;
    })
    .join('／');
}
