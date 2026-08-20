import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  ORG_IDS,
  PERIOD_IDS,
  UNIT_IDS,
  dataPointId,
  metricId,
  userId,
} from '@/lib/fixtures/dataset';
import {
  confirmIngestionJob,
  createIngestionJob,
  processIngestionJob,
} from '@/lib/imports/service';
import { transitionDataPoint, updateDataPointValue } from '@/lib/services/data-point-workflow';
import {
  generateDisclosureDraft,
  saveDisclosureResponse,
  transitionDisclosureResponse,
} from '@/lib/services/disclosure-write';
import { buildDataPointRows, loadPeriodDataset } from '@/lib/services/enterprise-data';
import { toCsv } from '@/lib/exports';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 企業 Vertical Slice の Integration テスト（指示書 20 章）。
 *
 *   Import → Preview → Confirm → Submit → Review → Approve → CDP Draft → Export
 *
 * Server Action と同じ Service を通すため、UI を経由せず業務ロジックを検証できる。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  unitScopeIds: string[] = [],
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);
const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);

const CSV = [
  '拠点,項目,値,単位,期間',
  '東日本工場,Scope1,3100.5,t-CO2e,FY2026',
  '東日本工場,用水使用量,124000,m3,FY2026',
  '東日本工場,蒸気（購入分）,18.4,GJ,FY2026',
].join('\r\n');

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('Import → Preview → Confirm', () => {
  it('CSV を取り込み、AI が指標を推定し、要確認行を検出する', async () => {
    const ctx = siteUser();

    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: UNIT_IDS.east,
      idempotencyKey: 'test-job-1',
      files: [
        { name: '東日本工場_FY2026.csv', type: 'text/csv', bytes: new TextEncoder().encode(CSV) },
      ],
    });

    expect(job.status).toBe('queued');
    expect(job.progressPercent).toBe(0);

    const processed = await processIngestionJob(db, ctx, job.id);
    expect(processed.progressPercent).toBe(100);
    expect(processed.totalRows).toBe(3);
    // 蒸気は指標マスターに無い → 要確認
    expect(processed.status).toBe('needs_review');

    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });
    expect(rows).toHaveLength(3);

    const scope1Row = rows.find((r) => r.metricId === metricId('AOMI', 'scope1'));
    expect(scope1Row?.value).toBe(3100.5);
    expect(scope1Row?.unitOfMeasure).toBe('t-CO2e');
    // 既存の Data Point があるため重複として検出される
    expect(scope1Row?.status).toBe('duplicate');
    expect(scope1Row?.duplicateOfDataPointId).toBe(dataPointId('EAST', 'scope1', 'FY2026'));

    const unknownRow = rows.find((r) => r.metricId === null);
    expect(unknownRow?.status).toBe('needs_review');
    expect(unknownRow?.warnings.join(' ')).toContain('指標を特定できませんでした');

    // AI 実行が Provenance 付きで記録されている
    const aiRuns = await db.select('aiRuns', { where: { featureType: 'importMapping' } });
    expect(aiRuns).toHaveLength(1);
    expect(aiRuns[0]?.provider).toBe('mock');
    expect(aiRuns[0]?.inputReferenceIds.length).toBeGreaterThan(0);
  });

  it('同一 idempotencyKey では二重にジョブを作らない', async () => {
    const ctx = siteUser();
    const input = {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: UNIT_IDS.east,
      idempotencyKey: 'same-key',
      files: [{ name: 'a.csv', type: 'text/csv', bytes: new TextEncoder().encode(CSV) }],
    };
    const first = await createIngestionJob(db, ctx, input);
    const second = await createIngestionJob(db, ctx, input);
    expect(second.id).toBe(first.id);
  });

  it('担当外の拠点を指定した取込は拒否される', async () => {
    await expect(
      createIngestionJob(db, siteUser(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        unitId: UNIT_IDS.west,
        idempotencyKey: 'forbidden',
        files: [{ name: 'a.csv', type: 'text/csv', bytes: new TextEncoder().encode(CSV) }],
      }),
    ).rejects.toThrow(/担当外/);
  });

  it('確定すると Data Point に新しい Version が追加される', async () => {
    const ctx = siteUser();
    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: UNIT_IDS.east,
      idempotencyKey: 'confirm-job',
      files: [{ name: 'a.csv', type: 'text/csv', bytes: new TextEncoder().encode(CSV) }],
    });
    await processIngestionJob(db, ctx, job.id);
    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });

    // 承認済みの Scope1 は site_contributor が変更できない（レビュー権限が必要）
    const waterRow = rows.find((r) => r.metricId === metricId('AOMI', 'water'));
    expect(waterRow).toBeDefined();
    if (!waterRow) return;

    const before = await db.select('dataPointVersions', {
      where: { dataPointId: dataPointId('EAST', 'water', 'FY2026') },
    });

    const result = await confirmIngestionJob(db, ctx, job.id, [
      {
        rowId: waterRow.id,
        include: true,
        metricId: waterRow.metricId,
        unitId: waterRow.unitId,
        value: waterRow.value,
        unitOfMeasure: waterRow.unitOfMeasure,
      },
    ]);

    expect(result.updated).toBe(1);
    const after = await db.select('dataPointVersions', {
      where: { dataPointId: dataPointId('EAST', 'water', 'FY2026') },
    });
    expect(after.length).toBe(before.length + 1);

    const dp = await db.findById('dataPoints', dataPointId('EAST', 'water', 'FY2026'));
    expect(dp?.value).toBe(124000);
  });
});

describe('Submit → Review → Approve', () => {
  // 差戻し中の東日本工場 用水使用量を使う
  const target = dataPointId('EAST', 'water', 'FY2026');

  it('拠点担当は提出できるが承認できない', async () => {
    await transitionDataPoint(db, siteUser(), { dataPointId: target, to: 'submitted' });
    const submitted = await db.findById('dataPoints', target);
    expect(submitted?.status).toBe('submitted');

    await expect(
      transitionDataPoint(db, siteUser(), { dataPointId: target, to: 'approved' }),
    ).rejects.toThrow(/権限/);
  });

  it('レビュー担当が差戻しできる（理由がコメントに残る）', async () => {
    await transitionDataPoint(db, siteUser(), { dataPointId: target, to: 'submitted' });
    await transitionDataPoint(db, reviewer(), {
      dataPointId: target,
      to: 'returned',
      comment: '検針票の対象期間を確認してください。',
    });

    const dp = await db.findById('dataPoints', target);
    expect(dp?.status).toBe('returned');

    const comments = await db.select('comments', {
      where: { targetType: 'data_point', targetId: target },
    });
    expect(comments.some((c) => c.body.includes('検針票'))).toBe(true);

    const approvals = await db.select('approvals', {
      where: { targetType: 'data_point', targetId: target },
    });
    expect(approvals.some((a) => a.decision === 'returned')).toBe(true);
  });

  it('承認者が承認すると承認証跡と監査ログが残る', async () => {
    await transitionDataPoint(db, siteUser(), { dataPointId: target, to: 'submitted' });
    await transitionDataPoint(db, approver(), { dataPointId: target, to: 'approved' });

    const dp = await db.findById('dataPoints', target);
    expect(dp?.status).toBe('approved');
    expect(dp?.approvedBy).toBe(userId('approver@demo.local'));
    expect(dp?.approvedAt).not.toBeNull();

    const events = await db.select('auditEvents', {
      where: { resourceType: 'data_point', resourceId: target, eventType: 'data_approved' },
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it('Evidence 必須の指標は Evidence が無いと承認できない', async () => {
    const euScope1 = dataPointId('EU', 'scope1', 'FY2026'); // submitted / Evidence なし
    await expect(
      transitionDataPoint(db, approver(), { dataPointId: euScope1, to: 'approved' }),
    ).rejects.toThrow(/Evidence/);
  });

  it('承認済みの値を変更すると承認後変更フラグが立つ', async () => {
    const approved = dataPointId('EAST', 'scope1', 'FY2026');
    await updateDataPointValue(db, manager(), {
      dataPointId: approved,
      value: 9999,
      unitOfMeasure: 't-CO2e',
      changeReason: '再集計',
    });
    const dp = await db.findById('dataPoints', approved);
    expect(dp?.changedAfterApproval).toBe(true);
    expect(dp?.status).toBe('draft');
  });

  it('許可されない状態遷移は拒否される', async () => {
    await expect(
      transitionDataPoint(db, approver(), {
        dataPointId: dataPointId('EU', 'scope2', 'FY2026'), // draft
        to: 'approved',
      }),
    ).rejects.toThrow(/遷移は許可されていません/);
  });
});

describe('CDP: Data Mapping → AI Draft → 人が編集 → 承認', () => {
  async function firstMappedResponse() {
    const responses = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: PERIOD_IDS.fy2026 },
    });
    const mappings = await db.select('disclosureMappings', {
      where: { organizationId: ORG_IDS.aomi },
    });
    const scope1MetricId = metricId('AOMI', 'scope1');
    const mapping = mappings.find((m) => m.metricId === scope1MetricId);
    return responses.find((r) => r.itemId === mapping?.itemId);
  }

  it('承認済みデータを根拠に AI 下書きを生成する', async () => {
    const response = await firstMappedResponse();
    expect(response).toBeDefined();
    if (!response) return;

    const result = await generateDisclosureDraft(db, manager(), response.id);
    expect(result.provider).toBe('mock');
    expect(result.version.originatedFromAiRunId).toBe(result.aiRunId);

    const run = await db.findById('aiRuns', result.aiRunId);
    expect(run?.sourceReferences.length).toBeGreaterThan(0);
    // 参照元はすべて承認済み Data Point
    for (const source of run?.sourceReferences ?? []) {
      if (source.kind !== 'data_point' || !source.id) continue;
      const dp = await db.findById('dataPoints', source.id);
      expect(dp?.status).toBe('approved');
    }

    const updated = await db.findById('disclosureResponses', response.id);
    expect(updated?.status).toBe('draft');
    expect(updated?.answerText).toBeTruthy();
  });

  it('AI 生成のままでは承認できない', async () => {
    const response = await firstMappedResponse();
    if (!response) return;
    await generateDisclosureDraft(db, manager(), response.id);

    await expect(
      transitionDisclosureResponse(db, approver(), response.id, 'approved'),
    ).rejects.toThrow(/AI が生成したままの回答は承認できません/);
  });

  it('人が編集して保存すると承認できるようになる', async () => {
    const response = await firstMappedResponse();
    if (!response) return;
    const draft = await generateDisclosureDraft(db, manager(), response.id);

    await saveDisclosureResponse(db, manager(), {
      responseId: response.id,
      answerText: '担当者が内容を確認し、算定範囲の記述を追記しました。',
      answerNumeric: draft.version.answerNumeric,
      answerChoice: [],
      aiRunId: draft.aiRunId,
      editedFromAi: true,
    });

    const afterSave = await db.findById('disclosureResponses', response.id);
    const version = afterSave?.currentVersionId
      ? await db.findById('disclosureResponseVersions', afterSave.currentVersionId)
      : null;
    expect(version?.originatedFromAiRunId).toBeNull();

    const approved = await transitionDisclosureResponse(db, approver(), response.id, 'approved');
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(userId('approver@demo.local'));

    // AI 出力の採否が記録されている
    const run = await db.findById('aiRuns', draft.aiRunId);
    expect(run?.status).toBe('accepted');
    expect(run?.reviewedBy).toBe(userId('sustainability@demo.local'));
  });

  it('開示回答の承認権限がないユーザーは承認できない', async () => {
    const response = await firstMappedResponse();
    if (!response) return;
    await saveDisclosureResponse(db, manager(), {
      responseId: response.id,
      answerText: '人が作成',
      answerNumeric: null,
      answerChoice: [],
      aiRunId: null,
      editedFromAi: false,
    });
    await expect(
      transitionDisclosureResponse(db, manager(), response.id, 'approved'),
    ).rejects.toThrow(/権限/);
  });
});

describe('Export', () => {
  it('承認済みデータを含む CSV を生成できる', async () => {
    const ctx = approver();
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026);
    if (!period) throw new Error('fixture missing');

    const dataset = await loadPeriodDataset(
      db,
      ctx,
      period,
      fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi),
      fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi),
      fixture.periods,
    );
    const rows = buildDataPointRows(dataset, period, ctx);

    const csv = toCsv({
      name: 'data',
      columns: [
        { key: 'metric', header: '指標', value: (r) => r.metric.name },
        { key: 'unit', header: '組織', value: (r) => r.unit.name },
        { key: 'value', header: '値', value: (r) => r.dataPoint.value, numeric: true },
        { key: 'status', header: '状態', value: (r) => r.dataPoint.status },
      ],
      rows,
    });

    expect(csv).toContain('指標,組織,値,状態');
    expect(csv).toContain('Scope1 排出量');
    expect(csv).toContain('東日本工場');
    expect(csv.split('\r\n').length).toBeGreaterThan(rows.length);
  });
});
