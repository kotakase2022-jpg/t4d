/**
 * 危険な操作の表（plan §1.16・§5.2 dangerous-ops）の型。スライスごとのファイルに分け、
 * 各スライスが自分の操作を確認ダイアログ（ConfirmDialog・kind: 'confirm'）か「元に戻す」へ移したら
 * status を 'done' にし、起点のファイル（origins）を移した先に直す。
 */
export interface DangerousOp {
  /** 機能 ID（docs/ui-redesign/inventory-features.md） */
  id: string;
  label: string;
  /** 1 不可逆・2 一括／上書き・3 可逆（実行後に元に戻す） */
  tier: 'irreversible' | 'bulk' | 'reversible';
  /** Server Action（'src/…#名前'） */
  action: string;
  /** 操作を起動する部品・画面のファイル（どれか 1 つが確認・元に戻すを持てばよい） */
  origins: string[];
  status: 'done' | 'pending';
  note?: string;
}
