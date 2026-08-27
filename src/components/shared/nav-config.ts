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

export const ENTERPRISE_NAV: NavItem[] = [
  {
    label: 'ホーム',
    href: '/enterprise/dashboard',
    icon: Home,
    keywords: ['dashboard', 'ダッシュボード'],
  },
  {
    label: 'データ収集',
    href: '/enterprise/imports',
    icon: Upload,
    keywords: ['import', '取込', 'アップロード'],
  },
  {
    label: '非財務データ',
    href: '/enterprise/data',
    icon: Database,
    keywords: ['data point', '台帳', '指標'],
  },
  {
    label: '組織・拠点',
    href: '/enterprise/organizations',
    icon: Boxes,
    keywords: ['組織', '拠点', '連結'],
  },
  { label: 'Evidence', href: '/enterprise/evidence', icon: FolderOpen, keywords: ['証憑', '根拠'] },
  {
    label: 'ワークフロー',
    href: '/enterprise/workflows',
    icon: Workflow,
    keywords: ['承認', 'レビュー', 'タスク', 'PBC'],
  },
  {
    label: 'GHG',
    href: '/enterprise/ghg',
    icon: Gauge,
    keywords: ['scope1', 'scope2', 'scope3', '排出量'],
  },
  {
    label: '開示対応',
    // 開示対応の起点は SSBJ。CDP・CSRD は SSBJ で整えたデータの展開先という位置づけ
    href: '/enterprise/disclosures/ssbj',
    icon: FileStack,
    keywords: ['disclosure', '開示'],
    children: [
      {
        label: 'SSBJ 対応状況',
        href: '/enterprise/disclosures/ssbj',
        icon: Gauge,
        keywords: ['SSBJ', 'ギャップ', '全体状況'],
      },
      {
        label: 'SSBJ 要求事項',
        href: '/enterprise/disclosures/ssbj/requirements',
        icon: ListChecks,
        keywords: ['SSBJ', '要求事項', 'ギャップ分析'],
      },
      {
        label: 'SSBJ 対応計画',
        href: '/enterprise/disclosures/ssbj/plans',
        icon: ClipboardList,
        keywords: ['SSBJ', '対応計画', '担当', '期限'],
      },
      {
        label: 'SSBJ データ収集',
        href: '/enterprise/disclosures/ssbj/collection',
        icon: Database,
        keywords: ['SSBJ', 'データ収集', '不足データ'],
      },
      { label: 'CDP', href: '/enterprise/disclosures/cdp', icon: FileSpreadsheet },
      { label: 'CSRD', href: '/enterprise/disclosures/csrd', icon: FileSpreadsheet },
      { label: 'MSCI', href: '/enterprise/disclosures/msci', icon: FileSpreadsheet },
      { label: 'FTSE', href: '/enterprise/disclosures/ftse', icon: FileSpreadsheet },
    ],
  },
  {
    label: 'アラート',
    href: '/enterprise/alerts',
    icon: AlertTriangle,
    keywords: ['警告', '期限超過'],
  },
  { label: 'AI Copilot', href: '/enterprise/ai', icon: Bot, keywords: ['AI', '生成'] },
  {
    label: 'レポート',
    href: '/enterprise/reports',
    icon: ScrollText,
    keywords: ['export', '出力'],
  },
  {
    label: '設定',
    href: '/enterprise/settings',
    icon: Settings,
    permission: 'enterprise.org.manage',
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
