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
  History,
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
  Waypoints,
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
  /**
   * 最上位だけに付ける。現在地（top-and-leaf の最上位の前方一致）を判定するパスが href と違うとき
   * （例: 分析の入口は現状診断 /enterprise/analysis/diagnosis だが、規制対応度・他社比較も分析の画面）。
   * 付けないと、折りたたみ中に規制対応度・他社比較の画面で現在地が 1 つも付かない
   */
  currentPrefix?: string;
  /**
   * グループの行だけに付ける。グループの入口の画面（href）を開くのに要る権限。持たない利用者には
   * グループと開ける子を残したまま、行のリンク先を「開ける最初の子」にする（開くと「アクセス権限が
   * ありません」になる項目をメニューに出さない。plan §1.5）。permission と違い、子は隠さない
   */
  linkPermission?: PermissionKey;
  /** visibleNavTree が付ける印: 行のリンク先を最初の子に置き換えた（パレットに入口として出さない） */
  linkFallback?: true;
}

/**
 * 定性情報は SSBJ 専用ではなく全基準共通の資産（§9.1 ①）。両ツリー・SSBJ と CSRD の両方で同じ項目を使う。
 * 開示の閲覧権限が無い役割（拠点担当など）は画面を開けない（listNarratives が拒む）ため出さない
 */
const NARRATIVES_ITEM: NavItem = {
  label: '定性情報',
  href: '/enterprise/narratives',
  icon: NotebookPen,
  permission: 'enterprise.disclosure.read',
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
 *  ③ CSRD を SSBJ と同じ 5 画面のグループへ
 * 2026-10-02 の追加要望（§10.1）:
 *  ① CSRD にも データ収集 と 開示ドラフト の間に「定性情報」（§9.1 ③「CSRD に入れない」を置き換え）。
 *     同じ href が SSBJ と CSRD の 2 か所に出るため、現在地はどちらか 1 つを「優先枝」で選ぶ（resolveNavCurrent）
 *  ② 分析に「自社経年比較」（規制対応度 と 他社比較 の間）
 *  ③ 分析に「財務影響分析」（他社比較 の次の兄弟）
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
        // SSBJ と同じ画面構成。ただし重要性はダブル・マテリアリティ（設定は対応状況の工程①から入る）。
        // CSRD の画面はすべて開示の閲覧権限を求める（拠点担当などには出さない。開いても権限なしの画面になる）
        label: 'CSRD',
        href: '/enterprise/disclosures/csrd',
        icon: FileSpreadsheet,
        permission: 'enterprise.disclosure.read',
        keywords: ['CSRD', 'ESRS', 'ダブル・マテリアリティ', 'DMA'],
        children: [
          {
            label: '対応状況',
            href: '/enterprise/disclosures/csrd',
            permission: 'enterprise.disclosure.read',
            icon: Gauge,
            keywords: ['CSRD', 'ESRS', '全体状況', 'ダブル・マテリアリティ', 'DMA', '重要性'],
          },
          {
            label: '要求事項',
            href: '/enterprise/disclosures/csrd/requirements',
            permission: 'enterprise.disclosure.read',
            icon: ListChecks,
            keywords: ['CSRD', 'ESRS', '要求事項', 'ギャップ分析', '適用'],
            // 既存の回答編集画面（csrd/[questionId]）は要求事項の詳細から入るため、ここを現在地にする
            alsoCurrentFor: [/^\/enterprise\/disclosures\/csrd\/[0-9a-f-]{36}$/],
          },
          {
            label: '対応計画',
            href: '/enterprise/disclosures/csrd/plans',
            permission: 'enterprise.disclosure.read',
            icon: ClipboardList,
            keywords: ['CSRD', 'ESRS', '対応計画', '担当', '期限'],
          },
          {
            label: 'データ収集',
            href: '/enterprise/disclosures/csrd/collection',
            permission: 'enterprise.disclosure.read',
            icon: Database,
            keywords: ['CSRD', 'ESRS', 'データ収集', '不足データ'],
          },
          NARRATIVES_ITEM,
          {
            label: '開示ドラフト',
            href: '/enterprise/disclosures/csrd/draft',
            permission: 'enterprise.disclosure.read',
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
    // 入口以外（規制対応度・自社経年比較・他社比較・財務影響分析）も分析の画面として、最上位の現在地を付ける
    currentPrefix: '/enterprise/analysis',
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
        // 直近 3 年度の確定値の経年変化（§10.2）。数値を読むだけなので権限は付けない
        // （enterprise.data.read は全 enterprise 役割が持つ）
        label: '自社経年比較',
        href: '/enterprise/analysis/trends',
        icon: History,
        keywords: ['経年', '推移', '前年比', '年度比較'],
      },
      {
        label: '他社比較',
        href: '/enterprise/analysis/benchmark',
        icon: Building2,
        keywords: ['分析', '他社', '比較', 'ベンチマーク', 'benchmark', '同業', 'ピア'],
      },
      {
        // 承認済みの非財務データ × 画面に示した仮定による決定論的な試算（§10.3）。
        // 他社比較の子ではなく次の兄弟。定性・IRO は画面側で開示の閲覧権限があるときだけ出す
        label: '財務影響分析',
        href: '/enterprise/analysis/financial-impact',
        icon: Waypoints,
        keywords: ['財務', '影響', 'シミュレーション', '経路', '炭素価格', 'シナリオ'],
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
 *  - 定性情報の正規の位置は「情報・根拠」。SSBJ・CSRD 配下の定性情報は従来ツリーと同じ並びを保つための
 *    別導線（secondary）で、現在地を付けない（同じ画面で aria-current が 2 つ並ばない。§9.1 ①・§10.1 ①）
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
    // 一覧は開示の閲覧権限が要る（拠点担当は持たない）。配下の SSBJ・CDP は開けるのでグループは残す
    linkPermission: 'enterprise.disclosure.read',
    keywords: ['開示', 'プロジェクト', '原稿', 'レビュー', '承認', '出力'],
    children: [
      legacyItemWithSecondaryChild('/enterprise/disclosures/ssbj', 'SSBJ', NARRATIVES_ITEM.href),
      legacyItemWithSecondaryChild('/enterprise/disclosures/csrd', 'CSRD', NARRATIVES_ITEM.href),
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
        // 画面は取込とデータ入力の権限が要る（取込の権限を持つ役割はすべてデータ入力も持つ）。
        // レビュー担当・最終承認者に「開くと権限なし」の項目を出さない
        permission: 'enterprise.import.run',
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

/**
 * 権限が無いため出さない項目の href（Sidebar・Command Palette が同じ一覧で隠す）。
 * 子項目（例: 管理 > 設定、CSRD > 対応状況）にも権限が付くため、階層をたどって集める
 */
export function hiddenNavHrefsFor(
  items: NavItem[],
  has: (permission: PermissionKey) => boolean,
): string[] {
  return items.flatMap((item) => [
    ...(item.permission && !has(item.permission) ? [item.href] : []),
    ...hiddenNavHrefsFor(item.children ?? [], has),
  ]);
}

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
  /** 祖先ラベルの経路（navBranchOf と同じ形） */
  branch: string | null;
}

/** 枝の識別子の区切り（Command Palette の経路ラベルと同じ） */
const BRANCH_SEPARATOR = ' / ';

/** 祖先ラベルの列から枝の識別子を作る（サイドバーが押したリンクの枝を覚えるときにも使う） */
export function joinNavBranch(labels: readonly string[]): string {
  return labels.join(BRANCH_SEPARATOR);
}

/**
 * 現在地にする項目の位置（navItemKey）を返す。描画するのと同じ（権限で絞った後の）ツリーを渡す。
 *
 * 候補が複数あれば、一致が強いもの → 深いもの（親子が同じ href のときは子。例: SSBJ → 対応状況）→
 * 優先枝（preferredBranch）に一致するもの → 木の順で先のもの、の順で 1 つに決める。
 * 優先枝は同点（同じ href が別の枝に同じ深さで出る。例: 従来ツリーの SSBJ と CSRD の定性情報）の解消にだけ効き、
 * 一致しなければ木の順（＝SSBJ）。どの順で呼んでも同じ結果になる（決定的）。
 * 折りたたみ中は子を描画しないため、`single` は現在地の項目を含む最上位に付け、
 * `top-and-leaf` は最上位の前方一致だけを残す（従来どおり）。
 */
export function resolveNavCurrent(
  items: NavItem[],
  pathname: string,
  {
    mode,
    collapsed,
    preferredBranch = null,
  }: { mode: NavCurrentMode; collapsed: boolean; preferredBranch?: string | null },
): Set<string> {
  const candidates: NavCandidate[] = [];
  const visit = (
    siblings: NavItem[],
    parentKey: string | null,
    topKey: string | null,
    trail: string[],
  ) => {
    siblings.forEach((item, index) => {
      const key = navItemKey(parentKey, index);
      const depth = parentKey === null ? 0 : parentKey.split('.').length;
      const isTop = parentKey === null;
      // top-and-leaf の最上位は下で別に決める（2 階層目以下の 1 つとは独立に付く既存仕様）
      if (!(isTop && mode === 'top-and-leaf')) {
        const rank = matchRank(pathname, item, siblings, isTop);
        if (rank > 0) {
          candidates.push({
            key,
            topKey: topKey ?? key,
            depth,
            rank,
            branch: trail.length === 0 ? null : trail.join(BRANCH_SEPARATOR),
          });
        }
      }
      if (item.children) visit(item.children, key, topKey ?? key, [...trail, item.label]);
    });
  };
  visit(items, null, null, []);

  const preference = (candidate: NavCandidate) =>
    preferredBranch !== null && candidate.branch === preferredBranch ? 0 : 1;
  // Array.prototype.sort は安定ソートなので、同点は木の順（先に見つけたもの）が残る
  const best = [...candidates].sort(
    (a, b) => b.rank - a.rank || b.depth - a.depth || preference(a) - preference(b),
  )[0];
  const current = new Set<string>();

  if (mode === 'top-and-leaf') {
    items.forEach((item, index) => {
      if (isNavPathActive(pathname, item.currentPrefix ?? item.href)) {
        current.add(navItemKey(null, index));
      }
    });
    if (!collapsed && best) current.add(best.key);
    return current;
  }

  if (best) current.add(collapsed ? best.topKey : best.key);
  return current;
}

/** 位置（navItemKey）の項目と、その祖先のラベル（上から順）。位置がツリーに無ければ null */
function navEntryAt(items: NavItem[], key: string): { item: NavItem; trail: string[] } | null {
  let nodes = items;
  let item: NavItem | undefined;
  const trail: string[] = [];
  const indexes = key.split('.').map(Number);
  for (const [position, index] of indexes.entries()) {
    item = nodes[index];
    if (!item) return null;
    if (position < indexes.length - 1) trail.push(item.label);
    nodes = item.children ?? [];
  }
  return item ? { item, trail } : null;
}

/**
 * 枝の識別子＝祖先ラベルの経路（例: 従来ツリーの CSRD 配下の定性情報 → `開示対応 / CSRD`）。
 * 最上位の項目・ツリーに無い位置は null。位置キー（添字）は権限で項目が隠れるとずれるため、保存にはこちらを使う
 */
export function navBranchOf(items: NavItem[], key: string): string | null {
  const entry = navEntryAt(items, key);
  if (!entry || entry.trail.length === 0) return null;
  return entry.trail.join(BRANCH_SEPARATOR);
}

/** 2 階層目以下に現在地があるか（無ければ強調表示は従来の isNavSubtreeActive に戻す） */
export function hasDeepNavCurrent(currentKeys: ReadonlySet<string>): boolean {
  return [...currentKeys].some((key) => key.includes('.'));
}

/**
 * key の項目が現在地の祖先か（強調表示: グループ行の太字・最上位の背景）。
 * 位置で判定するため、同じ href が SSBJ と CSRD に出ても現在地のある側だけが true になる
 */
export function isNavAncestorOfCurrent(key: string, currentKeys: ReadonlySet<string>): boolean {
  return [...currentKeys].some((current) => current.startsWith(`${key}.`));
}

/**
 * 同じ深さ（2 階層目以下）に 2 回以上出る href＝現在地が優先枝で決まる画面（従来ツリーの定性情報）。
 * 別導線（secondary）は現在地にならないため数えない（開示優先ツリーでは空になる）
 */
function branchAmbiguousHrefs(items: NavItem[]): Set<string> {
  const counts = new Map<string, number>();
  const walk = (nodes: NavItem[], depth: number) => {
    for (const node of nodes) {
      if (depth > 0 && !node.secondary) {
        const id = `${depth}\u0000${node.href}`;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(items, 0);
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id.slice(id.indexOf('\u0000') + 1)),
  );
}

/**
 * 遷移後に覚える優先枝（docs/disclosure-first.md §10.1 の書く時機 (b)）。
 * 2 階層目以下の現在地が「枝で迷わない画面」で、その親に枝で迷う子（同じ href が別の枝にもある子）が
 * あるとき、その親の経路を返す（例: CSRD の開示ドラフトを開いた後に画面内のリンクで定性情報へ移ると
 * CSRD 側を現在地にする）。それ以外は undefined（覚えている枝を変えない）。
 * 定性情報そのものでは変えない（サイドバーのどちらのリンクから来たかを上書きしないため）
 */
export function branchToRemember(
  items: NavItem[],
  currentKeys: ReadonlySet<string>,
): string | null | undefined {
  const deep = [...currentKeys].filter((key) => key.includes('.'));
  if (deep.length !== 1) return undefined;
  const key = deep[0]!;
  const entry = navEntryAt(items, key);
  if (!entry || entry.item.secondary) return undefined;
  const ambiguous = branchAmbiguousHrefs(items);
  if (ambiguous.has(entry.item.href)) return undefined;
  const parent = navEntryAt(items, key.slice(0, key.lastIndexOf('.')));
  const parentHasAmbiguousChild =
    parent?.item.children?.some((child) => !child.secondary && ambiguous.has(child.href)) ?? false;
  if (!parentHasAmbiguousChild) return undefined;
  return navBranchOf(items, key);
}

/**
 * 監査法人のメニュー（plan §1.4。形を固定するテストが無い範囲で、手続の流れの順に再編した）。
 *
 * 案件ホーム／保証契約／〔案件を選んでいるときだけ〕計画・実施・結論・記録／設定。
 * 案件を選んでいないときは案件の 12 画面を出さない（行き先の無い 11 項目が並び、押すと案件一覧へ
 * 戻るだけだった。N-12）。サイドバーは代わりに「案件を選ぶと手続の画面が並びます」の 1 行を出す。
 * 案件の画面は案件の閲覧権限（assurance.engagement.read）を求める: 法人管理者には出さない
 * （未アサイン案件のクライアントデータを見られない。assumptions C-1）。
 * 現在地はツリー全体で 1 つ（single）。
 */
export function assuranceNav(engagementId: string | null): NavItem[] {
  const top: NavItem[] = [
    { label: '案件ホーム', href: '/assurance/dashboard', icon: Home, keywords: ['dashboard'] },
    {
      label: '保証契約',
      href: '/assurance/engagements',
      icon: BadgeCheck,
      keywords: ['engagement', '案件'],
    },
  ];
  const settings: NavItem = {
    label: '設定',
    href: '/assurance/settings',
    icon: Settings,
    permission: 'assurance.firm.manage',
  };
  if (!engagementId) return [...top, settings];

  const base = `/assurance/engagements/${engagementId}`;
  const item = (label: string, path: string, icon: LucideIcon, keywords?: string[]): NavItem => ({
    label,
    href: `${base}/${path}`,
    icon,
    keywords,
    permission: ENGAGEMENT_READ,
  });
  const group = (label: string, icon: LucideIcon, children: NavItem[]): NavItem => ({
    label,
    // グループ行の行き先は先頭の画面（グループ名を押しても行き止まりにしない）
    href: children[0]!.href,
    icon,
    permission: ENGAGEMENT_READ,
    children,
  });

  return [
    ...top,
    group('計画', ClipboardList, [
      item('概要', 'overview', Gauge, ['overview', '概要', '進捗', 'チーム']),
      item('スコープ', 'scope', Layers, ['scope', '範囲']),
    ]),
    group('実施', FileSearch, [
      item('Data Room', 'data-room', FolderOpen, ['共有', 'snapshot']),
      item('母集団', 'population', Filter, ['population', '完全性']),
      item('サンプリング', 'sampling', ListChecks, ['sample', '抽出']),
      item('保証手続・調書', 'testing', FileSearch, ['test', '調書', 'workpaper']),
      item('PBC／資料依頼', 'requests', Inbox, ['pbc', '依頼']),
      item('指摘・例外', 'issues', MessageSquareWarning, ['issue', '指摘']),
    ]),
    group('結論', Signature, [
      item('レビューNote', 'review-notes', PenLine, ['review']),
      item('Sign-off', 'signoffs', Signature, ['signoff', '承認']),
    ]),
    group('記録', ShieldCheck, [
      item('監査ログ', 'audit-trail', ShieldCheck, ['audit', 'ログ']),
      // 出力は出力の権限が要る（無い役割は開くと権限なしになるため、メニューに出さない。R3 と同じ考え方）
      {
        ...item('出力', 'exports', ClipboardList, ['export', '出力', 'Export']),
        permission: 'assurance.export.run',
      },
    ]),
    settings,
  ];
}

const ENGAGEMENT_READ: PermissionKey = 'assurance.engagement.read';

/** 案件を選んでいないときにサイドバーへ出す 1 行（N-12） */
export const ASSURANCE_NO_ENGAGEMENT_HINT = '案件を選ぶと手続の画面が並びます';

/** 現在地の付け方（従来ツリーは最上位＋葉の既存仕様、開示優先・監査法人は 1 つ） */
export function navCurrentModeFor(variant: NavVariant): NavCurrentMode {
  return variant === 'enterprise' ? 'top-and-leaf' : 'single';
}

// ----------------------------------------------------------------------
// グループの開閉（plan §1.4）
// ----------------------------------------------------------------------

/**
 * グループの識別子＝自分までのラベルの経路（例: 「開示対応」「開示対応 / SSBJ」）。
 * 権限で項目が隠れると位置キー（添字）がずれるため、保存にはラベルの経路を使う
 */
export function navGroupId(trail: readonly string[]): string {
  return joinNavBranch(trail);
}

/**
 * 役割で既定を閉じるグループ。開示の閲覧権限が無い利用者（拠点担当・サプライヤー担当）には、
 * 開示の仕事のグループを既定で閉じる（開けられる。開閉は利用者ごとに覚える）。分析は閉じない
 * （数値を読むだけの画面で、開示の権限は要らない）
 */
export function defaultCollapsedGroups(
  variant: NavVariant,
  has: (permission: PermissionKey) => boolean,
): string[] {
  if (has('enterprise.disclosure.read')) return [];
  if (variant === 'enterprise') return [navGroupId(['開示対応'])];
  if (variant === 'enterprise-disclosure') return [navGroupId(['開示プロジェクト'])];
  return [];
}

/**
 * 権限が無いため出さない項目の権限キー（Sidebar・Command Palette が項目の permission で隠す）。
 * href で隠すと、案件の画面のように URL に ID を含む項目を案件ごとに数え直す必要があるため
 */
export function missingNavPermissions(
  items: NavItem[],
  has: (permission: PermissionKey) => boolean,
): PermissionKey[] {
  const missing = new Set<PermissionKey>();
  const walk = (nodes: NavItem[]) => {
    for (const node of nodes) {
      if (node.permission && !has(node.permission)) missing.add(node.permission);
      if (node.linkPermission && !has(node.linkPermission)) missing.add(node.linkPermission);
      walk(node.children ?? []);
    }
  };
  walk(items);
  return [...missing];
}

/**
 * 利用者に見せるツリー（Sidebar・Command Palette・パンくずが同じものを使う）。
 *  - href・権限で隠す項目を全階層から外す（例: 管理 > 設定）
 *  - linkPermission を持たない利用者には、グループの行のリンク先を開ける最初の子にする（linkFallback）
 */
export function visibleNavTree(
  items: NavItem[],
  hiddenHrefs: readonly string[],
  hiddenPermissions: readonly PermissionKey[],
): NavItem[] {
  const filterTree = (nodes: NavItem[]): NavItem[] =>
    nodes
      .filter(
        (node) =>
          !hiddenHrefs.includes(node.href) &&
          !(node.permission && hiddenPermissions.includes(node.permission)),
      )
      .map((node) => {
        const children = node.children ? filterTree(node.children) : undefined;
        const next: NavItem = children ? { ...node, children } : node;
        if (node.linkPermission && hiddenPermissions.includes(node.linkPermission)) {
          const first = children?.find((child) => !child.secondary);
          if (first) return { ...next, href: first.href, linkFallback: true };
        }
        return next;
      });
  return filterTree(items);
}
