import { z } from 'zod';
import type { ParsedTable } from '@/lib/imports/parsers';
import {
  parseActivity,
  parseCarrierKind,
  parseEconomyClass,
  parseFuelCode,
  parseMonth,
  parseVehicleUse,
} from './labels';
import {
  parseNumberWithSeparator,
  unreadableNumberMessage,
  type DecimalSeparator,
} from './number-format';
import { parseUnit } from './units';
import type {
  CarrierKind,
  FuelEconomyClass,
  GhgActivityKind,
  GhgBatchKind,
  VehicleUse,
} from '@/types/domain';

/**
 * 活動量の表から行を取り出す（plan §2.2 activity-parse.ts・CR-05）。純関数。Stage A は型と検査を置き、
 * 取込の画面の列の対応付け（ファイル → 列 → 検証 → 確定）は S2 が作る。
 *
 * 検査（Zod）:
 *  - エネルギー: 月・活動（燃料・電力・ガス・熱）・量・単位（読める単位）が必須
 *  - 輸送: 重量 × 距離 か t·km のどちらかが必須（燃料法の自社便は燃料の量と単位）。最大積載量は kg
 *    （30 以下は t で書いたのではないかの警告）、積載率は %（1 以下は割合で書いたのではないかの警告）
 * 読めない値は推測で埋めずにエラーとして返す。
 */

export interface ActivityRowInput {
  month: string;
  activityKind: GhgActivityKind;
  activityCode: string;
  amount: number | null;
  unit: string | null;
  contractCode: string | null;
  shipmentRef: string | null;
  cargoWeightT: number | null;
  distanceKm: number | null;
  tonKm: number | null;
  fuelCode: string | null;
  maxPayloadKg: number | null;
  loadFactorPct: number | null;
  vehicleUse: VehicleUse | null;
  fuelEconomyClass: FuelEconomyClass | null;
  carrierKind: CarrierKind | null;
  cargoKind: string | null;
  note: string;
}

/** 列の対応（取込のファイルの列名） */
export interface ActivityColumnMapping {
  month: string;
  activity?: string;
  amount?: string;
  unit?: string;
  contractCode?: string;
  shipmentRef?: string;
  cargoWeightT?: string;
  distanceKm?: string;
  tonKm?: string;
  fuel?: string;
  maxPayloadKg?: string;
  loadFactorPct?: string;
  vehicleUse?: string;
  fuelEconomyClass?: string;
  carrierKind?: string;
  cargoKind?: string;
  note?: string;
  /** 小数点の記号（利用者が選ぶ。無ければ曖昧な「3.741」は読めないまま返す） */
  decimalSeparator?: DecimalSeparator;
}

export interface ActivityParseIssue {
  rowNo: number;
  message: string;
}

/** 1 回の取込の行の上限（Supabase Mode。Demo Mode は Cookie の都合で 60 行） */
export const ACTIVITY_MAX_ROWS = 5000;

const finite = z.number().refine(Number.isFinite, '数ではありません');
const positive = finite.refine((n) => n > 0, '正の数ではありません');
const nonNegative = finite.refine((n) => n >= 0, '負の数です');

const baseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}-01$/, '月を読めません'),
  contractCode: z.string().max(40).nullable(),
  shipmentRef: z.string().max(60).nullable(),
  note: z.string().max(300),
});

const energySchema = baseSchema.extend({
  activityKind: z.enum(['fuel', 'electricity', 'gas', 'heat']),
  activityCode: z.string().min(1).max(40),
  amount: nonNegative,
  unit: z
    .string()
    .min(1, '単位がありません')
    .refine((u) => parseUnit(u) !== null, '単位を読めません'),
});

const transportSchema = baseSchema
  .extend({
    activityKind: z.literal('transport'),
    activityCode: z.string().min(1).max(40),
    amount: nonNegative.nullable(),
    unit: z.string().nullable(),
    cargoWeightT: positive.nullable(),
    distanceKm: positive.nullable(),
    tonKm: positive.nullable(),
    fuelCode: z.string().min(1, '燃料を読めません'),
    maxPayloadKg: positive.nullable(),
    loadFactorPct: positive.nullable(),
    vehicleUse: z.enum(['commercial', 'private']).nullable(),
    fuelEconomyClass: z.enum(['y2025', 'y2022', 'y2015', 'unverified']).nullable(),
    carrierKind: z.enum(['own_fleet', 'contracted']),
    cargoKind: z.string().max(40).nullable(),
  })
  .superRefine((row, ctx) => {
    const tonKmGiven = row.tonKm !== null || (row.cargoWeightT !== null && row.distanceKm !== null);
    const fuelGiven = row.amount !== null && !!row.unit;
    if (!tonKmGiven && !fuelGiven) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '重量×距離か t·km（燃料法なら燃料の量と単位）が必要です',
      });
    }
    if (tonKmGiven) {
      if (row.maxPayloadKg === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '最大積載量（kg）が必要です' });
      }
      if (row.fuelEconomyClass === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '燃費区分が必要です（不明なら「未確認」）',
        });
      }
    }
  });

function cell(row: Record<string, string>, column: string | undefined): string {
  return column ? (row[column] ?? '').trim() : '';
}

function num(raw: string, separator: DecimalSeparator | undefined): number | null {
  return raw === '' ? null : parseNumberWithSeparator(raw, separator);
}

/**
 * 表から活動量の行を取り出す。エラーの行は取り出さない（行番号付きで返す）。警告は取り出した行に付く
 */
export function extractActivityRows(
  table: Pick<ParsedTable, 'headers' | 'rows' | 'rowNumbers'>,
  kind: GhgBatchKind,
  mapping: ActivityColumnMapping,
): {
  rows: Array<ActivityRowInput & { rowNo: number }>;
  errors: ActivityParseIssue[];
  warnings: ActivityParseIssue[];
} {
  const rows: Array<ActivityRowInput & { rowNo: number }> = [];
  const errors: ActivityParseIssue[] = [];
  const warnings: ActivityParseIssue[] = [];
  if (!table.headers.includes(mapping.month)) {
    return {
      rows,
      errors: [{ rowNo: 0, message: `列「${mapping.month}」が見つかりません。` }],
      warnings,
    };
  }
  if (table.rows.length > ACTIVITY_MAX_ROWS) {
    return {
      rows,
      errors: [{ rowNo: 0, message: `行が多すぎます（上限 ${ACTIVITY_MAX_ROWS} 行）。` }],
      warnings,
    };
  }
  table.rows.forEach((raw, index) => {
    const rowNo = table.rowNumbers[index] ?? index + 1;
    const problems: string[] = [];
    const numberCell = (column: string | undefined, label: string): number | null => {
      const text = cell(raw, column);
      const value = num(text, mapping.decimalSeparator);
      if (text !== '' && value === null) {
        problems.push(unreadableNumberMessage(label, text, mapping.decimalSeparator));
      }
      return value;
    };
    const month = parseMonth(cell(raw, mapping.month)) ?? '';
    const base = {
      month,
      contractCode: cell(raw, mapping.contractCode) || null,
      shipmentRef: cell(raw, mapping.shipmentRef) || null,
      note: cell(raw, mapping.note),
    };
    let candidate: Record<string, unknown>;
    if (kind === 'energy') {
      const activity = parseActivity(cell(raw, mapping.activity));
      if (!activity || activity.kind === 'transport') {
        problems.push(`活動「${cell(raw, mapping.activity)}」を読めません`);
      }
      candidate = {
        ...base,
        activityKind: activity?.kind,
        activityCode: activity?.code,
        amount: numberCell(mapping.amount, '量'),
        unit: cell(raw, mapping.unit),
      };
    } else {
      const carrierText = cell(raw, mapping.carrierKind) || cell(raw, mapping.activity);
      const carrierKind = parseCarrierKind(carrierText);
      if (!carrierKind) problems.push(`輸送の担い手「${carrierText}」を読めません（委託・自社便）`);
      const fuelText = cell(raw, mapping.fuel);
      const fuelCode = parseFuelCode(fuelText);
      if (!fuelCode) problems.push(`燃料「${fuelText}」を読めません`);
      const useText = cell(raw, mapping.vehicleUse);
      const vehicleUse = useText === '' ? null : parseVehicleUse(useText);
      if (useText !== '' && !vehicleUse) problems.push(`事業用・自家用「${useText}」を読めません`);
      const classText = cell(raw, mapping.fuelEconomyClass);
      const economy = classText === '' ? null : parseEconomyClass(classText);
      if (classText !== '' && !economy) problems.push(`燃費区分「${classText}」を読めません`);
      const cargoText = cell(raw, mapping.cargoKind);
      candidate = {
        ...base,
        activityKind: 'transport',
        activityCode: carrierKind ?? '',
        amount: numberCell(mapping.amount, '燃料の量'),
        unit: cell(raw, mapping.unit) || null,
        cargoWeightT: numberCell(mapping.cargoWeightT, '重量'),
        distanceKm: numberCell(mapping.distanceKm, '距離'),
        tonKm: numberCell(mapping.tonKm, 't·km'),
        fuelCode: fuelCode ?? '',
        maxPayloadKg: numberCell(mapping.maxPayloadKg, '最大積載量'),
        loadFactorPct: numberCell(mapping.loadFactorPct, '積載率'),
        vehicleUse: vehicleUse ?? (carrierKind === 'contracted' ? 'commercial' : null),
        fuelEconomyClass: economy,
        carrierKind,
        cargoKind: cargoText === '' ? null : cargoText === '主要製品' ? 'main_product' : cargoText,
      };
    }
    if (problems.length > 0) {
      errors.push({ rowNo, message: problems.join('。') });
      return;
    }
    const parsed = (kind === 'energy' ? energySchema : transportSchema).safeParse(candidate);
    if (!parsed.success) {
      errors.push({ rowNo, message: parsed.error.issues.map((i) => i.message).join('。') });
      return;
    }
    const value = parsed.data as Record<string, unknown>;
    const row: ActivityRowInput & { rowNo: number } = {
      rowNo,
      month: value.month as string,
      activityKind: value.activityKind as GhgActivityKind,
      activityCode: value.activityCode as string,
      amount: (value.amount as number | null) ?? null,
      unit: (value.unit as string | null) || null,
      contractCode: value.contractCode as string | null,
      shipmentRef: value.shipmentRef as string | null,
      cargoWeightT: (value.cargoWeightT as number | null | undefined) ?? null,
      distanceKm: (value.distanceKm as number | null | undefined) ?? null,
      tonKm: (value.tonKm as number | null | undefined) ?? null,
      fuelCode: (value.fuelCode as string | undefined) ?? null,
      maxPayloadKg: (value.maxPayloadKg as number | null | undefined) ?? null,
      loadFactorPct: (value.loadFactorPct as number | null | undefined) ?? null,
      vehicleUse: (value.vehicleUse as VehicleUse | null | undefined) ?? null,
      fuelEconomyClass: (value.fuelEconomyClass as FuelEconomyClass | null | undefined) ?? null,
      carrierKind: (value.carrierKind as CarrierKind | undefined) ?? null,
      cargoKind: (value.cargoKind as string | null | undefined) ?? null,
      note: value.note as string,
    };
    if (row.maxPayloadKg !== null && row.maxPayloadKg <= 30) {
      warnings.push({
        rowNo,
        message: `最大積載量 ${row.maxPayloadKg} は kg です。単位が t ではありませんか`,
      });
    }
    if (row.loadFactorPct !== null && row.loadFactorPct <= 1) {
      warnings.push({
        rowNo,
        message: `積載率 ${row.loadFactorPct} は % です。割合ではなく % で入れてください`,
      });
    }
    rows.push(row);
  });
  return { rows, errors, warnings };
}
