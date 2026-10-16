import { describe, expect, it } from 'vitest';
import {
  mergeTrialOptions,
  parseTrialOptions,
  validateTrialOptionsPatch,
  verificationUnitIds,
} from '@/lib/domain/trial-options';

/**
 * トライアル計画の任意の設定（plan §2.2 trial-options.ts・K9・CR-20〜CR-26）。期間は ID、拠点は組織の拠点、
 * 総拠点数 ≥ 検証拠点数、メモ 100 字（Demo）、PDF の目安 0〜100,000。既存のキーは残す。
 */

const CTX = {
  organizationPeriodIds: new Set(['p-cy']),
  organizationUnitIds: new Set(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']),
  includedUnitIds: ['u1', 'u2', 'u3'],
  demo: true,
};

describe('parseTrialOptions', () => {
  it('形の違う値は無いものとして読む（推測で埋めない）。既存のキーは見ない', () => {
    const parsed = parseTrialOptions({
      cdp: { planned: true },
      ghgVerification: {
        periodId: 'p-cy',
        unitIds: ['u1', 'u2'],
        scopes: ['scope1', 'scopeX'],
        activityKinds: ['fuel', 'oil'],
      },
      rollout: { totalSites: 30, note: '（架空）' },
      freeScope: { pdfFiles: -1 },
      disposal: { plannedOn: '2027/01/01' },
    });
    expect(parsed.ghgVerification).toEqual({
      periodId: 'p-cy',
      unitIds: ['u1', 'u2'],
      scopes: ['scope1'],
      activityKinds: ['fuel'],
    });
    expect(parsed.rollout).toEqual({ totalSites: 30, note: '（架空）' });
    expect(parsed.freeScope).toEqual({ pdfFiles: null });
    expect(parsed.disposal).toEqual({ plannedOn: null });
    expect(parseTrialOptions({})).toEqual({
      ghgVerification: null,
      rollout: null,
      freeScope: null,
      disposal: null,
    });
  });

  it('算定の検証拠点が空なら計画の対象拠点', () => {
    expect(verificationUnitIds(parseTrialOptions({}), ['u1'])).toEqual(['u1']);
    expect(
      verificationUnitIds(parseTrialOptions({ ghgVerification: { unitIds: ['u5'] } }), ['u1']),
    ).toEqual(['u5']);
  });
});

describe('validateTrialOptionsPatch', () => {
  it('総拠点数が検証拠点数より少なければエラー（展開対象は全体の数）', () => {
    const errors = validateTrialOptionsPatch(
      {
        ghgVerification: {
          periodId: 'p-cy',
          unitIds: ['u1', 'u2', 'u3', 'u4', 'u5'],
          scopes: [],
          activityKinds: [],
        },
        rollout: { totalSites: 4, note: '' },
      },
      CTX,
    );
    expect(errors).toEqual([
      '将来の展開対象の拠点数（4）が検証対象の拠点数（5）より少なくなっています。展開対象は検証対象を含む全体の数です。',
    ]);
    expect(validateTrialOptionsPatch({ rollout: { totalSites: 2, note: '' } }, CTX)).toHaveLength(
      1,
    );
    expect(validateTrialOptionsPatch({ rollout: { totalSites: 30, note: '' } }, CTX)).toEqual([]);
  });

  it('他組織の期間・拠点、重複、メモ 100 字超（Demo）、PDF の目安の範囲外はエラー', () => {
    const errors = validateTrialOptionsPatch(
      {
        ghgVerification: {
          periodId: 'p-other',
          unitIds: ['u1', 'u1', 'x'],
          scopes: [],
          activityKinds: [],
        },
        rollout: { totalSites: 30, note: 'あ'.repeat(101) },
        freeScope: { pdfFiles: 100_001 },
      },
      CTX,
    );
    expect(errors).toEqual([
      '算定の検証期間が見つかりません。',
      '算定の検証拠点に、組織の拠点ではないものがあります。',
      '算定の検証拠点が重複しています。',
      '展開対象のメモは 100 字までです。',
      'PDF 等の一次データの目安は 0〜100,000 件で入れてください。',
    ]);
    expect(
      validateTrialOptionsPatch(
        { rollout: { totalSites: 30, note: 'あ'.repeat(101) } },
        { ...CTX, demo: false },
      ),
    ).toEqual([]);
  });
});

describe('mergeTrialOptions', () => {
  it('既存のキー（CDP など）を残して書き戻す', () => {
    expect(
      mergeTrialOptions({ cdp: { planned: true } }, { rollout: { totalSites: 30, note: '' } }),
    ).toEqual({ cdp: { planned: true }, rollout: { totalSites: 30, note: '' } });
  });
});
