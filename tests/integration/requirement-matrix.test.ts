import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { ESRS_40A_SAMPLE_VERSION_ID, esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { REQUIREMENT_COVERAGE_CATEGORIES } from '@/lib/domain/requirement-coverage';
import { loadRequirementMatrix } from '@/lib/services/requirement-matrix';
import { exportRequirementMatrix, MATRIX_COLUMNS } from '@/lib/exports/requirement-matrix';
import { saveProjectRequirementAssessment } from '@/lib/services/project-requirement-assessment';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 要求事項の判断（基準ごとの読み分け。NF-01）と要求事項・情報対応表（全基準・全件。NF-04）。
 * int:requirement-decisions・int:requirement-matrix。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

describe('要求事項・情報対応表', () => {
  it('全基準・全件を 1 要求事項 1 行で出し、件数は区分の合計と一致する（表示で行を作らない）', async () => {
    const guarded = new WriteDetectingDbClient(db);
    const matrix = await loadRequirementMatrix(guarded, author(), {
      projectId: IDS.projects.fy2026,
    });
    expect(guarded.writes).toEqual([]);
    expect(matrix.frameworks.length).toBeGreaterThanOrEqual(2);
    for (const f of matrix.frameworks) {
      const rows = matrix.rows.filter((r) => r.frameworkVersionId === f.frameworkVersionId);
      if (f.mode === 'not_loaded') {
        expect(f.notCalculatedReason).not.toBeNull();
        continue;
      }
      expect(rows).toHaveLength(f.total);
      const sum = REQUIREMENT_COVERAGE_CATEGORIES.reduce((n, c) => n + f.counts[c], 0);
      expect(sum).toBe(f.total);
    }
  });

  it('ESRS-40a はサンプル（架空）の版で、判断の記録が行に出る。充足確認済みにはならない（K6）', async () => {
    const matrix = await loadRequirementMatrix(db, author(), { projectId: IDS.projects.fy2026 });
    const framework = matrix.frameworks.find(
      (f) => f.frameworkVersionId === ESRS_40A_SAMPLE_VERSION_ID,
    );
    expect(framework).toBeDefined();
    expect(framework!.isSample).toBe(true);
    expect(framework!.total).toBe(8);
    const rows = matrix.rows.filter((r) => r.frameworkVersionId === ESRS_40A_SAMPLE_VERSION_ID);
    expect(rows.every((r) => r.isSample)).toBe(true);
    expect(rows.some((r) => r.category === 'confirmed')).toBe(false);

    const s01 = rows.find((r) => r.itemId === esrs40aSampleItemId('40A-S01'))!;
    expect(s01.decisionLabel).toContain('適用');
    // 対象外は申請中（承認待ち）なので分母から外さない
    const s06 = rows.find((r) => r.itemId === esrs40aSampleItemId('40A-S06'))!;
    expect(s06.category).toBe('undetermined');
    expect(s06.exclusionReason).not.toBeNull();
    const s08 = rows.find((r) => r.itemId === esrs40aSampleItemId('40A-S08'))!;
    expect(s08.category).toBe('undetermined');
  });

  it('基準を絞れる（プロジェクトの基準に無い版は無視）', async () => {
    const matrix = await loadRequirementMatrix(db, author(), {
      projectId: IDS.projects.fy2026,
      frameworkVersionIds: [ESRS_40A_SAMPLE_VERSION_ID, IDS.esrs40aDraftVersion],
    });
    expect(matrix.frameworks.map((f) => f.frameworkVersionId)).toEqual([
      ESRS_40A_SAMPLE_VERSION_ID,
    ]);
    expect(new Set(matrix.rows.map((r) => r.frameworkVersionId))).toEqual(
      new Set([ESRS_40A_SAMPLE_VERSION_ID]),
    );
  });

  it('AI の判定は候補の列だけに出し、人の評価と混ぜない', async () => {
    const matrix = await loadRequirementMatrix(db, author(), { projectId: IDS.projects.fy2026 });
    for (const row of matrix.rows) {
      if (row.aiCandidateLabel !== null && row.humanEvaluationLabel !== null) {
        expect(row.humanEvaluationLabel).not.toContain('AI');
      }
    }
  });

  it('他テナントのプロジェクトは見つからない', async () => {
    await expect(
      loadRequirementMatrix(db, otherTenant(), { projectId: IDS.projects.fy2026 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('要求事項・情報対応表の出力（NF-04。XLSX・CSV）', () => {
  async function workbookOf(bytes: Uint8Array) {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    return workbook;
  }

  it('XLSX は全件の対応表・対象外一覧・未対応一覧・基準別件数・基準横断・注記を持ち、行数は画面と同じ', async () => {
    const matrix = await loadRequirementMatrix(db, author(), { projectId: IDS.projects.fy2026 });
    const result = await exportRequirementMatrix(db, author(), {
      projectId: IDS.projects.fy2026,
      format: 'xlsx',
    });
    expect(result.rowCount).toBe(matrix.rows.length);
    expect(result.fileName).toMatch(/\.xlsx$/);
    const workbook = await workbookOf(result.bytes);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      '対応表',
      '対象外一覧',
      '未対応一覧',
      '基準別件数',
      '基準横断',
      '注記',
    ]);
    const sheet = workbook.getWorksheet('対応表')!;
    expect(sheet.rowCount).toBe(matrix.rows.length + 1);
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(
      MATRIX_COLUMNS.map((c) => c.header),
    );
    // SSBJ 133 項目＋40a サンプル 8 項目（対象外・未判定の行も消さない）
    expect(
      matrix.rows.filter((r) => r.frameworkVersionId === ESRS_40A_SAMPLE_VERSION_ID),
    ).toHaveLength(8);

    // 対象外一覧に 40a の対象外（承認待ち）の理由が出る
    const exclusions = workbook.getWorksheet('対象外一覧')!;
    const texts: string[] = [];
    exclusions.eachRow((row) => texts.push(JSON.stringify(row.values)));
    expect(texts.some((t) => t.includes('40A-S06') && t.includes('水ストレス'))).toBe(true);

    // 基準別件数は分母付き（区分の合計＝分母）
    const counts = workbook.getWorksheet('基準別件数')!;
    const sample = (counts.getRow(3).values as unknown[]).slice(1);
    expect(sample[0]).toContain('ESRS-40a');
    const denominator = Number(sample[2]);
    const sum = [3, 4, 5, 6, 7].reduce((n, i) => n + Number(sample[i]), 0);
    expect(denominator).toBe(8);
    expect(sum).toBe(denominator);
    // SSBJ は一部だけ収録した版。分母（133）を基準の全件と取り違えさせないよう、備考・注記・画面に収録範囲を出す
    const ssbj = matrix.frameworks.find((f) => f.label.startsWith('SSBJ'))!;
    expect(ssbj.coverage).toContain('一部のみ収録');
    expect(ssbj.coverage).toContain('ユニバーサル基準（適用）は未収録');
    const ssbjCounts = (counts.getRow(2).values as unknown[]).slice(1).map(String);
    expect(ssbjCounts[0]).toContain('SSBJ');
    expect(ssbjCounts.at(-1)).toContain('ユニバーサル基準（適用）は未収録');

    // 基準横断（NF-09）はサンプル 6 件
    expect(workbook.getWorksheet('基準横断')!.rowCount).toBe(7);

    // 注記: 社内承認であり第三者保証ではない
    const notes: string[] = [];
    workbook.getWorksheet('注記')!.eachRow((row) => notes.push(JSON.stringify(row.values)));
    expect(notes.some((n) => n.includes('第三者による保証ではありません'))).toBe(true);
    expect(
      notes.some(
        (n) => n.includes('基準の位置付け') && n.includes('ユニバーサル基準（適用）は未収録'),
      ),
    ).toBe(true);
  });

  it('企業が入力した文字列は数式にならない（CSV・XLSX とも先頭を無害化する）', async () => {
    await saveProjectRequirementAssessment(db, author(), {
      projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
      itemId: esrs40aSampleItemId('40A-S02'),
      applicability: 'not_applicable',
      applicabilityReason: '=HYPERLINK("https://example.invalid","x")',
      ruleRef: '',
      disclosureCoverage: null,
      dataCoverage: null,
      processCoverage: null,
      missingInformation: '',
      ownerUserId: null,
      dueOn: null,
      actionNote: '',
    });
    const csv = await exportRequirementMatrix(db, author(), {
      projectId: IDS.projects.fy2026,
      format: 'csv',
    });
    const text = new TextDecoder().decode(csv.bytes);
    expect(text).toContain(`'=HYPERLINK`);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);

    const xlsx = await exportRequirementMatrix(db, author(), {
      projectId: IDS.projects.fy2026,
      format: 'xlsx',
    });
    const workbook = await workbookOf(xlsx.bytes);
    let found = false;
    workbook.getWorksheet('対応表')!.eachRow((row) => {
      for (const value of row.values as unknown[]) {
        if (typeof value === 'string' && value.includes('HYPERLINK')) {
          expect(value.startsWith(`'=`)).toBe(true);
          found = true;
        }
      }
    });
    expect(found).toBe(true);
  });

  it('出力の権限を ID より先に確かめ、他の組織のプロジェクトは「見つかりません」。書くのは監査ログだけ', async () => {
    await expect(
      exportRequirementMatrix(db, reviewer(), { projectId: 'not-a-project', format: 'csv' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      exportRequirementMatrix(db, otherTenant(), { projectId: IDS.projects.fy2026, format: 'csv' }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const guarded = new WriteDetectingDbClient(db);
    await exportRequirementMatrix(guarded, author(), {
      projectId: IDS.projects.fy2026,
      format: 'xlsx',
    });
    expect(guarded.writes).toEqual(['insert:auditEvents']);
  });
});
