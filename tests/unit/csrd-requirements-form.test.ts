import { describe, expect, it } from 'vitest';
import {
  CSRD_OPEN_HIGH_PRIORITY_QUERY,
  CSRD_REQUIREMENTS_PATH,
  parseAssessmentForm,
  parsePlanForm,
  parseRequirementQuery,
  parseReviewForm,
  requirementDetailPath,
  safeItemId,
} from '@/app/enterprise/disclosures/csrd/requirements/form-input';

/**
 * CSRD 要求事項の Server Action・一覧の URL 絞り込みの入力の取り出し（docs/disclosure-first.md §9.4）。
 * 値の検査はサービスが行う。ここでは文字列を型へ写すだけで、戻り先の URL には UUID だけを使う。
 */

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

const PERIOD = '11111111-1111-4111-8111-111111111111';
const ITEM = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';

describe('戻り先', () => {
  it('要求事項の詳細へは UUID のときだけ戻る（それ以外は一覧）', () => {
    expect(safeItemId(ITEM)).toBe(ITEM);
    expect(safeItemId('ESRS-E1-1')).toBeNull();
    expect(safeItemId(`${ITEM}/../x`)).toBeNull();
    expect(safeItemId(null)).toBeNull();
    expect(requirementDetailPath(ITEM)).toBe(`/enterprise/disclosures/csrd/requirements/${ITEM}`);
    expect(requirementDetailPath('x')).toBe(CSRD_REQUIREMENTS_PATH);
  });
});

describe('担当者の入力（3 観点）', () => {
  it('3 観点・コメント・担当部署', () => {
    expect(
      parseAssessmentForm(
        form([
          ['reportingPeriodId', PERIOD],
          ['itemId', ITEM],
          ['disclosureStatus', 'partial'],
          ['dataStatus', 'covered'],
          ['processStatus', 'not_covered'],
          ['comment', '資料を確認（テスト）'],
          ['ownerDepartment', '経営企画部'],
        ]),
      ),
    ).toEqual({
      reportingPeriodId: PERIOD,
      itemId: ITEM,
      disclosureStatus: 'partial',
      dataStatus: 'covered',
      processStatus: 'not_covered',
      comment: '資料を確認（テスト）',
      ownerDepartment: '経営企画部',
    });
  });

  it('担当部署の欄が無いフォームは担当部署を変えない（undefined）', () => {
    expect(parseAssessmentForm(form([['itemId', ITEM]])).ownerDepartment).toBeUndefined();
  });
});

describe('担当者の確認（候補を採用／修正して確定）', () => {
  it('候補を採用は 3 観点を送らない（AI の候補を写すのはサービス）。表示した候補の実行日時だけを渡す', () => {
    expect(
      parseReviewForm(
        form([
          ['assessmentId', ITEM],
          ['decision', 'approved'],
          ['disclosureStatus', 'covered'],
          ['comment', ''],
          ['aiEvaluatedAt', '2026-09-15T00:00:00.000Z'],
        ]),
      ),
    ).toEqual({
      assessmentId: ITEM,
      decision: 'approved',
      comment: '',
      aiEvaluatedAt: '2026-09-15T00:00:00.000Z',
    });
  });

  it('修正して確定は人の 3 観点とコメント', () => {
    expect(
      parseReviewForm(
        form([
          ['assessmentId', ITEM],
          ['decision', 'modified'],
          ['disclosureStatus', 'partial'],
          ['dataStatus', 'partial'],
          ['processStatus', 'mostly_covered'],
          ['comment', '修正理由'],
        ]),
      ),
    ).toEqual({
      assessmentId: ITEM,
      decision: 'modified',
      disclosureStatus: 'partial',
      dataStatus: 'partial',
      processStatus: 'mostly_covered',
      comment: '修正理由',
    });
  });

  it('区分が不明ならそのまま渡す（サービスが「確認の区分が正しくありません」と拒否する）', () => {
    expect(parseReviewForm(form([['decision', 'auto']])).decision).toBe('auto');
  });
});

describe('対応計画の追加', () => {
  it('担当者・期限の空欄は null', () => {
    expect(
      parsePlanForm(
        form([
          ['reportingPeriodId', PERIOD],
          ['itemId', ITEM],
          ['gapKind', 'data'],
          ['title', '収集する（テスト）'],
          ['detail', ''],
          ['actionType', 'data_collection'],
          ['department', '人事部'],
          ['assigneeUserId', ''],
          ['dueDate', ''],
          ['priority', 'high'],
        ]),
      ),
    ).toEqual({
      reportingPeriodId: PERIOD,
      itemId: ITEM,
      gapKind: 'data',
      title: '収集する（テスト）',
      detail: '',
      actionType: 'data_collection',
      department: '人事部',
      assigneeUserId: null,
      dueDate: null,
      priority: 'high',
    });
    const withAssignee = parsePlanForm(
      form([
        ['assigneeUserId', USER],
        ['dueDate', '2026-12-31'],
      ]),
    );
    expect(withAssignee.assigneeUserId).toBe(USER);
    expect(withAssignee.dueDate).toBe('2026-12-31');
  });
});

describe('一覧の絞り込み（URL）', () => {
  it('同じキーを複数持てる。検索語は前後の空白を落とす', () => {
    expect(
      parseRequirementQuery({
        applicability: ['always', 'material'],
        perspective: 'financial',
        coverage: undefined,
        priority: 'high',
        review: 'awaiting',
        q: '  E1 ',
      }),
    ).toEqual({
      filters: {
        applicability: ['always', 'material'],
        perspective: ['financial'],
        coverage: [],
        priority: ['high'],
        review: ['awaiting'],
      },
      q: 'E1',
    });
  });

  it('優先度「高」（評価対象・未対応）の URL は対応済みを除く 4 状況', () => {
    const params = new URLSearchParams(CSRD_OPEN_HIGH_PRIORITY_QUERY);
    expect(params.getAll('priority')).toEqual(['high']);
    expect(params.getAll('coverage')).toEqual([
      'mostly_covered',
      'partial',
      'not_covered',
      'unconfirmed',
    ]);
  });
});
