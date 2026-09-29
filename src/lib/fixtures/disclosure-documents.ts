/**
 * 開示優先モードのデモ資料（すべて架空。docs/disclosure-first.md §7）。
 *
 * 定性情報の根拠を「どの資料の・どの版の・どこ」まで辿れることを見せるため、
 * 段落ごとに位置（見出し・段落番号）を持つテキスト資料を 3 点用意する。
 *  1. 過年度（FY2025）有価証券報告書のサステナビリティ情報（抜粋）… 前年の記載（当年度の根拠にはしない）
 *  2. FY2026 第3回サステナビリティ委員会 資料 … 当年度の事実の根拠
 *  3. 気候関連リスク・機会 評価資料 2026 … 当年度の事実の根拠（財務的影響は未確定）
 *
 * 既存の Fixture 証憑（電力請求書など）は実体を持たず抽出テキストだけを見せる（known-limitations D-2）。
 * この 3 点は本文そのものが引用・前年比較の題材なので、Demo Mode のストレージが
 * ここから本文を生成して返す（`findDisclosureDocumentBytes`）。Supabase Mode では従来の Fixture と同じく実体を持たない。
 *
 * `server-only` を付けない純粋モジュール（Fixture 生成・Demo ストレージ・テストが同じ実装を使う）。
 * 生成は決定論（乱数・現在時刻を使わない）。実在の企業・会議・書類は一切含めない。
 */

import { fid } from './ids';
import { ORG_IDS, day } from './dataset';
import type {
  ConfidentialityLevel,
  EvidenceUsagePurpose,
  IsoDate,
  StorageBucket,
  Uuid,
} from '@/types/domain';

export const DISCLOSURE_DOCUMENT_KEYS = [
  'fy2025-securities-report-excerpt',
  'fy2026-sustainability-committee-3',
  'climate-risk-assessment-2026',
] as const;
export type DisclosureDocumentKey = (typeof DISCLOSURE_DOCUMENT_KEYS)[number];

export interface DisclosureDocumentParagraph {
  /** 資料内で一意の段落キー（抽出断片・引用位置の ID の元にする） */
  key: string;
  /** 段落が属する見出し。紙面では見出しが変わる所にだけ出す */
  heading: string;
  /** 資料内の位置（extracted_fragments.locator / source_anchors.locator） */
  locator: string;
  text: string;
}

export interface DisclosureDocumentSpec {
  key: DisclosureDocumentKey;
  /** files.original_name。ファイル名だけで架空と分かるようにする */
  fileName: string;
  /** 紙面の 1 行目 */
  title: string;
  documentType: string;
  usagePurpose: EvidenceUsagePurpose;
  editionLabel: string;
  issuedOn: IsoDate;
  periodCode: 'FY2025' | 'FY2026';
  /** 登録（アップロード）した時点。基準日から何日前か */
  uploadedDaysAgo: number;
  confidentiality: ConfidentialityLevel;
  paragraphs: DisclosureDocumentParagraph[];
  footer: string;
}

// 発行日は基準日（FIXTURE_TODAY）からの相対で決め、本文中の日付も同じ値から作る
// （基準日を動かしたときに、版の発行日と本文の開催日が食い違わないように）
const PRIOR_REPORT_ISSUED_ON = day(-63);
const COMMITTEE_HELD_ON = day(-21);
const ASSESSMENT_ISSUED_ON = day(-25);

function jaDate(iso: IsoDate): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

function jaMonth(iso: IsoDate): string {
  const [y, m] = iso.split('-').map(Number);
  return `${y}年${m}月`;
}

export const DISCLOSURE_DOCUMENTS: readonly DisclosureDocumentSpec[] = [
  {
    key: 'fy2025-securities-report-excerpt',
    fileName: 'FY2025 有価証券報告書 サステナビリティ情報（抜粋・架空）.txt',
    title:
      '有価証券報告書（2026年3月期）第一部 第2 事業の状況 ― サステナビリティに関する考え方及び取組（抜粋・架空）',
    documentType: '有価証券報告書（抜粋）',
    // 前年度に公表した文章。当年度の事実の根拠として引用させない（前年比較・言い回しの参照に限る）
    usagePurpose: 'prior_year_text',
    editionLabel: `${jaMonth(PRIOR_REPORT_ISSUED_ON)}提出版（架空）`,
    issuedOn: PRIOR_REPORT_ISSUED_ON,
    periodCode: 'FY2025',
    // 「最新の有価証券報告書」から報告範囲を自動選択する機能（services/securities-report.ts）は、
    // 名前に「有価証券報告書」を含む最新のファイルを読む。抜粋が全文（有価証券報告書_FY2026.pdf、
    // 60 日前登録）より新しいと拠点名の無い抜粋を読んでしまうため、それより前に登録したことにする
    uploadedDaysAgo: 62,
    confidentiality: 'public',
    paragraphs: [
      {
        key: 'gov-1',
        heading: '(1) ガバナンス',
        locator: 'p.12 (1) ガバナンス 第1段落',
        text: '当社は、気候変動をはじめとするサステナビリティ関連のリスク及び機会を経営上の重要な課題と位置付けています。取締役会は、サステナビリティ推進部から年1回報告を受け、気候関連の課題への対応状況を監督しています。',
      },
      {
        key: 'gov-2',
        heading: '(1) ガバナンス',
        locator: 'p.12 (1) ガバナンス 第2段落',
        text: '代表取締役社長を委員長とするサステナビリティ委員会を年2回開催し、気候関連のリスク及び機会の識別と対応方針を審議しています。',
      },
      {
        key: 'strategy-1',
        heading: '(2) 戦略',
        locator: 'p.13 (2) 戦略 第1段落',
        text: '当社は、気候関連のリスクとして、炭素価格の導入による操業コストの上昇と、豪雨の激甚化による生産拠点の被災を識別しています。これらの財務的影響の定量化は今後の課題です。',
      },
      {
        key: 'metrics-1',
        heading: '(4) 指標及び目標',
        locator: 'p.14 (4) 指標及び目標 第1段落',
        text: 'Scope1 及び Scope2 の温室効果ガス排出量を管理指標とし、2030年度を目標年度とする削減目標を設定しています。',
      },
    ],
    footer: '※ 架空のサンプル資料（デモ用）。実在の提出書類ではありません。',
  },
  {
    key: 'fy2026-sustainability-committee-3',
    fileName: 'FY2026 第3回サステナビリティ委員会 資料（架空）.txt',
    title: '2026年度 第3回サステナビリティ委員会 資料（架空）',
    documentType: '委員会資料',
    usagePurpose: 'current_fact',
    editionLabel: `${jaDate(COMMITTEE_HELD_ON)} 委員会配布版（架空）`,
    issuedOn: COMMITTEE_HELD_ON,
    periodCode: 'FY2026',
    uploadedDaysAgo: 20,
    confidentiality: 'confidential',
    paragraphs: [
      {
        key: 'overview-1',
        heading: '第1章 開催概要',
        locator: '第1章 第1段落',
        text: `2026年度第3回サステナビリティ委員会を${jaDate(COMMITTEE_HELD_ON)}に開催した。委員長（代表取締役社長）ほか委員8名が出席した。`,
      },
      {
        key: 'gov-1',
        heading: '第2章 ガバナンス体制 ― 2.1 監督体制',
        locator: '第2章 2.1 第1段落',
        text: '取締役会は、気候関連の課題を含むサステナビリティ関連のリスク及び機会への対応を監督する。',
      },
      {
        key: 'gov-2',
        heading: '第2章 ガバナンス体制 ― 2.1 監督体制',
        locator: '第2章 2.1 第2段落',
        text: 'サステナビリティ委員会は代表取締役社長を委員長とし、年4回開催する。委員会は審議の結果を年2回、取締役会に報告する。',
      },
      {
        key: 'gov-3',
        heading: '第2章 ガバナンス体制 ― 2.2 経営者の役割',
        locator: '第2章 2.2 第1段落',
        text: '2026年度より、気候関連の目標の進捗を委員会の定例議題とし、執行役員（サステナビリティ担当）が進捗を報告する。',
      },
      {
        key: 'agenda-1',
        heading: '第3章 審議事項',
        locator: '第3章 3.1 第1段落',
        text: '「気候関連リスク・機会 評価資料 2026」に基づき、識別したリスク及び機会を審議した。財務的影響の算定は継続中であることを確認した。',
      },
    ],
    footer: '※ 架空のサンプル資料（デモ用）。実在の会議資料ではありません。',
  },
  {
    key: 'climate-risk-assessment-2026',
    fileName: '気候関連リスク・機会 評価資料 2026（架空）.txt',
    title: '気候関連リスク・機会 評価資料 2026（架空）',
    documentType: 'リスク評価資料',
    usagePurpose: 'current_fact',
    editionLabel: `${jaMonth(ASSESSMENT_ISSUED_ON)} 第1版（架空）`,
    issuedOn: ASSESSMENT_ISSUED_ON,
    periodCode: 'FY2026',
    uploadedDaysAgo: 24,
    confidentiality: 'confidential',
    paragraphs: [
      {
        key: 'scope-1',
        heading: '第1章 評価の範囲',
        locator: '第1章 1.1 第1段落',
        text: '評価の対象は当社及び連結子会社の生産拠点・販売拠点とする。時間軸は短期（2027年度まで）・中期（2030年度まで）・長期（2050年度まで）とする。',
      },
      {
        key: 'physical-1',
        heading: '第2章 識別したリスク及び機会 ― 2.1 物理的リスク',
        locator: '第2章 2.1 第1段落',
        text: '物理的リスク（急性）：西日本工場は近隣河川の氾濫時に浸水が想定される区域に立地している。豪雨の激甚化により、生産設備の浸水と操業停止が生じるおそれがある（中期〜長期）。',
      },
      {
        key: 'transition-1',
        heading: '第2章 識別したリスク及び機会 ― 2.2 移行リスク',
        locator: '第2章 2.2 第1段落',
        text: '移行リスク（政策・法規制）：炭素価格（カーボンプライシング）の導入や引上げにより、燃料及び購入電力に係る操業コストが上昇するおそれがある（短期〜中期）。',
      },
      {
        key: 'opportunity-1',
        heading: '第2章 識別したリスク及び機会 ― 2.3 機会',
        locator: '第2章 2.3 第1段落',
        text: '機会（製品及びサービス）：顧客の省エネルギー需要の高まりにより、低消費電力型の電子部品の需要が拡大する可能性がある（中期）。',
      },
      {
        key: 'financial-1',
        heading: '第3章 財務的影響',
        locator: '第3章 3.1 第1段落',
        // 財務的影響額を「未確定」と明記する（数値を架空で埋めると、不足情報のデモにならない）
        text: '上記のリスクの財務的影響額は現在評価中であり、未確定である。浸水時の復旧費用と炭素価格の感応度分析は2026年度下期に完了する予定である。',
      },
    ],
    footer: '※ 架空のサンプル資料（デモ用）。実在の評価資料ではありません。',
  },
];

const BUCKET: StorageBucket = 'evidence-private';
const BOM = String.fromCharCode(0xfeff);

export interface DisclosureDocumentIds {
  fileId: Uuid;
  fileVersionId: Uuid;
  storageKey: string;
}

/** 資料の ID と Storage Key。Fixture とストレージが同じ規則で引けるよう、ここだけで決める */
export function disclosureDocumentIds(key: DisclosureDocumentKey): DisclosureDocumentIds {
  const fileVersionId = fid('file_version', `AOMI/disclosure/${key}/v1`);
  return {
    fileId: fid('file', `AOMI/disclosure/${key}`),
    fileVersionId,
    // 既存の証憑と同じ形（組織 / evidence / 版 ID / 名前）。ファイル名は含めない（Path Traversal 防止）
    storageKey: `enterprise/${ORG_IDS.aomi}/evidence/${fileVersionId}/${key}.txt`,
  };
}

/** 段落（抽出断片）の ID */
export function disclosureFragmentId(key: DisclosureDocumentKey, paragraphKey: string): Uuid {
  return fid('fragment', `AOMI/disclosure/${key}/${paragraphKey}`);
}

export function disclosureDocument(key: DisclosureDocumentKey): DisclosureDocumentSpec {
  const spec = DISCLOSURE_DOCUMENTS.find((d) => d.key === key);
  if (!spec) throw new Error(`Unknown disclosure document: ${key}`);
  return spec;
}

export function disclosureParagraph(
  key: DisclosureDocumentKey,
  paragraphKey: string,
): DisclosureDocumentParagraph {
  const paragraph = disclosureDocument(key).paragraphs.find((p) => p.key === paragraphKey);
  if (!paragraph) throw new Error(`Unknown paragraph: ${key}/${paragraphKey}`);
  return paragraph;
}

/**
 * 紙面の本文。段落の前に位置（【第2章 2.1 第1段落】）を出し、
 * 画面で引用位置を見たときに資料のどこか分かるようにする。
 */
export function renderDisclosureDocument(spec: DisclosureDocumentSpec): string {
  const lines: string[] = [spec.title, `${spec.editionLabel} ／ 発行日 ${spec.issuedOn}`, ''];
  let heading: string | null = null;
  for (const paragraph of spec.paragraphs) {
    if (paragraph.heading !== heading) {
      if (heading !== null) lines.push('');
      lines.push(paragraph.heading);
      heading = paragraph.heading;
    }
    lines.push(`【${paragraph.locator}】`, paragraph.text);
  }
  lines.push('', spec.footer);
  return `${lines.join('\n')}\n`;
}

/** 実体のバイト列。UTF-8（BOM 付き。Windows のメモ帳・Excel でも文字化けしないように） */
export function disclosureDocumentBytes(spec: DisclosureDocumentSpec): Uint8Array {
  return new TextEncoder().encode(BOM + renderDisclosureDocument(spec));
}

let bytesByStorageKey: Map<string, Uint8Array> | null = null;

/**
 * Demo Mode のストレージに実体が無いとき、デモ資料なら本文を返す。
 * 対象外（他の Fixture・別のバケット）は null（従来どおり「実体なし」として扱わせる）。
 */
export function findDisclosureDocumentBytes(
  bucket: StorageBucket,
  storageKey: string,
): Uint8Array | null {
  if (bucket !== BUCKET) return null;
  if (!bytesByStorageKey) {
    bytesByStorageKey = new Map(
      DISCLOSURE_DOCUMENTS.map((spec) => [
        disclosureDocumentIds(spec.key).storageKey,
        disclosureDocumentBytes(spec),
      ]),
    );
  }
  const bytes = bytesByStorageKey.get(storageKey);
  // 呼び出し側が書き換えても次の読み出しに影響させない
  return bytes ? bytes.slice() : null;
}

export const DISCLOSURE_DOCUMENT_BUCKET = BUCKET;
