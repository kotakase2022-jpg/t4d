import { TRIAL_SCOPE_KINDS, type TrialScopeKind } from '@/types/domain';
import type { TrialScopeSignalState } from '@/lib/ui/status/trialScopeSignal';

/**
 * 無償の範囲（標準機能）と別途協議の信号（トライアル概要・検証結果の XLSX。2026-10-16 の要望 ④・plan CR-23）。
 * DB にも画面にも依存しない純関数だけ。
 *
 * 誠実さの規則:
 *  - 金額は扱わない（製品に価格を埋め込まない）。数えたものと目安を並べるだけ
 *  - 「目安を超過」は別途協議の候補であって確定ではない。操作は止めない（知らせるだけ）
 *  - 目安が無いものは「目安なし」、製品に機能が無いもの（外部システムとの個別連携）は「数えられない」と出す
 *    （推測で「範囲内」と書かない）
 *  - OCR が要る PDF（文字が取れない PDF）は、目安の内外にかかわらず標準機能の外（製品に OCR は無い）
 */

/** 別途協議の 4 区分（改善管理表の scope_kind と同じ値・同じ並び） */
export const SEPARATE_CONSULTATION_KINDS = TRIAL_SCOPE_KINDS;

export const SEPARATE_CONSULTATION_LABELS: Readonly<Record<TrialScopeKind, string>> = {
  site_expansion: '大幅な拠点追加',
  bulk_primary_data: '大量の PDF 等の一次データ処理',
  system_integration: '外部システムとの個別連携',
  custom_development: '新規機能の個別開発',
};

/**
 * 標準機能の一覧（製品の事実だけ。無償の範囲そのものは人が合意して記録する。この一覧から推測しない）。
 * Scope1・2 の算定と照合は標準機能として扱う（plan §4.1 D5 の既定）
 */
export const STANDARD_SCOPE_ITEMS: readonly string[] = [
  'データの取込（CSV・Excel・文字を取れる PDF）',
  '排出係数・算定ルール（丸め・単位換算・Scope の区分）の設定',
  'Scope1・2 の算定（活動量 × 排出係数）と改良トンキロ法',
  '既存の算定結果との照合（整合性の確認と差異の原因）',
  '承認（1〜5 段階）・監査ログ',
  '出力と突合（原稿・算定明細・照合結果）',
  'AI の候補（採用は人が確定）',
  '全データの返却用の書き出し',
];

/** 標準機能の一覧に添える固定の文 */
export const STANDARD_SCOPE_NOTE = 'この一覧は製品の機能です。無償の範囲は上の合意に従います。';

/** 超過があるときの固定の文（操作は止めない） */
export const SCOPE_OVER_NOTICE = '別途協議の対象になりうる利用があります（操作は止めません）';

export interface ScopeSignalInput {
  sites: {
    /** トライアルの拠点（計画の対象拠点と算定の検証拠点の和。全社なら null） */
    trialSites: number | null;
    /** 計画の対象拠点数（目安） */
    plannedSites: number | null;
    /** 対象期間にデータがある、トライアルの拠点の外の拠点の数と行数（サプライヤーを除く） */
    outsideUnits: number;
    outsideRows: number;
  };
  pdf: {
    /** 取込に使った PDF（期間内） */
    ingestionPdf: number;
    /** そのうち文字が取れず OCR が要るもの */
    needsOcr: number;
    /** 資料として登録した PDF（期間内） */
    registeredPdf: number;
    /** PDF 等の一次データの目安（合意した値。未設定は null） */
    threshold: number | null;
    /** 数えた期間の説明（「トライアルの期間（…）」など） */
    periodLabel: string;
  };
  /** 改善管理表で費用区分を「別途協議」にした件数（区分ごと）と、区分の無い件数 */
  feedback: { byKind: Readonly<Record<TrialScopeKind, number>>; unclassified: number };
}

export interface ScopeSignal {
  kind: TrialScopeKind;
  label: string;
  /** 数えたもの（1 行） */
  measured: string;
  /** 件数（数えないものは null） */
  count: number | null;
  /** 目安（無ければ null） */
  threshold: number | null;
  /** 件数の単位 */
  unit: '拠点' | '件';
  state: TrialScopeSignalState;
  /** 補足（何が目安を超えたか・どこで数えたか） */
  detail: string;
}

const recorded = (n: number) => (n > 0 ? `改善管理表で別途協議とした要望 ${n} 件` : '');
const join = (parts: readonly string[]) => parts.filter((p) => p !== '').join('。');

/** 4 区分の信号（並びは SEPARATE_CONSULTATION_KINDS） */
export function scopeSignals(input: ScopeSignalInput): ScopeSignal[] {
  const { sites, pdf, feedback } = input;

  const siteOver =
    (sites.trialSites !== null &&
      sites.plannedSites !== null &&
      sites.trialSites > sites.plannedSites) ||
    sites.outsideUnits > 0 ||
    feedback.byKind.site_expansion > 0;
  const site: ScopeSignal = {
    kind: 'site_expansion',
    label: SEPARATE_CONSULTATION_LABELS.site_expansion,
    measured: 'トライアルの拠点（計画の対象拠点と算定の検証拠点）と、その外の拠点のデータ',
    count: sites.trialSites,
    threshold: sites.plannedSites,
    unit: '拠点',
    state: siteOver
      ? 'over'
      : sites.plannedSites === null || sites.trialSites === null
        ? 'no_threshold'
        : 'within',
    detail: join([
      sites.trialSites === null ? '拠点を指定していません（全社）' : '',
      sites.outsideUnits > 0
        ? `トライアルの拠点の外の ${sites.outsideUnits} 拠点に対象期間のデータ ${sites.outsideRows} 件`
        : '',
      recorded(feedback.byKind.site_expansion),
    ]),
  };

  const pdfCount = pdf.ingestionPdf + pdf.registeredPdf;
  const ocr = pdf.needsOcr > 0;
  const pdfOver =
    ocr ||
    (pdf.threshold !== null && pdfCount > pdf.threshold) ||
    feedback.byKind.bulk_primary_data > 0;
  const bulk: ScopeSignal = {
    kind: 'bulk_primary_data',
    label: SEPARATE_CONSULTATION_LABELS.bulk_primary_data,
    measured: `PDF の件数（取込 ${pdf.ingestionPdf}・資料 ${pdf.registeredPdf}。${pdf.periodLabel}）`,
    count: pdfCount,
    threshold: pdf.threshold,
    unit: '件',
    state: pdfOver ? 'over' : pdf.threshold === null ? 'no_threshold' : 'within',
    detail: join([
      ocr
        ? `標準機能の外（OCR）: 文字を取れない PDF ${pdf.needsOcr} 件（製品に OCR はありません）`
        : '',
      recorded(feedback.byKind.bulk_primary_data),
    ]),
  };

  const integration: ScopeSignal = {
    kind: 'system_integration',
    label: SEPARATE_CONSULTATION_LABELS.system_integration,
    measured: '改善管理表で別途協議とした要望（製品に連携の機能はありません）',
    count: feedback.byKind.system_integration,
    threshold: null,
    unit: '件',
    state: feedback.byKind.system_integration > 0 ? 'over' : 'not_measured',
    detail: '利用の件数は数えられません。要望は改善管理表に記録します',
  };

  const development: ScopeSignal = {
    kind: 'custom_development',
    label: SEPARATE_CONSULTATION_LABELS.custom_development,
    measured: '改善管理表で別途協議とした要望',
    count: feedback.byKind.custom_development,
    threshold: null,
    unit: '件',
    state: feedback.byKind.custom_development > 0 ? 'over' : 'no_threshold',
    detail:
      feedback.unclassified > 0
        ? `区分の無い別途協議 ${feedback.unclassified} 件は、どの区分にも数えていません（改善管理表で区分を選んでください）`
        : '',
  };

  return [site, bulk, integration, development];
}

/** 件数／目安の表示（「5 拠点 / 目安 3」「2 件（目安なし）」「—」） */
export function signalCountLabel(
  signal: Pick<ScopeSignal, 'count' | 'threshold' | 'unit'>,
): string {
  if (signal.count === null) return '—';
  return signal.threshold === null
    ? `${signal.count} ${signal.unit}（目安なし）`
    : `${signal.count} ${signal.unit} / 目安 ${signal.threshold}`;
}

/** PDF か（MIME の種類か拡張子） */
export function isPdf(file: { mimeType: string; originalName: string }): boolean {
  return (
    file.mimeType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.originalName.trim())
  );
}
