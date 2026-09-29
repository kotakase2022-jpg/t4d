import { describe, expect, it } from 'vitest';
import {
  isOldRefKept,
  latestRecheckDecision,
  type RecheckDecisionFacts,
} from '@/lib/domain/disclosure-block';

/**
 * 再確認の判断（recheck_decisions）の効き方。
 * 原稿画面（disclosure-recheck.ts）・ホーム（disclosure-home.ts）・レポートの確定
 * （report-snapshot.ts）が同じこの関数を使う。
 */

const target = {
  blockId: 'b1',
  refKind: 'metric' as const,
  oldRefId: 'v1',
  newRefId: 'v2',
  newApproved: true,
};

function decision(
  id: string,
  decisionKind: RecheckDecisionFacts['decision'],
  decidedAt: string,
  overrides: Partial<RecheckDecisionFacts> = {},
): RecheckDecisionFacts {
  const { newApproved, ...keys } = target;
  return {
    id,
    ...keys,
    decision: decisionKind,
    decidedAt,
    newRefApproved: newApproved,
    ...overrides,
  };
}

describe('再確認の判断', () => {
  it('判断が無ければ維持していない', () => {
    expect(latestRecheckDecision([], target)).toBeNull();
    expect(isOldRefKept([], target)).toBe(false);
  });

  it('維持の判断は、判断した時点の節の版に縛られない（節単位で効く）', () => {
    // RecheckDecisionFacts は block_version_id を持たない＝判定に使わない
    expect(isOldRefKept([decision('d1', 'keep_old', '2026-08-01T00:00:00Z')], target)).toBe(true);
  });

  it('同じ組み合わせは最後の判断が有効（維持の後に差戻しなら維持は無効）', () => {
    const decisions = [
      decision('d1', 'keep_old', '2026-08-01T00:00:00Z'),
      decision('d2', 'return_to_owner', '2026-08-02T00:00:00Z'),
    ];
    expect(latestRecheckDecision(decisions, target)?.id).toBe('d2');
    expect(isOldRefKept(decisions, target)).toBe(false);
    // 並び順に依存しない
    expect(isOldRefKept([...decisions].reverse(), target)).toBe(false);
  });

  it('上流にさらに新しい版ができると組み合わせが変わり、改めて判断が要る', () => {
    const decisions = [decision('d1', 'keep_old', '2026-08-01T00:00:00Z')];
    expect(isOldRefKept(decisions, { ...target, newRefId: 'v3' })).toBe(false);
  });

  it('別の節・別の種類の判断は数えない', () => {
    const decisions = [
      decision('d1', 'keep_old', '2026-08-01T00:00:00Z', { blockId: 'b2' }),
      decision('d2', 'keep_old', '2026-08-01T00:00:00Z', { refKind: 'narrative' }),
    ];
    expect(isOldRefKept(decisions, target)).toBe(false);
  });

  it('同時刻は id の小さい方を採る（並びが揺れない）', () => {
    const decisions = [
      decision('d2', 'return_to_owner', '2026-08-01T00:00:00Z'),
      decision('d1', 'keep_old', '2026-08-01T00:00:00Z'),
    ];
    expect(latestRecheckDecision(decisions, target)?.id).toBe('d1');
  });

  // INV-1: 新しい版が未承認のときの「維持」は、その版が承認されたら前提が崩れる
  it('新しい版が未承認のときに維持した判断は、その版が承認されると無効になる', () => {
    const decisions = [
      decision('d1', 'keep_old', '2026-08-01T00:00:00Z', { newRefApproved: false }),
    ];
    // まだ未承認: 維持は有効
    expect(isOldRefKept(decisions, { ...target, newApproved: false })).toBe(true);
    // 承認された: 維持は無効（再確認を求める）
    expect(isOldRefKept(decisions, { ...target, newApproved: true })).toBe(false);
    expect(latestRecheckDecision(decisions, { ...target, newApproved: true })).toBeNull();
  });

  it('新しい版が承認済みのときに維持した判断は、そのまま有効', () => {
    const decisions = [
      decision('d1', 'keep_old', '2026-08-01T00:00:00Z', { newRefApproved: true }),
    ];
    expect(isOldRefKept(decisions, { ...target, newApproved: true })).toBe(true);
  });

  it('判断の時点の承認状態が分からない維持（0042 より前の行）は、承認済みの新版には効かない', () => {
    const legacy = [
      decision('d1', 'keep_old', '2026-08-01T00:00:00Z', { newRefApproved: undefined }),
    ];
    expect(isOldRefKept(legacy, { ...target, newApproved: true })).toBe(false);
    expect(isOldRefKept(legacy, { ...target, newApproved: false })).toBe(true);
  });

  it('無効になった維持の前の判断が、最後の有効な判断として残る', () => {
    const decisions = [
      decision('d1', 'return_to_owner', '2026-08-01T00:00:00Z'),
      decision('d2', 'keep_old', '2026-08-02T00:00:00Z', { newRefApproved: false }),
    ];
    expect(latestRecheckDecision(decisions, { ...target, newApproved: true })?.id).toBe('d1');
    expect(latestRecheckDecision(decisions, { ...target, newApproved: false })?.id).toBe('d2');
  });
});
