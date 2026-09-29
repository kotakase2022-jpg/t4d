/**
 * 開示優先モードのデモ Fixture（すべて架空。docs/disclosure-first.md §7）。
 *
 * 主役の架空企業（青海テクノロジー）に、次の筋書きが一通りつながる状態を作る。
 *  - FY2025 の承認済みプロジェクト（前年比較の元）と、FY2026 の進行中プロジェクト
 *    「FY2026 統合開示（SSBJ・CSRD域外準備）」
 *  - 節: ガバナンス（根拠付き・承認済み）／リスク・機会（財務的影響が未確定・下書き）／
 *    指標（承認済みだが、引用した Scope1 に承認後の新版があり「再確認が必要」）／
 *    ESRS-40a 準備のガバナンス（同じ定性情報の版を別の基準で再利用・下書き）
 *  - 根拠資料 3 点（disclosure-documents.ts）と、その段落を指す引用位置
 *  - ESRS-40a は公開草案（要求事項は未収録）、既存 CSRD 12 項目は架空サンプルと明示する
 *
 * 機能設定（disclosure_first）は false のまま置く（A01: 画面の切替は発表者・E2E が行う）。
 * 監査ログの行は作らない（既存の監査ログ一覧・件数の表示を変えないため）。
 *
 * 時系列（基準日 FIXTURE_TODAY から何日前か。前の出来事ほど数字が大きい）
 *   FY2025: 適用判断 148 → 節の承認 86 → 有報の提出 63（抜粋の登録 62）→ 前年の記載を台帳へ 44
 *   FY2026: プロジェクト作成 48 → 適用判断 46 → 指標の節を承認 27 → Scope1 を訂正 25・再承認 23
 *           → 監査法人の SNAP-1 固定 21 → 定性情報の版 18・確認 17 → ガバナンスの節を承認 10
 *           → リスク・機会の下書き 8 → ESRS-40a 準備の下書き 5
 */

import {
  canonicalJson,
  collectRefs,
  contentHashOf,
  plainTextOf,
} from '@/lib/domain/disclosure-block';
import {
  DEFAULT_REVIEW_POLICY,
  DEFAULT_REVIEW_POLICY_VERSION,
  canCompleteReview,
  canFinalApprove,
  reviewEventIdempotencyKey,
} from '@/lib/domain/disclosure-status';
import { formatNumber } from '@/lib/format/datetime';
import { SSBJ_MASTER_ITEMS } from '@/lib/frameworks/ssbj-2026';
import { ORG_IDS, PERIOD_IDS, at, dataPointId, day, metricId, userId } from './dataset';
import {
  DISCLOSURE_DOCUMENTS,
  DISCLOSURE_DOCUMENT_BUCKET,
  disclosureDocumentBytes,
  disclosureDocumentIds,
  disclosureFragmentId,
  disclosureParagraph,
  renderDisclosureDocument,
  type DisclosureDocumentKey,
} from './disclosure-documents';
import { contentHash, fid } from './ids';
import type { FixtureDb } from './store';
import type {
  BlockBody,
  BlockInline,
  DisclosureFrameworkVersion,
  IsoDate,
  IsoDateTime,
  NarrativeRecord,
  NarrativeTheme,
  NarrativeVersion,
  ReviewEvent,
  ReviewEventType,
  ReviewStage,
  Uuid,
} from '@/types/domain';

// ----------------------------------------------------------------------
// 登場人物（dataset.ts の DEMO_USERS）
// ----------------------------------------------------------------------

const ORG = ORG_IDS.aomi;
/** 海野 みどり（本社サステナビリティ担当）: 原稿の作成・レビュー依頼 */
const AUTHOR = userId('sustainability@demo.local');
/** 検見川 涼（レビュー担当）: 第 1 段レビュー */
const REVIEWER = userId('reviewer@demo.local');
/** 承 花子（執行役員）: 最終承認 */
const APPROVER = userId('approver@demo.local');
/** 青海 太郎（サステナビリティ推進部長）: 適用判断の確定 */
const ADMIN = userId('enterprise-admin@demo.local');

const SSBJ_VERSION_ID = fid('framework_version', 'ssbj/2026');

// ----------------------------------------------------------------------
// 基準の版メタデータ（0034）。store.ts の版の行がここを参照する
// ----------------------------------------------------------------------

type FrameworkVersionMetadata = Pick<
  DisclosureFrameworkVersion,
  | 'versionCode'
  | 'legalStatus'
  | 'issuedAt'
  | 'effectiveAt'
  | 'jurisdiction'
  | 'materialityBasis'
  | 'sourceUrl'
  | 'verifiedAt'
  | 'verifiedBy'
  | 'coverageStatus'
  | 'coverageNote'
>;

/**
 * SSBJ 2026-03-13 改正基準。一次資料（SSBJ の基準一覧）で確認した事実だけを書く。
 * 収録は一般・気候・実務対応の 133 項目で、ユニバーサル基準（適用）は収録していない。
 */
export const SSBJ_2026_VERSION_METADATA: FrameworkVersionMetadata = {
  versionCode: 'ssbj-2026-03-13',
  legalStatus: 'adopted',
  issuedAt: '2026-03-13',
  effectiveAt: null,
  jurisdiction: 'JP',
  materialityBasis: 'financial',
  sourceUrl: 'https://www.ssb-j.jp/jp/ssbj_standards.html',
  verifiedAt: '2026-09-29',
  verifiedBy: 'W0 一次資料確認',
  coverageStatus: 'partial',
  coverageNote:
    '一般開示基準33・気候関連開示基準96・実務対応基準第1号4の計133項目。ユニバーサル基準（適用）は未収録',
};

/** 既存の CSRD（ESRS 架空縮小版）。正式な ESRS と見誤らせないよう、サンプルと明示する */
export const CSRD_SAMPLE_VERSION_METADATA: FrameworkVersionMetadata = {
  versionCode: null,
  legalStatus: 'sample',
  issuedAt: null,
  effectiveAt: null,
  jurisdiction: null,
  materialityBasis: null,
  sourceUrl: null,
  verifiedAt: null,
  verifiedBy: null,
  coverageStatus: 'sample',
  coverageNote: 'デモ用の架空サンプル12項目（正式ESRSではない）',
};

/**
 * ESRS-40a 公開草案（EFRAG、2026-07-23 公表・意見募集 2026-10-31 まで）。
 * 要求事項の本文は収録しない（草案の条文を推測で作らない。正式版で差し替える）。
 */
export const ESRS_40A_VERSION_METADATA: FrameworkVersionMetadata = {
  versionCode: 'esrs-40a-ed-2026-07',
  legalStatus: 'draft',
  issuedAt: '2026-07-23',
  effectiveAt: null,
  jurisdiction: 'EU',
  materialityBasis: 'impact',
  sourceUrl:
    'https://www.efrag.org/en/news-and-calendar/news/efrag-launches-public-consultation-on-the-esrs40a-exposure-draft-for-certain-noneu-undertakings',
  verifiedAt: '2026-09-29',
  verifiedBy: 'W0 一次資料確認',
  coverageStatus: 'not_loaded',
  coverageNote: '要求事項本文は未収録（公開草案。意見募集期限 2026-10-31、正式版で差し替え）',
};

// ----------------------------------------------------------------------
// ID（E2E・テストからも同じ値で引けるように公開する）
// ----------------------------------------------------------------------

function blockIds(key: string) {
  return {
    block: fid('disclosure_block', key),
    version: fid('disclosure_block_version', `${key}/v1`),
    request: fid('review_request', `${key}/1`),
  };
}

function anchorId(doc: DisclosureDocumentKey, paragraphKey: string): Uuid {
  return fid('source_anchor', `AOMI/${doc}/${paragraphKey}`);
}

const SCOPE1_DATA_POINT_ID = dataPointId('HQ', 'scope1', 'FY2026');

/**
 * 指標の節が引用した Scope1（本社・FY2026）と、節の承認後にできた新しい版。
 * 値は同じで、集計範囲の注記だけを訂正した版にする（既存の GHG 集計・画面の数値を変えないため）。
 */
export const SCOPE1_CORRECTION = {
  dataPointId: SCOPE1_DATA_POINT_ID,
  citedVersionId: fid('data_point_version', `${SCOPE1_DATA_POINT_ID}/v1`),
  correctedVersionId: fid('data_point_version', `${SCOPE1_DATA_POINT_ID}/v2`),
  approvalId: fid('approval', `${SCOPE1_DATA_POINT_ID}/final/v2`),
  changeReason: '集計範囲の訂正（架空）',
} as const;

export const DISCLOSURE_FIRST_IDS = {
  featureSettings: fid('organization_feature_settings', 'AOMI'),
  esrs40aFramework: fid('framework', 'esrs_40a'),
  esrs40aVersion: fid('framework_version', 'esrs_40a/2026-ed'),
  documents: {
    priorSecuritiesReport: disclosureDocumentIds('fy2025-securities-report-excerpt'),
    committee: disclosureDocumentIds('fy2026-sustainability-committee-3'),
    riskAssessment: disclosureDocumentIds('climate-risk-assessment-2026'),
  },
  anchors: {
    priorGovernance1: anchorId('fy2025-securities-report-excerpt', 'gov-1'),
    priorGovernance2: anchorId('fy2025-securities-report-excerpt', 'gov-2'),
    committeeGovernance1: anchorId('fy2026-sustainability-committee-3', 'gov-1'),
    committeeGovernance2: anchorId('fy2026-sustainability-committee-3', 'gov-2'),
    committeeGovernance3: anchorId('fy2026-sustainability-committee-3', 'gov-3'),
    riskPhysical: anchorId('climate-risk-assessment-2026', 'physical-1'),
    riskTransition: anchorId('climate-risk-assessment-2026', 'transition-1'),
    opportunity: anchorId('climate-risk-assessment-2026', 'opportunity-1'),
    financialImpact: anchorId('climate-risk-assessment-2026', 'financial-1'),
  },
  narratives: {
    governance: fid('narrative_record', 'AOMI/governance'),
    riskPhysical: fid('narrative_record', 'AOMI/risk-physical-flood'),
    riskTransition: fid('narrative_record', 'AOMI/risk-transition-carbon-price'),
    financialImpact: fid('narrative_record', 'AOMI/financial-impact'),
    strategy: fid('narrative_record', 'AOMI/strategy-low-power-products'),
  },
  narrativeVersions: {
    governanceFy2025: fid('narrative_version', 'AOMI/governance/v1'),
    governanceFy2026: fid('narrative_version', 'AOMI/governance/v2'),
    riskPhysical: fid('narrative_version', 'AOMI/risk-physical-flood/v1'),
    riskTransition: fid('narrative_version', 'AOMI/risk-transition-carbon-price/v1'),
    financialImpact: fid('narrative_version', 'AOMI/financial-impact/v1'),
    strategy: fid('narrative_version', 'AOMI/strategy-low-power-products/v1'),
  },
  projects: {
    fy2025: fid('disclosure_project', 'AOMI/FY2025'),
    fy2026: fid('disclosure_project', 'AOMI/FY2026'),
  },
  projectFrameworks: {
    fy2025Ssbj: fid('project_framework', 'AOMI/FY2025/ssbj'),
    fy2026Ssbj: fid('project_framework', 'AOMI/FY2026/ssbj'),
    fy2026Esrs40a: fid('project_framework', 'AOMI/FY2026/esrs_40a'),
  },
  decisions: {
    fy2025Ssbj: fid('project_framework_decision', 'AOMI/FY2025/ssbj/1'),
    fy2026Ssbj: fid('project_framework_decision', 'AOMI/FY2026/ssbj/1'),
  },
  blocks: {
    fy2026Governance: blockIds('AOMI/FY2026/governance'),
    fy2026RiskOpportunity: blockIds('AOMI/FY2026/risk_opportunity'),
    fy2026Metrics: blockIds('AOMI/FY2026/metrics_targets'),
    fy2026Esrs40aGovernance: blockIds('AOMI/FY2026/esrs40a_governance'),
    fy2025Governance: blockIds('AOMI/FY2025/governance'),
    fy2025Metrics: blockIds('AOMI/FY2025/metrics_targets'),
  },
  riskOpportunityComment: fid('review_comment', 'AOMI/FY2026/risk_opportunity/c1'),
  kpiTargets: {
    scope1: fid('kpi_target', 'AOMI/scope1_reduction_2030/v1'),
    scope2Market: fid('kpi_target', 'AOMI/scope2_market_reduction_2030/v1'),
  },
} as const;

const IDS = DISCLOSURE_FIRST_IDS;

// ----------------------------------------------------------------------
// 共通
// ----------------------------------------------------------------------

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(`Fixture inconsistency: ${message}`);
  return value;
}

function audit(created: IsoDateTime, updated: IsoDateTime, createdBy: Uuid, updatedBy = createdBy) {
  return { createdAt: created, updatedAt: updated, createdBy, updatedBy };
}

/** SSBJ の要求事項コード → disclosure_items.id（存在しないコードは Fixture の誤りとして止める） */
function ssbjItemIds(codes: readonly string[]): Uuid[] {
  return codes.map((code) => {
    must(
      SSBJ_MASTER_ITEMS.find((item) => item.code === code),
      `SSBJ requirement ${code}`,
    );
    return fid('disclosure_item', `ssbj/2026/${code}`);
  });
}

/** 数値の参照。表示用の文字列は「引用した版」の値で作る（参照先に新版ができても見た目を変えない） */
function metricInline(db: FixtureDb, dataPointIdValue: Uuid, versionNo: number): BlockInline {
  const versionId = fid('data_point_version', `${dataPointIdValue}/v${versionNo}`);
  const version = must(
    db.dataPointVersions.find((v) => v.id === versionId),
    `data point version ${dataPointIdValue}/v${versionNo}`,
  );
  return {
    t: 'metric',
    dataPointId: dataPointIdValue,
    dataPointVersionId: version.id,
    display: `${formatNumber(version.value)} ${version.unitOfMeasure}`,
  };
}

/** 定性情報の引用。採用時点の本文を quote に写す */
function narrativeInline(db: FixtureDb, narrativeVersionId: Uuid): BlockInline {
  const version = must(
    db.narrativeVersions.find((v) => v.id === narrativeVersionId),
    `narrative version ${narrativeVersionId}`,
  );
  return { t: 'narrative', narrativeVersionId, quote: version.body };
}

function cite(sourceAnchorId: Uuid): BlockInline {
  return { t: 'cite', sourceAnchorId };
}

function text(value: string): BlockInline {
  return { t: 'text', text: value };
}

// ======================================================================
// Scope1 の訂正版（store.ts が Data Point 生成の直後に呼ぶ）
// ======================================================================

/**
 * 本社 Scope1（FY2026）に、指標の節の承認後の新しい版を足す。
 *
 * 規則は画面の操作と同じにする（data-point-workflow.ts）:
 *  - 承認済みの値を直すと、版は下書き（draft）として作られ、Data Point は承認後変更になる
 *  - その後に再承認すると、状態は承認済みに戻り、承認後変更の印は外れる（承認の記録は新しい版を指す）
 * 再承認まで済ませておくのは、Data Room・監査法人の SNAP-1 に載る「承認済み」の範囲と、
 * 検証結果（承認後変更の警告）を既存のデモから変えないため。開示本文の側だけが古い版を引用している状態になる。
 *
 * 監査法人の SNAP-1（21 日前に固定）より前に済ませる。後にすると Snapshot 後の変更として
 * 数えられ、保証側のデモの件数が変わってしまう。
 */
export function applyScope1Correction(db: FixtureDb): void {
  const index = db.dataPoints.findIndex((d) => d.id === SCOPE1_CORRECTION.dataPointId);
  const dp = must(db.dataPoints[index], 'HQ scope1 FY2026');
  const cited = must(
    db.dataPointVersions.find((v) => v.id === SCOPE1_CORRECTION.citedVersionId),
    'HQ scope1 FY2026 v1',
  );
  if (dp.status !== 'approved' || dp.currentVersionId !== cited.id) {
    throw new Error(
      'Fixture inconsistency: HQ scope1 FY2026 must be approved at v1 before the fix',
    );
  }

  const correctedAt = at(25, 4);
  const reapprovedAt = at(23, 6);

  db.dataPointVersions.push({
    id: SCOPE1_CORRECTION.correctedVersionId,
    dataPointId: dp.id,
    organizationId: dp.organizationId,
    versionNo: 2,
    value: cited.value,
    textValue: cited.textValue,
    unitOfMeasure: cited.unitOfMeasure,
    status: 'draft',
    valueKind: cited.valueKind,
    availabilityStatus: cited.availabilityStatus,
    absenceReason: cited.absenceReason,
    sourceType: 'manual',
    sourceReference: '画面からの手入力',
    changeReason: SCOPE1_CORRECTION.changeReason,
    contentHash: contentHash(`${dp.id}|2|${cited.value}|${cited.unitOfMeasure}`),
    createdAt: correctedAt,
    createdBy: AUTHOR,
  });

  db.dataPoints[index] = {
    ...dp,
    currentVersionId: SCOPE1_CORRECTION.correctedVersionId,
    status: 'approved',
    approvedAt: reapprovedAt,
    approvedBy: APPROVER,
    changedAfterApproval: false,
    updatedAt: reapprovedAt,
    updatedBy: APPROVER,
  };

  db.approvals.push({
    id: SCOPE1_CORRECTION.approvalId,
    organizationId: dp.organizationId,
    targetType: 'data_point',
    targetId: dp.id,
    targetVersionId: SCOPE1_CORRECTION.correctedVersionId,
    stage: 'final',
    decision: 'approved',
    actorUserId: APPROVER,
    comment: '集計範囲の注記の訂正を確認しました（値の変更はありません）。',
    decidedAt: reapprovedAt,
  });
}

// ======================================================================
// 開示優先モードの Fixture 本体（store.ts が呼ぶ）
// ======================================================================

export function seedDisclosureFirst(db: FixtureDb): void {
  seedFeatureSettings(db);
  seedEsrs40a(db);
  seedDocuments(db);
  seedAnchors(db);
  seedNarratives(db);
  seedProjects(db);
  seedBlocks(db);
  seedKpiTargets(db);
}

function seedFeatureSettings(db: FixtureDb): void {
  // 行は置くが false のまま（従来ナビ・従来ホーム）。蒼天（別テナント）には行を作らない
  // （行が無い組織は既定値 false として扱う設計の確認に使う）
  db.organizationFeatureSettings.push({
    id: IDS.featureSettings,
    organizationId: ORG,
    disclosureFirst: false,
    ...audit(at(48), at(48), ADMIN),
  });
}

function seedEsrs40a(db: FixtureDb): void {
  db.frameworks.push({
    id: IDS.esrs40aFramework,
    key: 'esrs_40a',
    name: 'ESRS-40a（EU 域外企業向け ESRS）',
    description:
      'EU 会計指令 第40a条に基づく EU 域外企業向けの ESRS。公開草案の段階で、要求事項の本文は収録していません。',
  });
  db.frameworkVersions.push({
    id: IDS.esrs40aVersion,
    frameworkId: IDS.esrs40aFramework,
    year: 2026,
    label: 'ESRS-40a 公開草案（2026年7月）',
    status: 'draft',
    // 版の位置付け（草案）と出典は一次資料で確認した事実。架空の条文は持たないので Fixture 扱いにしない
    isFixture: false,
    createdAt: at(20),
    ...ESRS_40A_VERSION_METADATA,
  });
}

const PERIOD_BY_CODE = { FY2025: PERIOD_IDS.fy2025, FY2026: PERIOD_IDS.fy2026 } as const;

function seedDocuments(db: FixtureDb): void {
  for (const spec of DISCLOSURE_DOCUMENTS) {
    const ids = disclosureDocumentIds(spec.key);
    const uploadedAt = at(spec.uploadedDaysAgo, 2);
    db.files.push({
      id: ids.fileId,
      organizationId: ORG,
      bucket: DISCLOSURE_DOCUMENT_BUCKET,
      originalName: spec.fileName,
      mimeType: 'text/plain',
      confidentiality: spec.confidentiality,
      currentVersionId: ids.fileVersionId,
      documentType: spec.documentType,
      reportingPeriodId: PERIOD_BY_CODE[spec.periodCode],
      scanStatus: 'skipped',
      usagePurpose: spec.usagePurpose,
      editionLabel: spec.editionLabel,
      issuedOn: spec.issuedOn,
      deletedAt: null,
      ...audit(uploadedAt, uploadedAt, AUTHOR),
    });
    db.fileVersions.push({
      id: ids.fileVersionId,
      fileId: ids.fileId,
      organizationId: ORG,
      versionNo: 1,
      storageKey: ids.storageKey,
      sizeBytes: disclosureDocumentBytes(spec).length,
      // 既存の Fixture 証憑と同じく内容から決定論的に作る（Fixture では実 SHA-256 を計算しない）
      sha256: contentHash(renderDisclosureDocument(spec)),
      createdAt: uploadedAt,
      createdBy: AUTHOR,
    });
    // 段落単位の抽出結果。テキスト資料にはページが無いため page は段落の通し番号にし、
    // 位置は locator（見出し・段落番号）で示す（page を重複させると抽出テキスト表示のページ送りが崩れる）
    spec.paragraphs.forEach((paragraph, index) => {
      db.fragments.push({
        id: disclosureFragmentId(spec.key, paragraph.key),
        fileVersionId: ids.fileVersionId,
        organizationId: ORG,
        page: index + 1,
        kind: 'text',
        text: paragraph.text,
        locator: paragraph.locator,
        createdAt: uploadedAt,
      });
    });
  }
}

/** 引用位置: [資料, 段落, 作成した日（何日前）] */
const ANCHOR_SPECS: ReadonlyArray<[DisclosureDocumentKey, string, number]> = [
  ['fy2025-securities-report-excerpt', 'gov-1', 44],
  ['fy2025-securities-report-excerpt', 'gov-2', 44],
  ['climate-risk-assessment-2026', 'physical-1', 22],
  ['climate-risk-assessment-2026', 'transition-1', 22],
  ['climate-risk-assessment-2026', 'opportunity-1', 22],
  ['climate-risk-assessment-2026', 'financial-1', 22],
  ['fy2026-sustainability-committee-3', 'gov-1', 19],
  ['fy2026-sustainability-committee-3', 'gov-2', 19],
  ['fy2026-sustainability-committee-3', 'gov-3', 19],
];

function seedAnchors(db: FixtureDb): void {
  for (const [doc, paragraphKey, daysAgo] of ANCHOR_SPECS) {
    const paragraph = disclosureParagraph(doc, paragraphKey);
    db.sourceAnchors.push({
      id: anchorId(doc, paragraphKey),
      organizationId: ORG,
      fileVersionId: disclosureDocumentIds(doc).fileVersionId,
      fragmentId: disclosureFragmentId(doc, paragraphKey),
      anchorKind: 'heading_paragraph',
      page: null,
      locator: paragraph.locator,
      quoteText: paragraph.text,
      acquiredBy: 'extracted',
      createdAt: at(daysAgo, 3),
      createdBy: AUTHOR,
    });
  }
}

// ----------------------------------------------------------------------
// 定性情報（台帳と版）
// ----------------------------------------------------------------------

interface NarrativeVersionSpec {
  id: Uuid;
  periodId: Uuid;
  scopeNote: string;
  /** テンプレート項目（src/lib/domain/narrative-template.ts）。値の無い項目はキーを置かない */
  fields: Record<string, string>;
  body: string;
  anchorIds: Uuid[];
  changeReason: string | null;
  createdAt: IsoDateTime;
}

interface NarrativeSpec {
  id: Uuid;
  theme: NarrativeTheme;
  title: string;
  ownerDepartment: string;
  tags: string[];
  versions: NarrativeVersionSpec[];
  /** 確認済みにする場合の確認者と日時（版は最新の版） */
  confirmed: { by: Uuid; at: IsoDateTime } | null;
}

const SCOPE_NOTE_FY2025 = '青海テクノロジー株式会社及び連結子会社（2025年度）';
const SCOPE_NOTE_FY2026 = '青海テクノロジー株式会社及び連結子会社（2026年度）';

function narrativeSpecs(): NarrativeSpec[] {
  const A = IDS.anchors;
  const V = IDS.narrativeVersions;
  return [
    {
      id: IDS.narratives.governance,
      theme: 'governance',
      title: '気候関連のガバナンス体制',
      ownerDepartment: 'サステナビリティ推進部',
      tags: ['気候', '取締役会', 'サステナビリティ委員会'],
      versions: [
        {
          // 前年度に公表した記載を台帳の 1 版目として取り込む（前年比較の元）
          id: V.governanceFy2025,
          periodId: PERIOD_IDS.fy2025,
          scopeNote: SCOPE_NOTE_FY2025,
          fields: {
            oversightBody: '取締役会',
            oversightProcess:
              'サステナビリティ推進部から年1回報告を受け、気候関連の課題への対応状況を監督する',
            committee: 'サステナビリティ委員会（委員長: 代表取締役社長／年2回開催）',
          },
          body: '取締役会は、サステナビリティ推進部から年1回報告を受け、気候関連の課題への対応状況を監督しています。代表取締役社長を委員長とするサステナビリティ委員会を年2回開催し、気候関連のリスク及び機会の識別と対応方針を審議しています。',
          anchorIds: [A.priorGovernance1, A.priorGovernance2],
          changeReason: '前年度（FY2025）の有価証券報告書の記載を台帳へ登録',
          createdAt: at(44, 4),
        },
        {
          // 当年度の委員会資料に基づく版。開催頻度・報告頻度が前年から変わった（前年比較の見どころ）
          id: V.governanceFy2026,
          periodId: PERIOD_IDS.fy2026,
          scopeNote: SCOPE_NOTE_FY2026,
          fields: {
            oversightBody: '取締役会',
            oversightProcess:
              'サステナビリティ委員会から年2回報告を受け、気候関連の課題を含むリスク及び機会への対応を監督する',
            committee: 'サステナビリティ委員会（委員長: 代表取締役社長／年4回開催）',
            managementRole:
              '執行役員（サステナビリティ担当）が気候関連の目標の進捗を委員会に報告する',
          },
          body: '取締役会は、気候関連の課題を含むサステナビリティ関連のリスク及び機会への対応を監督しています。代表取締役社長を委員長とするサステナビリティ委員会を年4回開催し、その審議の結果を年2回、取締役会に報告しています。',
          anchorIds: [A.committeeGovernance1, A.committeeGovernance2, A.committeeGovernance3],
          changeReason:
            '第3回サステナビリティ委員会資料に基づき、委員会の開催頻度と取締役会への報告頻度を更新',
          createdAt: at(18, 3),
        },
      ],
      confirmed: { by: REVIEWER, at: at(17, 5) },
    },
    {
      id: IDS.narratives.riskPhysical,
      theme: 'risk_opportunity',
      title: '物理的リスク：西日本工場の浸水（架空）',
      ownerDepartment: '環境管理部',
      tags: ['気候', '物理的リスク', '西日本工場'],
      versions: [
        {
          id: V.riskPhysical,
          periodId: PERIOD_IDS.fy2026,
          scopeNote: SCOPE_NOTE_FY2026,
          // 対応策（response）は評価資料に無いため空けておく（不足情報として見せる）
          fields: {
            riskCategory: '物理的リスク（急性）',
            description: '近隣河川の氾濫による生産設備の浸水と操業停止',
            timeHorizon: '中期〜長期',
            affectedAssets: '西日本工場',
          },
          body: '西日本工場は近隣河川の氾濫時に浸水が想定される区域に立地しており、豪雨の激甚化により生産設備の浸水と操業停止が生じるおそれがあります（物理的リスク・中期〜長期）。',
          anchorIds: [A.riskPhysical],
          changeReason: '気候関連リスク・機会 評価資料 2026 から登録',
          createdAt: at(22, 5),
        },
      ],
      confirmed: null,
    },
    {
      id: IDS.narratives.riskTransition,
      theme: 'risk_opportunity',
      title: '移行リスク：炭素価格の導入・引上げ（架空）',
      ownerDepartment: '経営企画部',
      tags: ['気候', '移行リスク', '炭素価格'],
      versions: [
        {
          id: V.riskTransition,
          periodId: PERIOD_IDS.fy2026,
          scopeNote: SCOPE_NOTE_FY2026,
          fields: {
            riskCategory: '移行リスク（政策・法規制）',
            description: '炭素価格の導入・引上げによる燃料及び購入電力に係る操業コストの上昇',
            timeHorizon: '短期〜中期',
            affectedAssets: '国内の生産拠点',
          },
          body: '炭素価格（カーボンプライシング）の導入や引上げにより、燃料及び購入電力に係る操業コストが上昇するおそれがあります（移行リスク・短期〜中期）。',
          anchorIds: [A.riskTransition],
          changeReason: '気候関連リスク・機会 評価資料 2026 から登録',
          createdAt: at(22, 5),
        },
      ],
      confirmed: null,
    },
    {
      id: IDS.narratives.financialImpact,
      theme: 'financial_impact',
      title: '気候関連リスクの財務的影響（評価中・架空）',
      ownerDepartment: '経理部',
      tags: ['気候', '財務的影響'],
      versions: [
        {
          id: V.financialImpact,
          periodId: PERIOD_IDS.fy2026,
          scopeNote: SCOPE_NOTE_FY2026,
          // 影響額（amount）・算定方法（amountBasis）はキーごと置かない。
          // 未確定の金額を 0 や仮の値で埋めず、示さない理由を書く（§7「財務影響が未確定で不足情報あり」）
          fields: {
            relatedRisk: '西日本工場の浸水（物理的リスク）／炭素価格の導入・引上げ（移行リスク）',
            impactDescription:
              '浸水時の復旧費用と操業停止による売上の減少、炭素価格による操業コストの上昇',
            estimationStatus: '評価中（未確定）',
            noAmountReason:
              '財務的影響額は評価中のため未確定（感応度分析は2026年度下期に完了する予定）',
          },
          body: 'これらのリスクの財務的影響額は現在評価中であり、未確定です。浸水時の復旧費用と炭素価格の感応度分析は2026年度下期に完了する予定です。',
          anchorIds: [A.financialImpact],
          changeReason: '気候関連リスク・機会 評価資料 2026 から登録',
          createdAt: at(21, 6),
        },
      ],
      confirmed: null,
    },
    {
      id: IDS.narratives.strategy,
      theme: 'strategy',
      title: '機会への対応：低消費電力型製品の拡大（架空）',
      ownerDepartment: '事業開発部',
      tags: ['気候', '機会', '製品'],
      versions: [
        {
          id: V.strategy,
          periodId: PERIOD_IDS.fy2026,
          scopeNote: SCOPE_NOTE_FY2026,
          fields: {
            relatedRiskOpportunity: '顧客の省エネルギー需要の高まり（機会）',
            initiative: '低消費電力型の電子部品の開発と拡販',
          },
          body: '顧客の省エネルギー需要の高まりを機会と捉え、低消費電力型の電子部品の開発と拡販に取り組んでいます。',
          anchorIds: [A.opportunity],
          changeReason: '気候関連リスク・機会 評価資料 2026 から登録',
          createdAt: at(21, 6),
        },
      ],
      confirmed: null,
    },
  ];
}

function seedNarratives(db: FixtureDb): void {
  for (const spec of narrativeSpecs()) {
    let previousId: Uuid | null = null;
    for (const [index, v] of spec.versions.entries()) {
      const version: NarrativeVersion = {
        id: v.id,
        organizationId: ORG,
        narrativeRecordId: spec.id,
        versionNo: index + 1,
        reportingPeriodId: v.periodId,
        scopeNote: v.scopeNote,
        fields: v.fields,
        body: v.body,
        sourceAnchorIds: v.anchorIds,
        // 2 版目以降は直前の版から引き継いだものとして記録する（前年の記載からの更新を辿れるように）
        carriedFromVersionId: previousId,
        changeReason: v.changeReason,
        originatedFromAiRunId: null,
        contentHash: contentHash(
          canonicalJson({
            reportingPeriodId: v.periodId,
            scopeNote: v.scopeNote,
            fields: v.fields,
            body: v.body,
            sourceAnchorIds: v.anchorIds,
          }),
        ),
        createdAt: v.createdAt,
        createdBy: AUTHOR,
      };
      db.narrativeVersions.push(version);
      previousId = version.id;
    }

    const first = must(spec.versions[0], `narrative ${spec.title} v1`);
    const latest = must(spec.versions[spec.versions.length - 1], `narrative ${spec.title}`);
    const record: NarrativeRecord = {
      id: spec.id,
      organizationId: ORG,
      theme: spec.theme,
      title: spec.title,
      ownerUserId: AUTHOR,
      ownerDepartment: spec.ownerDepartment,
      tags: spec.tags,
      status: spec.confirmed ? 'confirmed' : 'draft',
      currentVersionId: latest.id,
      confirmedVersionId: spec.confirmed ? latest.id : null,
      confirmedBy: spec.confirmed?.by ?? null,
      confirmedAt: spec.confirmed?.at ?? null,
      deletedAt: null,
      ...audit(
        first.createdAt,
        spec.confirmed?.at ?? latest.createdAt,
        AUTHOR,
        spec.confirmed?.by ?? AUTHOR,
      ),
    };
    db.narrativeRecords.push(record);
  }
}

// ----------------------------------------------------------------------
// プロジェクト・基準・適用判断
// ----------------------------------------------------------------------

const RULE_REF_SSBJ = 'SSBJ 2026-03-13 改正基準／任意適用の社内決定（架空）';

function seedProjects(db: FixtureDb): void {
  const fy2025 = must(
    db.periods.find((p) => p.id === PERIOD_IDS.fy2025),
    'period FY2025',
  );
  const fy2026 = must(
    db.periods.find((p) => p.id === PERIOD_IDS.fy2026),
    'period FY2026',
  );

  const scope = {
    scopeOrgNote: '青海テクノロジー株式会社及び連結子会社（欧州販売子会社を含む）。',
    scopeConsolidationNote:
      '財務諸表と同じ連結の範囲。持分法適用関連会社（青海マテリアル合弁会社）は連結の範囲に含めない。',
    scopeGhgBoundaryNote:
      'GHG 排出量は財務支配力基準で集計する。Scope2 はマーケット基準（ロケーション基準は未集計）。',
    scopeValueChainNote:
      'Scope3 はカテゴリ1（購入した製品・サービス）のみ算定済み。その他のカテゴリは未算定。',
  };

  db.disclosureProjects.push(
    {
      // 前年比較の元。承認済みの節を持ったまま完了している
      id: IDS.projects.fy2025,
      organizationId: ORG,
      reportingPeriodId: fy2025.id,
      name: 'FY2025 サステナビリティ開示（SSBJ 任意適用）',
      reportingEntity: '青海テクノロジー株式会社及び連結子会社',
      periodStart: fy2025.startDate,
      periodEnd: fy2025.endDate,
      currency: 'JPY',
      purposes: ['ssbj_voluntary'],
      languages: ['ja'],
      ownerUserId: AUTHOR,
      reviewerUserId: REVIEWER,
      finalApproverUserId: APPROVER,
      dueDate: day(-60),
      ...scope,
      includedUnitIds: [],
      status: 'closed',
      deletedAt: null,
      ...audit(at(170), at(62), AUTHOR),
    },
    {
      id: IDS.projects.fy2026,
      organizationId: ORG,
      reportingPeriodId: fy2026.id,
      name: 'FY2026 統合開示（SSBJ・CSRD域外準備）',
      reportingEntity: '青海テクノロジー株式会社及び連結子会社',
      periodStart: fy2026.startDate,
      periodEnd: fy2026.endDate,
      currency: 'JPY',
      purposes: ['ssbj_voluntary', 'csrd_40a_prep'],
      languages: ['ja'],
      ownerUserId: AUTHOR,
      reviewerUserId: REVIEWER,
      finalApproverUserId: APPROVER,
      // 期限は基準日からの相対（デモの「あと何日」が基準日と食い違わないように）
      dueDate: day(45),
      ...scope,
      includedUnitIds: [],
      status: 'active',
      deletedAt: null,
      ...audit(at(48), at(19), AUTHOR),
    },
  );

  db.projectFrameworks.push(
    {
      id: IDS.projectFrameworks.fy2025Ssbj,
      organizationId: ORG,
      projectId: IDS.projects.fy2025,
      frameworkVersionId: SSBJ_VERSION_ID,
      purpose: 'ssbj_voluntary',
      applicabilityStatus: 'voluntary',
      currentDecisionId: IDS.decisions.fy2025Ssbj,
      conditions: {},
      ...audit(at(170), at(148), AUTHOR, ADMIN),
    },
    {
      id: IDS.projectFrameworks.fy2026Ssbj,
      organizationId: ORG,
      projectId: IDS.projects.fy2026,
      frameworkVersionId: SSBJ_VERSION_ID,
      purpose: 'ssbj_voluntary',
      applicabilityStatus: 'applicable',
      currentDecisionId: IDS.decisions.fy2026Ssbj,
      conditions: {},
      ...audit(at(48), at(46), AUTHOR, ADMIN),
    },
    {
      // ESRS-40a は準備のために登録しただけで、適用判断は確定していない（草案のため判断材料が揃わない）。
      // 適用条件（EU 域内売上など）も未入力のまま（未入力を 0 として扱わない）
      id: IDS.projectFrameworks.fy2026Esrs40a,
      organizationId: ORG,
      projectId: IDS.projects.fy2026,
      frameworkVersionId: IDS.esrs40aVersion,
      purpose: 'csrd_40a_prep',
      applicabilityStatus: 'candidate',
      currentDecisionId: null,
      conditions: {},
      ...audit(at(19), at(19), AUTHOR),
    },
  );

  db.projectFrameworkDecisions.push(
    {
      id: IDS.decisions.fy2025Ssbj,
      organizationId: ORG,
      projectFrameworkId: IDS.projectFrameworks.fy2025Ssbj,
      decisionNo: 1,
      applicabilityStatus: 'voluntary',
      reason:
        'SSBJ 基準を任意適用し、2025年度の有価証券報告書のサステナビリティ情報に記載する（取締役会決議・架空）。',
      ruleRef: RULE_REF_SSBJ,
      confirmedOn: day(-148),
      transitionalNote: null,
      conditionsSnapshot: {},
      decidedBy: ADMIN,
      decidedAt: at(148),
    },
    {
      id: IDS.decisions.fy2026Ssbj,
      organizationId: ORG,
      projectFrameworkId: IDS.projectFrameworks.fy2026Ssbj,
      decisionNo: 1,
      applicabilityStatus: 'applicable',
      reason:
        'FY2025 に続き SSBJ 基準を任意適用し、2026年度の有価証券報告書のサステナビリティ情報を SSBJ 基準に準拠して開示する（取締役会決議・架空）。',
      ruleRef: RULE_REF_SSBJ,
      confirmedOn: day(-46),
      transitionalNote:
        '経過措置の適用可否は、法定開示への移行時期の判断とあわせて再確認する（架空の社内メモ）。',
      conditionsSnapshot: {},
      decidedBy: ADMIN,
      decidedAt: at(46),
    },
  );
}

// ----------------------------------------------------------------------
// 節・版・レビュー
// ----------------------------------------------------------------------

interface ReviewSpec {
  requestedAt: IsoDateTime;
  reviewedAt: IsoDateTime;
  approvedAt: IsoDateTime;
  decisionIds: Uuid[];
}

interface BlockSpec {
  ids: ReturnType<typeof blockIds>;
  projectId: Uuid;
  frameworkVersionId: Uuid;
  sectionKey: string;
  title: string;
  sortOrder: number;
  requirementItemIds: Uuid[];
  dueDate: IsoDate;
  createdAt: IsoDateTime;
  versionCreatedAt: IsoDateTime;
  body: BlockBody;
  /** 承認まで済んだ節のレビュー。null は下書きのまま（依頼していない） */
  review: ReviewSpec | null;
}

function pushBlock(db: FixtureDb, spec: BlockSpec): void {
  const refs = collectRefs(spec.body);
  const versionId = spec.ids.version;

  db.disclosureBlockVersions.push({
    id: versionId,
    organizationId: ORG,
    blockId: spec.ids.block,
    versionNo: 1,
    baseVersionId: null,
    body: spec.body,
    plainText: plainTextOf(spec.body),
    metricRefs: refs.metricVersionIds,
    narrativeRefs: refs.narrativeVersionIds,
    anchorRefs: refs.anchorIds,
    changeReason: null,
    origin: 'human',
    originatedFromAiRunId: null,
    contentHash: contentHashOf(spec.body),
    createdAt: spec.versionCreatedAt,
    createdBy: AUTHOR,
  });

  const review = spec.review;
  db.disclosureBlocks.push({
    id: spec.ids.block,
    organizationId: ORG,
    projectId: spec.projectId,
    frameworkVersionId: spec.frameworkVersionId,
    sectionKey: spec.sectionKey,
    title: spec.title,
    sortOrder: spec.sortOrder,
    language: 'ja',
    translationOfBlockId: null,
    requirementItemIds: spec.requirementItemIds,
    ownerUserId: AUTHOR,
    dueDate: spec.dueDate,
    status: review ? 'approved' : 'draft',
    currentVersionId: versionId,
    submittedVersionId: review ? versionId : null,
    approvedVersionId: review ? versionId : null,
    workingBody: null,
    workingBaseVersionId: null,
    workingSavedAt: null,
    deletedAt: null,
    ...(review
      ? audit(spec.createdAt, review.approvedAt, AUTHOR, APPROVER)
      : audit(spec.createdAt, spec.versionCreatedAt, AUTHOR)),
  });

  if (!review) return;

  // 職務分離はアプリ層と同じ関数で確かめる（DB トリガ t4d.enforce_review_event と同じ規則。
  // Fixture が規則に反していると、seed の投入で初めて落ちて原因を追いにくいため）
  const reviewCheck = canCompleteReview({
    actorId: REVIEWER,
    request: { requestedBy: AUTHOR, status: 'open' },
    targetVersionCreatedBy: AUTHOR,
  });
  const approveCheck = canFinalApprove({
    actorId: APPROVER,
    request: { requestedBy: AUTHOR, status: 'reviewed' },
    targetVersionCreatedBy: AUTHOR,
    reviewCompletedBy: REVIEWER,
  });
  if (!reviewCheck.ok || !approveCheck.ok) {
    throw new Error(`Fixture inconsistency: separation of duties for ${spec.sectionKey}`);
  }

  const requestId = spec.ids.request;
  db.reviewRequests.push({
    id: requestId,
    organizationId: ORG,
    projectId: spec.projectId,
    targetType: 'disclosure_block',
    targetId: spec.ids.block,
    targetVersionId: versionId,
    requestedBy: AUTHOR,
    reviewerUserId: REVIEWER,
    approverUserId: APPROVER,
    policyVersion: DEFAULT_REVIEW_POLICY_VERSION,
    policy: { ...DEFAULT_REVIEW_POLICY, stages: [...DEFAULT_REVIEW_POLICY.stages] },
    decisionIds: review.decisionIds,
    referencedVersions: refs,
    status: 'approved',
    ...audit(review.requestedAt, review.approvedAt, AUTHOR, APPROVER),
  });

  const events: Array<[ReviewEventType, ReviewStage, Uuid, IsoDateTime]> = [
    ['requested', 'request', AUTHOR, review.requestedAt],
    ['review_completed', 'review', REVIEWER, review.reviewedAt],
    ['approved', 'final', APPROVER, review.approvedAt],
  ];
  for (const [eventType, stage, actor, createdAt] of events) {
    const event: ReviewEvent = {
      id: fid('review_event', `${requestId}/${eventType}`),
      organizationId: ORG,
      reviewRequestId: requestId,
      eventType,
      stage,
      actorUserId: actor,
      targetVersionId: versionId,
      reason: null,
      paragraphId: null,
      idempotencyKey: reviewEventIdempotencyKey(requestId, stage, versionId),
      createdAt,
    };
    db.reviewEvents.push(event);
  }
}

function seedBlocks(db: FixtureDb): void {
  const B = IDS.blocks;
  const A = IDS.anchors;
  const V = IDS.narrativeVersions;
  const fy2026Due = day(20);
  const fy2025Due = day(-75);

  // --- FY2025（前年比較の元。公表した文章そのもの） ---------------------------------
  const priorGov1 = disclosureParagraph('fy2025-securities-report-excerpt', 'gov-1');
  const priorGov2 = disclosureParagraph('fy2025-securities-report-excerpt', 'gov-2');
  const priorMetrics = disclosureParagraph('fy2025-securities-report-excerpt', 'metrics-1');
  const fy2025Review = (offsetHours: number): ReviewSpec => ({
    requestedAt: at(91, 2 + offsetHours),
    reviewedAt: at(88, 5 + offsetHours),
    approvedAt: at(86, 6 + offsetHours),
    decisionIds: [IDS.decisions.fy2025Ssbj],
  });

  pushBlock(db, {
    ids: B.fy2025Governance,
    projectId: IDS.projects.fy2025,
    frameworkVersionId: SSBJ_VERSION_ID,
    sectionKey: 'governance',
    title: 'ガバナンス',
    sortOrder: 10,
    requirementItemIds: ssbjItemIds(['気候-10', '気候-11']),
    dueDate: fy2025Due,
    createdAt: at(160),
    versionCreatedAt: at(92, 2),
    // 段落 ID は FY2026 の同じ節と揃える（前年比較で段落を対応付けられるように）
    body: {
      paragraphs: [
        { id: 'gov-h', kind: 'heading', children: [text('ガバナンス')] },
        { id: 'gov-1', kind: 'paragraph', children: [text(priorGov1.text)] },
        { id: 'gov-2', kind: 'paragraph', children: [text(priorGov2.text)] },
      ],
    },
    review: fy2025Review(0),
  });

  pushBlock(db, {
    ids: B.fy2025Metrics,
    projectId: IDS.projects.fy2025,
    frameworkVersionId: SSBJ_VERSION_ID,
    sectionKey: 'metrics_targets',
    title: '指標及び目標',
    sortOrder: 30,
    requirementItemIds: ssbjItemIds(['気候-47(1)']),
    dueDate: fy2025Due,
    createdAt: at(160),
    versionCreatedAt: at(92, 3),
    body: {
      paragraphs: [
        { id: 'met-h', kind: 'heading', children: [text('指標及び目標')] },
        {
          id: 'met-1',
          kind: 'paragraph',
          children: [
            text('2025年度の Scope1 温室効果ガス排出量（本社）は '),
            metricInline(db, dataPointId('HQ', 'scope1', 'FY2025'), 1),
            text(' です。'),
          ],
        },
        { id: 'met-2', kind: 'paragraph', children: [text(priorMetrics.text)] },
      ],
    },
    review: fy2025Review(1),
  });

  // --- FY2026 ---------------------------------------------------------------------
  const ssbjDecision = [IDS.decisions.fy2026Ssbj];

  // (a) ガバナンス: 根拠付き・承認済み。確認済みの定性情報（版 2）と委員会資料の段落を引用する
  pushBlock(db, {
    ids: B.fy2026Governance,
    projectId: IDS.projects.fy2026,
    frameworkVersionId: SSBJ_VERSION_ID,
    sectionKey: 'governance',
    title: 'ガバナンス',
    sortOrder: 10,
    requirementItemIds: ssbjItemIds(['気候-10', '気候-11']),
    dueDate: fy2026Due,
    createdAt: at(47),
    versionCreatedAt: at(15, 2),
    body: {
      paragraphs: [
        { id: 'gov-h', kind: 'heading', children: [text('ガバナンス')] },
        {
          id: 'gov-1',
          kind: 'paragraph',
          children: [
            narrativeInline(db, V.governanceFy2026),
            cite(A.committeeGovernance1),
            cite(A.committeeGovernance2),
          ],
        },
        {
          id: 'gov-2',
          kind: 'paragraph',
          children: [
            text(
              'また、2026年度より気候関連の目標の進捗をサステナビリティ委員会の定例議題とし、執行役員（サステナビリティ担当）が進捗を報告しています。',
            ),
            cite(A.committeeGovernance3),
          ],
        },
      ],
    },
    review: {
      requestedAt: at(14, 2),
      reviewedAt: at(12, 5),
      approvedAt: at(10, 6),
      decisionIds: ssbjDecision,
    },
  });

  // (b) リスク・機会: 下書き。財務的影響は評価中（未確定）である旨の段落を含む。
  //     E2E がこの節で依頼 → レビュー → 承認を通すため、阻害条件（未解決の要対応コメント等）は置かない
  pushBlock(db, {
    ids: B.fy2026RiskOpportunity,
    projectId: IDS.projects.fy2026,
    frameworkVersionId: SSBJ_VERSION_ID,
    sectionKey: 'risk_opportunity',
    title: 'リスク及び機会',
    sortOrder: 20,
    requirementItemIds: ssbjItemIds(['気候-19', '気候-21', '気候-22']),
    dueDate: fy2026Due,
    createdAt: at(47),
    versionCreatedAt: at(8, 3),
    body: {
      paragraphs: [
        { id: 'risk-h', kind: 'heading', children: [text('リスク及び機会')] },
        {
          id: 'risk-1',
          kind: 'paragraph',
          children: [narrativeInline(db, V.riskPhysical), cite(A.riskPhysical)],
        },
        {
          id: 'risk-2',
          kind: 'paragraph',
          children: [narrativeInline(db, V.riskTransition), cite(A.riskTransition)],
        },
        {
          id: 'risk-3',
          kind: 'paragraph',
          children: [narrativeInline(db, V.financialImpact), cite(A.financialImpact)],
        },
      ],
    },
    review: null,
  });

  // (c) 指標: 承認済み。ただし引用した Scope1（v1）には承認後に新しい版（v2）ができている
  //     （applyScope1Correction）。本文は v1 の値のまま残り、画面は「再確認が必要」を示す
  pushBlock(db, {
    ids: B.fy2026Metrics,
    projectId: IDS.projects.fy2026,
    frameworkVersionId: SSBJ_VERSION_ID,
    sectionKey: 'metrics_targets',
    title: '指標及び目標',
    sortOrder: 30,
    requirementItemIds: ssbjItemIds(['気候-47(1)']),
    dueDate: fy2026Due,
    createdAt: at(47),
    versionCreatedAt: at(31, 2),
    body: {
      paragraphs: [
        { id: 'met-h', kind: 'heading', children: [text('指標及び目標')] },
        {
          id: 'met-1',
          kind: 'paragraph',
          children: [
            text('2026年度の Scope1 温室効果ガス排出量（本社）は '),
            metricInline(db, SCOPE1_DATA_POINT_ID, 1),
            text(' です。'),
          ],
        },
        {
          id: 'met-2',
          kind: 'paragraph',
          children: [
            text(
              'Scope1 及び Scope2 の温室効果ガス排出量について、2030年度を目標年度とする削減目標を設定しています。',
            ),
          ],
        },
      ],
    },
    review: {
      requestedAt: at(30, 2),
      reviewedAt: at(29, 5),
      approvedAt: at(27, 6),
      decisionIds: ssbjDecision,
    },
  });

  // (d) ESRS-40a 準備のガバナンス: SSBJ のガバナンスと同じ定性情報の版を引用する（A20: 再利用しても
  //     承認は基準ごとに独立）。適用判断は未確定（適用候補）で、要求事項も未収録のため紐付けない
  pushBlock(db, {
    ids: B.fy2026Esrs40aGovernance,
    projectId: IDS.projects.fy2026,
    frameworkVersionId: IDS.esrs40aVersion,
    sectionKey: 'esrs40a_governance',
    title: 'ガバナンス（ESRS-40a 準備）',
    sortOrder: 110,
    requirementItemIds: [],
    dueDate: day(60),
    createdAt: at(19),
    versionCreatedAt: at(5, 3),
    body: {
      paragraphs: [
        { id: 'e40-h', kind: 'heading', children: [text('ガバナンス（ESRS-40a 準備）')] },
        {
          id: 'e40-1',
          kind: 'paragraph',
          children: [
            narrativeInline(db, V.governanceFy2026),
            cite(A.committeeGovernance1),
            cite(A.committeeGovernance2),
          ],
        },
        {
          id: 'e40-2',
          kind: 'paragraph',
          children: [
            text(
              'ESRS-40a は公開草案の段階であり、要求事項の本文は未収録です。正式版の公表後に、インパクト重要性の観点から記載範囲を見直します。',
            ),
          ],
        },
      ],
    },
    review: null,
  });

  // リスク・機会の節のコメントは「参考」1 件だけで、解決済みにしておく（レビュー依頼の阻害条件にしない）
  db.reviewComments.push({
    id: IDS.riskOpportunityComment,
    organizationId: ORG,
    blockId: B.fy2026RiskOpportunity.block,
    blockVersionId: B.fy2026RiskOpportunity.version,
    paragraphId: 'risk-1',
    body: '浸水が想定される区域であることの出典が評価資料に書かれているか確認してください。',
    severity: 'info',
    createdAt: at(7, 5),
    createdBy: REVIEWER,
    resolvedAt: at(6, 2),
    resolvedBy: AUTHOR,
    resolutionNote:
      '評価資料の第2章 2.1 に記載があることを確認しました。出典印はそのままとします。',
  });
}

// ----------------------------------------------------------------------
// KPI 目標
// ----------------------------------------------------------------------

function seedKpiTargets(db: FixtureDb): void {
  const scope1Boundary = must(
    db.dataPoints.find((d) => d.id === SCOPE1_DATA_POINT_ID),
    'HQ scope1 FY2026',
  ).boundary;

  db.kpiTargets.push(
    {
      // 実績（Data Point）と同じ境界。進捗率をそのまま計算できる
      id: IDS.kpiTargets.scope1,
      organizationId: ORG,
      targetKey: 'scope1_reduction_2030',
      versionNo: 1,
      metricId: metricId('AOMI', 'scope1'),
      boundary: scope1Boundary,
      scopeNote: '青海テクノロジー株式会社及び連結子会社（財務支配力基準）',
      baseYear: 2023,
      baseValue: 11_200,
      targetYear: 2030,
      targetValue: 7_840,
      targetType: 'absolute',
      direction: 'reduce',
      methodologyNote:
        'GHG プロトコルに基づき、連結の範囲で集計した Scope1 排出量の総量（架空の目標）。',
      ownerUserId: AUTHOR,
      revisionReason: null,
      createdAt: at(60, 3),
      createdBy: AUTHOR,
    },
    {
      // 目標を立てたときの範囲（国内拠点のみ）が実績の集計範囲（連結）と違う。
      // 進捗率を黙って出さず「比較条件の確認が必要」と示すデモに使う
      id: IDS.kpiTargets.scope2Market,
      organizationId: ORG,
      targetKey: 'scope2_market_reduction_2030',
      versionNo: 1,
      metricId: metricId('AOMI', 'scope2'),
      boundary: '単体（国内拠点）',
      scopeNote: '国内の本社・東日本工場・西日本工場（欧州販売子会社を含まない）',
      baseYear: 2023,
      baseValue: 21_500,
      targetYear: 2030,
      targetValue: 10_750,
      targetType: 'absolute',
      direction: 'reduce',
      methodologyNote: 'マーケット基準。国内拠点の購入電力等に伴う排出量（架空の目標）。',
      ownerUserId: AUTHOR,
      revisionReason: null,
      createdAt: at(60, 3),
      createdBy: AUTHOR,
    },
  );
}
