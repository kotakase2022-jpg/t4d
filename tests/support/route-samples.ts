import type { Page } from '@playwright/test';

/**
 * 画面を開いて検査する E2E（primary 監査・到達性）が使う、ルートごとの具体的な URL（plan §5.2）。
 *
 * - key はルートのパターン（＋タブ・状態の変種）。実行ごとに変えない
 * - 詳細画面（ID を含む）は、一覧の画面から最初のリンクを辿って決める（Fixture の ID を手で書かない）
 * - owner はそのルートを所有する Stage B のスライス（plan §6.2。違反の報告に使う）
 * - タブ（?tab=）・段（?step=）・作成パネル（?new=1）を開いた状態も別の変種として開く（状態ごとに primary は 1 つ。
 *   作成パネルを開いている間は、見出しの「〜を作成」を隠し、パネルの送信が primary になる）
 */

export type SliceOwner = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6';

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
