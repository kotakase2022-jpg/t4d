import type { PermissionKey } from '@/types/domain';

/**
 * 全画面の一覧（plan §3.1 ROUTE_CATALOG）。Command Palette の「画面」・パンくず・到達性の検査の
 * 単一の出所。`src/app/**\/page.tsx` の全ルートを載せる（tests/unit/route-catalog.test.ts が
 * 足し忘れを検出する。新しいページを作ったらここにも足す）。
 *
 * - React・アイコンに依存しない（サーバー・クライアント・テストのどこからでも読める）
 * - `permission` はページのゲートと同じ（配列はどれか 1 つを持てば開ける）。メニューの権限とは別
 * - `href` は固定の URL を持つ画面だけ。詳細画面（[id] を含む）は持たず、パレットには出さない
 *   （行き先の ID が要るため。データの検索から開く）
 * - 案件の画面（`engagement: true`）は、案件を選んでいるときだけ `{engagementId}` を埋めて出す
 */

export type RouteWorkspace = 'enterprise' | 'assurance' | 'common' | 'auth';

/**
 * どのメニューに載っているか。classic＝従来、disclosure＝開示優先、both＝両方、assurance＝監査法人、
 * header＝ヘッダー・ユーザーメニュー、none＝メニュー外（画面内リンクとパレットから開く）
 */
export type RouteMenu = 'classic' | 'disclosure' | 'both' | 'assurance' | 'header' | 'none';

export interface RouteCatalogEntry {
  /** `src/app` のパス（route group を除き、動的セグメントは [name]） */
  pattern: string;
  /** 画面名（h1・メニューと同じ名前。plan §1.9 名称の統一） */
  label: string;
  /** パンくず・パレットの経路（上から。最後は label と同じ） */
  path: readonly string[];
  /** 固定の行き先（詳細画面は持たない） */
  href?: string;
  permission?: PermissionKey | readonly PermissionKey[];
  workspace: RouteWorkspace;
  keywords?: readonly string[];
  menu: RouteMenu;
  /** 案件の画面（`{engagementId}` を埋める） */
  engagement?: true;
  /** ログイン前・招待・リダイレクト専用など、パレットやメニューからは辿らない入口 */
  entryOnly?: true;
}

const E = '/enterprise';
const SSBJ = `${E}/disclosures/ssbj`;
const CSRD = `${E}/disclosures/csrd`;
const CDP = `${E}/disclosures/cdp`;
const PROJECTS = `${E}/disclosure-projects`;
const ENG = '/assurance/engagements/[engagementId]';

const DISCLOSURE_READ: PermissionKey = 'enterprise.disclosure.read';
const DISCLOSURE_WRITE: PermissionKey = 'enterprise.disclosure.write';
const ENGAGEMENT_READ: PermissionKey = 'assurance.engagement.read';

function engagementRoute(
  segment: string,
  label: string,
  group: string,
  keywords: readonly string[],
): RouteCatalogEntry {
  return {
    pattern: `${ENG}/${segment}`,
    label,
    path: ['案件', group, label],
    href: `/assurance/engagements/{engagementId}/${segment}`,
    permission: ENGAGEMENT_READ,
    workspace: 'assurance',
    keywords,
    menu: 'assurance',
    engagement: true,
  };
}

export const ROUTE_CATALOG: readonly RouteCatalogEntry[] = [
  // ---- 企業: ホーム・業務 -------------------------------------------------
  {
    pattern: `${E}/dashboard`,
    label: 'ホーム',
    path: ['ホーム'],
    href: `${E}/dashboard`,
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['dashboard', 'ダッシュボード', '自分の作業', '次にやること'],
    menu: 'both',
  },
  {
    pattern: `${E}/workflows`,
    label: 'ワークフロー',
    path: ['業務管理', 'ワークフロー'],
    href: `${E}/workflows`,
    workspace: 'enterprise',
    keywords: ['承認', 'レビュー', 'タスク', 'PBC', '自分の作業・レビュー'],
    menu: 'both',
  },
  {
    pattern: `${E}/alerts`,
    label: 'アラート',
    path: ['業務管理', 'アラート'],
    href: `${E}/alerts`,
    workspace: 'enterprise',
    keywords: ['警告', '期限超過'],
    menu: 'both',
  },
  {
    pattern: `${E}/reports`,
    label: 'レポート',
    path: ['業務管理', 'レポート'],
    href: `${E}/reports`,
    workspace: 'enterprise',
    keywords: ['export', '出力', 'レポート出力'],
    menu: 'both',
  },
  {
    pattern: `${E}/roadmap`,
    label: '今後対応',
    path: ['今後対応'],
    href: `${E}/roadmap`,
    workspace: 'enterprise',
    keywords: ['ロードマップ', '予定', '未実装'],
    menu: 'none',
  },
  {
    pattern: `${E}/ai`,
    label: 'AI Copilot',
    path: ['AI Copilot'],
    href: `${E}/ai`,
    workspace: 'enterprise',
    keywords: ['AI', '生成', '対話'],
    menu: 'both',
  },
  // ---- 企業: SSBJ ----------------------------------------------------------
  {
    pattern: SSBJ,
    label: 'SSBJ 対応状況',
    path: ['開示対応', 'SSBJ', '対応状況'],
    href: SSBJ,
    workspace: 'enterprise',
    keywords: ['SSBJ', 'ギャップ', '全体状況'],
    menu: 'both',
  },
  {
    pattern: `${SSBJ}/requirements`,
    label: 'SSBJ 要求事項',
    path: ['開示対応', 'SSBJ', '要求事項'],
    href: `${SSBJ}/requirements`,
    workspace: 'enterprise',
    keywords: ['SSBJ', '要求事項', 'ギャップ分析', '評価'],
    menu: 'both',
  },
  {
    pattern: `${SSBJ}/requirements/[itemId]`,
    label: 'SSBJ 要求事項の詳細',
    path: ['開示対応', 'SSBJ', '要求事項', '詳細'],
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${SSBJ}/requirements/top-priority`,
    label: '最優先のギャップを開く',
    path: ['開示対応', 'SSBJ', '要求事項', '最優先のギャップ'],
    href: `${SSBJ}/requirements/top-priority`,
    workspace: 'enterprise',
    keywords: ['SSBJ', '優先', 'ギャップ', '次'],
    menu: 'none',
  },
  {
    pattern: `${SSBJ}/plans`,
    label: 'SSBJ 対応計画',
    path: ['開示対応', 'SSBJ', '対応計画'],
    href: `${SSBJ}/plans`,
    workspace: 'enterprise',
    keywords: ['SSBJ', '対応計画', '担当', '期限'],
    menu: 'both',
  },
  {
    pattern: `${SSBJ}/collection`,
    label: 'SSBJ データ収集',
    path: ['開示対応', 'SSBJ', 'データ収集'],
    href: `${SSBJ}/collection`,
    workspace: 'enterprise',
    keywords: ['SSBJ', 'データ収集', '不足データ'],
    menu: 'both',
  },
  {
    pattern: `${SSBJ}/draft`,
    label: 'SSBJ 開示ドラフト',
    path: ['開示対応', 'SSBJ', '開示ドラフト'],
    href: `${SSBJ}/draft`,
    workspace: 'enterprise',
    keywords: ['SSBJ', 'ドラフト', '草案', '開示文書', 'Word'],
    menu: 'both',
  },
  {
    pattern: `${SSBJ}/settings`,
    label: 'SSBJ マテリアリティ・分析条件の設定',
    path: ['開示対応', 'SSBJ', '設定'],
    href: `${SSBJ}/settings`,
    workspace: 'enterprise',
    keywords: ['SSBJ', 'マテリアリティ', '重要性', '分析条件', '設定'],
    menu: 'none',
  },
  // ---- 企業: CDP・その他の開示 ---------------------------------------------
  {
    pattern: CDP,
    label: 'CDP',
    path: ['開示対応', 'CDP'],
    href: CDP,
    workspace: 'enterprise',
    keywords: ['CDP', '気候変動', '質問書'],
    menu: 'both',
  },
  {
    pattern: `${CDP}/[questionId]`,
    label: 'CDP 質問',
    path: ['開示対応', 'CDP', '質問'],
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${CDP}/import`,
    label: 'CDP 過去回答の取込',
    path: ['開示対応', 'CDP', '過去回答の取込'],
    href: `${CDP}/import`,
    permission: DISCLOSURE_WRITE,
    workspace: 'enterprise',
    keywords: ['CDP', '過去回答', '取込', '前年'],
    menu: 'none',
  },
  {
    pattern: `${E}/disclosures/[framework]`,
    label: 'MSCI',
    path: ['開示対応', 'MSCI'],
    href: `${E}/disclosures/msci`,
    workspace: 'enterprise',
    keywords: ['MSCI', '評価機関'],
    menu: 'both',
  },
  {
    pattern: `${E}/disclosures/[framework]`,
    label: 'FTSE',
    path: ['開示対応', 'FTSE'],
    href: `${E}/disclosures/ftse`,
    workspace: 'enterprise',
    keywords: ['FTSE', '評価機関'],
    menu: 'both',
  },
  // ---- 企業: CSRD ----------------------------------------------------------
  {
    pattern: CSRD,
    label: 'CSRD 対応状況',
    path: ['開示対応', 'CSRD', '対応状況'],
    href: CSRD,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['CSRD', 'ESRS', 'ダブル・マテリアリティ', 'DMA'],
    menu: 'both',
  },
  {
    pattern: `${CSRD}/requirements`,
    label: 'CSRD 要求事項',
    path: ['開示対応', 'CSRD', '要求事項'],
    href: `${CSRD}/requirements`,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['CSRD', 'ESRS', '要求事項', 'ギャップ分析', '適用'],
    menu: 'both',
  },
  {
    pattern: `${CSRD}/requirements/[itemId]`,
    label: 'CSRD 要求事項の詳細',
    path: ['開示対応', 'CSRD', '要求事項', '詳細'],
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${CSRD}/[questionId]`,
    label: 'CSRD 開示項目',
    path: ['開示対応', 'CSRD', '要求事項', '回答'],
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${CSRD}/plans`,
    label: 'CSRD 対応計画',
    path: ['開示対応', 'CSRD', '対応計画'],
    href: `${CSRD}/plans`,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['CSRD', 'ESRS', '対応計画', '担当', '期限'],
    menu: 'both',
  },
  {
    pattern: `${CSRD}/collection`,
    label: 'CSRD データ収集',
    path: ['開示対応', 'CSRD', 'データ収集'],
    href: `${CSRD}/collection`,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['CSRD', 'ESRS', 'データ収集', '不足データ'],
    menu: 'both',
  },
  {
    pattern: `${CSRD}/draft`,
    label: 'CSRD 開示ドラフト',
    path: ['開示対応', 'CSRD', '開示ドラフト'],
    href: `${CSRD}/draft`,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['CSRD', 'ESRS', 'ドラフト', '草案', '開示文書'],
    menu: 'both',
  },
  {
    pattern: `${CSRD}/settings`,
    label: 'CSRD 設定（報告範囲・ダブル・マテリアリティ評価）',
    path: ['開示対応', 'CSRD', '設定'],
    href: `${CSRD}/settings`,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['CSRD', 'DMA', '報告範囲', '評価方法', 'ダブル・マテリアリティ', '設定'],
    menu: 'none',
  },
  {
    pattern: `${CSRD}/settings/matters/[topic]`,
    label: 'CSRD サステナビリティ事項の評価',
    path: ['開示対応', 'CSRD', '設定', '事項の評価'],
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    menu: 'none',
  },
  // ---- 企業: 定性情報・開示プロジェクト ------------------------------------
  {
    pattern: `${E}/narratives`,
    label: '定性情報',
    path: ['情報・根拠', '定性情報'],
    href: `${E}/narratives`,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['定性', 'ガバナンス', 'リスク', '機会', '財務的影響', '戦略'],
    menu: 'both',
  },
  {
    pattern: `${E}/narratives/new`,
    label: '定性情報の登録',
    path: ['情報・根拠', '定性情報', '登録'],
    href: `${E}/narratives/new`,
    permission: DISCLOSURE_WRITE,
    workspace: 'enterprise',
    keywords: ['定性', '登録', '新規', '資料から候補'],
    menu: 'none',
  },
  {
    pattern: `${E}/narratives/[narrativeId]`,
    label: '定性情報の編集',
    path: ['情報・根拠', '定性情報', '編集'],
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: PROJECTS,
    label: '開示プロジェクト',
    path: ['開示プロジェクト'],
    href: PROJECTS,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['開示', 'プロジェクト', '原稿', 'レビュー', '承認', '出力'],
    menu: 'disclosure',
  },
  {
    pattern: `${PROJECTS}/new`,
    label: '開示プロジェクトの作成',
    path: ['開示プロジェクト', '作成'],
    href: `${PROJECTS}/new`,
    permission: DISCLOSURE_WRITE,
    workspace: 'enterprise',
    keywords: ['プロジェクト', '作成', '新規'],
    menu: 'none',
  },
  {
    pattern: `${PROJECTS}/[projectId]`,
    label: '開示プロジェクトの詳細',
    path: ['開示プロジェクト', '詳細'],
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${PROJECTS}/[projectId]/blocks/[blockId]`,
    label: '原稿編集',
    path: ['開示プロジェクト', '原稿'],
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${PROJECTS}/[projectId]/blocks/[blockId]/recheck`,
    label: '引用先の再確認',
    path: ['開示プロジェクト', '原稿', '引用先の再確認'],
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    menu: 'none',
  },
  // ---- 企業: データ・取込・資料・GHG ---------------------------------------
  {
    pattern: `${E}/data`,
    label: '非財務データ',
    path: ['ESG データ（GHG以外）', '非財務データ'],
    href: `${E}/data`,
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['data point', '台帳', '指標', '定量データ'],
    menu: 'both',
  },
  {
    pattern: `${E}/data/[dataPointId]`,
    label: 'データの詳細',
    path: ['ESG データ（GHG以外）', '非財務データ', '詳細'],
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${E}/imports`,
    label: 'データ取込',
    path: ['ESG データ（GHG以外）', 'データ取込'],
    href: `${E}/imports`,
    workspace: 'enterprise',
    keywords: ['import', '取込', 'アップロード', 'データ収集'],
    menu: 'both',
  },
  {
    pattern: `${E}/imports/[jobId]`,
    label: '取込プレビュー',
    path: ['ESG データ（GHG以外）', 'データ取込', '取込の確認'],
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${E}/imports/standard`,
    label: '数値を登録（標準CSV）',
    path: ['ESG データ（GHG以外）', 'データ取込', '標準CSV'],
    href: `${E}/imports/standard`,
    permission: 'enterprise.import.run',
    workspace: 'enterprise',
    keywords: ['CSV', '標準', '手入力', '数値', '登録'],
    menu: 'disclosure',
  },
  {
    pattern: `${E}/evidence`,
    label: 'Evidence',
    path: ['ESG データ（GHG以外）', 'Evidence'],
    href: `${E}/evidence`,
    // サプライヤー担当（登録だけできる）も開ける
    permission: ['enterprise.evidence.read', 'enterprise.evidence.write'],
    workspace: 'enterprise',
    keywords: ['証憑', '根拠', '資料', '証跡', '資料・証跡'],
    menu: 'both',
  },
  {
    pattern: `${E}/evidence/[fileId]`,
    label: '資料の詳細',
    path: ['ESG データ（GHG以外）', 'Evidence', '詳細'],
    permission: 'enterprise.evidence.read',
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${E}/ghg`,
    label: 'GHG 算定サマリー',
    path: ['GHG', '算定サマリー'],
    href: `${E}/ghg`,
    workspace: 'enterprise',
    keywords: ['scope1', 'scope2', 'scope3', '排出量', '連結集計', '排出係数', 'GHG算定'],
    menu: 'both',
  },
  {
    pattern: `${E}/ghg/suppliers`,
    label: 'Scope3データ取込（Cat.1）',
    path: ['GHG', 'Scope3データ取込', 'Cat.1'],
    href: `${E}/ghg/suppliers`,
    workspace: 'enterprise',
    keywords: ['GHG', 'scope3', 'サプライヤー', '一次データ', '購買', 'サプライヤーデータ取込'],
    menu: 'both',
  },
  // ---- 企業: ESG経営・分析 -------------------------------------------------
  {
    pattern: `${E}/esg`,
    label: 'ESG経営',
    path: ['ESG経営'],
    href: `${E}/esg`,
    workspace: 'enterprise',
    keywords: ['KPI', '目標', '推移', '経営'],
    menu: 'disclosure',
  },
  {
    pattern: `${E}/esg/[kpiKey]`,
    label: 'ESG経営 KPI の詳細',
    path: ['ESG経営', 'KPI の詳細'],
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${E}/esg/targets`,
    label: 'ESG経営の目標',
    path: ['ESG経営', '目標'],
    href: `${E}/esg/targets`,
    workspace: 'enterprise',
    keywords: ['目標', 'KPI', '削減目標', '基準年'],
    menu: 'none',
  },
  {
    pattern: `${E}/analysis`,
    label: '分析',
    path: ['分析'],
    workspace: 'enterprise',
    menu: 'none',
    // 現状診断へのリダイレクト専用
    entryOnly: true,
  },
  {
    pattern: `${E}/analysis/diagnosis`,
    label: '現状診断',
    path: ['分析', '現状診断'],
    href: `${E}/analysis/diagnosis`,
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['分析', '診断', '現状', '不足', 'データ品質', '網羅性'],
    menu: 'both',
  },
  {
    pattern: `${E}/analysis/regulations`,
    label: '規制対応度',
    path: ['分析', '規制対応度'],
    href: `${E}/analysis/regulations`,
    permission: DISCLOSURE_READ,
    workspace: 'enterprise',
    keywords: ['分析', '規制', '対応度', '基準', 'SSBJ', 'CSRD', 'ESRS', 'CDP'],
    menu: 'both',
  },
  {
    pattern: `${E}/analysis/trends`,
    label: '自社経年比較',
    path: ['分析', '自社経年比較'],
    href: `${E}/analysis/trends`,
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['経年', '推移', '前年比', '年度比較'],
    menu: 'both',
  },
  {
    pattern: `${E}/analysis/benchmark`,
    label: '他社比較',
    path: ['分析', '他社比較'],
    href: `${E}/analysis/benchmark`,
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['分析', '他社', '比較', 'ベンチマーク', 'benchmark', '同業', 'ピア'],
    menu: 'both',
  },
  {
    pattern: `${E}/analysis/financial-impact`,
    label: '財務影響分析',
    path: ['分析', '財務影響分析'],
    href: `${E}/analysis/financial-impact`,
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['財務', '影響', 'シミュレーション', '経路', '炭素価格', 'シナリオ'],
    menu: 'both',
  },
  // ---- 企業: 管理 ----------------------------------------------------------
  {
    pattern: `${E}/organizations`,
    label: '組織・拠点',
    path: ['管理', '組織・拠点'],
    href: `${E}/organizations`,
    workspace: 'enterprise',
    keywords: ['組織', '拠点', '連結', '指標マスター', '報告年度', 'キャンペーン'],
    menu: 'both',
  },
  // 指標マスターの追加・編集とキャンペーンの作成は、モーダルから専用ページへ移した（plan §4 B6・S10）
  {
    pattern: `${E}/organizations/metrics/new`,
    label: '指標を追加',
    path: ['管理', '組織・拠点', '指標を追加'],
    href: `${E}/organizations/metrics/new`,
    permission: 'enterprise.metric.manage',
    workspace: 'enterprise',
    keywords: ['指標', 'マスター', '追加', 'KPI'],
    menu: 'none',
  },
  {
    pattern: `${E}/organizations/metrics/[metricId]`,
    label: '指標を編集',
    path: ['管理', '組織・拠点', '指標を編集'],
    permission: 'enterprise.metric.manage',
    workspace: 'enterprise',
    menu: 'none',
  },
  {
    pattern: `${E}/organizations/campaigns/new`,
    label: '収集キャンペーンを作成',
    path: ['管理', '組織・拠点', '収集キャンペーンを作成'],
    href: `${E}/organizations/campaigns/new`,
    permission: 'enterprise.period.manage',
    workspace: 'enterprise',
    keywords: ['キャンペーン', '収集', '依頼'],
    menu: 'none',
  },
  {
    pattern: `${E}/settings`,
    label: '設定',
    path: ['管理', '設定'],
    href: `${E}/settings`,
    // ページのゲートと同じ企業管理者だけ（権限の挙動は変えない。R1・plan Q6 は見送り）
    permission: 'enterprise.org.manage',
    workspace: 'enterprise',
    keywords: ['設定', 'メンバー', '招待', 'セキュリティ', 'アクセス許諾', '開示優先モード'],
    menu: 'both',
  },
  // ---- 監査法人 --------------------------------------------------------------
  {
    pattern: '/assurance/dashboard',
    label: '案件ホーム',
    path: ['案件ホーム'],
    href: '/assurance/dashboard',
    workspace: 'assurance',
    keywords: ['dashboard', 'ホーム'],
    menu: 'assurance',
  },
  {
    pattern: '/assurance/engagements',
    label: '保証契約',
    path: ['保証契約'],
    href: '/assurance/engagements',
    workspace: 'assurance',
    keywords: ['engagement', '案件', '一覧'],
    menu: 'assurance',
  },
  {
    pattern: '/assurance/settings',
    label: '設定',
    path: ['設定'],
    href: '/assurance/settings',
    permission: 'assurance.firm.manage',
    workspace: 'assurance',
    keywords: ['設定', 'メンバー', '法人'],
    menu: 'assurance',
  },
  engagementRoute('overview', '案件の概要', '計画', ['概要', '進捗', 'チーム']),
  engagementRoute('scope', 'スコープ', '計画', ['scope', '範囲', '対象範囲']),
  engagementRoute('data-room', 'Data Room', '実施', ['共有', 'snapshot', 'Snapshot']),
  engagementRoute('population', '母集団', '実施', ['population', '完全性']),
  engagementRoute('sampling', 'サンプリング', '実施', ['sample', '抽出']),
  engagementRoute('testing', '保証手続・調書', '実施', ['test', '調書', 'workpaper', '手続']),
  engagementRoute('requests', 'PBC／資料依頼', '実施', ['pbc', '依頼', '資料依頼']),
  engagementRoute('issues', '指摘・例外', '実施', ['issue', '指摘', '例外']),
  engagementRoute('review-notes', 'レビューNote', '結論', ['review', 'レビュー']),
  engagementRoute('signoffs', 'Sign-off', '結論', ['signoff', '承認', 'サインオフ']),
  engagementRoute('audit-trail', '監査ログ', '記録', ['audit', 'ログ', '履歴']),
  // 出力は出力の権限（assurance.export.run）でだけ使える。権限の無い役割のパレットには出さない（メニューと同じ）
  {
    ...engagementRoute('exports', '出力', '記録', ['export', '出力', 'Export', 'ダウンロード']),
    permission: 'assurance.export.run',
  },
  // ---- 共通 -----------------------------------------------------------------
  {
    pattern: '/notifications',
    label: '通知',
    path: ['通知'],
    href: '/notifications',
    workspace: 'common',
    keywords: ['通知', 'お知らせ', '未読'],
    menu: 'header',
  },
  {
    pattern: '/profile',
    label: 'プロフィール',
    path: ['プロフィール'],
    href: '/profile',
    workspace: 'common',
    keywords: ['プロフィール', '自分', '権限', 'パスワード'],
    menu: 'header',
  },
  {
    pattern: '/workspace',
    label: 'ワークスペース選択',
    path: ['ワークスペース選択'],
    href: '/workspace',
    workspace: 'common',
    keywords: ['ワークスペース', '切替', '組織'],
    menu: 'header',
  },
  // ---- 認証・入口 -----------------------------------------------------------
  {
    pattern: '/',
    label: 'トップ',
    path: ['トップ'],
    workspace: 'auth',
    menu: 'none',
    entryOnly: true,
  },
  {
    pattern: '/login',
    label: 'ログイン',
    path: ['ログイン'],
    workspace: 'auth',
    menu: 'none',
    entryOnly: true,
  },
  {
    pattern: '/mfa',
    label: '多要素認証',
    path: ['多要素認証'],
    workspace: 'auth',
    menu: 'none',
    entryOnly: true,
  },
  {
    pattern: '/reset',
    label: 'パスワード再設定',
    path: ['パスワード再設定'],
    workspace: 'auth',
    menu: 'none',
    entryOnly: true,
  },
  {
    pattern: '/invite/[invitationId]',
    label: '招待の受諾',
    path: ['招待の受諾'],
    workspace: 'auth',
    menu: 'none',
    entryOnly: true,
  },
];

// ----------------------------------------------------------------------
// 照合
// ----------------------------------------------------------------------

function patternToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((segment) =>
      /^\[[^\]]+\]$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${body}$`);
}

const COMPILED = ROUTE_CATALOG.map((entry) => ({ entry, re: patternToRegExp(entry.pattern) }));

/**
 * pathname に当たる画面（固定セグメントの多いものを優先。例: /ssbj/requirements/top-priority は
 * [itemId] より top-priority）。無ければ null
 */
export function routeForPath(pathname: string): RouteCatalogEntry | null {
  const path = pathname.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  const hits = COMPILED.filter(({ re }) => re.test(path)).map(({ entry }) => entry);
  if (hits.length === 0) return null;
  const staticScore = (entry: RouteCatalogEntry) =>
    entry.pattern.split('/').filter((s) => s && !s.startsWith('[')).length;
  // 同じパターン（MSCI・FTSE）は href が一致するものを優先
  return (
    hits.find((entry) => entry.href === path) ??
    [...hits].sort((a, b) => staticScore(b) - staticScore(a))[0]!
  );
}

/** そのパターンが動的セグメントを含むか（詳細画面） */
export function isDynamicPattern(pattern: string): boolean {
  return /\[[^\]]+\]/.test(pattern);
}

/** 権限の条件（配列はどれか 1 つ）を満たすか */
export function canOpenRoute(
  entry: Pick<RouteCatalogEntry, 'permission'>,
  can: (permission: PermissionKey) => boolean,
): boolean {
  if (!entry.permission) return true;
  const list: readonly PermissionKey[] =
    typeof entry.permission === 'string' ? [entry.permission] : entry.permission;
  return list.some((permission) => can(permission));
}

/** 案件の画面の行き先（案件を選んでいないときは null） */
export function resolveRouteHref(
  entry: RouteCatalogEntry,
  engagementId: string | null,
): string | null {
  if (!entry.href) return null;
  if (!entry.engagement) return entry.href;
  return engagementId
    ? entry.href.replace('{engagementId}', encodeURIComponent(engagementId))
    : null;
}
