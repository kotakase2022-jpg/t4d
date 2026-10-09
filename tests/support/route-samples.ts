import type { Page } from '@playwright/test';
import { ORG_IDS } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import {
  FY2025_APPROVED_SNAPSHOT_ID,
  TRIAL_FICTIONAL_MEMBERS,
  TRIAL_XBRL_MAPPING_IDS,
} from '@/lib/fixtures/trial-case';

/**
 * 画面を開いて検査する E2E（primary 監査・到達性）が使う、ルートごとの具体的な URL（plan §5.2）。
 *
 * - key はルートのパターン（＋タブ・状態の変種）。実行ごとに変えない
 * - 詳細画面（ID を含む）は、一覧の画面から最初のリンクを辿って決める（Fixture の ID を手で書かない）
 * - owner はそのルートを所有する Stage B のスライス（plan §6.2。違反の報告に使う）
 * - タブ（?tab=）・段（?step=）・作成パネル（?new=1）を開いた状態も別の変種として開く（状態ごとに primary は 1 つ。
 *   作成パネルを開いている間は、見出しの「〜を作成」を隠し、パネルの送信が primary になる）
 */

/** UI 再設計のスライス（B1〜B6）と、トライアル対応（2026-10）のスライス（T1〜T8） */
export type SliceOwner =
  'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';

export interface RouteSample {
  key: string;
  owner: SliceOwner;
  workspace: 'enterprise' | 'assurance';
  /** 固定の URL。discover があればそちらで決める */
  url?: string;
  /**
   * 一覧の画面と、そこから辿る詳細のリンクの形。via があれば、from で via に合う最初のリンクを開き
   * （query を足して）、その画面で link を探す（原稿はプロジェクトの「原稿」タブにだけリンクがある）
   */
  discover?: {
    from: string;
    via?: { link: RegExp; query?: string };
    link: RegExp;
    suffix?: string;
  };
  /** 開示優先モードでも開く（ホーム・取込・資料。plan §5.2） */
  disclosureFirst?: true;
}

const E = '/enterprise';
const SSBJ = `${E}/disclosures/ssbj`;
const CSRD = `${E}/disclosures/csrd`;
const CDP = `${E}/disclosures/cdp`;
const UUID = '[0-9a-f-]{36}';
const PROJECT = new RegExp(`^${E}/disclosure-projects/${UUID}$`);
/** トライアル対応の画面の標本に使う Fixture の ID（架空。定数を読むだけで、UUID を手で書かない） */
const FY2025_PROJECT = `${E}/disclosure-projects/${DISCLOSURE_FIRST_IDS.projects.fy2025}`;
const FY2026_PROJECT = `${E}/disclosure-projects/${DISCLOSURE_FIRST_IDS.projects.fy2026}`;
const FICTIONAL_REVIEWER_MEMBERSHIP = fid(
  'membership',
  `${ORG_IDS.aomi}/${TRIAL_FICTIONAL_MEMBERS[1].email}`,
);

/**
 * トライアル対応（2026-10。plan §4.3-4・付録 D）の新しい画面・タブ・状態。
 * どの役割でも primary は 1 つ以下（作成・編集のパネルを開いた状態はパネルの送信が唯一の primary）
 */
const TRIAL_ENTERPRISE_SAMPLES: RouteSample[] = [
  // ---- T1 要求事項・判断・対応表
  {
    key: `${E}/disclosure-projects/[projectId]/requirements/[itemId]`,
    owner: 'T1',
    workspace: 'enterprise',
    // 40a の要求事項タブの題名のリンクから辿る
    discover: {
      from: `${FY2026_PROJECT}?tab=requirements&fw=${DISCLOSURE_FIRST_IDS.projectFrameworks.fy2026Esrs40a}`,
      link: new RegExp(`^${E}/disclosure-projects/${UUID}/requirements/${UUID}$`),
    },
  },
  ...(
    [
      'requirements&fw=all',
      'requirements&coverage=undetermined',
      'crosswalk',
      'crosswalk&ai=1',
    ] as const
  ).map((tab): RouteSample => ({
    key: `${E}/disclosure-projects/[projectId]?tab=${tab}`,
    owner: 'T1',
    workspace: 'enterprise',
    url: `${FY2026_PROJECT}?tab=${tab}`,
  })),
  // ---- T2 トレース・出力・突合
  {
    key: `${E}/disclosure-projects/[projectId]/snapshots/[snapshotId]`,
    owner: 'T2',
    workspace: 'enterprise',
    url: `${FY2025_PROJECT}/snapshots/${FY2025_APPROVED_SNAPSHOT_ID}`,
  },
  {
    key: `${E}/disclosure-projects/[projectId]/snapshots/[snapshotId]?filter=untraceable`,
    owner: 'T2',
    workspace: 'enterprise',
    url: `${FY2025_PROJECT}/snapshots/${FY2025_APPROVED_SNAPSHOT_ID}?filter=untraceable`,
  },
  {
    key: `${E}/disclosure-projects/[projectId]?tab=outputs&reconcile=1`,
    owner: 'T2',
    workspace: 'enterprise',
    url: `${FY2025_PROJECT}?tab=outputs&reconcile=1&rs=${FY2025_APPROVED_SNAPSHOT_ID}`,
  },
  // ---- T3 保証側のコメント（企業）
  {
    key: `${E}/assurance-comments`,
    owner: 'T3',
    workspace: 'enterprise',
    url: `${E}/assurance-comments`,
  },
  {
    key: `${E}/assurance-comments?state=unanswered`,
    owner: 'T3',
    workspace: 'enterprise',
    url: `${E}/assurance-comments?state=unanswered`,
  },
  // ---- T4 トライアルの評価
  ...(
    [
      '',
      '?tab=overview',
      '?tab=scenarios',
      '?tab=feedback',
      '?tab=timing',
      '?tab=roi',
      '?tab=overview&edit=1',
      '?tab=scenarios&new=1',
      '?tab=timing&new=1',
    ] as const
  ).map((suffix): RouteSample => ({
    key: `${E}/trial${suffix}`,
    owner: 'T4',
    workspace: 'enterprise',
    url: `${E}/trial${suffix}`,
  })),
  // ---- T5 監査ログ・設定の新しいタブ（設定は企業管理者だけ。他の役割は権限なしの画面）
  { key: `${E}/audit-log`, owner: 'T5', workspace: 'enterprise', url: `${E}/audit-log` },
  {
    key: `${E}/audit-log?kind=data_approved`,
    owner: 'T5',
    workspace: 'enterprise',
    url: `${E}/audit-log?kind=data_approved`,
  },
  ...[
    'approval',
    'approval&edit=new&template=three',
    'roles',
    'data-handling',
    'data-handling&new=1',
    'data-handling&confirm=tenant-export',
    `members&edit=${FICTIONAL_REVIEWER_MEMBERSHIP}`,
    `members&handover=${FICTIONAL_REVIEWER_MEMBERSHIP}`,
  ].map((tab): RouteSample => ({
    key: `${E}/settings?tab=${tab.replace(FICTIONAL_REVIEWER_MEMBERSHIP, '[membershipId]')}`,
    owner: 'T5',
    workspace: 'enterprise',
    url: `${E}/settings?tab=${tab}`,
  })),
  // ---- T6 XBRL（FY2025＝スナップショットあり、FY2026＝空の状態）
  {
    key: `${E}/disclosure-projects/[projectId]?tab=xbrl（FY2025）`,
    owner: 'T6',
    workspace: 'enterprise',
    url: `${FY2025_PROJECT}?tab=xbrl`,
  },
  {
    key: `${E}/disclosure-projects/[projectId]?tab=xbrl（FY2026・空）`,
    owner: 'T6',
    workspace: 'enterprise',
    url: `${FY2026_PROJECT}?tab=xbrl`,
  },
  {
    key: `${E}/disclosure-projects/[projectId]?tab=xbrl&new=1`,
    owner: 'T6',
    workspace: 'enterprise',
    url: `${FY2025_PROJECT}?tab=xbrl&new=1`,
  },
  {
    key: `${E}/disclosure-projects/[projectId]?tab=xbrl&edit=1&mapping=[mappingId]`,
    owner: 'T6',
    workspace: 'enterprise',
    url: `${FY2025_PROJECT}?tab=xbrl&edit=1&mapping=${TRIAL_XBRL_MAPPING_IDS.scope2Candidate}`,
  },
  // ---- T8 インパクト・リスク・機会の台帳
  {
    key: `${E}/disclosures/impacts`,
    owner: 'T8',
    workspace: 'enterprise',
    url: `${E}/disclosures/impacts`,
  },
  {
    key: `${E}/disclosures/impacts?type=impact`,
    owner: 'T8',
    workspace: 'enterprise',
    url: `${E}/disclosures/impacts?type=impact`,
  },
];

export const ENTERPRISE_SAMPLES: RouteSample[] = [
  // ---- B1 データ・取込・資料・業務キュー・ホーム
  {
    key: `${E}/dashboard`,
    owner: 'B1',
    workspace: 'enterprise',
    url: `${E}/dashboard`,
    disclosureFirst: true,
  },
  {
    key: `${E}/dashboard?tab=esg`,
    owner: 'B1',
    workspace: 'enterprise',
    url: `${E}/dashboard?tab=esg`,
    disclosureFirst: true,
  },
  { key: `${E}/workflows`, owner: 'B1', workspace: 'enterprise', url: `${E}/workflows` },
  { key: `${E}/alerts`, owner: 'B1', workspace: 'enterprise', url: `${E}/alerts` },
  { key: `${E}/data`, owner: 'B1', workspace: 'enterprise', url: `${E}/data` },
  {
    key: `${E}/data/[dataPointId]`,
    owner: 'B1',
    workspace: 'enterprise',
    discover: { from: `${E}/data`, link: new RegExp(`^${E}/data/${UUID}$`) },
  },
  {
    key: `${E}/evidence`,
    owner: 'B1',
    workspace: 'enterprise',
    url: `${E}/evidence`,
    disclosureFirst: true,
  },
  {
    key: `${E}/evidence?new=1`,
    owner: 'B1',
    workspace: 'enterprise',
    url: `${E}/evidence?new=1`,
    disclosureFirst: true,
  },
  {
    key: `${E}/evidence/[fileId]`,
    owner: 'B1',
    workspace: 'enterprise',
    discover: { from: `${E}/evidence`, link: new RegExp(`^${E}/evidence/${UUID}$`) },
  },
  {
    key: `${E}/imports`,
    owner: 'B1',
    workspace: 'enterprise',
    url: `${E}/imports`,
    disclosureFirst: true,
  },
  {
    key: `${E}/imports?job=needs_review`,
    owner: 'B1',
    workspace: 'enterprise',
    url: `${E}/imports?job=needs_review`,
  },
  {
    key: `${E}/imports/[jobId]`,
    owner: 'B1',
    workspace: 'enterprise',
    discover: { from: `${E}/imports`, link: new RegExp(`^${E}/imports/${UUID}$`) },
  },
  {
    key: `${E}/imports/standard`,
    owner: 'B1',
    workspace: 'enterprise',
    url: `${E}/imports/standard`,
  },
  // ---- B2 SSBJ・CDP・回答・その他の開示
  { key: SSBJ, owner: 'B2', workspace: 'enterprise', url: SSBJ },
  {
    key: `${SSBJ}/requirements`,
    owner: 'B2',
    workspace: 'enterprise',
    url: `${SSBJ}/requirements`,
  },
  {
    key: `${SSBJ}/requirements/[itemId]`,
    owner: 'B2',
    workspace: 'enterprise',
    discover: { from: `${SSBJ}/requirements`, link: new RegExp(`^${SSBJ}/requirements/${UUID}$`) },
  },
  { key: `${SSBJ}/plans`, owner: 'B2', workspace: 'enterprise', url: `${SSBJ}/plans` },
  {
    key: `${SSBJ}/plans?new=1`,
    owner: 'B2',
    workspace: 'enterprise',
    url: `${SSBJ}/plans?new=1`,
  },
  { key: `${SSBJ}/collection`, owner: 'B2', workspace: 'enterprise', url: `${SSBJ}/collection` },
  { key: `${SSBJ}/draft`, owner: 'B2', workspace: 'enterprise', url: `${SSBJ}/draft` },
  { key: `${SSBJ}/settings`, owner: 'B2', workspace: 'enterprise', url: `${SSBJ}/settings` },
  { key: CDP, owner: 'B2', workspace: 'enterprise', url: CDP },
  { key: `${CDP}/import`, owner: 'B2', workspace: 'enterprise', url: `${CDP}/import` },
  {
    key: `${CDP}/[questionId]`,
    owner: 'B2',
    workspace: 'enterprise',
    discover: { from: CDP, link: new RegExp(`^${CDP}/${UUID}$`) },
  },
  {
    key: `${CSRD}/[questionId]`,
    owner: 'B2',
    workspace: 'enterprise',
    discover: { from: `${CSRD}/requirements`, link: new RegExp(`^${CSRD}/requirements/${UUID}$`) },
  },
  {
    key: `${E}/disclosures/[framework]`,
    owner: 'B2',
    workspace: 'enterprise',
    url: `${E}/disclosures/msci`,
  },
  // ---- B3 CSRD
  { key: CSRD, owner: 'B3', workspace: 'enterprise', url: CSRD },
  {
    key: `${CSRD}/requirements`,
    owner: 'B3',
    workspace: 'enterprise',
    url: `${CSRD}/requirements`,
  },
  {
    key: `${CSRD}/requirements/[itemId]`,
    owner: 'B3',
    workspace: 'enterprise',
    discover: { from: `${CSRD}/requirements`, link: new RegExp(`^${CSRD}/requirements/${UUID}$`) },
  },
  { key: `${CSRD}/plans`, owner: 'B3', workspace: 'enterprise', url: `${CSRD}/plans` },
  { key: `${CSRD}/collection`, owner: 'B3', workspace: 'enterprise', url: `${CSRD}/collection` },
  {
    key: `${CSRD}/collection?new=1`,
    owner: 'B3',
    workspace: 'enterprise',
    url: `${CSRD}/collection?new=1`,
  },
  { key: `${CSRD}/draft`, owner: 'B3', workspace: 'enterprise', url: `${CSRD}/draft` },
  { key: `${CSRD}/settings`, owner: 'B3', workspace: 'enterprise', url: `${CSRD}/settings` },
  ...(['boundary', 'method'] as const).map((step): RouteSample => ({
    key: `${CSRD}/settings?step=${step}`,
    owner: 'B3',
    workspace: 'enterprise',
    url: `${CSRD}/settings?step=${step}`,
  })),
  {
    key: `${CSRD}/settings/matters/[topic]`,
    owner: 'B3',
    workspace: 'enterprise',
    url: `${CSRD}/settings/matters/E1`,
  },
  {
    key: `${CSRD}/settings/matters/[topic]?new=1`,
    owner: 'B3',
    workspace: 'enterprise',
    url: `${CSRD}/settings/matters/S1?new=1`,
  },
  // ---- B4 開示プロジェクト・原稿・定性情報
  {
    key: `${E}/disclosure-projects`,
    owner: 'B4',
    workspace: 'enterprise',
    url: `${E}/disclosure-projects`,
  },
  {
    key: `${E}/disclosure-projects/new`,
    owner: 'B4',
    workspace: 'enterprise',
    url: `${E}/disclosure-projects/new`,
  },
  {
    key: `${E}/disclosure-projects/[projectId]`,
    owner: 'B4',
    workspace: 'enterprise',
    discover: { from: `${E}/disclosure-projects`, link: PROJECT },
  },
  // プロジェクトのタブごと（タブ・状態ごとに primary は 1 つ。plan S1）
  ...(['requirements', 'manuscripts', 'reviews', 'outputs', 'settings'] as const).map(
    (tab): RouteSample => ({
      key: `${E}/disclosure-projects/[projectId]?tab=${tab}`,
      owner: 'B4',
      workspace: 'enterprise',
      discover: { from: `${E}/disclosure-projects`, link: PROJECT, suffix: `?tab=${tab}` },
    }),
  ),
  {
    key: `${E}/disclosure-projects/[projectId]?tab=manuscripts&new=1`,
    owner: 'B4',
    workspace: 'enterprise',
    discover: {
      from: `${E}/disclosure-projects`,
      link: PROJECT,
      suffix: '?tab=manuscripts&new=1',
    },
  },
  {
    key: `${E}/disclosure-projects/[projectId]/blocks/[blockId]`,
    owner: 'B4',
    workspace: 'enterprise',
    discover: {
      from: `${E}/disclosure-projects`,
      via: { link: PROJECT, query: '?tab=manuscripts' },
      link: new RegExp(`^${E}/disclosure-projects/${UUID}/blocks/${UUID}$`),
    },
  },
  {
    key: `${E}/disclosure-projects/[projectId]/blocks/[blockId]/recheck`,
    owner: 'B4',
    workspace: 'enterprise',
    discover: {
      from: `${E}/disclosure-projects`,
      via: { link: PROJECT, query: '?tab=manuscripts' },
      link: new RegExp(`^${E}/disclosure-projects/${UUID}/blocks/${UUID}$`),
      suffix: '/recheck',
    },
  },
  { key: `${E}/narratives`, owner: 'B4', workspace: 'enterprise', url: `${E}/narratives` },
  { key: `${E}/narratives/new`, owner: 'B4', workspace: 'enterprise', url: `${E}/narratives/new` },
  {
    key: `${E}/narratives/[narrativeId]`,
    owner: 'B4',
    workspace: 'enterprise',
    discover: { from: `${E}/narratives`, link: new RegExp(`^${E}/narratives/${UUID}$`) },
  },
  // ---- B5 集計・分析・ESG経営・GHG・マスター
  { key: `${E}/reports`, owner: 'B5', workspace: 'enterprise', url: `${E}/reports` },
  { key: `${E}/roadmap`, owner: 'B5', workspace: 'enterprise', url: `${E}/roadmap` },
  { key: `${E}/ai`, owner: 'B5', workspace: 'enterprise', url: `${E}/ai` },
  { key: `${E}/ghg`, owner: 'B5', workspace: 'enterprise', url: `${E}/ghg` },
  { key: `${E}/ghg/suppliers`, owner: 'B5', workspace: 'enterprise', url: `${E}/ghg/suppliers` },
  {
    key: `${E}/analysis/diagnosis`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/analysis/diagnosis`,
  },
  {
    key: `${E}/analysis/regulations`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/analysis/regulations`,
  },
  {
    key: `${E}/analysis/trends`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/analysis/trends`,
  },
  {
    key: `${E}/analysis/benchmark`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/analysis/benchmark`,
  },
  {
    key: `${E}/analysis/financial-impact`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/analysis/financial-impact`,
  },
  { key: `${E}/esg`, owner: 'B5', workspace: 'enterprise', url: `${E}/esg` },
  { key: `${E}/esg/[kpiKey]`, owner: 'B5', workspace: 'enterprise', url: `${E}/esg/scope1` },
  { key: `${E}/esg/targets`, owner: 'B5', workspace: 'enterprise', url: `${E}/esg/targets` },
  {
    key: `${E}/esg/targets?new=1`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/esg/targets?new=1`,
  },
  { key: `${E}/organizations`, owner: 'B5', workspace: 'enterprise', url: `${E}/organizations` },
  ...(['periods', 'campaigns', 'metrics', 'coverage'] as const).map((tab): RouteSample => ({
    key: `${E}/organizations?tab=${tab}`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/organizations?tab=${tab}`,
  })),
  {
    key: `${E}/organizations?tab=units&new=1`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/organizations?tab=units&new=1`,
  },
  {
    key: `${E}/organizations/metrics/new`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/organizations/metrics/new`,
  },
  {
    key: `${E}/organizations/metrics/[metricId]`,
    owner: 'B5',
    workspace: 'enterprise',
    discover: {
      from: `${E}/organizations?tab=metrics`,
      link: new RegExp(`^${E}/organizations/metrics/(?!new$)[^/?#]+$`),
    },
  },
  {
    key: `${E}/organizations/campaigns/new`,
    owner: 'B5',
    workspace: 'enterprise',
    url: `${E}/organizations/campaigns/new`,
  },
  // ---- B6 設定・共通
  { key: `${E}/settings`, owner: 'B6', workspace: 'enterprise', url: `${E}/settings` },
  ...(
    ['invitations', 'grants', 'security', 'features', 'invitations&new=1', 'grants&new=1'] as const
  ).map((tab): RouteSample => ({
    key: `${E}/settings?tab=${tab}`,
    owner: 'B6',
    workspace: 'enterprise',
    url: `${E}/settings?tab=${tab}`,
  })),
  { key: '/notifications', owner: 'B6', workspace: 'enterprise', url: '/notifications' },
  { key: '/profile', owner: 'B6', workspace: 'enterprise', url: '/profile' },
  ...TRIAL_ENTERPRISE_SAMPLES,
];

const ENG = '/assurance/engagements/[engagementId]';

export function assuranceSamples(engagementId: string): RouteSample[] {
  const page = (segment: string): RouteSample => ({
    key: `${ENG}/${segment}`,
    owner: 'B6',
    workspace: 'assurance',
    url: `/assurance/engagements/${engagementId}/${segment}`,
  });
  return [
    {
      key: '/assurance/dashboard',
      owner: 'B6',
      workspace: 'assurance',
      url: '/assurance/dashboard',
    },
    {
      key: '/assurance/engagements',
      owner: 'B6',
      workspace: 'assurance',
      url: '/assurance/engagements',
    },
    {
      key: '/assurance/engagements?new=1',
      owner: 'B6',
      workspace: 'assurance',
      url: '/assurance/engagements?new=1',
    },
    { key: '/assurance/settings', owner: 'B6', workspace: 'assurance', url: '/assurance/settings' },
    ...[
      'overview',
      'scope',
      'data-room',
      'population',
      'sampling',
      'testing',
      'requests',
      'issues',
      'review-notes',
      'signoffs',
      'audit-trail',
      'exports',
      // 作成パネル（?new=1）・チームの変更（?team=1）を開いた状態
      'requests?new=1',
      'issues?new=1',
      'review-notes?new=1',
      'sampling?new=1',
      'overview?team=1',
    ].map(page),
    // トライアル対応（T3）: 開示レポートの一覧と、共有された写しの内容（共有した後にだけある。無ければ数えない）
    { ...page('reports'), owner: 'T3' },
    {
      key: `${ENG}/reports/[copyId]`,
      owner: 'T3',
      workspace: 'assurance',
      discover: {
        from: `/assurance/engagements/${engagementId}/reports`,
        link: new RegExp(`^/assurance/engagements/${UUID}/reports/${UUID}$`),
      },
    },
    {
      key: `${ENG}/reports/[copyId]?new=1`,
      owner: 'T3',
      workspace: 'assurance',
      discover: {
        from: `/assurance/engagements/${engagementId}/reports`,
        link: new RegExp(`^/assurance/engagements/${UUID}/reports/${UUID}$`),
        suffix: '?new=1',
      },
    },
  ];
}

/** サンプルの URL を決める。詳細画面は一覧から最初のリンクを辿る（見つからなければ null） */
export async function resolveSample(page: Page, sample: RouteSample): Promise<string | null> {
  if (sample.url) return sample.url;
  if (!sample.discover) return null;
  const mainLinks = async (url: string, link: RegExp): Promise<string | undefined> => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const hrefs = await page
      .locator('#t4d-main a[href]')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
    return hrefs.map((h) => h.split(/[?#]/)[0]!).find((h) => link.test(h));
  };
  const { from, via, link, suffix } = sample.discover;
  let start = from;
  if (via) {
    const step = await mainLinks(from, via.link);
    if (!step) return null;
    start = `${step}${via.query ?? ''}`;
  }
  const found = await mainLinks(start, link);
  return found ? `${found}${suffix ?? ''}` : null;
}

/** 見えている primary・danger の数と、ボタンの名前（数字は # に。重複を除いて並べる） */
export interface EmphasisCounts {
  primary: number;
  danger: number;
  primaryLabels: string[];
  dangerLabels: string[];
}

/** main の中で見えている primary・danger（ダイアログの中は数えない。ダイアログは main の外に出る） */
export async function countVisibleEmphasis(page: Page): Promise<EmphasisCounts> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el as HTMLElement);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        !el.closest('[hidden], details:not([open]) > :not(summary), [role="dialog"]')
      );
    };
    const label = (el: Element) =>
      (el.getAttribute('aria-label') || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[0-9０-９]+/g, '#');
    const main = document.querySelector('#t4d-main');
    const pick = (selector: string) =>
      main ? [...main.querySelectorAll(selector)].filter(visible) : [];
    const primary = pick('[data-variant="primary"]');
    const danger = pick('[data-variant="danger"]');
    const names = (els: Element[]) => [...new Set(els.map(label))].sort();
    return {
      primary: primary.length,
      danger: danger.length,
      primaryLabels: names(primary),
      dangerLabels: names(danger),
    };
  });
}
