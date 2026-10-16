import type { RouteCatalogEntry } from '../route-catalog';
import { ENTERPRISE_BASE } from './helpers';

/**
 * Scope1・2 の算定と照合（2026-10-16 の要望）のスライス S1 係数セット・割当・算定ルール が持つ画面。
 * Stage A が仮ページと一緒に置き、S1 が画面を置き換えた（P91 係数セットの一覧・取込と割当、P92 係数の表と有効化、
 * P93 丸め・換算・改良トンキロ法の組織の設定と区分規則）。
 * メニュー木には載せない（menu: 'none'。P90 の画面上部のタブ・Command Palette・画面内リンクから届かせる。plan K2）
 */
const CALC = `${ENTERPRISE_BASE}/ghg/calculation`;

export const S1_ROUTES: readonly RouteCatalogEntry[] = [
  {
    pattern: `${CALC}/factors`,
    label: '排出係数（Scope1・2算定）',
    path: ['GHG', 'Scope1・2算定', '排出係数'],
    href: `${CALC}/factors`,
    // 閲覧は enterprise.data.read（loadCalcContext と各サービスの読み取りと同じ）
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: [
      '係数セット',
      '係数セットを取り込む',
      '排出係数',
      '割当',
      '未割当',
      '単位発熱量',
      '炭素排出係数',
      '電力',
      'ロケーション基準',
      'マーケット基準',
      '改良トンキロ法',
      '見なし積載率',
    ],
    menu: 'none',
  },
  {
    pattern: `${CALC}/factors/[setId]`,
    label: '係数セットの詳細',
    path: ['GHG', 'Scope1・2算定', '排出係数', '係数セットの詳細'],
    // 閲覧は enterprise.data.read（loadCalcContext と各サービスの読み取りと同じ）
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: ['係数セット', '排出係数', '有効化', '取り下げ', '組織指定', '公的参照'],
    menu: 'none',
  },
  {
    pattern: `${CALC}/rules`,
    label: '算定ルール（Scope1・2算定）',
    path: ['GHG', 'Scope1・2算定', '算定ルール'],
    href: `${CALC}/rules`,
    // 閲覧は enterprise.data.read（loadCalcContext と各サービスの読み取りと同じ）
    permission: 'enterprise.data.read',
    workspace: 'enterprise',
    keywords: [
      '丸め',
      '単位換算',
      '算定方針',
      '区分規則',
      '区分規則の承認',
      '報告区分',
      '既定区分',
      '委託物流',
      '改良トンキロ法の設定',
      '積載率',
    ],
    menu: 'none',
  },
];
