import {
  ROUTE_CATALOG,
  canOpenRoute,
  resolveRouteHref,
  type RouteCatalogEntry,
} from '@/components/shared/route-catalog';
import type { PermissionKey } from '@/types/domain';
import type { Can, HomeProfile } from './home-profile';
import {
  RECOMMENDATIONS,
  availableTaskVerbs,
  resolveTaskVerb,
  taskVerb,
  type TaskVerbContext,
} from './task-verbs';

/**
 * Command Palette の候補（plan §1.10）。React 非依存の純関数で、クライアントの部品と単体テストが
 * 同じ関数を使う。
 *
 * グループの順: 最近使った画面 → おすすめ（空のクエリのときだけ）→ 操作 → 画面 → 設定の項目 → データ。
 * 実行はしない: 操作（動詞）もその画面へ移るだけで、承認・確定・リセットは移った先で人が押す。
 */

export const PALETTE_GROUPS = [
  'recent',
  'recommended',
  'actions',
  'screens',
  'settings',
  'data',
] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export const PALETTE_GROUP_LABELS: Record<PaletteGroup, string> = {
  recent: '最近使った画面',
  recommended: 'おすすめ',
  actions: '操作',
  screens: '画面',
  settings: '設定の項目',
  data: 'データ',
};

export interface PaletteEntry {
  /** グループ内で一意 */
  id: string;
  group: PaletteGroup;
  label: string;
  href: string;
  /** 右に出す短い補足（種類・経路など） */
  hint?: string;
  keywords?: readonly string[];
}

/** メニューの葉の経路（「開示対応 / SSBJ / 要求事項」）。描画中のツリーから作ったものを渡す */
export interface NavPathEntry {
  href: string;
  label: string;
  keywords?: readonly string[];
}

export interface PaletteContext {
  workspace: 'enterprise' | 'assurance';
  can: Can;
  /** 企業のみ */
  profile?: HomeProfile;
  verbContext: TaskVerbContext;
  /** 監査法人で案件を選んでいるとき */
  engagementId?: string | null;
  /** 描画中のメニューの全項目（経路ラベル）。メニューにある画面はこの経路で出す */
  navPaths: readonly NavPathEntry[];
}

// ----------------------------------------------------------------------
// 設定の項目（設定画面の節・組織・拠点のタブ）
// ----------------------------------------------------------------------

interface SettingsItem {
  label: string;
  href: string;
  /** 項目の権限（どれか 1 つ）。加えて行き先の画面のゲートも満たす必要がある */
  permission?: readonly PermissionKey[];
  keywords?: readonly string[];
}

/**
 * タブのキー（?tab=）は Stage B5（組織・拠点）・B6（設定）が NavTabs で実装する。キーが無い段階でも
 * 画面は開け、該当の節が見える（未知の ?tab= は無視される）
 */
const ENTERPRISE_SETTINGS_ITEMS: readonly SettingsItem[] = [
  {
    label: '設定 / 機能設定',
    href: '/enterprise/settings?tab=features',
    permission: ['enterprise.org.manage'],
    keywords: ['開示優先モード', '機能'],
  },
  {
    label: '設定 / メンバー',
    href: '/enterprise/settings?tab=members',
    permission: ['enterprise.member.manage'],
    keywords: ['利用者', 'ユーザー', '役割'],
  },
  {
    label: '設定 / 招待',
    href: '/enterprise/settings?tab=invitations',
    permission: ['enterprise.member.manage'],
    keywords: ['招待', 'メール'],
  },
  {
    label: '設定 / セキュリティ',
    href: '/enterprise/settings?tab=security',
    permission: ['enterprise.org.manage'],
    keywords: ['MFA', '多要素認証', 'パスワード'],
  },
  {
    label: '設定 / アクセス許諾',
    href: '/enterprise/settings?tab=grants',
    permission: ['enterprise.grant.manage'],
    keywords: ['許諾', 'Grant', '監査法人'],
  },
  {
    label: '組織・拠点 / 組織・拠点',
    href: '/enterprise/organizations?tab=units',
    keywords: ['組織', '拠点', '連結', '子会社'],
  },
  {
    label: '組織・拠点 / 報告年度',
    href: '/enterprise/organizations?tab=periods',
    keywords: ['報告年度', '期間', '提出期限'],
  },
  {
    label: '組織・拠点 / 収集キャンペーン',
    href: '/enterprise/organizations?tab=campaigns',
    keywords: ['キャンペーン', '収集', '依頼'],
  },
  {
    label: '組織・拠点 / 指標マスター',
    href: '/enterprise/organizations?tab=metrics',
    keywords: ['指標', 'マスター', 'KPI', '単位'],
  },
  {
    label: '組織・拠点 / 基準別の充足',
    href: '/enterprise/organizations?tab=coverage',
    keywords: ['基準', '充足', 'SSBJ', 'CSRD', 'CDP'],
  },
  // CSRD 設定は段階 UI（?step=）。メニューに無い画面のため、段ごとに設定の項目として引けるようにする（plan S11）
  {
    label: 'CSRD 設定 / ① 報告範囲',
    href: '/enterprise/disclosures/csrd/settings?step=boundary',
    keywords: ['CSRD', '報告範囲', '連結', 'バリューチェーン'],
  },
  {
    label: 'CSRD 設定 / ② 評価方法・閾値',
    href: '/enterprise/disclosures/csrd/settings?step=method',
    keywords: ['CSRD', '評価方法', '閾値', '算定式', 'DMA'],
  },
  {
    label: 'CSRD 設定 / ③ DMA の判断と確定',
    href: '/enterprise/disclosures/csrd/settings?step=dma',
    keywords: ['CSRD', 'DMA', 'ダブル・マテリアリティ', '確定', '重要性'],
  },
];

const ASSURANCE_SETTINGS_ITEMS: readonly SettingsItem[] = [
  {
    label: '設定 / 法人メンバー',
    href: '/assurance/settings',
    permission: ['assurance.firm.manage'],
    keywords: ['メンバー', '法人', '利用者'],
  },
];

/**
 * 監査法人の「操作」（plan §1.10。B6 の作成の入口）。企業のタスク動詞と同じく、作成欄を開いた画面へ
 * 移るだけで、起票・送付は移った先で人が押す。案件の中の操作は、案件を選んでいるときだけ出す
 */
interface AssuranceAction {
  id: string;
  label: string;
  hint: string;
  permission: PermissionKey;
  /** 案件の画面の中の操作（href は案件の URL からの相対。engagementId が無ければ出さない） */
  inEngagement?: true;
  href: string;
  keywords: readonly string[];
}

const ASSURANCE_ACTIONS: readonly AssuranceAction[] = [
  {
    id: 'create-engagement',
    label: '保証契約を起票する',
    hint: '保証契約',
    permission: 'assurance.engagement.manage',
    href: '/assurance/engagements?new=1',
    keywords: ['起票', '案件', '保証契約', 'Engagement'],
  },
  {
    id: 'create-pbc',
    label: '資料依頼を作成する',
    hint: 'PBC／資料依頼',
    permission: 'assurance.pbc.manage',
    inEngagement: true,
    href: 'requests?new=1',
    keywords: ['PBC', '資料依頼', '依頼', '送付'],
  },
  {
    id: 'create-issue',
    label: '指摘を起票する',
    hint: '指摘・例外',
    permission: 'assurance.issue.manage',
    inEngagement: true,
    href: 'issues?new=1',
    keywords: ['指摘', '例外', '起票'],
  },
  {
    id: 'create-review-note',
    label: 'レビューNote を追加する',
    hint: 'レビューNote',
    permission: 'assurance.review.write',
    inEngagement: true,
    href: 'review-notes?new=1',
    keywords: ['レビュー', 'ノート', 'Note'],
  },
  {
    id: 'run-sampling',
    label: 'サンプルを抽出する',
    hint: 'サンプリング',
    permission: 'assurance.sampling.run',
    inEngagement: true,
    href: 'sampling?new=1',
    keywords: ['サンプル', '抽出', 'サンプリング'],
  },
  {
    id: 'change-team',
    label: '案件チームを変更する',
    hint: '案件の概要',
    permission: 'assurance.engagement.manage',
    inEngagement: true,
    href: 'overview?team=1',
    keywords: ['チーム', 'メンバー', 'アサイン'],
  },
];

function assuranceActions(c: PaletteContext): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const action of ASSURANCE_ACTIONS) {
    if (!c.can(action.permission)) continue;
    let href = action.href;
    if (action.inEngagement) {
      // 案件の画面は案件の閲覧が要る（ページのゲートと同じ）。案件を選んでいないときは出さない
      if (!c.engagementId || !c.can('assurance.engagement.read')) continue;
      href = `/assurance/engagements/${encodeURIComponent(c.engagementId)}/${action.href}`;
    }
    out.push({
      id: `action:${action.id}`,
      group: 'actions',
      label: action.label,
      href,
      hint: action.hint,
      keywords: action.keywords,
    });
  }
  return out;
}

function pathnameOf(href: string): string {
  return href.split(/[?#]/)[0] ?? href;
}

function routeGate(href: string): RouteCatalogEntry | undefined {
  const path = pathnameOf(href);
  return ROUTE_CATALOG.find((entry) => entry.href === path);
}

// ----------------------------------------------------------------------
// 組み立て
// ----------------------------------------------------------------------

export function buildPaletteEntries(c: PaletteContext): {
  recommended: PaletteEntry[];
  actions: PaletteEntry[];
  screens: PaletteEntry[];
  settings: PaletteEntry[];
} {
  const navLabelByHref = new Map<string, NavPathEntry>();
  for (const nav of c.navPaths) {
    if (!navLabelByHref.has(nav.href)) navLabelByHref.set(nav.href, nav);
  }

  // 画面: メニューの葉＋メニュー外の画面（固定の行き先を持つものだけ）。href で重複を除く
  const screens: PaletteEntry[] = [];
  const seen = new Set<string>();
  for (const entry of ROUTE_CATALOG) {
    if (entry.entryOnly) continue;
    if (entry.workspace !== c.workspace && entry.workspace !== 'common') continue;
    if (!canOpenRoute(entry, c.can)) continue;
    const href = resolveRouteHref(entry, c.engagementId ?? null);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const nav = navLabelByHref.get(href);
    screens.push({
      id: `screen:${href}`,
      group: 'screens',
      label: nav?.label ?? entry.path.join(' / '),
      href,
      hint: nav ? undefined : 'メニュー外の画面',
      keywords: [entry.label, ...(entry.keywords ?? []), ...(nav?.keywords ?? [])],
    });
  }

  const actions: PaletteEntry[] =
    c.workspace === 'enterprise'
      ? availableTaskVerbs(c.can, c.verbContext).map((verb) => ({
          id: `action:${verb.id}`,
          group: 'actions',
          label: verb.label,
          href: verb.href,
          hint: verb.hint,
          keywords: verb.keywords,
        }))
      : assuranceActions(c);

  const items = c.workspace === 'enterprise' ? ENTERPRISE_SETTINGS_ITEMS : ASSURANCE_SETTINGS_ITEMS;
  const settings: PaletteEntry[] = items
    .filter((item) => !item.permission || item.permission.some((p) => c.can(p)))
    .filter((item) => {
      const gate = routeGate(item.href);
      return !gate || canOpenRoute(gate, c.can);
    })
    .map((item) => ({
      id: `settings:${item.href}`,
      group: 'settings',
      label: item.label,
      href: item.href,
      keywords: item.keywords,
    }));

  const recommended: PaletteEntry[] = [];
  if (c.workspace === 'enterprise' && c.profile) {
    for (const rec of RECOMMENDATIONS[c.profile]) {
      if (rec.kind === 'verb') {
        const verb = resolveTaskVerb(taskVerb(rec.id), c.can, c.verbContext);
        if (verb) {
          recommended.push({
            id: `recommended:${verb.id}`,
            group: 'recommended',
            label: verb.label,
            href: verb.href,
            hint: verb.hint,
            keywords: verb.keywords,
          });
        }
      } else {
        const gate = routeGate(rec.href);
        if (gate && !canOpenRoute(gate, c.can)) continue;
        recommended.push({
          id: `recommended:${rec.href}`,
          group: 'recommended',
          label: rec.label,
          href: rec.href,
          hint: '画面',
        });
      }
    }
  }

  return { recommended, actions, screens, settings };
}

// ----------------------------------------------------------------------
// 絞り込み
// ----------------------------------------------------------------------

/** 全角・半角・大文字小文字の差を無視して比べる（「ｓｓｂｊ」でも SSBJ に当たる） */
export function normalizePaletteText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function matchesPaletteQuery(
  entry: Pick<PaletteEntry, 'label' | 'hint' | 'keywords'>,
  query: string,
): boolean {
  const q = normalizePaletteText(query);
  if (!q) return true;
  const haystack = normalizePaletteText(
    [entry.label, entry.hint ?? '', ...(entry.keywords ?? [])].join(' '),
  );
  // 空白で区切った語をすべて含む（「SSBJ 計画」で SSBJ 対応計画に当たる）
  return q.split(' ').every((word) => haystack.includes(word));
}

/** 空のクエリで出す件数（最近 5・おすすめ全件・各グループの先頭） */
export const PALETTE_EMPTY_LIMITS: Record<PaletteGroup, number> = {
  recent: 5,
  recommended: 4,
  actions: 6,
  screens: 8,
  settings: 0,
  data: 0,
};

/** クエリがあるときの各グループの上限 */
export const PALETTE_QUERY_LIMIT = 8;

/**
 * グループごとの候補を、表示する順の 1 本の列にする。空のクエリでは「おすすめ」を出し、
 * クエリがあれば各グループから一致するものを上限まで出す（おすすめは出さない: 操作と重なるため）
 */
export function arrangePaletteEntries(
  groups: Partial<Record<PaletteGroup, readonly PaletteEntry[]>>,
  query: string,
): PaletteEntry[] {
  const empty = normalizePaletteText(query) === '';
  const out: PaletteEntry[] = [];
  for (const group of PALETTE_GROUPS) {
    if (!empty && group === 'recommended') continue;
    const entries = groups[group] ?? [];
    const limit = empty ? PALETTE_EMPTY_LIMITS[group] : PALETTE_QUERY_LIMIT;
    let count = 0;
    // 同じグループの中だけで行き先の重複を除く（従来メニューは 開示対応・SSBJ・対応状況 が同じ画面）。
    // グループをまたいでは除かない: 「操作」の取込を始める と「画面」のデータ取込 は別の探し方のため
    const seenHref = new Set<string>();
    for (const entry of entries) {
      if (count >= limit) break;
      if (!empty && !matchesPaletteQuery(entry, query)) continue;
      if (seenHref.has(entry.href)) continue;
      seenHref.add(entry.href);
      out.push(entry);
      count += 1;
    }
  }
  return out;
}
