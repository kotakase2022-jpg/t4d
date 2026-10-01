import { describe, expect, it } from 'vitest';
import {
  CSRD_SETTINGS_PATH,
  matterPath,
  parseBoundaryForm,
  parseIroForm,
  parseMatterDecisionForm,
  parseMethodForm,
  safeTopic,
} from '@/app/enterprise/disclosures/csrd/settings/form-input';

/**
 * CSRD 設定の Server Action が使う入力の取り出し（docs/disclosure-first.md §9.4）。
 *  - 値の検査はサービスが行う。ここは文字列を型へ写すだけ（空欄は null・NaN のまま渡し、黙って 0 にしない）
 *  - IRO は種類に合わない欄を使わない（画面に出していない欄が送られても入れない）
 *  - 戻り先の URL に入れる事項コードは ESRS のテーマだけ（他の文字列で別の画面へ飛ばさない）
 */

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

const PERIOD = '11111111-1111-4111-8111-111111111111';
const UNIT_A = '22222222-2222-4222-8222-222222222222';
const UNIT_B = '33333333-3333-4333-8333-333333333333';

describe('報告範囲', () => {
  it('選んだ拠点をすべて受け取り、値をそのまま渡す', () => {
    expect(
      parseBoundaryForm(
        form([
          ['reportingPeriodId', PERIOD],
          ['consolidationScope', 'custom'],
          ['consolidationNote', ' EU 子会社を含める（テスト） '],
          ['includedUnitIds', UNIT_A],
          ['includedUnitIds', UNIT_B],
          ['valueChainScope', 'both'],
          ['valueChainNote', '主要サプライヤー'],
        ]),
      ),
    ).toEqual({
      reportingPeriodId: PERIOD,
      consolidationScope: 'custom',
      consolidationNote: ' EU 子会社を含める（テスト） ',
      includedUnitIds: [UNIT_A, UNIT_B],
      valueChainScope: 'both',
      valueChainNote: '主要サプライヤー',
    });
  });

  it('拠点を選ばなければ空配列（全社）', () => {
    const parsed = parseBoundaryForm(form([['reportingPeriodId', PERIOD]]));
    expect(parsed.includedUnitIds).toEqual([]);
    expect(parsed.consolidationScope).toBe('');
    expect(parsed.valueChainScope).toBe('');
  });
});

describe('評価方法・閾値', () => {
  it('閾値は数値に変える（全角も読む）', () => {
    expect(
      parseMethodForm(
        form([
          ['reportingPeriodId', PERIOD],
          ['impactThreshold', '3.5'],
          ['financialThreshold', '２．５'],
          ['methodNote', '方法'],
          ['stakeholderEngagementNote', '聞き取り'],
        ]),
      ),
    ).toEqual({
      reportingPeriodId: PERIOD,
      impactThreshold: 3.5,
      financialThreshold: 2.5,
      methodNote: '方法',
      stakeholderEngagementNote: '聞き取り',
    });
  });

  it('空欄・数値でない入力は NaN（0 にしない。サービスが理由を返す）', () => {
    const parsed = parseMethodForm(
      form([
        ['impactThreshold', ''],
        ['financialThreshold', 'abc'],
      ]),
    );
    expect(parsed.impactThreshold).toBeNaN();
    expect(parsed.financialThreshold).toBeNaN();
  });
});

describe('IRO', () => {
  const base: Array<[string, string]> = [
    ['reportingPeriodId', PERIOD],
    ['topic', 'E1'],
    ['subTopic', '気候変動の緩和'],
    ['description', '工場の排出（テスト）'],
    ['valueChainStage', 'own_operations'],
    ['affectedStakeholders', '地域社会'],
  ];

  it('負・潜在のインパクトは 規模・範囲・回復困難性・可能性を読み、財務の欄は使わない', () => {
    const parsed = parseIroForm(
      form([
        ...base,
        ['iroType', 'impact'],
        ['impactOccurrence', 'potential'],
        ['impactDirection', 'negative'],
        ['impactScale', '4'],
        ['impactScope', '３'],
        ['impactIrremediability', '3'],
        ['impactLikelihood', '2'],
        ['humanRights', 'on'],
        ['timeHorizon', ''],
        // 画面に出していない欄が送られても使わない
        ['financialLikelihood', '5'],
        ['financialMagnitude', '5'],
        ['relatedImpactIroId', UNIT_A],
      ]),
    );
    expect(parsed).toEqual({
      reportingPeriodId: PERIOD,
      topic: 'E1',
      iroId: null,
      iroType: 'impact',
      subTopic: '気候変動の緩和',
      description: '工場の排出（テスト）',
      valueChainStage: 'own_operations',
      timeHorizon: null,
      impactOccurrence: 'potential',
      impactDirection: 'negative',
      impactScale: 4,
      impactScope: 3,
      impactIrremediability: 3,
      impactLikelihood: 2,
      financialLikelihood: null,
      financialMagnitude: null,
      humanRights: true,
      affectedStakeholders: '地域社会',
      relatedImpactIroId: null,
    });
  });

  it('実在のインパクトは可能性を、正のインパクトは回復困難性を使わない', () => {
    const parsed = parseIroForm(
      form([
        ...base,
        ['iroType', 'impact'],
        ['impactOccurrence', 'actual'],
        ['impactDirection', 'positive'],
        ['impactScale', '2'],
        ['impactScope', '2'],
        ['impactIrremediability', '5'],
        ['impactLikelihood', '5'],
      ]),
    );
    expect(parsed.impactIrremediability).toBeNull();
    expect(parsed.impactLikelihood).toBeNull();
    expect(parsed.humanRights).toBe(false);
  });

  it('リスク・機会は 可能性・大きさ・期間・関連インパクトを読み、インパクトの欄と人権は使わない', () => {
    const parsed = parseIroForm(
      form([
        ...base,
        ['iroId', UNIT_B],
        ['iroType', 'risk'],
        ['timeHorizon', 'medium'],
        ['financialLikelihood', '4'],
        ['financialMagnitude', '4'],
        ['relatedImpactIroId', UNIT_A],
        ['impactOccurrence', 'actual'],
        ['impactDirection', 'negative'],
        ['impactScale', '4'],
        ['impactScope', '4'],
        ['impactIrremediability', '4'],
        ['humanRights', 'on'],
      ]),
    );
    expect(parsed).toMatchObject({
      iroId: UNIT_B,
      iroType: 'risk',
      timeHorizon: 'medium',
      financialLikelihood: 4,
      financialMagnitude: 4,
      relatedImpactIroId: UNIT_A,
      impactOccurrence: null,
      impactDirection: null,
      impactScale: null,
      impactScope: null,
      impactIrremediability: null,
      impactLikelihood: null,
      humanRights: false,
    });
  });

  it('空欄は null、数値でない・小数の入力はそのまま渡してサービスに拒否させる', () => {
    const parsed = parseIroForm(
      form([
        ...base,
        ['iroType', 'opportunity'],
        ['timeHorizon', 'long'],
        ['financialLikelihood', ''],
        ['financialMagnitude', '2.5'],
      ]),
    );
    expect(parsed.financialLikelihood).toBeNull();
    expect(parsed.financialMagnitude).toBe(2.5);
    expect(
      parseIroForm(form([...base, ['iroType', 'risk'], ['financialLikelihood', 'x']]))
        .financialLikelihood,
    ).toBeNaN();
  });
});

describe('事項の判断', () => {
  it('2 軸の判断・根拠・ステークホルダーの意見', () => {
    expect(
      parseMatterDecisionForm(
        form([
          ['reportingPeriodId', PERIOD],
          ['topic', 'G1'],
          ['impactAssessment', 'not_material'],
          ['impactRationale', '閾値未満'],
          ['financialAssessment', 'material'],
          ['financialRationale', '制裁金'],
          ['stakeholderNote', ''],
        ]),
      ),
    ).toEqual({
      reportingPeriodId: PERIOD,
      topic: 'G1',
      impactAssessment: 'not_material',
      impactRationale: '閾値未満',
      financialAssessment: 'material',
      financialRationale: '制裁金',
      stakeholderNote: '',
    });
  });
});

describe('戻り先', () => {
  it('ESRS のテーマだけを事項の画面の URL に使う', () => {
    expect(safeTopic('S1')).toBe('S1');
    expect(safeTopic('ESRS2')).toBeNull();
    expect(safeTopic('../../admin')).toBeNull();
    expect(safeTopic(null)).toBeNull();
    expect(matterPath('E3')).toBe('/enterprise/disclosures/csrd/settings/matters/E3');
    expect(matterPath(null)).toBe(CSRD_SETTINGS_PATH);
    expect(CSRD_SETTINGS_PATH).toBe('/enterprise/disclosures/csrd/settings');
  });
});
