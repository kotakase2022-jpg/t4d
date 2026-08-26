import { describe, expect, it } from 'vitest';
import {
  areaOfSection,
  combineCoverage,
  coverageRate,
  evaluatePriority,
  type PriorityInput,
} from '@/lib/domain/ssbj';

/**
 * SSBJ ギャップ分析のドメイン規則。
 *
 * 優先順位は AI に決めさせず、規則で計算する（監査法人へ根拠を説明する必要があるため）。
 * どう評価したかを factors で返すので、ここでは点数だけでなく
 * 「根拠が人に読める形で出ているか」も確かめる。
 */

const base: PriorityInput = {
  required: true,
  materiality: 'material',
  disclosureStatus: 'not_covered',
  dataStatus: 'not_covered',
  processStatus: 'not_covered',
  assuranceRelevant: true,
  daysToDeadline: 30,
};

describe('evaluatePriority', () => {
  it('重要性が高く、ギャップが深く、保証に響き、期限が近いものは優先度「高」', () => {
    const result = evaluatePriority(base);
    expect(result.priority).toBe('high');
    expect(result.score).toBeGreaterThanOrEqual(7);
  });

  it('対応済みで重要性なしなら優先度「低」', () => {
    const result = evaluatePriority({
      ...base,
      required: false,
      materiality: 'not_material',
      disclosureStatus: 'covered',
      dataStatus: 'covered',
      processStatus: 'covered',
      assuranceRelevant: false,
      daysToDeadline: 300,
    });
    expect(result.priority).toBe('low');
  });

  it('重要だが一部対応まで進んでいれば「中」', () => {
    const result = evaluatePriority({
      ...base,
      disclosureStatus: 'partial',
      dataStatus: 'mostly_covered',
      processStatus: 'partial',
      assuranceRelevant: false,
      daysToDeadline: 300,
    });
    expect(result.priority).toBe('medium');
  });

  it('評価項目が 6 つそろい、それぞれ根拠の文が付く', () => {
    const { factors } = evaluatePriority(base);
    expect(factors.map((f) => f.label)).toEqual([
      '制度上の重要性',
      '企業にとっての重要性',
      'ギャップの深さ',
      'データの有無と対応工数',
      '第三者保証への影響',
      '対応期限',
    ]);
    for (const factor of factors) {
      expect(factor.note.length, `${factor.label} の根拠が空`).toBeGreaterThan(10);
      expect(factor.judgement.length).toBeGreaterThan(0);
    }
  });

  it('ギャップの深さは 3 観点のうち最も遅れているもので評価する', () => {
    const { factors } = evaluatePriority({
      ...base,
      disclosureStatus: 'covered',
      dataStatus: 'covered',
      processStatus: 'not_covered',
    });
    const depth = factors.find((f) => f.label === 'ギャップの深さ');
    expect(depth?.judgement).toBe('業務プロセス・内部統制が未対応');
  });

  it('重要性が未判定なら、重要性ありより低く・重要性なしより高く評価する', () => {
    const notAssessed = evaluatePriority({ ...base, materiality: 'not_assessed' }).score;
    const material = evaluatePriority({ ...base, materiality: 'material' }).score;
    const notMaterial = evaluatePriority({ ...base, materiality: 'not_material' }).score;
    expect(notAssessed).toBeLessThan(material);
    expect(notAssessed).toBeGreaterThan(notMaterial);
  });

  it('データが未取得なら工数の加点が入る（収集の仕組みから作る必要があるため）', () => {
    const missing = evaluatePriority({ ...base, dataStatus: 'not_covered' });
    const present = evaluatePriority({ ...base, dataStatus: 'covered' });
    const factor = missing.factors.find((f) => f.label === 'データの有無と対応工数');
    expect(factor?.score).toBe(1);
    expect(present.factors.find((f) => f.label === 'データの有無と対応工数')?.score).toBe(0);
  });

  it('期限が 90 日以内なら緊急として加点する', () => {
    expect(
      evaluatePriority({ ...base, daysToDeadline: 90 }).factors.find((f) => f.label === '対応期限')
        ?.score,
    ).toBe(1);
    expect(
      evaluatePriority({ ...base, daysToDeadline: 91 }).factors.find((f) => f.label === '対応期限')
        ?.score,
    ).toBe(0);
    expect(
      evaluatePriority({ ...base, daysToDeadline: null }).factors.find(
        (f) => f.label === '対応期限',
      )?.judgement,
    ).toBe('期限未設定');
  });
});

describe('combineCoverage', () => {
  it('最も遅れている観点に合わせる', () => {
    expect(combineCoverage('covered', 'covered', 'not_covered')).toBe('not_covered');
    expect(combineCoverage('covered', 'unconfirmed', 'covered')).toBe('unconfirmed');
    expect(combineCoverage('covered', 'partial', 'covered')).toBe('partial');
    expect(combineCoverage('covered', 'mostly_covered', 'covered')).toBe('mostly_covered');
    expect(combineCoverage('covered', 'covered', 'covered')).toBe('covered');
  });

  it('未対応は未確認より優先して表す（対応できていないことが確定しているため）', () => {
    expect(combineCoverage('not_covered', 'unconfirmed', 'covered')).toBe('not_covered');
  });
});

describe('coverageRate', () => {
  it('一部対応の積み上がりが見えるように重み付けする', () => {
    expect(coverageRate(['covered', 'covered'])).toBe(100);
    expect(coverageRate(['not_covered', 'not_covered'])).toBe(0);
    // 対応済み 100 / 一部対応 40 の平均
    expect(coverageRate(['covered', 'partial'])).toBe(70);
    expect(coverageRate([])).toBe(0);
  });

  it('未確認は 0 として扱う（対応できている証拠が無いため）', () => {
    expect(coverageRate(['unconfirmed'])).toBe(0);
  });
});

describe('areaOfSection', () => {
  it('一般基準・気候基準の区分を同じ 4 領域へ寄せる', () => {
    expect(areaOfSection('一般：ガバナンス')).toBe('governance');
    expect(areaOfSection('気候：ガバナンス')).toBe('governance');
    expect(areaOfSection('一般：戦略')).toBe('strategy');
    expect(areaOfSection('気候：リスク管理')).toBe('risk');
    expect(areaOfSection('気候：指標及び目標')).toBe('metrics');
    expect(areaOfSection('実務対応第1号：温対法SHK制度')).toBe('other');
  });
});
