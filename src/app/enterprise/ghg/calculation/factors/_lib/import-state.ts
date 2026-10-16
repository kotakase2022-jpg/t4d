import type { FactorColumnMapping, FactorImportResult } from '@/lib/domain/ghg/factor-import';
import type { DecimalSeparator } from '@/lib/domain/ghg/number-format';

/**
 * 係数セットの取込のフォームと Server Action が受け渡す状態（クライアントとサーバーの両方から読む。型だけ）。
 * プレビューの結果はサーバーに残さない（確定のときにファイルと列の対応を送り直し、サーバーが検証し直す）。
 */
export interface FactorImportPreviewView {
  fileName: string;
  sha256: string;
  headers: string[];
  sheetNotes: string[];
  mapping: FactorColumnMapping;
  mappingSuggested: boolean;
  decimalSeparator: DecimalSeparator | null;
  result: FactorImportResult;
  previewToken: string;
  /** 検証したときの基準年・出典（変えたら検証し直す） */
  referenceYear: string;
  sourceLabel: string;
}

export type FactorImportPreviewState =
  { ok: true; preview: FactorImportPreviewView } | { ok: false; message: string } | null;

export type FactorImportConfirmState = { ok: false; message: string } | null;

/** フォームの欄の名前（列の対応は map:<項目>） */
export const MAPPING_FIELD_PREFIX = 'map:';
