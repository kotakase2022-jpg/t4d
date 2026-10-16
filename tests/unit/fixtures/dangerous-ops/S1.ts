import type { DangerousOp } from './types';

/**
 * Scope1・2 の算定と照合（2026-10-16 の要望）のスライス S1 係数セット・割当・算定ルール（係数セットの有効化・取り下げ、区分規則の承認・取り下げ など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.15 の F202〜F211（S1 の機能）のうち危険な操作。
 *
 * 表に載せないもの（取り消せない変更ではないため）:
 *  - 係数セットの取込の確定: 下書きのセットを作るだけ（算定に使うのは有効にした後。有効化はこの表の F204）
 *  - 算定方針の保存: 新しい版を積むだけで前の版は残る（追記専用）
 *  - 係数の割当・区分規則の提案: 割り当て直し・取り下げができる。承認・取り下げ・割当を外すはこの表にある
 */
export const S1_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F204',
    label: '係数のセットの有効化（以後、係数を変更できない）',
    tier: 'irreversible',
    action: 'src/app/enterprise/ghg/calculation/factors/actions.ts#activateFactorSetAction',
    origins: ['src/app/enterprise/ghg/calculation/factors/[setId]/page.tsx'],
    status: 'done',
    note: '係数のセットの詳細の見出しの「有効にする」→ 確認ダイアログ（範囲＝セットのコード・版・係数の件数）',
  },
  {
    id: 'F205',
    label: '係数のセットの取り下げ（割当は残り、算定はエラーになる）',
    tier: 'irreversible',
    action: 'src/app/enterprise/ghg/calculation/factors/actions.ts#retireFactorSetAction',
    origins: ['src/app/enterprise/ghg/calculation/factors/[setId]/page.tsx'],
    status: 'done',
    note: '係数のセットの詳細の「その他 ▾ > 取り下げる…」→ 確認ダイアログ（使っている割当の件数・理由は任意）',
  },
  {
    id: 'F210',
    label: '区分規則の承認（報告区分が変わる。提案者は承認できない）',
    tier: 'irreversible',
    action: 'src/app/enterprise/ghg/calculation/rules/actions.ts#approveRuleAction',
    origins: ['src/app/enterprise/ghg/calculation/rules/page.tsx'],
    status: 'done',
    note: '算定ルールの区分規則の行の「承認する」→ 確認ダイアログ（範囲＝規則のコード・名称・区分の移動、根拠）',
  },
  {
    id: 'F211',
    label: '区分規則の取り下げ（報告区分が既定区分に戻る）',
    tier: 'irreversible',
    action: 'src/app/enterprise/ghg/calculation/rules/actions.ts#withdrawRuleAction',
    origins: ['src/app/enterprise/ghg/calculation/rules/page.tsx'],
    status: 'done',
    note: '算定ルールの区分規則の行の「操作 ▾ > 取り下げる…」→ 確認ダイアログ（理由は任意）',
  },
  {
    id: 'F207',
    label: '係数の割当を外す（その活動は算定でエラーになりうる）',
    tier: 'irreversible',
    action: 'src/app/enterprise/ghg/calculation/factors/actions.ts#clearAssignmentAction',
    origins: ['src/app/enterprise/ghg/calculation/factors/page.tsx'],
    status: 'done',
    note: '排出係数の「割当」の「いまの割当」の行の「操作 ▾ > 割当を外す…」→ 確認ダイアログ（範囲＝期間・範囲・活動）',
  },
];
