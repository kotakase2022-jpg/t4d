import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  BadgeCheck,
  Bot,
  Boxes,
  ClipboardList,
  Database,
  FileSearch,
  FileSpreadsheet,
  FileStack,
  FileText,
  Filter,
  FolderOpen,
  Gauge,
  Home,
  Inbox,
  Layers,
  ListChecks,
  MessageSquareWarning,
  PenLine,
  ScrollText,
  Settings,
  ShieldCheck,
  Signature,
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
}

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
      { label: 'CSRD', href: '/enterprise/disclosures/csrd', icon: FileSpreadsheet },
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
