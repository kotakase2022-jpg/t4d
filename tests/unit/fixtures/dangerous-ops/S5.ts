import type { DangerousOp } from './types';

/**
 * Scope1・2 の算定と照合（2026-10-16 の要望）のスライス S5 トライアル範囲・条件・データ取扱・削除。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * Stage A は空で置く（機能 ID は既存と重ならない F 番号を使う）
 */
export const S5_DANGEROUS_OPS: DangerousOp[] = [];
