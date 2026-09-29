import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  dropOldestUnpinned,
  normalizeLegacyRow,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import { restoreDisclosureDemoTables } from '@/lib/repositories/demo-reset-sync';
import { resetDisclosureDemoData } from '@/lib/services/disclosure-demo-reset';
import { completeReview, finalApprove, requestReview } from '@/lib/services/disclosure-review';
import { saveNarrative } from '@/lib/services/narrative';
import type { AuthorizationContext, ReviewEvent, RoleKey } from '@/types/domain';

/**
 * 自己監査（2026-09-29）: Demo Mode の Cookie による持ち回りの回帰テスト。
 * Fixture DB はインスタンスの全利用者で共有されるため、Cookie から戻す内容は DB の規則を通す。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);

const RISK = IDS.blocks.fy2026RiskOpportunity;

describe('SEC-F8 偽の Cookie で職務分離を通らない承認を共有メモリへ入れない', () => {
  it('レビュー完了の記録が無い最終承認と、それを前提にした節の承認は適用しない', () => {
    const requestId = fid('review_request', 'forged');
    const forged: DemoEdit[] = [
      {
        t: 'reviewRequests',
        id: requestId,
        v: {
          ...fixture.reviewRequests[0]!,
          id: requestId,
          targetId: RISK.block,
          targetVersionId: RISK.version,
          status: 'approved',
        },
      },
      {
        t: 'reviewEvents',
        id: fid('review_event', 'forged'),
        v: {
          id: fid('review_event', 'forged'),
          organizationId: ORG_IDS.aomi,
          reviewRequestId: requestId,
          eventType: 'approved',
          stage: 'final',
          actorUserId: userId('approver@demo.local'),
          targetVersionId: RISK.version,
          reason: null,
          paragraphId: null,
          idempotencyKey: 'forged',
          createdAt: new Date().toISOString(),
        } satisfies ReviewEvent,
      },
      {
        t: 'disclosureBlocks',
        id: RISK.block,
        v: { status: 'approved', approvedVersionId: RISK.version },
      },
    ];
    applyDemoEdits(fixture, forged);
    expect(fixture.disclosureBlocks.find((b) => b.id === RISK.block)?.status).toBe('draft');
    expect(fixture.reviewEvents.some((e) => e.id === fid('review_event', 'forged'))).toBe(false);
    expect(fixture.reviewRequests.some((r) => r.id === requestId)).toBe(false);
  });

  it('追記専用の記録（既存のレビューの記録）は Cookie から書き換えられない', () => {
    const existing = fixture.reviewEvents[0]!;
    applyDemoEdits(fixture, [
      { t: 'reviewEvents', id: existing.id, v: { actorUserId: userId('reviewer@demo.local') } },
    ]);
    expect(fixture.reviewEvents.find((e) => e.id === existing.id)).toEqual(existing);
  });

  it('本物の手順で作った依頼・記録・承認は、Cookie の中の順番が入れ替わっても別インスタンスで戻る', async () => {
    const { request } = await requestReview(db, author(), { blockId: RISK.block });
    await completeReview(db, reviewer(), { requestId: request.id });
    await finalApprove(db, approver(), { requestId: request.id });

    const finalRequest = fixture.reviewRequests.find((r) => r.id === request.id)!;
    const events = fixture.reviewEvents.filter((e) => e.reviewRequestId === request.id);
    const block = fixture.disclosureBlocks.find((b) => b.id === RISK.block)!;
    // Cookie では同じ行の更新がまとまって末尾へ移るため、記録が依頼より前に来ることがある
    const edits: DemoEdit[] = [
      ...events.map((e) => ({ t: 'reviewEvents', id: e.id, v: { ...e } })),
      { t: 'reviewRequests', id: finalRequest.id, v: { ...finalRequest } },
      {
        t: 'disclosureBlocks',
        id: block.id,
        v: {
          status: block.status,
          submittedVersionId: block.submittedVersionId,
          approvedVersionId: block.approvedVersionId,
        },
      },
    ];
    const other = createFixtureDb();
    applyDemoEdits(other, edits);
    expect(other.disclosureBlocks.find((b) => b.id === RISK.block)?.status).toBe('approved');
    expect(other.reviewRequests.find((r) => r.id === request.id)?.status).toBe('approved');
    expect(other.reviewEvents.filter((e) => e.reviewRequestId === request.id)).toHaveLength(3);
  });
});

describe('REG-F1 以前のデプロイの Cookie に残った Data Point の行を今の列の形へそろえる', () => {
  it('値の区分・値の有無・理由の列が無い行を補う', () => {
    expect(normalizeLegacyRow('dataPoints', { id: 'x', value: 12, textValue: null })).toMatchObject(
      { valueKind: 'actual', availabilityStatus: 'value_present', absenceReason: null },
    );
    expect(
      normalizeLegacyRow('dataPointVersions', { id: 'y', value: null, textValue: null }),
    ).toMatchObject({ availabilityStatus: 'not_entered' });
    // 以前のデプロイで作った Data Point と、その版（どちらも 0039 の列を持たない）。
    // Data Point は自分の版を指す（Cookie から戻す Data Point は現在の版の値の写しでなければならない。SEC-2）
    const legacyId = fid('data_point', 'legacy');
    const legacyVersionId = fid('data_point_version', 'legacy/v1');
    const template = fixture.dataPoints[0]!;
    const legacyVersion = {
      ...fixture.dataPointVersions.find((v) => v.id === template.currentVersionId)!,
      id: legacyVersionId,
      dataPointId: legacyId,
      value: template.value,
      textValue: template.textValue,
      unitOfMeasure: template.unitOfMeasure,
      status: 'draft',
    } as Record<string, unknown>;
    const legacy = {
      ...template,
      id: legacyId,
      currentVersionId: legacyVersionId,
      status: 'draft',
      approvedAt: null,
      approvedBy: null,
    } as Record<string, unknown>;
    for (const row of [legacy, legacyVersion]) {
      delete row.valueKind;
      delete row.availabilityStatus;
      delete row.absenceReason;
    }
    applyDemoEdits(fixture, [
      { t: 'dataPointVersions', id: legacyVersionId, v: legacyVersion },
      { t: 'dataPoints', id: legacyId, v: legacy },
    ]);
    const restored = fixture.dataPoints.find((d) => d.id === legacyId)!;
    expect(restored.valueKind).toBe('actual');
    expect(restored.availabilityStatus).toBeDefined();
  });
});

describe('PER-F3 Cookie の容量が足りないときも、機能設定の ON/OFF は押し出さない', () => {
  it('押し出す順は、機能設定以外のいちばん古い編集から', () => {
    const edits: DemoEdit[] = [
      { t: 'organizationFeatureSettings', id: 's', v: { disclosureFirst: true } },
      { t: 'dataPoints', id: 'a', v: {} },
      { t: 'dataPoints', id: 'b', v: {} },
    ];
    expect(dropOldestUnpinned(edits)?.map((e) => e.id)).toEqual(['s', 'b']);
    expect(dropOldestUnpinned([edits[0]!])).toBeNull();
  });
});

describe('PER-F2 / PER-F10 開示デモのリセットは、ほかのインスタンスにも同じ範囲で反映する', () => {
  it('別インスタンスのメモリに残った依頼・状態・開示の通知を Fixture の初期値へ戻す', async () => {
    // インスタンス B で依頼まで進めた（通知も届いた）
    await requestReview(db, author(), { blockId: RISK.block });
    expect(fixture.disclosureBlocks.find((b) => b.id === RISK.block)?.status).toBe(
      'review_requested',
    );
    expect(fixture.notifications.some((n) => (n.href ?? '').includes(RISK.block))).toBe(true);
    // インスタンス A でリセットが行われ、B は次のリクエストで反映する
    restoreDisclosureDemoTables(fixture, createFixtureDb(), ORG_IDS.aomi);
    expect(fixture.disclosureBlocks.find((b) => b.id === RISK.block)?.status).toBe('draft');
    expect(fixture.reviewRequests.filter((r) => r.targetId === RISK.block)).toHaveLength(0);
    expect(fixture.notifications.some((n) => (n.href ?? '').includes(RISK.block))).toBe(false);
  });

  it('リセットはデモ中に届いた開示の通知を消す（消した依頼・節を指し続けない）', async () => {
    await requestReview(db, author(), { blockId: RISK.block });
    const before = fixture.notifications.filter((n) => (n.href ?? '').includes(RISK.block));
    expect(before.length).toBeGreaterThan(0);
    const result = await resetDisclosureDemoData(db, author());
    expect(result.byTable.notifications?.removed).toBe(before.length);
    expect(fixture.notifications.some((n) => (n.href ?? '').includes(RISK.block))).toBe(false);
  });
});

describe('PER-F6 定性情報の版の ID は、同じ版番号でもインスタンスごとに別の値になる', () => {
  it('版の ID は版番号だけから決めない（別の本文を同じ ID で指さない）', async () => {
    const record = fixture.narrativeRecords.find((r) => r.id === IDS.narratives.riskPhysical)!;
    const version = fixture.narrativeVersions.find((v) => v.id === record.currentVersionId)!;
    const result = await saveNarrative(db, author(), {
      narrativeId: record.id,
      baseVersionId: record.currentVersionId,
      reportingPeriodId: version.reportingPeriodId,
      scopeNote: version.scopeNote,
      fields: { ...version.fields, response: '止水板の設置（架空）' },
      body: `${version.body} 対応策として止水板を設置します。`,
      sourceAnchorIds: version.sourceAnchorIds,
      changeReason: 'テスト',
      acknowledgeImpact: true,
    });
    expect(result.status).toBe('saved');
    const saved = fixture.narrativeVersions.find(
      (v) => v.narrativeRecordId === record.id && v.versionNo === 2,
    )!;
    expect(saved.id).not.toBe(fid('narrative_version', `${record.id}/v2`));
  });
});
