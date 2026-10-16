import type { StatusSemantic } from '@/lib/ui/status/types';
import type { CarrierKind, FuelEconomyClass, GhgBatchKind, VehicleUse } from '@/types/domain';

/**
 * 活動量の画面（P94・P95）と取込の検証で使う語。画面（クライアント）とサービスが同じ語を使う。
 * 状態（確認中・確定・差し替え済み・破棄、積載率の出所）は登録簿（src/lib/ui/status）のラベルを使う。
 */

export const BATCH_KIND_LABELS: Readonly<Record<GhgBatchKind, string>> = {
  energy: 'エネルギー',
  transport: '輸送実績',
};

export const BATCH_KIND_DESCRIPTIONS: Readonly<Record<GhgBatchKind, string>> = {
  energy: '電力・燃料・ガス・熱の月ごとの使用量',
  transport: '委託物流（改良トンキロ法）・自社便（燃料法）の輸送の行',
};

export const ECONOMY_CLASS_LABELS: Readonly<Record<FuelEconomyClass, string>> = {
  y2025: '2025年度基準',
  y2022: '2022年度基準',
  y2015: '2015年度基準',
  unverified: '燃費基準未確認',
};

export const VEHICLE_USE_LABELS: Readonly<Record<VehicleUse, string>> = {
  commercial: '事業用',
  private: '自家用',
};

export const CARRIER_KIND_LABELS: Readonly<Record<CarrierKind, string>> = {
  contracted: '委託物流',
  own_fleet: '自社便',
};

function labelOf<K extends string>(labels: Readonly<Record<K, string>>, value: string | null) {
  if (value === null) return '—';
  return (labels as Readonly<Record<string, string>>)[value] ?? value;
}

export function economyClassLabel(value: string | null): string {
  return labelOf(ECONOMY_CLASS_LABELS, value);
}

export function vehicleUseLabel(value: string | null): string {
  return labelOf(VEHICLE_USE_LABELS, value);
}

export function carrierKindLabel(value: string | null): string {
  return labelOf(CARRIER_KIND_LABELS, value);
}

/** 月の表示（YYYY-MM） */
export function monthLabel(month: string | null): string {
  return month ? month.slice(0, 7) : '—';
}

/**
 * 「未受領」の数の示し方（P94 の数の帯）。未受領は検証拠点 × 活動で確定済みの行が無い月を数えるため、検証拠点が
 * 無い組織（トライアルの設定が無い）では数えていない。0 を「すべて受領」と示すと、下の受領状況の表（検証対象外の
 * 拠点の未受領の月）と食い違う（自己監査 UX-04）。検証拠点が無ければ「—」と「検証拠点が未設定」にする
 */
export function missingMonthsTile(
  verificationUnits: number,
  missingMonths: number,
): { value: number | string; unit?: string; status: { semantic: StatusSemantic; label: string } } {
  if (verificationUnits === 0) {
    return { value: '—', status: { semantic: 'excluded', label: '検証拠点が未設定' } };
  }
  return {
    value: missingMonths,
    unit: 'か月',
    status:
      missingMonths > 0
        ? { semantic: 'pending', label: '検証拠点 × 活動で確定済みの行が無い月' }
        : { semantic: 'done', label: 'すべて受領' },
  };
}
