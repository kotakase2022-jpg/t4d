import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  BadgeCheck,
  Bot,
  Boxes,
  Building2,
  ChartColumnBig,
  ChartLine,
  ClipboardCheck,
  ClipboardList,
  Database,
  FileSearch,
  FileSpreadsheet,
  FileStack,
  FileText,
  Filter,
  FolderKanban,
  FolderOpen,
  Gauge,
  Home,
  Inbox,
  Landmark,
  Layers,
  ListChecks,
  MessageSquareWarning,
  NotebookPen,
  PenLine,
  ScrollText,
  Settings,
  ShieldCheck,
  Signature,
  Stethoscope,
  Upload,
  Workflow,
} from 'lucide-react';
import type { PermissionKey } from '@/types/domain';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** これを持たないユーザーには表示しない（設定画面等） */
  permission?: PermissionKey;
  children?: NavItem[];
  /** Command Palette 用の追加検索語 */
  keywords?: string[];
  /**
   * 同じ画面への別導線（docs/disclosure-first.md §9.1）。現在地（aria-current）・強調表示を付けず、
   * 親の「配下が現在地」にも数えず、Command Palette の候補にも重ねない。
   * 正規の位置が同じツリーの別の枝にあるときだけ使う。
   */
  secondary?: true;
  /**
   * 葉だけに付ける。href の配下ではないが、この項目を現在地とする画面のパス
   * （例: CSRD の回答編集 `/csrd/{UUID}` は「要求事項」から入る画面なので、要求事項を現在地にする）。
   */
  alsoCurrentFor?: RegExp[];
}

/** 定性情報は SSBJ 専用ではなく全基準共通の資産（§9.1 ①）。両ツリーで同じ検索語を使う */
const NARRATIVES_ITEM: NavItem = {
  label: '定性情報',
  href: '/enterprise/narratives',
  icon: NotebookPen,
  keywords: ['定性', 'ガバナンス', 'リスク', '機会', '財務的影響', '戦略'],
};

/**
 * 企業ワークスペースの左メニュー。
 *
 * 発注者会議（T4D 開発 Update）で決めた 2 つの入口に沿って並べる:
 *  1. 開示目的ドリブン（SSBJ・CSRD から始める）→「開示対応」
 *  2. データ先行（ESG データを先に取り込む）→「ESG データ（GHG以外）」
 * GHG は算定ロジックが重い独立モジュールとして ESG データから分離する
 * （分離が分かるよう、データ側のラベルにも「GHG以外」と明記する）。
 * 旧「データ収集」は「SSBJ データ収集」と役割が紛れるため「データ取込」へ改名した。
 *
 * 開示対応の配下は基準ごとにまとめる（SSBJ → 対応状況/要求事項/…）。
 * SSBJ の画面が 5 つに増え、CDP 以降と同じ階層に並べると
 * どこまでが SSBJ なのか読み取れなくなったため 3 階層にした。
 *
 * 2026-10-01 の追加要望（docs/disclosure-first.md §9.1）:
 *  ① SSBJ の データ収集 と 開示ドラフト の間に「定性情報」（集めた事実を文章へ移す前の工程）
 *  ② AI Copilot と 管理 の間に「分析」（閲覧専用の横断画面）
 *  ③ CSRD を SSBJ と同じ 5 画面のグループへ。定性情報は入れない（共通資産であり、同じ href が
 *     2 つの枝に出て現在地が 2 つ付くのを避ける。CSRD 開示ドラフト画面から定性情報へリンクする）
 */
export const ENTERPRISE_NAV: NavItem[] = [
  {
    label: 'ホーム',
    href: '/enterprise/dashboard',
    icon: Home,
    keywords: ['dashboard', 'ダッシュボード'],
  },
  {
    label: '開示対応',
    // 開示対応の起点は SSBJ。CDP・CSRD は SSBJ で整えたデータの展開先という位置づけ
    href: '/enterprise/disclosures/ssbj',
    icon: FileStack,
    keywords: ['disclosure', '開示'],
    children: [
      {
        label: 'SSBJ',
        href: '/enterprise/disclosures/ssbj',
        icon: FileText,
        keywords: ['SSBJ', 'サステナビリティ基準'],
        children: [
          {
            label: '対応状況',
            href: '/enterprise/disclosures/ssbj',
            icon: Gauge,
            keywords: ['SSBJ', 'ギャップ', '全体状況'],
          },
          {
            label: '要求事項',
            href: '/enterprise/disclosures/ssbj/requirements',
            icon: ListChecks,
            keywords: ['SSBJ', '要求事項', 'ギャップ分析'],
          },
          {
            label: '対応計画',
            href: '/enterprise/disclosures/ssbj/plans',
            icon: ClipboardList,
            keywords: ['SSBJ', '対応計画', '担当', '期限'],
          },
          {
            label: 'データ収集',
            href: '/enterprise/disclosures/ssbj/collection',
            icon: Database,
            keywords: ['SSBJ', 'データ収集', '不足データ'],
          },
          NARRATIVES_ITEM,
          {
            // 会議での指摘「ドラフト作成を左メニューに明示する」
            label: '開示ドラフト',
            href: '/enterprise/disclosures/ssbj/draft',
            icon: FileText,
            keywords: ['SSBJ', 'ドラフト', '草案', '開示文書'],
          },
        ],
      },
      { label: 'CDP', href: '/enterprise/disclosures/cdp', icon: FileSpreadsheet },
      {
        // SSBJ と同じ画面構成。ただし重要性はダブル・マテリアリティ（設定は対応状況の工程①から入る）
        label: 'CSRD',
        href: '/enterprise/disclosures/csrd',
        icon: FileSpreadsheet,
        keywords: ['CSRD', 'ESRS', 'ダブル・マテリアリティ', 'DMA'],
        children: [
          {
            label: '対応状況',
            href: '/enterprise/disclosures/csrd',
            icon: Gauge,
            keywords: ['CSRD', 'ESRS', '全体状況', 'ダブル・マテリアリティ', 'DMA', '重要性'],
          },
          {
            label: '要求事項',
            href: '/enterprise/disclosures/csrd/requirements',
            icon: ListChecks,
            keywords: ['CSRD', 'ESRS', '要求事項', 'ギャップ分析', '適用'],
            // 既存の回答編集画面（csrd/[questionId]）は要求事項の詳細から入るため、ここを現在地にする
            alsoCurrentFor: [/^\/enterprise\/disclosures\/csrd\/[0-9a-f-]{36}$/],
          },
          {
            label: '対応計画',
            href: '/enterprise/disclosures/csrd/plans',
            icon: ClipboardList,
            keywords: ['CSRD', 'ESRS', '対応計画', '担当', '期限'],
          },
          {
            label: 'データ収集',
            href: '/enterprise/disclosures/csrd/collection',
            icon: Database,
            keywords: ['CSRD', 'ESRS', 'データ収集', '不足データ'],
          },
          {
            label: '開示ドラフト',
            href: '/enterprise/disclosures/csrd/draft',
            icon: FileText,
            keywords: ['CSRD', 'ESRS', 'ドラフト', '草案', '開示文書'],
          },
        ],
      },
      { label: 'MSCI', href: '/enterprise/disclosures/msci', icon: FileSpreadsheet },
      { label: 'FTSE', href: '/enterprise/disclosures/ftse', icon: FileSpreadsheet },
    ],
  },
  {
    // データ先行の入口。取込 → 台帳 → 根拠資料 の順（データが流れる順）
    label: 'ESG データ（GHG以外）',
    href: '/enterprise/data',
    icon: Database,
    keywords: ['ESG', 'データ'],
    children: [
      {
        label: 'データ取込',
        href: '/enterprise/imports',
        icon: Upload,
        keywords: ['import', '取込', 'アップロード', 'データ収集'],
      },
      {
        label: '非財務データ',
        href: '/enterprise/data',
        icon: Database,
        keywords: ['data point', '台帳', '指標'],
      },
      {
        label: 'Evidence',
        href: '/enterprise/evidence',
        icon: FolderOpen,
        keywords: ['証憑', '根拠'],
      },
    ],
  },
  {
    // 独立モジュール（Scope 3 まで含む算定）。ESG データとは分けるが、導線の重複は許容
    label: 'GHG',
    href: '/enterprise/ghg',
    icon: Gauge,
    keywords: ['scope1', 'scope2', 'scope3', '排出量'],
    children: [
      {
        label: '算定サマリー',
        href: '/enterprise/ghg',
        icon: Gauge,
        keywords: ['GHG', 'scope3', '連結集計', '排出係数'],
      },
      {
        // 2026-09-15 の発注者指示でカテゴリー別の 3 階層へ（SSBJ 配下と同じ構造）。
        // 現状はカテゴリー1 のみだが、他カテゴリーを増やす場所を先に用意する
        label: 'Scope3データ取込',
        href: '/enterprise/ghg/suppliers',
        icon: Upload,
        keywords: ['GHG', 'scope3', 'サプライヤー', '一次データ', '購買'],
        children: [
          {
            label: 'Cat.1',
            href: '/enterprise/ghg/suppliers',
            icon: Upload,
            // 旧メニュー名でも Command Palette から探せるよう残す
            keywords: [
              'GHG',
              'scope3',
              'カテゴリー1',
              'サプライヤー',
              '購買',
              '購入した製品',
              'サプライヤーデータ取込',
            ],
          },
        ],
      },
    ],
  },
  {
    label: '業務管理',
    href: '/enterprise/workflows',
    icon: Workflow,
    keywords: ['業務', '進捗'],
    children: [
      {
        label: 'ワークフロー',
        href: '/enterprise/workflows',
        icon: Workflow,
        keywords: ['承認', 'レビュー', 'タスク', 'PBC'],
      },
      {
        label: 'アラート',
        href: '/enterprise/alerts',
        icon: AlertTriangle,
        keywords: ['警告', '期限超過'],
      },
      {
        label: 'レポート',
        href: '/enterprise/reports',
        icon: ScrollText,
        keywords: ['export', '出力'],
      },
    ],
  },
  { label: 'AI Copilot', href: '/enterprise/ai', icon: Bot, keywords: ['AI', '生成'] },
  {
    // 閲覧専用の横断画面。単一の総合点は作らない（§9.6）。入口は現状診断
    label: '分析',
    href: '/enterprise/analysis/diagnosis',
    icon: ChartColumnBig,
    keywords: ['分析', 'analysis', '診断', '比較'],
    children: [
      {
        label: '現状診断',
        href: '/enterprise/analysis/diagnosis',
        icon: Stethoscope,
        keywords: ['分析', '診断', '現状', '不足', 'データ品質', '網羅性'],
      },
      {
        label: '規制対応度',
        href: '/enterprise/analysis/regulations',
        icon: Landmark,
        // 開示の評価を読むため、開示の閲覧権限が無い役割（拠点担当など）には出さない
        permission: 'enterprise.disclosure.read',
        keywords: ['分析', '規制', '対応度', '基準', 'SSBJ', 'CSRD', 'ESRS', 'CDP', 'MSCI', 'FTSE'],
      },
      {
        label: '他社比較',
        href: '/enterprise/analysis/benchmark',
        icon: Building2,
        keywords: ['分析', '他社', '比較', 'ベンチマーク', 'benchmark', '同業', 'ピア'],
      },
    ],
  },
  {
    label: '管理',
    href: '/enterprise/organizations',
    icon: Settings,
    keywords: ['マスター', '管理'],
    children: [
      {
        label: '組織・拠点',
        href: '/enterprise/organizations',
        icon: Boxes,
        keywords: ['組織', '拠点', '連結', '指標マスター'],
      },
      {
        label: '設定',
        href: '/enterprise/settings',
        icon: Settings,
        permission: 'enterprise.org.manage',
      },
    ],
  },
];

/**
 * 従来メニューの項目を名指しで取り出す（検索語・アイコンを二重管理しないため）。
 * 見つからなければモジュール読込時に止める（黙って項目が消えるより早く気付ける）。
 */
function legacyItem(href: string, label: string): NavItem {
  const walk = (items: NavItem[]): NavItem | undefined => {
    for (const item of items) {
      if (item.href === href && item.label === label) return item;
      const found = walk(item.children ?? []);
      if (found) return found;
    }
    return undefined;
  };
  const found = walk(ENTERPRISE_NAV);
  if (!found) throw new Error(`ENTERPRISE_NAV に ${label}（${href}）がありません`);
  return found;
}

/**
 * 従来メニューの項目の複製で、子のうち `secondaryHref` のものだけを別導線（secondary）にする。
 * 従来メニューの項目そのものは書き換えない（従来ツリーでは同じ子が通常の葉として現在地を持つ）。
 */
function legacyItemWithSecondaryChild(href: string, label: string, secondaryHref: string): NavItem {
  const item = legacyItem(href, label);
  const children = item.children ?? [];
  if (!children.some((child) => child.href === secondaryHref)) {
    throw new Error(`${label} の子に ${secondaryHref} がありません`);
  }
  return {
    ...item,
    children: children.map((child) =>
      child.href === secondaryHref ? { ...child, secondary: true } : child,
    ),
  };
}

/**
 * 開示優先モード（organization_feature_settings.disclosure_first）の左メニュー
 * （指示書 §4.1・docs/disclosure-first.md §2-1）。
 *
 * 「開示を完成へ進める仕事」から入れるよう、開示プロジェクトを先頭に置き、
 * データ・定性情報・資料は「情報・根拠」へまとめる。従来メニューの画面は削除せず、
 * すべてこのツリーのどこかから開けるようにする（A01: 既存 URL を使い続けられる）。
 *  - CDP・MSCI・FTSE は「その他の開示」へ格納する
 *  - GHG 算定・Scope3 は「情報・根拠」の関連導線に置き、既存の直リンクは変えない
 *  - AI Copilot は補助メニューとして最後に残す（AI は各作業画面の補助として出す）
 *  - 分析は 管理 の直前（従来ツリーと同じく「管理の直上」。§9.1 ②）
 *  - 定性情報の正規の位置は「情報・根拠」。SSBJ 配下の定性情報は従来ツリーと同じ並びを保つための
 *    別導線（secondary）で、現在地を付けない（同じ画面で aria-current が 2 つ並ばない。§9.1 ①）
 *
 * 機能設定が false の組織には ENTERPRISE_NAV（従来ツリー）をそのまま使う（A39）。
 */
export const ENTERPRISE_NAV_DISCLOSURE_FIRST: NavItem[] = [
  {
    ...legacyItem('/enterprise/dashboard', 'ホーム'),
    keywords: ['dashboard', 'ダッシュボード', '自分の作業'],
  },
  {
    label: '開示プロジェクト',
    href: '/enterprise/disclosure-projects',
    icon: FolderKanban,
    keywords: ['開示', 'プロジェクト', '原稿', 'レビュー', '承認', '出力'],
    children: [
      legacyItemWithSecondaryChild('/enterprise/disclosures/ssbj', 'SSBJ', NARRATIVES_ITEM.href),
      legacyItem('/enterprise/disclosures/csrd', 'CSRD'),
      {
        label: 'その他の開示',
        href: '/enterprise/disclosures/cdp',
        icon: FileStack,
        keywords: ['CDP', 'MSCI', 'FTSE', '評価機関'],
        children: [
          legacyItem('/enterprise/disclosures/cdp', 'CDP'),
          legacyItem('/enterprise/disclosures/msci', 'MSCI'),
          legacyItem('/enterprise/disclosures/ftse', 'FTSE'),
        ],
      },
      { ...legacyItem('/enterprise/reports', 'レポート'), label: 'レポート出力' },
    ],
  },
  {
    label: '情報・根拠',
    href: '/enterprise/data',
    icon: Database,
    keywords: ['情報', '根拠', 'データ'],
    children: [
      { ...legacyItem('/enterprise/data', '非財務データ'), label: '定量データ' },
      NARRATIVES_ITEM,
      { ...legacyItem('/enterprise/evidence', 'Evidence'), label: '資料・証跡' },
      { ...legacyItem('/enterprise/imports', 'データ取込'), label: '取込' },
      {
        label: '数値を登録（標準CSV）',
        href: '/enterprise/imports/standard',
        icon: FileSpreadsheet,
        keywords: ['CSV', '標準', '手入力', '数値', '登録'],
      },
      { ...legacyItem('/enterprise/ghg', '算定サマリー'), label: 'GHG算定' },
      legacyItem('/enterprise/ghg/suppliers', 'Scope3データ取込'),
    ],
  },
  {
    label: 'ESG経営',
    href: '/enterprise/esg',
    icon: ChartLine,
    keywords: ['KPI', '目標', '推移', '経営'],
  },
  {
    label: 'タスク・承認',
    href: '/enterprise/workflows',
    icon: ClipboardCheck,
    keywords: ['タスク', '承認', 'レビュー', '差戻し', '期限', 'PBC'],
    children: [
      { ...legacyItem('/enterprise/workflows', 'ワークフロー'), label: '自分の作業・レビュー' },
      legacyItem('/enterprise/alerts', 'アラート'),
    ],
  },
  legacyItem('/enterprise/analysis/diagnosis', '分析'),
  legacyItem('/enterprise/organizations', '管理'),
  legacyItem('/enterprise/ai', 'AI Copilot'),
];

export type NavVariant = 'enterprise' | 'enterprise-disclosure' | 'assurance';

/** メニューの種類ごとのツリー。Sidebar・Command Palette・非表示判定が同じツリーを使う */
export function navTreeFor(variant: NavVariant, engagementId: string | null): NavItem[] {
  if (variant === 'enterprise') return ENTERPRISE_NAV;
  if (variant === 'enterprise-disclosure') return ENTERPRISE_NAV_DISCLOSURE_FIRST;
  return assuranceNav(engagementId);
}

/**
 * 現在地（aria-current）の付け方（docs/disclosure-first.md §9.1）。
 *  - `top-and-leaf`: 従来ツリー・監査法人。最上位は自分の href の前方一致で付ける既存仕様（A39。
 *    例: GHG と Cat.1 の 2 つ）を保ち、2 階層目以下は木全体で 1 つ以下にする。
 *  - `single`: 開示優先ツリー。最上位も含めて木全体で 1 つにする（メニューにある画面ならちょうど 1 つ）。
 */
export type NavCurrentMode = 'top-and-leaf' | 'single';

/**
 * ツリー内の位置（添字の列。例 "1.0.4"）。同じ href・同じ項目が別の枝に出ても区別できるよう、
 * 現在地は href ではなく位置で持つ。
 */
export function navItemKey(parentKey: string | null, index: number): string {
  return parentKey === null ? String(index) : `${parentKey}.${index}`;
}

/** href と一致するか、その配下の画面か */
export function isNavPathActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function aliasMatches(pathname: string, item: NavItem): boolean {
  return item.alsoCurrentFor?.some((pattern) => pattern.test(pathname)) ?? false;
}

/**
 * 自分または子孫のどこかが現在の画面か（強調表示に使う。3 階層対応）。
 * 別導線（secondary）は数えない: 正規の位置の親だけを強調する。
 */
export function isNavSubtreeActive(pathname: string, item: NavItem): boolean {
  if (item.secondary) return false;
  if (isNavPathActive(pathname, item.href) || aliasMatches(pathname, item)) return true;
  return item.children?.some((child) => isNavSubtreeActive(pathname, child)) ?? false;
}

// 一致の強さ。完全一致 > 別名（alsoCurrentFor）> 前方一致（href が長いほど強い）
const RANK_EXACT = Number.MAX_SAFE_INTEGER;
const RANK_ALIAS = Number.MAX_SAFE_INTEGER - 1;

function matchRank(
  pathname: string,
  item: NavItem,
  siblings: NavItem[],
  topLevel: boolean,
): number {
  if (item.secondary) return 0;
  if (pathname === item.href) return RANK_EXACT;
  const prefix = pathname.startsWith(`${item.href}/`);
  // 最上位は配下の画面すべてで一致させる（開示プロジェクト → 原稿編集 など。既存仕様）
  if (topLevel) return prefix ? item.href.length : 0;
  // 2 階層目以下のグループ行（例: SSBJ）は配下すべてに前方一致してしまうため、完全一致のときだけ
  if ((item.children?.length ?? 0) > 0) return 0;
  if (aliasMatches(pathname, item)) return RANK_ALIAS;
  // 兄弟の親パスを持つ入口行（例: 算定サマリー = /enterprise/ghg）も兄弟の画面で光らないよう完全一致のみ
  const overlapsSibling = siblings.some(
    (other) => other !== item && other.href.startsWith(`${item.href}/`),
  );
  return prefix && !overlapsSibling ? item.href.length : 0;
}

interface NavCandidate {
  key: string;
  topKey: string;
  depth: number;
  rank: number;
}

/**
 * 現在地にする項目の位置（navItemKey）を返す。描画するのと同じ（権限で絞った後の）ツリーを渡す。
 *
 * 候補が複数あれば、一致が強いもの → 深いもの（親子が同じ href のときは子。例: SSBJ → 対応状況）→
 * 木の順で先のもの、の順で 1 つに決める。どの順で呼んでも同じ結果になる（決定的）。
 * 折りたたみ中は子を描画しないため、`single` は現在地の項目を含む最上位に付け、
 * `top-and-leaf` は最上位の前方一致だけを残す（従来どおり）。
 */
export function resolveNavCurrent(
  items: NavItem[],
  pathname: string,
  { mode, collapsed }: { mode: NavCurrentMode; collapsed: boolean },
): Set<string> {
  const candidates: NavCandidate[] = [];
  const visit = (siblings: NavItem[], parentKey: string | null, topKey: string | null) => {
    siblings.forEach((item, index) => {
      const key = navItemKey(parentKey, index);
      const depth = parentKey === null ? 0 : parentKey.split('.').length;
      const isTop = parentKey === null;
      // top-and-leaf の最上位は下で別に決める（2 階層目以下の 1 つとは独立に付く既存仕様）
      if (!(isTop && mode === 'top-and-leaf')) {
        const rank = matchRank(pathname, item, siblings, isTop);
        if (rank > 0) candidates.push({ key, topKey: topKey ?? key, depth, rank });
      }
      if (item.children) visit(item.children, key, topKey ?? key);
    });
  };
  visit(items, null, null);

  // Array.prototype.sort は安定ソートなので、同点は木の順（先に見つけたもの）が残る
  const best = [...candidates].sort((a, b) => b.rank - a.rank || b.depth - a.depth)[0];
  const current = new Set<string>();

  if (mode === 'top-and-leaf') {
    items.forEach((item, index) => {
      if (isNavPathActive(pathname, item.href)) current.add(navItemKey(null, index));
    });
    if (!collapsed && best) current.add(best.key);
    return current;
  }

  if (best) current.add(collapsed ? best.topKey : best.key);
  return current;
}

export function assuranceNav(engagementId: string | null): NavItem[] {
  const base = engagementId ? `/assurance/engagements/${engagementId}` : null;
  const item = (label: string, path: string, icon: LucideIcon, keywords?: string[]): NavItem => ({
    label,
    href: base ? `${base}/${path}` : '/assurance/engagements',
    icon,
    keywords,
  });

  return [
    { label: '案件ホーム', href: '/assurance/dashboard', icon: Home, keywords: ['dashboard'] },
    {
      label: '保証契約',
      href: '/assurance/engagements',
      icon: BadgeCheck,
      keywords: ['engagement', '案件'],
    },
    item('スコープ', 'scope', Layers, ['scope', '範囲']),
    item('Data Room', 'data-room', FolderOpen, ['共有', 'snapshot']),
    item('母集団', 'population', Filter, ['population', '完全性']),
    item('サンプリング', 'sampling', ListChecks, ['sample', '抽出']),
    item('保証手続・調書', 'testing', FileSearch, ['test', '調書', 'workpaper']),
    item('PBC／資料依頼', 'requests', Inbox, ['pbc', '依頼']),
    item('指摘・例外', 'issues', MessageSquareWarning, ['issue', '指摘']),
    item('レビューNote', 'review-notes', PenLine, ['review']),
    item('Sign-off', 'signoffs', Signature, ['signoff', '承認']),
    item('監査ログ', 'audit-trail', ShieldCheck, ['audit', 'ログ']),
    item('Export', 'exports', ClipboardList, ['export', '出力']),
    {
      label: '設定',
      href: '/assurance/settings',
      icon: Settings,
      permission: 'assurance.firm.manage',
    },
  ];
}
