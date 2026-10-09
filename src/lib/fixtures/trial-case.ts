/**
 * トライアル対応（2026-10）の架空 Fixture（すべて架空。実在する企業・人物・数値・基準の条文ではない）。
 *
 * 主役の架空企業（青海テクノロジー）に、トライアルの実演がひとつながりで通る状態を作る。
 *  - ESRS-40a 試行用サンプル（架空・条文ではない）の版と 8 項目。FY2026 のプロジェクトはこの版に固定する（K5）
 *  - 40a の判断（適用 3・対象外 1〔承認待ち〕・未判定 1）と 3 観点の評価・履歴
 *  - 対象外の申請と承認: SSBJ の既存の対象外・非重要の判断は承認済み、うち 1 件と 40a の 1 件は申請中
 *  - 横断対応表（SSBJ ↔ 40a サンプル）6 件（sample_fixture）
 *  - 定性情報の版が説明するインパクト・リスク・機会（IRO）の参照と、IRO の根拠の引用位置
 *  - XBRL の SAMPLE（架空）タクソノミ（約 40 概念・提出用ではない）と、FY2025 の既定の対応付け・提出者の識別子（sample）
 *  - FY2025 の社内承認済みスナップショット（v2）。保証側への共有・トレース・XBRL の実演は書き込みなしで始められる
 *  - トライアルの計画・シナリオ 7 件・実施 6 件・判定 2 件・フィードバック・作業時間（架空の記録）
 *  - データ取扱条件 v1（未合意の項目を含む）・CDP オプション（青海は有効、越権テスト用の組織は無効）
 *  - ログインしない架空メンバー 2 名（役割・担当拠点の変更の実演用。Demo のログイン利用者は変更しない）
 *
 * Fixture の不変条件（Data Room・監査法人の SNAP-1・検証の件数）は変えない（数値・資料・許諾には触れない）。
 */

import { canonicalJson } from '@/lib/domain/disclosure-block';
import { REPORT_SNAPSHOT_KIND_LABELS } from '@/lib/domain/disclosure-status';
import {
  computeSnapshotContentHash,
  namesMentionedIn,
  snapshotApprovalOf,
  snapshotBlockOf,
  snapshotFrameworkOf,
  snapshotMetricValueOf,
  snapshotRequirementStateOf,
  snapshotRequirementsOf,
  ssbjRequirementDigest,
  type SnapshotBlock,
  type SnapshotMetricValue,
} from '@/lib/domain/report-snapshot-content';
import { exclusionReasonDigest } from '@/lib/domain/exclusion-digest';
import { exclusionReasonExcerpt } from '@/lib/domain/requirement-coverage';
import { CSRD_IDS } from './csrd';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, at, dataPointId, day, metricId, userId } from './dataset';
import { DISCLOSURE_FIRST_IDS } from './disclosure-first';
import { fid } from './ids';
import type { FixtureDb } from './store';
import {
  ESRS_40A_SAMPLE_VERSION_ID,
  XBRL_SAMPLE_PACKAGE_ID,
  esrs40aSampleItemId,
  xbrlSampleConceptId,
} from './trial-ids';
import type {
  AnswerType,
  DataPointVersion,
  ExclusionDecision,
  IsoDateTime,
  ProjectRequirementAssessment,
  ReportSnapshot,
  SsbjCoverageStatus,
  TrialCompletion,
  TrialTaskKey,
  TrialTimingMode,
  Uuid,
  XbrlConceptKind,
  XbrlPeriodType,
  XbrlTagMapping,
} from '@/types/domain';

// ----------------------------------------------------------------------
// 登場人物（dataset.ts の DEMO_USERS と、ログインしない架空メンバー）
// ----------------------------------------------------------------------

const ORG = ORG_IDS.aomi;
const AUTHOR = userId('sustainability@demo.local');
const REVIEWER = userId('reviewer@demo.local');
const APPROVER = userId('approver@demo.local');
const ADMIN = userId('enterprise-admin@demo.local');
const SITE = userId('site-user@demo.local');

const IDS = DISCLOSURE_FIRST_IDS;
const SSBJ_VERSION_ID = fid('framework_version', 'ssbj/2026');

function ssbjItemId(code: string): Uuid {
  return fid('disclosure_item', `ssbj/2026/${code}`);
}

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(`Fixture inconsistency: ${message}`);
  return value;
}

/** ログインしない架空メンバー（役割・担当拠点の変更・引継ぎの実演用。Demo のログイン利用者は変更しない） */
export const TRIAL_FICTIONAL_MEMBERS = [
  {
    email: 'trial-member-west@fictional.invalid',
    displayName: '西川 蒼',
    jobTitle: '西日本工場 環境管理課',
    roleKeys: ['site_contributor'] as const,
    unitScopeIds: [UNIT_IDS.west],
  },
  {
    email: 'trial-member-reviewer@fictional.invalid',
    displayName: '北原 灯',
    jobTitle: '経営企画部 レビュー担当',
    roleKeys: ['reviewer'] as const,
    unitScopeIds: [] as string[],
  },
] as const;

export function trialMemberUserId(email: string): Uuid {
  return fid('user', email);
}

// ----------------------------------------------------------------------
// ESRS-40a 試行用サンプル（架空・条文ではない）
// ----------------------------------------------------------------------

/** 試行用サンプルの項目の説明。公開草案の条文・要約ではないことを全項目に書く */
export const ESRS_40A_SAMPLE_GUIDANCE =
  '架空の試行用項目です。ESRS-40a 公開草案の条文・要約ではありません（トライアルの操作確認用）。';

export const ESRS_40A_SAMPLE_ITEMS: ReadonlyArray<{
  code: string;
  section: string;
  title: string;
  answerType: AnswerType;
}> = [
  {
    code: '40A-S01',
    section: 'ガバナンス（サンプル）',
    title: '（サンプル）サステナビリティに関するガバナンスの体制',
    answerType: 'text',
  },
  {
    code: '40A-S02',
    section: 'インパクト・リスク・機会の管理（サンプル）',
    title: '（サンプル）インパクトを特定・評価する手順',
    answerType: 'text',
  },
  {
    code: '40A-S03',
    section: 'インパクト・リスク・機会の管理（サンプル）',
    title: '（サンプル）重要なインパクトとその説明',
    answerType: 'text',
  },
  {
    code: '40A-S04',
    section: '環境（サンプル）',
    title: '（サンプル）気候変動の緩和に関する方針と取組',
    answerType: 'text',
  },
  {
    code: '40A-S05',
    section: '環境（サンプル）',
    title: '（サンプル）温室効果ガス排出量（総量）',
    answerType: 'numeric',
  },
  {
    code: '40A-S06',
    section: '環境（サンプル）',
    title: '（サンプル）水資源の利用',
    answerType: 'numeric',
  },
  {
    code: '40A-S07',
    section: '社会（サンプル）',
    title: '（サンプル）自社の従業員の労働条件',
    answerType: 'text',
  },
  {
    code: '40A-S08',
    section: '社会（サンプル）',
    title: '（サンプル）バリューチェーンの労働者への影響',
    answerType: 'text',
  },
];

function seedEsrs40aSample(db: FixtureDb): void {
  db.frameworkVersions.push({
    id: ESRS_40A_SAMPLE_VERSION_ID,
    frameworkId: IDS.esrs40aFramework,
    // 公開草案の版（2026）より古い年にして、プロジェクト設定で公開草案を「新しい版」として並べる
    year: 2025,
    label: 'ESRS-40a 試行用サンプル（架空・条文ではない）',
    status: 'draft',
    isFixture: true,
    createdAt: at(21),
    versionCode: 'esrs-40a-trial-sample',
    legalStatus: 'sample',
    issuedAt: null,
    effectiveAt: null,
    jurisdiction: null,
    materialityBasis: 'impact',
    sourceUrl: null,
    verifiedAt: null,
    verifiedBy: null,
    coverageStatus: 'sample',
    coverageNote: '架空の試行用項目 8 件（ESRS-40a 公開草案の条文・要約ではありません）',
  });
  ESRS_40A_SAMPLE_ITEMS.forEach((spec, index) => {
    db.disclosureItems.push({
      id: esrs40aSampleItemId(spec.code),
      frameworkVersionId: ESRS_40A_SAMPLE_VERSION_ID,
      code: spec.code,
      section: spec.section,
      sortOrder: index,
      questionText: spec.title,
      guidance: ESRS_40A_SAMPLE_GUIDANCE,
      answerType: spec.answerType,
      options: [],
      required: false,
      parentCode: null,
      changeType: 'new',
      previousItemCode: null,
      createdAt: at(21),
    });
  });
}

// ----------------------------------------------------------------------
// 架空メンバー
// ----------------------------------------------------------------------

function seedFictionalMembers(db: FixtureDb): void {
  for (const spec of TRIAL_FICTIONAL_MEMBERS) {
    const uid = trialMemberUserId(spec.email);
    db.profiles.push({
      id: uid,
      email: spec.email,
      displayName: spec.displayName,
      jobTitle: spec.jobTitle,
      locale: 'ja',
      timezone: 'Asia/Tokyo',
      createdAt: at(40),
    });
    const membershipId = fid('membership', `${ORG}/${spec.email}`);
    db.memberships.push({
      id: membershipId,
      organizationId: ORG,
      userId: uid,
      status: 'active',
      unitScopeIds: [...spec.unitScopeIds],
      invitedBy: ADMIN,
      joinedAt: at(38),
      createdAt: at(40),
      updatedAt: at(38),
      createdBy: ADMIN,
      updatedBy: ADMIN,
    });
    for (const roleKey of spec.roleKeys) {
      db.membershipRoles.push({ membershipId, roleKey, grantedAt: at(38), grantedBy: ADMIN });
    }
  }
}

// ----------------------------------------------------------------------
// 40a の判断と対象外の申請・承認
// ----------------------------------------------------------------------

interface JudgementSpec {
  code: string;
  applicability: ProjectRequirementAssessment['applicability'];
  reason: string;
  coverage: [SsbjCoverageStatus, SsbjCoverageStatus, SsbjCoverageStatus] | null;
  missing: string;
  actionNote: string;
  dueOffset: number;
  decidedAt: IsoDateTime;
}

const JUDGEMENTS: readonly JudgementSpec[] = [
  {
    code: '40A-S01',
    applicability: 'applicable',
    reason: '（架空）ガバナンスの体制は全社共通のため、適用と判断。',
    coverage: ['covered', 'mostly_covered', 'covered'],
    missing: '',
    actionNote: 'SSBJ のガバナンスの定性情報を共通本文として再利用する（架空）。',
    dueOffset: 30,
    decidedAt: at(4, 2),
  },
  {
    code: '40A-S04',
    applicability: 'applicable',
    reason: '（架空）気候変動の緩和は重要なインパクトと判断。',
    coverage: ['partial', 'mostly_covered', 'partial'],
    missing: '移行計画の数値目標と進捗の説明（架空）',
    actionNote: '移行計画の数値目標を経営企画部に確認する（架空）。',
    dueOffset: 40,
    decidedAt: at(4, 3),
  },
  {
    code: '40A-S05',
    applicability: 'applicable',
    reason: '（架空）温室効果ガス排出量は全社で算定済みのため、適用と判断。',
    coverage: ['covered', 'covered', 'mostly_covered'],
    missing: '',
    actionNote: '',
    dueOffset: 30,
    decidedAt: at(4, 4),
  },
  {
    code: '40A-S06',
    applicability: 'not_applicable',
    reason:
      '（架空）当社の事業所は水ストレスの高い地域に無く、水資源の利用は重要なインパクトではないと判断。',
    coverage: null,
    missing: '',
    actionNote: '',
    dueOffset: 30,
    decidedAt: at(4, 5),
  },
  {
    code: '40A-S08',
    applicability: 'not_assessed',
    reason: '',
    coverage: null,
    missing: 'バリューチェーンの労働者への影響の調査結果（架空）',
    actionNote: '調達部に取引先の調査の予定を確認する（架空）。',
    dueOffset: 45,
    decidedAt: at(4, 6),
  },
];

export const TRIAL_ASSESSMENT_IDS = Object.fromEntries(
  JUDGEMENTS.map((j) => [
    j.code,
    fid('project_requirement_assessment', `${IDS.projectFrameworks.fy2026Esrs40a}/${j.code}`),
  ]),
) as Record<string, Uuid>;

function seedRequirementJudgements(db: FixtureDb): void {
  for (const spec of JUDGEMENTS) {
    const id = must(TRIAL_ASSESSMENT_IDS[spec.code], spec.code);
    const decided = spec.applicability !== 'not_assessed';
    const row: ProjectRequirementAssessment = {
      id,
      organizationId: ORG,
      projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
      itemId: esrs40aSampleItemId(spec.code),
      applicability: spec.applicability,
      applicabilityReason: spec.reason,
      ruleRef: decided ? `（サンプル）${spec.code}` : '',
      disclosureCoverage: spec.coverage?.[0] ?? null,
      dataCoverage: spec.coverage?.[1] ?? null,
      processCoverage: spec.coverage?.[2] ?? null,
      missingInformation: spec.missing,
      ownerUserId: AUTHOR,
      dueOn: day(spec.dueOffset),
      actionNote: spec.actionNote,
      decidedBy: decided ? AUTHOR : null,
      decidedAt: decided ? spec.decidedAt : null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: spec.decidedAt,
      updatedAt: spec.decidedAt,
      createdBy: AUTHOR,
      updatedBy: AUTHOR,
    };
    db.projectRequirementAssessments.push(row);
    db.projectRequirementAssessmentEvents.push({
      id: fid('project_requirement_assessment_event', `${id}/1`),
      organizationId: ORG,
      assessmentId: id,
      projectFrameworkId: row.projectFrameworkId,
      itemId: row.itemId,
      before: null,
      after: {
        applicability: row.applicability,
        applicabilityReason: row.applicabilityReason,
        disclosureCoverage: row.disclosureCoverage,
        dataCoverage: row.dataCoverage,
        processCoverage: row.processCoverage,
      },
      reason: '初回の判断（架空）',
      actorUserId: AUTHOR,
      createdAt: spec.decidedAt,
    });
  }
}

/** 対象外の申請・承認の記録の ID（テスト・E2E からも同じ値で引けるように公開する） */
export function exclusionEventId(key: string): Uuid {
  return fid('requirement_exclusion_event', key);
}

function seedExclusionEvents(db: FixtureDb): void {
  // 40a: 対象外（S06）を申請中（承認は最終承認者が行う）
  const s06 = must(
    JUDGEMENTS.find((j) => j.code === '40A-S06'),
    '40A-S06 judgement',
  );
  db.requirementExclusionEvents.push({
    id: exclusionEventId('esrs40a/40A-S06/requested'),
    organizationId: ORG,
    frameworkVersionId: ESRS_40A_SAMPLE_VERSION_ID,
    itemId: esrs40aSampleItemId('40A-S06'),
    reportingPeriodId: PERIOD_IDS.fy2026,
    projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
    source: 'project_assessment',
    event: 'requested',
    decision: 'not_applicable',
    reasonDigest: exclusionReasonDigest('not_applicable', s06.reason),
    reasonExcerpt: exclusionReasonExcerpt(s06.reason),
    note: '',
    actorUserId: AUTHOR,
    createdAt: at(3, 2),
  });

  // SSBJ: 既存の対象外・非重要の判断（理由付き）は承認済み。最初の 1 件だけ申請中のまま
  const excluded = db.ssbjAssessments
    .filter(
      (a) =>
        a.organizationId === ORG &&
        a.reportingPeriodId === PERIOD_IDS.fy2026 &&
        ((a.applicability === 'not_applicable' && a.applicabilityReason.trim() !== '') ||
          (a.applicability !== 'not_applicable' &&
            a.materiality === 'not_material' &&
            a.materialityReason.trim() !== '')),
    )
    .sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  excluded.forEach((assessment, index) => {
    const decision: ExclusionDecision =
      assessment.applicability === 'not_applicable' ? 'not_applicable' : 'not_material';
    const reason =
      decision === 'not_applicable' ? assessment.applicabilityReason : assessment.materialityReason;
    const base = {
      organizationId: ORG,
      frameworkVersionId: SSBJ_VERSION_ID,
      itemId: assessment.itemId,
      reportingPeriodId: PERIOD_IDS.fy2026,
      projectFrameworkId: null,
      source: 'ssbj_assessment' as const,
      decision,
      reasonDigest: exclusionReasonDigest(decision, reason),
      reasonExcerpt: exclusionReasonExcerpt(reason),
      note: '',
    };
    db.requirementExclusionEvents.push({
      ...base,
      id: exclusionEventId(`ssbj/${assessment.itemId}/requested`),
      event: 'requested',
      actorUserId: AUTHOR,
      createdAt: at(39, 2, index),
    });
    if (index === 0) return;
    db.requirementExclusionEvents.push({
      ...base,
      id: exclusionEventId(`ssbj/${assessment.itemId}/approved`),
      event: 'approved',
      actorUserId: APPROVER,
      createdAt: at(38, 5, index),
    });
  });
}

/** 申請中のまま残す SSBJ の対象外（Fixture の並びで最初の 1 件） */
export function pendingSsbjExclusionItemId(db: FixtureDb): Uuid | null {
  return (
    db.requirementExclusionEvents
      .filter((e) => e.source === 'ssbj_assessment')
      .find(
        (e) =>
          e.event === 'requested' &&
          !db.requirementExclusionEvents.some(
            (o) => o.itemId === e.itemId && o.event === 'approved',
          ),
      )?.itemId ?? null
  );
}

// ----------------------------------------------------------------------
// 横断対応表（SSBJ ↔ 40a サンプル。架空の整理）
// ----------------------------------------------------------------------

const CROSSWALKS: ReadonlyArray<{
  from: string;
  to: string | null;
  relation: 'equivalent' | 'partial' | 'related' | 'no_counterpart';
  rationale: string;
}> = [
  {
    from: '気候-10',
    to: '40A-S01',
    relation: 'partial',
    rationale:
      '（架空の整理）取締役会の監督の体制は共通。サンプルの 40a 側はインパクトの監督も含む想定のため一部対応。',
  },
  {
    from: '気候-11',
    to: '40A-S01',
    relation: 'related',
    rationale: '（架空の整理）経営者の役割はガバナンスの体制の説明に関連する。',
  },
  {
    from: '気候-19',
    to: '40A-S03',
    relation: 'partial',
    rationale:
      '（架空の整理）SSBJ は企業への影響（財務的影響を含む）、40a は人・環境へのインパクトを扱うため一部対応。',
  },
  {
    from: '気候-22',
    to: '40A-S04',
    relation: 'related',
    rationale: '（架空の整理）移行計画の説明は緩和の方針と取組に関連する。',
  },
  {
    from: '気候-47(1)',
    to: '40A-S05',
    relation: 'equivalent',
    rationale: '（架空の整理）温室効果ガス排出量（総量）は同じ数値を開示する想定。',
  },
  {
    from: '気候-21',
    to: null,
    relation: 'no_counterpart',
    rationale: '（架空の整理）サンプルの 40a 側に対応する項目が無い。',
  },
];

function seedCrosswalks(db: FixtureDb): void {
  for (const spec of CROSSWALKS) {
    db.requirementCrosswalks.push({
      id: fid('requirement_crosswalk', `ssbj/2026/${spec.from}->${spec.to ?? 'none'}`),
      fromItemId: ssbjItemId(spec.from),
      toFrameworkVersionId: ESRS_40A_SAMPLE_VERSION_ID,
      toItemId: spec.to ? esrs40aSampleItemId(spec.to) : null,
      relation: spec.relation,
      rationale: spec.rationale,
      source: 'sample_fixture',
      sourceRef: 'トライアル用の架空の整理（公表資料に基づくものではありません）',
      verifiedAt: null,
      verifiedBy: null,
      createdAt: at(21),
    });
  }
}

// ----------------------------------------------------------------------
// 定性情報が説明する IRO・IRO の根拠
// ----------------------------------------------------------------------

function linkNarrativeIros(db: FixtureDb): void {
  const e1 = CSRD_IDS.iros.E1;
  for (const versionId of [
    IDS.narrativeVersions.riskPhysical,
    IDS.narrativeVersions.riskTransition,
  ]) {
    const version = must(
      db.narrativeVersions.find((v) => v.id === versionId),
      `narrative version ${versionId}`,
    );
    version.iroRefs = [e1.financial];
  }
  const iro = must(
    db.csrdDmaIros.find((i) => i.id === e1.financial),
    'CSRD E1 financial IRO',
  );
  iro.sourceAnchorIds = [IDS.anchors.riskPhysical, IDS.anchors.riskTransition];
  iro.policyActionNote =
    '（架空）浸水想定区域の拠点に止水板を設置し、炭素価格の上昇に備えて省エネ投資を前倒しする。';
}

// ----------------------------------------------------------------------
// XBRL の SAMPLE（架空）タクソノミ
// ----------------------------------------------------------------------

export const XBRL_SAMPLE_NAMESPACE = 'urn:t4d:sample-taxonomy:2026';
export const XBRL_SAMPLE_PREFIX = 't4ds';

interface ConceptSpec {
  localName: string;
  kind: XbrlConceptKind;
  dataType: string;
  periodType: XbrlPeriodType | null;
  label: string;
  labelEn: string;
  parent: string | null;
  balance?: 'debit' | 'credit';
  reference?: string;
}

const DECIMAL = 'xbrli:decimalItemType';
const INTEGER = 'xbrli:integerItemType';
const PERCENT = 'num:percentItemType';
const MONETARY = 'xbrli:monetaryItemType';
const TEXT_BLOCK = 'nonnum:textBlockItemType';
const DOMAIN = 'nonnum:domainItemType';

/** SAMPLE の概念（架空。公式タクソノミの要素名ではない。ラベルは「（サンプル）」で始める） */
export const XBRL_SAMPLE_CONCEPTS: readonly ConceptSpec[] = [
  {
    localName: 'SampleSustainabilityDisclosureAbstract',
    kind: 'abstract',
    dataType: '',
    periodType: null,
    label: '（サンプル）サステナビリティ開示',
    labelEn: '(Sample) Sustainability disclosure',
    parent: null,
  },
  {
    localName: 'SampleGovernanceAbstract',
    kind: 'abstract',
    dataType: '',
    periodType: null,
    label: '（サンプル）ガバナンス',
    labelEn: '(Sample) Governance',
    parent: 'SampleSustainabilityDisclosureAbstract',
  },
  {
    localName: 'SampleStrategyAbstract',
    kind: 'abstract',
    dataType: '',
    periodType: null,
    label: '（サンプル）戦略',
    labelEn: '(Sample) Strategy',
    parent: 'SampleSustainabilityDisclosureAbstract',
  },
  {
    localName: 'SampleRiskManagementAbstract',
    kind: 'abstract',
    dataType: '',
    periodType: null,
    label: '（サンプル）リスク管理',
    labelEn: '(Sample) Risk management',
    parent: 'SampleSustainabilityDisclosureAbstract',
  },
  {
    localName: 'SampleMetricsAndTargetsAbstract',
    kind: 'abstract',
    dataType: '',
    periodType: null,
    label: '（サンプル）指標及び目標',
    labelEn: '(Sample) Metrics and targets',
    parent: 'SampleSustainabilityDisclosureAbstract',
  },
  {
    localName: 'SampleGovernanceTextBlock',
    kind: 'text_block',
    dataType: TEXT_BLOCK,
    periodType: 'duration',
    label: '（サンプル）ガバナンス［テキストブロック］',
    labelEn: '(Sample) Governance [text block]',
    parent: 'SampleGovernanceAbstract',
    reference: '気候-10',
  },
  {
    localName: 'SampleStrategyTextBlock',
    kind: 'text_block',
    dataType: TEXT_BLOCK,
    periodType: 'duration',
    label: '（サンプル）戦略［テキストブロック］',
    labelEn: '(Sample) Strategy [text block]',
    parent: 'SampleStrategyAbstract',
  },
  {
    localName: 'SampleClimateRisksAndOpportunitiesTextBlock',
    kind: 'text_block',
    dataType: TEXT_BLOCK,
    periodType: 'duration',
    label: '（サンプル）気候関連のリスク及び機会［テキストブロック］',
    labelEn: '(Sample) Climate-related risks and opportunities [text block]',
    parent: 'SampleStrategyAbstract',
    reference: '気候-19',
  },
  {
    localName: 'SampleTransitionPlanTextBlock',
    kind: 'text_block',
    dataType: TEXT_BLOCK,
    periodType: 'duration',
    label: '（サンプル）移行計画［テキストブロック］',
    labelEn: '(Sample) Transition plan [text block]',
    parent: 'SampleStrategyAbstract',
    reference: '気候-22',
  },
  {
    localName: 'SampleRiskManagementTextBlock',
    kind: 'text_block',
    dataType: TEXT_BLOCK,
    periodType: 'duration',
    label: '（サンプル）リスク管理［テキストブロック］',
    labelEn: '(Sample) Risk management [text block]',
    parent: 'SampleRiskManagementAbstract',
  },
  {
    localName: 'SampleMetricsAndTargetsTextBlock',
    kind: 'text_block',
    dataType: TEXT_BLOCK,
    periodType: 'duration',
    label: '（サンプル）指標及び目標［テキストブロック］',
    labelEn: '(Sample) Metrics and targets [text block]',
    parent: 'SampleMetricsAndTargetsAbstract',
    reference: '気候-47(1)',
  },
  {
    localName: 'SampleScope1GhgEmissions',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）スコープ1 温室効果ガス排出量',
    labelEn: '(Sample) Scope 1 GHG emissions',
    parent: 'SampleMetricsAndTargetsAbstract',
    reference: '気候-47(1)',
  },
  {
    localName: 'SampleScope2GhgEmissionsLocationBased',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）スコープ2 温室効果ガス排出量（ロケーション基準）',
    labelEn: '(Sample) Scope 2 GHG emissions (location-based)',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleScope2GhgEmissionsMarketBased',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）スコープ2 温室効果ガス排出量（マーケット基準）',
    labelEn: '(Sample) Scope 2 GHG emissions (market-based)',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleScope3GhgEmissions',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）スコープ3 温室効果ガス排出量',
    labelEn: '(Sample) Scope 3 GHG emissions',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleScope3Category1GhgEmissions',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）スコープ3 カテゴリ1 温室効果ガス排出量',
    labelEn: '(Sample) Scope 3 category 1 GHG emissions',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleTotalGhgEmissions',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）温室効果ガス排出量の合計',
    labelEn: '(Sample) Total GHG emissions',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleGhgEmissionsIntensity',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）温室効果ガス排出量の原単位',
    labelEn: '(Sample) GHG emissions intensity',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleEnergyConsumption',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）エネルギー消費量',
    labelEn: '(Sample) Energy consumption',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleRenewableEnergyRatio',
    kind: 'item',
    dataType: PERCENT,
    periodType: 'duration',
    label: '（サンプル）再生可能エネルギーの比率',
    labelEn: '(Sample) Renewable energy ratio',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleWaterWithdrawal',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）取水量',
    labelEn: '(Sample) Water withdrawal',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleWasteGenerated',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）廃棄物の発生量',
    labelEn: '(Sample) Waste generated',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleNumberOfEmployees',
    kind: 'item',
    dataType: INTEGER,
    periodType: 'instant',
    label: '（サンプル）従業員数',
    labelEn: '(Sample) Number of employees',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleFemaleManagerRatio',
    kind: 'item',
    dataType: PERCENT,
    periodType: 'instant',
    label: '（サンプル）女性管理職比率',
    labelEn: '(Sample) Ratio of female managers',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleGenderPayGap',
    kind: 'item',
    dataType: PERCENT,
    periodType: 'duration',
    label: '（サンプル）男女の賃金の差異',
    labelEn: '(Sample) Gender pay gap',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleTrainingHoursPerEmployee',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）従業員 1 人あたりの研修時間',
    labelEn: '(Sample) Training hours per employee',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleLostTimeInjuryFrequencyRate',
    kind: 'item',
    dataType: DECIMAL,
    periodType: 'duration',
    label: '（サンプル）休業災害度数率',
    labelEn: '(Sample) Lost time injury frequency rate',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleClimateRelatedCapitalExpenditure',
    kind: 'item',
    dataType: MONETARY,
    periodType: 'duration',
    label: '（サンプル）気候関連の設備投資額',
    labelEn: '(Sample) Climate-related capital expenditure',
    parent: 'SampleMetricsAndTargetsAbstract',
    balance: 'debit',
  },
  {
    localName: 'SampleInternalCarbonPrice',
    kind: 'item',
    dataType: MONETARY,
    periodType: 'duration',
    label: '（サンプル）社内炭素価格',
    labelEn: '(Sample) Internal carbon price',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleGhgReductionTargetPercentage',
    kind: 'item',
    dataType: PERCENT,
    periodType: 'duration',
    label: '（サンプル）温室効果ガス排出量の削減目標（%）',
    labelEn: '(Sample) GHG reduction target (%)',
    parent: 'SampleMetricsAndTargetsAbstract',
  },
  {
    localName: 'SampleConsolidationAxis',
    kind: 'axis',
    dataType: '',
    periodType: null,
    label: '（サンプル）連結の範囲［軸］',
    labelEn: '(Sample) Consolidation [axis]',
    parent: null,
  },
  {
    localName: 'SampleConsolidatedMember',
    kind: 'member',
    dataType: DOMAIN,
    periodType: null,
    label: '（サンプル）連結［メンバー］',
    labelEn: '(Sample) Consolidated [member]',
    parent: 'SampleConsolidationAxis',
  },
  {
    localName: 'SampleParentCompanyOnlyMember',
    kind: 'member',
    dataType: DOMAIN,
    periodType: null,
    label: '（サンプル）単体［メンバー］',
    labelEn: '(Sample) Parent company only [member]',
    parent: 'SampleConsolidationAxis',
  },
  {
    localName: 'SampleGhgBoundaryAxis',
    kind: 'axis',
    dataType: '',
    periodType: null,
    label: '（サンプル）GHG の集計範囲［軸］',
    labelEn: '(Sample) GHG boundary [axis]',
    parent: null,
  },
  {
    localName: 'SampleFinancialControlMember',
    kind: 'member',
    dataType: DOMAIN,
    periodType: null,
    label: '（サンプル）財務支配力基準［メンバー］',
    labelEn: '(Sample) Financial control [member]',
    parent: 'SampleGhgBoundaryAxis',
  },
  {
    localName: 'SampleOperationalControlMember',
    kind: 'member',
    dataType: DOMAIN,
    periodType: null,
    label: '（サンプル）経営支配力基準［メンバー］',
    labelEn: '(Sample) Operational control [member]',
    parent: 'SampleGhgBoundaryAxis',
  },
  {
    localName: 'SampleScope3CategoryAxis',
    kind: 'axis',
    dataType: '',
    periodType: null,
    label: '（サンプル）スコープ3 のカテゴリ［軸］',
    labelEn: '(Sample) Scope 3 category [axis]',
    parent: null,
  },
  {
    localName: 'SampleScope3Category1Member',
    kind: 'member',
    dataType: DOMAIN,
    periodType: null,
    label: '（サンプル）カテゴリ1［メンバー］',
    labelEn: '(Sample) Category 1 [member]',
    parent: 'SampleScope3CategoryAxis',
  },
];

function seedXbrlSample(db: FixtureDb): void {
  db.xbrlTaxonomyPackages.push({
    id: XBRL_SAMPLE_PACKAGE_ID,
    key: 'sample-ssbj-2026',
    frameworkKey: 'ssbj',
    profile: 'sample',
    name: '（サンプル）サステナビリティ開示の試行用タクソノミ',
    versionLabel: 'SAMPLE 2026（架空）',
    publisher: 'T4D（架空のサンプル）',
    legalStatus: 'sample',
    namespaceUri: XBRL_SAMPLE_NAMESPACE,
    prefix: XBRL_SAMPLE_PREFIX,
    entryPoint: '',
    sourceUrl: null,
    publishedOn: null,
    verifiedAt: null,
    licenseStatus: 'not_required',
    licenseNote: '架空の概念のみ。公式タクソノミ（EDINET・ISSB）は含みません。',
    filingReady: false,
    isFixture: true,
    createdAt: at(21),
  });
  XBRL_SAMPLE_CONCEPTS.forEach((spec, index) => {
    db.xbrlConcepts.push({
      id: xbrlSampleConceptId(spec.localName),
      packageId: XBRL_SAMPLE_PACKAGE_ID,
      prefix: XBRL_SAMPLE_PREFIX,
      localName: spec.localName,
      namespaceUri: XBRL_SAMPLE_NAMESPACE,
      kind: spec.kind,
      dataType: spec.dataType,
      periodType: spec.periodType,
      balance: spec.balance ?? null,
      labelJa: spec.label,
      labelEn: spec.labelEn,
      conceptReferences: spec.reference
        ? [
            {
              name: '（サンプル）架空の参照',
              locator: `SSBJ ${spec.reference} に対応する想定（架空）`,
            },
          ]
        : [],
      parentId: spec.parent ? xbrlSampleConceptId(spec.parent) : null,
      roleCode: spec.kind === 'axis' || spec.kind === 'member' ? 'dimension' : 'disclosure',
      sortOrder: index,
      supersedesConceptId: null,
      deprecated: false,
      createdAt: at(21),
    });
    if (spec.reference) {
      db.xbrlConceptRequirements.push({
        id: fid('xbrl_concept_requirement', `sample-ssbj-2026/${spec.localName}/${spec.reference}`),
        conceptId: xbrlSampleConceptId(spec.localName),
        disclosureItemId: ssbjItemId(spec.reference),
        basis: 'sample_fixture',
        note: '架空の参照（トライアルの構造確認用）',
        createdAt: at(21),
      });
    }
  });
  db.organizationFilingIdentifiers.push({
    id: fid('organization_filing_identifier', `${ORG}/sample`),
    organizationId: ORG,
    scheme: 'sample',
    value: 'SAMPLE-AOMI-0001',
    verifiedAt: null,
    verifiedBy: null,
    createdAt: at(21),
    updatedAt: at(21),
    createdBy: ADMIN,
    updatedBy: ADMIN,
  });
}

export const TRIAL_XBRL_MAPPING_IDS = {
  scope1: fid('xbrl_tag_mapping', `${ORG}/FY2025/scope1`),
  governance: fid('xbrl_tag_mapping', `${ORG}/FY2025/governance`),
  metricsTargets: fid('xbrl_tag_mapping', `${ORG}/FY2025/metrics_targets`),
  scope2Candidate: fid('xbrl_tag_mapping', `${ORG}/FY2025/scope2`),
} as const;

function seedXbrlMappings(db: FixtureDb): void {
  const scope1Dp = must(
    db.dataPoints.find((d) => d.id === dataPointId('HQ', 'scope1', 'FY2025')),
    'HQ scope1 FY2025',
  );
  const scope2Dp = must(
    db.dataPoints.find((d) => d.id === dataPointId('HQ', 'scope2', 'FY2025')),
    'HQ scope2 FY2025',
  );
  const createdAt = at(66, 2);
  const confirmedAt = at(65, 4);
  const base = {
    organizationId: ORG,
    projectId: IDS.projects.fy2025,
    packageId: XBRL_SAMPLE_PACKAGE_ID,
    frameworkVersionId: SSBJ_VERSION_ID,
    periodRole: 'current' as const,
    scale: 0,
    excludedReason: '',
    origin: 'fixture' as const,
    aiRunId: null,
    deletedAt: null,
    createdAt,
    createdBy: AUTHOR,
  };
  const confirmed = {
    status: 'confirmed' as const,
    confirmedBy: APPROVER,
    confirmedAt,
    updatedAt: confirmedAt,
    updatedBy: APPROVER,
  };
  const rows: XbrlTagMapping[] = [
    {
      ...base,
      ...confirmed,
      id: TRIAL_XBRL_MAPPING_IDS.scope1,
      conceptId: xbrlSampleConceptId('SampleScope1GhgEmissions'),
      targetKind: 'metric',
      metricId: scope1Dp.metricId,
      unitId: scope1Dp.unitId,
      boundary: scope1Dp.boundary,
      sectionKey: null,
      disclosureItemId: ssbjItemId('気候-47(1)'),
      dimensions: { SampleGhgBoundaryAxis: 'SampleFinancialControlMember' },
      decimals: 0,
    },
    {
      ...base,
      ...confirmed,
      id: TRIAL_XBRL_MAPPING_IDS.governance,
      conceptId: xbrlSampleConceptId('SampleGovernanceTextBlock'),
      targetKind: 'block',
      metricId: null,
      unitId: null,
      boundary: null,
      sectionKey: 'governance',
      disclosureItemId: ssbjItemId('気候-10'),
      dimensions: {},
      decimals: null,
    },
    {
      ...base,
      ...confirmed,
      id: TRIAL_XBRL_MAPPING_IDS.metricsTargets,
      conceptId: xbrlSampleConceptId('SampleMetricsAndTargetsTextBlock'),
      targetKind: 'block',
      metricId: null,
      unitId: null,
      boundary: null,
      sectionKey: 'metrics_targets',
      disclosureItemId: ssbjItemId('気候-47(1)'),
      dimensions: {},
      decimals: null,
    },
    {
      // 候補のまま（確定は承認権限を持つ別の人が行う）
      ...base,
      id: TRIAL_XBRL_MAPPING_IDS.scope2Candidate,
      conceptId: xbrlSampleConceptId('SampleScope2GhgEmissionsMarketBased'),
      targetKind: 'metric',
      metricId: scope2Dp.metricId,
      unitId: scope2Dp.unitId,
      boundary: scope2Dp.boundary,
      sectionKey: null,
      disclosureItemId: null,
      dimensions: { SampleGhgBoundaryAxis: 'SampleFinancialControlMember' },
      decimals: 0,
      status: 'candidate',
      confirmedBy: null,
      confirmedAt: null,
      updatedAt: createdAt,
      updatedBy: AUTHOR,
    },
  ];
  for (const row of rows) {
    db.xbrlTagMappings.push(row);
    db.xbrlTagMappingEvents.push({
      id: fid('xbrl_tag_mapping_event', `${row.id}/created`),
      organizationId: ORG,
      mappingId: row.id,
      event: 'created',
      before: null,
      after: { conceptId: row.conceptId, targetKind: row.targetKind, status: 'candidate' },
      reason: '既定の対応付け（架空のサンプル）',
      actorUserId: AUTHOR,
      createdAt,
    });
    if (row.status === 'confirmed') {
      db.xbrlTagMappingEvents.push({
        id: fid('xbrl_tag_mapping_event', `${row.id}/confirmed`),
        organizationId: ORG,
        mappingId: row.id,
        event: 'confirmed',
        before: { status: 'candidate' },
        after: { status: 'confirmed' },
        reason: '',
        actorUserId: APPROVER,
        createdAt: confirmedAt,
      });
    }
  }
}

// ----------------------------------------------------------------------
// FY2025 の社内承認済みスナップショット（v2）
// ----------------------------------------------------------------------

export const FY2025_APPROVED_SNAPSHOT_ID: Uuid = fid('report_snapshot', 'AOMI/FY2025/approved/1');
const FY2025_SNAPSHOT_AT = at(70, 9);

function seedFy2025ApprovedSnapshot(db: FixtureDb): void {
  const project = must(
    db.disclosureProjects.find((p) => p.id === IDS.projects.fy2025),
    'FY2025 project',
  );
  const pf = must(
    db.projectFrameworks.find((p) => p.id === IDS.projectFrameworks.fy2025Ssbj),
    'FY2025 SSBJ project framework',
  );
  const version = must(
    db.frameworkVersions.find((v) => v.id === pf.frameworkVersionId),
    'SSBJ version',
  );
  const framework = must(
    db.frameworks.find((f) => f.id === version.frameworkId),
    'SSBJ framework',
  );
  const items = db.disclosureItems.filter((i) => i.frameworkVersionId === version.id);
  const requirementState = snapshotRequirementStateOf({
    assessmentEvents: db.projectRequirementAssessmentEvents.filter(
      (e) => e.projectFrameworkId === pf.id,
    ),
    exclusionEvents: db.requirementExclusionEvents.filter(
      (e) =>
        e.organizationId === ORG &&
        e.reportingPeriodId === project.reportingPeriodId &&
        e.frameworkVersionId === version.id &&
        (e.projectFrameworkId === null || e.projectFrameworkId === pf.id),
    ),
    assessmentDigest: ssbjRequirementDigest(
      items.map((i) => i.id),
      db.ssbjAssessments.filter(
        (a) => a.organizationId === ORG && a.reportingPeriodId === project.reportingPeriodId,
      ),
    ),
    asOf: FY2025_SNAPSHOT_AT,
  });
  const frameworks = [snapshotFrameworkOf(pf, version, framework, project, { requirementState })];

  const itemById = new Map(db.disclosureItems.map((i) => [i.id, i]));
  const nonPublicNames = [
    ...new Set(
      db.files
        .filter((f) => f.organizationId === ORG && f.confidentiality !== 'public')
        .map((f) => f.originalName.trim())
        .filter((n) => n.length >= 3),
    ),
  ].sort();
  const blocks: SnapshotBlock[] = db.disclosureBlocks
    .filter((b) => b.projectId === project.id && b.deletedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
    .map((block) => {
      const blockVersion = must(
        db.disclosureBlockVersions.find((v) => v.id === block.approvedVersionId),
        `approved version of ${block.sectionKey}`,
      );
      return snapshotBlockOf(
        block,
        blockVersion,
        {
          status: block.status,
          approvedVersionId: block.approvedVersionId,
          isApprovedVersion: true,
          requirements: snapshotRequirementsOf(block.requirementItemIds, itemById),
          issues: [],
          internalComments: [],
          maskedFileNames: namesMentionedIn(blockVersion.body, nonPublicNames),
        },
        {
          approval: snapshotApprovalOf(
            block.id,
            blockVersion.id,
            db.reviewRequests.filter((r) => r.organizationId === ORG),
            db.reviewEvents.filter((e) => e.organizationId === ORG),
            project.scopeRevision ?? 0,
          ),
        },
      );
    });

  const versionIds = new Set<Uuid>();
  for (const block of blocks) {
    for (const paragraph of block.body.paragraphs) {
      for (const inline of paragraph.children) {
        if (inline.t === 'metric') versionIds.add(inline.dataPointVersionId);
      }
    }
  }
  const metricValues: SnapshotMetricValue[] = [...versionIds]
    .map((id) =>
      must(
        db.dataPointVersions.find((v) => v.id === id),
        `dp version ${id}`,
      ),
    )
    .map((v: DataPointVersion) => {
      const dp = must(
        db.dataPoints.find((d) => d.id === v.dataPointId),
        `data point ${v.dataPointId}`,
      );
      const approved =
        v.status === 'approved' ||
        (dp.status === 'approved' && dp.currentVersionId === v.id) ||
        db.approvals.some(
          (a) =>
            a.targetType === 'data_point' &&
            a.targetId === dp.id &&
            a.targetVersionId === v.id &&
            a.decision === 'approved',
        );
      if (!approved) throw new Error('Fixture inconsistency: FY2025 cited value must be approved');
      return snapshotMetricValueOf(
        v,
        dp,
        {
          metric: db.metrics.find((m) => m.id === dp.metricId),
          unit: db.units.find((u) => u.id === dp.unitId),
          period: db.periods.find((p) => p.id === dp.reportingPeriodId),
        },
        { status: 'approved', versionApproved: true },
        {
          evidenceFileVersionIds: db.evidenceLinks
            .filter((l) => l.targetType === 'data_point' && l.targetId === dp.id)
            .map((l) => l.fileVersionId),
        },
      );
    })
    .sort((a, b) =>
      canonicalJson([a.metricCode, a.unitName, a.periodCode, a.versionNo]) <
      canonicalJson([b.metricCode, b.unitName, b.periodCode, b.versionNo])
        ? -1
        : 1,
    );

  const policyVersions = [
    ...new Set(
      db.reviewRequests
        .filter((r) => r.status === 'approved' && blocks.some((b) => b.blockId === r.targetId))
        .map((r) => r.policyVersion),
    ),
  ].sort();

  const content = {
    projectId: project.id,
    snapshotKind: 'approved' as const,
    label: REPORT_SNAPSHOT_KIND_LABELS.approved,
    frameworkVersions: frameworks,
    decisionIds: frameworks.flatMap((f) => (f.decisionId ? [f.decisionId] : [])),
    blocks,
    metricValues,
    narrativeVersionIds: [],
    anchors: [],
    policyVersion: policyVersions.length > 0 ? policyVersions.join(',') : null,
  };
  const snapshot: ReportSnapshot = {
    id: FY2025_APPROVED_SNAPSHOT_ID,
    organizationId: ORG,
    snapshotNo: 1,
    ...content,
    contentHash: computeSnapshotContentHash(content),
    createdAt: FY2025_SNAPSHOT_AT,
    createdBy: APPROVER,
  };
  db.reportSnapshots.push(snapshot);
}

// ----------------------------------------------------------------------
// トライアルの評価（架空の記録）
// ----------------------------------------------------------------------

export const TRIAL_PROGRAM_ID: Uuid = fid('trial_program', `${ORG}/2026`);

export function trialScenarioId(code: string): Uuid {
  return fid('trial_scenario', `${ORG}/${code}`);
}

const SCENARIOS: ReadonlyArray<{
  code: string;
  theme:
    | 'traceability'
    | 'gap_distinction'
    | 'approval_change'
    | 'output_reuse'
    | 'usability'
    | 'work_time'
    | 'operations';
  title: string;
  steps: string;
  targetRole: string;
  criterion: string;
}> = [
  {
    code: 'TS-01',
    theme: 'traceability',
    title: '出力した原稿の本文・数値から要求事項・根拠・承認版へ遡る',
    steps: '出力の記録 → 内容とトレース → 段落を選ぶ → 承認者と根拠を確かめる',
    targetRole: '作成担当',
    criterion: '選定ケースの追跡率 100%',
  },
  {
    code: 'TS-02',
    theme: 'gap_distinction',
    title: '対象外と未対応を区別し、理由・担当・期限を確かめる',
    steps: '要求事項 → 区分で絞り込む → 対象外の理由と承認者、未対応の担当と期限を見る',
    targetRole: '作成担当',
    criterion: '対象外は理由・承認者、未対応は担当・期限が見える',
  },
  {
    code: 'TS-03',
    theme: 'approval_change',
    title: '差戻し→修正→再承認を行い、承認後の変更の影響先を確かめる',
    steps: 'レビューで差し戻す → 修正して再依頼 → 承認 → 数値を訂正して影響先を見る',
    targetRole: '最終承認者',
    criterion: '承認後の変更で影響先が一覧に出る',
  },
  {
    code: 'TS-04',
    theme: 'output_reuse',
    title: '承認版から原稿・対応表を出力し、承認済みの本文・数値と突合する',
    steps: '出力 → 突合の結果を見る',
    targetRole: '作成担当',
    criterion: '対象値・本文の不一致 0 件',
  },
  {
    code: 'TS-05',
    theme: 'usability',
    title: '担当者が主要タスクを自力で完了する',
    steps: '自分の作業 → 担当の節を更新 → レビューを依頼する',
    targetRole: '作成担当・レビュー担当',
    criterion: '自力で完了した割合（目安。件数を併記）',
  },
  {
    code: 'TS-06',
    theme: 'work_time',
    title: '転記・確認の作業時間を現行と比べる',
    steps: '同じ作業を現行の方法と T4D で行い、作業時間を記録する',
    targetRole: '作成担当',
    criterion: '対象作業の 20〜30% 短縮（目標。結果とは分けて示す）',
  },
  {
    code: 'TS-07',
    theme: 'operations',
    title: 'バックアップからの復旧手順を確かめる（運用）',
    steps: '手順書に沿って別の環境へ復旧し、件数を照合する',
    targetRole: '管理者',
    criterion: '手順書どおりに復旧でき、件数が一致する',
  },
];

const RUNS: ReadonlyArray<{
  code: string;
  by: Uuid;
  role: string;
  completion: TrialCompletion;
  minutes: number;
  help: number;
  ease: number;
  comment: string;
  daysAgo: number;
}> = [
  {
    code: 'TS-01',
    by: AUTHOR,
    role: '作成担当',
    completion: 'self',
    minutes: 25,
    help: 0,
    ease: 4,
    comment: '（架空）段落から承認者まで迷わず辿れた。',
    daysAgo: 9,
  },
  {
    code: 'TS-02',
    by: AUTHOR,
    role: '作成担当',
    completion: 'with_help',
    minutes: 40,
    help: 1,
    ease: 3,
    comment: '（架空）区分の絞り込みの場所を一度質問した。',
    daysAgo: 8,
  },
  {
    code: 'TS-04',
    by: AUTHOR,
    role: '作成担当',
    completion: 'self',
    minutes: 15,
    help: 0,
    ease: 4,
    comment: '（架空）不一致 0 件を確認した。',
    daysAgo: 7,
  },
  {
    code: 'TS-05',
    by: REVIEWER,
    role: 'レビュー担当',
    completion: 'self',
    minutes: 20,
    help: 0,
    ease: 5,
    comment: '（架空）自分の作業から迷わず開けた。',
    daysAgo: 6,
  },
  {
    code: 'TS-05',
    by: SITE,
    role: '拠点の入力担当',
    completion: 'not_completed',
    minutes: 30,
    help: 2,
    ease: 2,
    comment: '（架空）担当外の節を開こうとして止まった。',
    daysAgo: 6,
  },
  {
    code: 'TS-03',
    by: APPROVER,
    role: '最終承認者',
    completion: 'self',
    minutes: 18,
    help: 0,
    ease: 4,
    comment: '（架空）影響先の一覧で再確認の節が分かった。',
    daysAgo: 5,
  },
];

function seedTrial(db: FixtureDb): void {
  db.trialPrograms.push({
    id: TRIAL_PROGRAM_ID,
    organizationId: ORG,
    name: '試行導入（架空）',
    startsOn: day(-30),
    endsOn: day(150),
    phase: 'started',
    projectId: IDS.projects.fy2026,
    includedUnitIds: [UNIT_IDS.hq, UNIT_IDS.east, UNIT_IDS.west],
    targetDataNote: '（架空）本社と国内 2 拠点の FY2026 のデータ（定量 10 指標・定性 10 ブロック）',
    selectedRequirementItemIds: [
      ssbjItemId('気候-10'),
      ssbjItemId('気候-11'),
      ssbjItemId('気候-19'),
      ssbjItemId('気候-47(1)'),
      esrs40aSampleItemId('40A-S01'),
      esrs40aSampleItemId('40A-S05'),
    ],
    selectedMetricIds: [
      'scope1',
      'scope2',
      'scope3_cat1',
      'energy',
      'water',
      'waste',
      'employees',
      'female_manager_ratio',
      'training_hours',
      'ltifr',
    ].map((code) => metricId('AOMI', code)),
    plannedMembers: 10,
    plannedSites: 3,
    plannedQuantitativeMetrics: 10,
    plannedNarrativeBlocks: 10,
    plannedRequirements: 30,
    plannedFiscalYears: 1,
    plannedFiles: 30,
    plannedApprovalLevels: 3,
    options: {},
    agreements: {
      scope: { agreedOn: day(-35), note: '（架空）対象範囲は本社と国内 2 拠点で合意。' },
      decider: { agreedOn: null, note: '（架空）対象外の最終判断者は調整中。' },
      schedule: { agreedOn: day(-35), note: '（架空）定例会は隔週で開催。' },
    },
    endDisposition: 'undecided',
    endAgreedOn: null,
    decision: 'undecided',
    decisionConditions: '',
    decidedByLabel: '',
    createdAt: at(36),
    updatedAt: at(30),
    createdBy: ADMIN,
    updatedBy: ADMIN,
  });

  SCENARIOS.forEach((spec, index) => {
    db.trialScenarios.push({
      id: trialScenarioId(spec.code),
      organizationId: ORG,
      theme: spec.theme,
      code: spec.code,
      title: spec.title,
      steps: spec.steps,
      targetRole: spec.targetRole,
      acceptanceCriterion: spec.criterion,
      sortOrder: index,
      deletedAt: null,
      createdAt: at(30),
      updatedAt: at(30),
      createdBy: ADMIN,
      updatedBy: ADMIN,
    });
  });

  RUNS.forEach((spec, index) => {
    const endedAt = at(spec.daysAgo, 6, index);
    db.trialScenarioRuns.push({
      id: fid('trial_scenario_run', `${ORG}/${spec.code}/${index + 1}`),
      organizationId: ORG,
      scenarioId: trialScenarioId(spec.code),
      performedBy: spec.by,
      performedRole: spec.role,
      startedAt: new Date(Date.parse(endedAt) - spec.minutes * 60_000).toISOString(),
      endedAt,
      minutes: spec.minutes,
      completion: spec.completion,
      helpCount: spec.help,
      easeRating: spec.ease,
      comment: spec.comment,
      evidence: {},
      environmentVersion: 'fixture',
      supersedesRunId: null,
      createdAt: endedAt,
    });
  });

  db.trialScenarioJudgements.push(
    {
      id: fid('trial_scenario_judgement', `${ORG}/TS-01/1`),
      organizationId: ORG,
      scenarioId: trialScenarioId('TS-01'),
      judgement: 'pass',
      reason: '（架空）選定ケース 6 件のうち、確認した段落・数値はすべて承認版と根拠へ遡れた。',
      measuredValue: '確認した 6 件中 6 件',
      judgedBy: ADMIN,
      judgedAt: at(4, 7),
    },
    {
      id: fid('trial_scenario_judgement', `${ORG}/TS-04/1`),
      organizationId: ORG,
      scenarioId: trialScenarioId('TS-04'),
      judgement: 'hold',
      reason: '（架空）外部で編集したファイルの照合が未実施のため保留。',
      measuredValue: '',
      judgedBy: ADMIN,
      judgedAt: at(4, 8),
    },
  );

  const feedback: ReadonlyArray<{
    key: string;
    kind: 'defect' | 'request' | 'question' | 'positive' | 'other';
    channel: 'in_app' | 'meeting' | 'email' | 'phone' | 'other';
    title: string;
    body: string;
    route: string;
    severity: 'critical' | 'major' | 'minor' | null;
    mandatory: boolean;
    status: 'open' | 'triaged' | 'in_progress' | 'resolved' | 'wont_fix' | 'verified';
    policy: string;
    cost: 'maintenance' | 'separate_estimate' | 'undecided';
    owner: string;
    due: number | null;
    resolvedIn: string;
    by: Uuid;
    daysAgo: number;
  }> = [
    {
      key: 'FB-01',
      kind: 'defect',
      channel: 'meeting',
      title: '（架空）保証側へ共有したレポートの数値が古い版を示しているように見える',
      body: '（架空）定例会で指摘。共有した写しと最新の承認版の違いが分かりにくい。',
      route: '/assurance/engagements/[engagementId]/reports',
      severity: 'critical',
      mandatory: true,
      status: 'open',
      policy: '',
      cost: 'undecided',
      owner: '',
      due: 14,
      resolvedIn: '',
      by: ADMIN,
      daysAgo: 6,
    },
    {
      key: 'FB-02',
      kind: 'defect',
      channel: 'in_app',
      title: '（架空）対応表の出力で列名が分かりにくい',
      body: '（架空）「出所」の列が何を指すのか分からない。',
      route: '/enterprise/disclosure-projects/[projectId]',
      severity: 'major',
      mandatory: false,
      status: 'triaged',
      policy: '（架空）列名に補足を付ける方向で検討。',
      cost: 'maintenance',
      owner: '開発担当（架空）',
      due: 21,
      resolvedIn: '',
      by: AUTHOR,
      daysAgo: 7,
    },
    {
      key: 'FB-03',
      kind: 'request',
      channel: 'in_app',
      title: '（架空）要求事項の担当を一括で付け替えたい',
      body: '（架空）異動のときに担当をまとめて変えたい。',
      route: '/enterprise/disclosure-projects/[projectId]',
      severity: null,
      mandatory: false,
      status: 'triaged',
      policy: '（架空）引継ぎ一覧で対応し、一括の付け替えは別途見積とする。',
      cost: 'separate_estimate',
      owner: '開発担当（架空）',
      due: null,
      resolvedIn: '',
      by: AUTHOR,
      daysAgo: 8,
    },
    {
      key: 'FB-04',
      kind: 'positive',
      channel: 'in_app',
      title: '（架空）根拠資料と本文を並べて確認できるのが良い',
      body: '',
      route: '/enterprise/disclosure-projects/[projectId]/blocks/[blockId]',
      severity: null,
      mandatory: false,
      status: 'resolved',
      policy: '',
      cost: 'undecided',
      owner: '',
      due: null,
      resolvedIn: '',
      by: REVIEWER,
      daysAgo: 6,
    },
    {
      key: 'FB-05',
      kind: 'question',
      channel: 'email',
      title: '（架空）承認後に数値を直したときの影響範囲はどこで分かるか',
      body: '',
      route: '/enterprise/data/[dataPointId]',
      severity: null,
      mandatory: false,
      status: 'resolved',
      policy: '（架空）データの詳細の「この数値を使っている原稿・レポート」で確認できると回答。',
      cost: 'maintenance',
      owner: '開発担当（架空）',
      due: null,
      resolvedIn: 'fixture',
      by: APPROVER,
      daysAgo: 5,
    },
  ];
  for (const spec of feedback) {
    const createdAt = at(spec.daysAgo, 3);
    db.trialFeedbackItems.push({
      id: fid('trial_feedback_item', `${ORG}/${spec.key}`),
      organizationId: ORG,
      kind: spec.kind,
      channel: spec.channel,
      title: spec.title,
      body: spec.body,
      routePattern: spec.route,
      scenarioId: null,
      severity: spec.severity,
      mandatoryRequirement: spec.mandatory,
      status: spec.status,
      responsePolicy: spec.policy,
      costClass: spec.cost,
      ownerLabel: spec.owner,
      dueOn: spec.due === null ? null : day(spec.due),
      resolvedInVersion: spec.resolvedIn,
      verificationResult: '',
      verifiedBy: null,
      verifiedAt: null,
      agreed: false,
      environmentVersion: 'fixture',
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
      createdBy: spec.by,
      updatedBy: spec.by,
    });
  }

  // 作業時間: 転記は現行・T4D とも 3 件（短縮率を出せる件数）、確認・突合は T4D が 1 件（件数不足の例）
  const timings: ReadonlyArray<[TrialTaskKey, TrialTimingMode, number, number]> = [
    ['transcription', 'baseline', 120, 20],
    ['transcription', 'baseline', 110, 19],
    ['transcription', 'baseline', 130, 18],
    ['transcription', 't4d', 85, 9],
    ['transcription', 't4d', 90, 8],
    ['transcription', 't4d', 80, 7],
    ['check_reconcile', 'baseline', 60, 20],
    ['check_reconcile', 'baseline', 70, 19],
    ['check_reconcile', 't4d', 40, 7],
  ];
  timings.forEach(([taskKey, mode, minutes, daysAgo], index) => {
    db.trialTaskTimings.push({
      id: fid('trial_task_timing', `${ORG}/${taskKey}/${mode}/${index + 1}`),
      organizationId: ORG,
      taskKey,
      mode,
      unitLabel: taskKey === 'transcription' ? '節' : '表',
      quantity: 1,
      minutes,
      method: mode === 'baseline' ? 'self_report' : 'observed',
      department: 'サステナビリティ推進部',
      measuredOn: day(-daysAgo),
      scenarioRunId: null,
      supersedesId: null,
      note: '（架空）',
      recordedBy: AUTHOR,
      createdAt: at(daysAgo, 8),
    });
  });
}

// ----------------------------------------------------------------------
// データ取扱条件・オプション
// ----------------------------------------------------------------------

function seedDataTermsAndOptions(db: FixtureDb): void {
  // 合意済みの項目と未合意の項目が混ざった版（推測で埋めない。空・undecided は「未合意」と表示する）
  db.organizationDataTerms.push({
    id: fid('organization_data_terms', `${ORG}/1`),
    organizationId: ORG,
    versionNo: 1,
    ndaStatus: 'signed',
    processingTermsRef: '（架空）データ処理条件 草案 v0.1',
    storageLocation: '',
    retentionPolicy: '',
    aiTrainingUse: 'not_allowed',
    aiProviderStorage: 'undecided',
    subprocessors: [],
    returnMethod: '',
    deletionMethod: '',
    agreedOn: null,
    agreedByLabel: '',
    note: '（架空）トライアル開始前の確認中の版。',
    createdBy: ADMIN,
    createdAt: at(20),
  });
  db.organizationOptions.push(
    {
      id: fid('organization_option', `${ORG}/cdp`),
      organizationId: ORG,
      optionKey: 'cdp',
      enabled: true,
      contractRef: '（架空）CDP 対応オプション',
      validFrom: day(-30),
      validTo: null,
      note: '',
      setAt: at(30),
      setByLabel: '運営（架空）',
    },
    {
      id: fid('organization_option', `${ORG_IDS.soten}/cdp`),
      organizationId: ORG_IDS.soten,
      optionKey: 'cdp',
      enabled: false,
      contractRef: '',
      validFrom: null,
      validTo: null,
      note: '越権テスト用の組織（CDP オプションなし）',
      setAt: at(30),
      setByLabel: '運営（架空）',
    },
  );
}

// ======================================================================
// 入口（store.ts が最後に呼ぶ）
// ======================================================================

export function seedTrialCase(db: FixtureDb): void {
  seedEsrs40aSample(db);
  seedFictionalMembers(db);
  seedRequirementJudgements(db);
  seedExclusionEvents(db);
  seedCrosswalks(db);
  linkNarrativeIros(db);
  seedXbrlSample(db);
  seedXbrlMappings(db);
  seedFy2025ApprovedSnapshot(db);
  seedTrial(db);
  seedDataTermsAndOptions(db);
}
