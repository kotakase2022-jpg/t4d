import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { itemVerdict } from '@/lib/domain/ghg/attribution';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { compactRow } from '@/lib/repositories/demo-compact';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
} from '@/lib/repositories/demo-edit-codec';
import { loadReconciliation } from '@/lib/services/ghg/reconciliation';
import { notePermissionReason, recordCause } from '@/lib/services/ghg/reconciliation-notes';
import type { AuthorizationContext, ReconciliationItem, RoleKey, Uuid } from '@/types/domain';

/**
 * 差異の原因の確認の記録（plan §2.3 reconciliation-notes.ts・CR-13・int:ghg-reconciliation-notes）。
 *  - 記録は enterprise.data.review・本人名義・追記専用（記録し直すと前の記録を差し替える新しい記録）
 *  - 「その他」と「原因不明（残差）」の項目はコメント必須
 *  - 原因を記録した項目の判定は「原因を確認済み」になる（照合の主な原因は候補にすぎない）
 *  - Demo の上限（20 件・コメント 200 字）。記録は Cookie から戻せる
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
  organizationId: Uuid = ORG_IDS.aomi,
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

const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);
const other = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
const G = GHG_FIXTURE_IDS;

function fixtureItems(): ReconciliationItem[] {
  return fixture.ghgReconciliations.find((r) => r.id === G.reconciliation)!.result!.items;
}

const vnItem = () =>
  fixtureItems().find((i) => i.unitId === G.units.vn && i.mainCause === 'factor')!;
const usResidual = () =>
  fixtureItems().find((i) => i.unitId === G.units.us && itemVerdict(i, []) === 'unexplained')!;

describe('recordCause', () => {
  it('レビュー担当が本人名義で記録し、判定は「原因を確認済み」になる（監査ログは data_created）', async () => {
    const item = vnItem();
    const note = await recordCause(db, reviewer(), {
      reconciliationId: G.reconciliation,
      itemKey: item.key,
      cause: 'factor',
      comment: '（テスト）2024 年版の係数で算定していた',
    });
    expect(note).toMatchObject({
      organizationId: ORG_IDS.aomi,
      reconciliationId: G.reconciliation,
      itemKey: item.key,
      confirmedCause: 'factor',
      decidedBy: userId('reviewer@demo.local'),
      supersedesId: null,
    });
    const loaded = await loadReconciliation(db, reviewer(), G.reconciliation);
    const view = loaded.items!.find((i) => i.key === item.key)!;
    expect(view.verdict).toBe('cause_confirmed');
    expect(view.latestNote?.id).toBe(note.id);
    const audit = fixture.auditEvents.find((e) => e.resourceId === note.id)!;
    expect(audit).toMatchObject({
      eventType: 'data_created',
      resourceType: 'ghg_reconciliation_note',
    });
  });

  it('記録し直すと前の記録を差し替える（前の記録は履歴に残り、最新だけが効く）', async () => {
    const item = vnItem();
    const first = await recordCause(db, reviewer(), {
      reconciliationId: G.reconciliation,
      itemKey: item.key,
      cause: 'factor',
      comment: '',
    });
    const second = await recordCause(db, reviewer(), {
      reconciliationId: G.reconciliation,
      itemKey: item.key,
      cause: 'activity',
      comment: '（テスト）活動量の転記の差だった',
    });
    expect(second.supersedesId).toBe(first.id);
    const loaded = await loadReconciliation(db, reviewer(), G.reconciliation);
    const view = loaded.items!.find((i) => i.key === item.key)!;
    expect(view.notes.map((n) => n.id)).toEqual([first.id, second.id]);
    expect(view.latestNote?.confirmedCause).toBe('activity');
    expect(fixture.ghgReconciliationNotes).toHaveLength(2);
  });

  it('「その他」と「原因不明（残差）」の項目はコメント必須。原因は列挙の値だけ', async () => {
    await expect(
      recordCause(db, reviewer(), {
        reconciliationId: G.reconciliation,
        itemKey: vnItem().key,
        cause: 'other',
        comment: '  ',
      }),
    ).rejects.toThrow(/「その他」のときは/);
    await expect(
      recordCause(db, reviewer(), {
        reconciliationId: G.reconciliation,
        itemKey: usResidual().key,
        cause: 'factor',
        comment: '',
      }),
    ).rejects.toThrow(/原因不明（残差）」の項目は/);
    await expect(
      recordCause(db, reviewer(), {
        reconciliationId: G.reconciliation,
        itemKey: vnItem().key,
        cause: 'ai_guess',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const note = await recordCause(db, reviewer(), {
      reconciliationId: G.reconciliation,
      itemKey: usResidual().key,
      cause: 'factor',
      comment: '（テスト）仮説の再計算（2024 年版）で差が閉じることを確かめた',
    });
    expect(note.confirmedCause).toBe('factor');
    expect(fixture.ghgReconciliationNotes).toHaveLength(1);
  });

  it('確認の権限が無い人・他社は記録できない。項目・照合が無ければ見つからない', async () => {
    expect(notePermissionReason(siteUser())).not.toBeNull();
    expect(notePermissionReason(reviewer())).toBeNull();
    await expect(
      recordCause(db, siteUser(), {
        reconciliationId: G.reconciliation,
        itemKey: vnItem().key,
        cause: 'factor',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      recordCause(db, other(), {
        reconciliationId: G.reconciliation,
        itemKey: vnItem().key,
        cause: 'factor',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      recordCause(db, reviewer(), {
        reconciliationId: G.reconciliation,
        itemKey: 'no-such-item',
        cause: 'factor',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      recordCause(db, reviewer(), {
        reconciliationId: 'not-a-uuid',
        itemKey: vnItem().key,
        cause: 'factor',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fixture.ghgReconciliationNotes).toHaveLength(0);
  });

  it('Demo の上限: コメントは 200 字まで・記録は 20 件まで', async () => {
    await expect(
      recordCause(db, reviewer(), {
        reconciliationId: G.reconciliation,
        itemKey: vnItem().key,
        cause: 'factor',
        comment: 'あ'.repeat(DEMO_GHG_LIMITS.noteComment + 1),
      }),
    ).rejects.toThrow(/200 字まで/);
    const keys = fixtureItems().map((i) => i.key);
    for (let n = 0; n < DEMO_GHG_LIMITS.notes; n += 1) {
      await recordCause(db, reviewer(), {
        reconciliationId: G.reconciliation,
        itemKey: keys[n]!,
        cause: 'rounding',
        comment: '（テスト）',
      });
    }
    await expect(
      recordCause(db, reviewer(), {
        reconciliationId: G.reconciliation,
        itemKey: keys[DEMO_GHG_LIMITS.notes]!,
        cause: 'rounding',
        comment: '（テスト）',
      }),
    ).rejects.toThrow(/20 件まで/);
  });

  it('記録は Cookie から戻せる（本人名義・確認の権限の検査を通る）', async () => {
    const note = await recordCause(db, reviewer(), {
      reconciliationId: G.reconciliation,
      itemKey: vnItem().key,
      cause: 'factor',
      comment: '（テスト）',
    });
    const target = createFixtureDb();
    applyDemoEdits(
      target,
      decodeDemoEdits(
        encodeDemoEditStream([
          {
            t: 'ghgReconciliationNotes',
            id: note.id,
            v: compactRow(
              'ghgReconciliationNotes',
              note as unknown as Record<string, unknown>,
              fixture,
            )!,
          },
        ]),
      ),
    );
    expect(target.ghgReconciliationNotes.find((n) => n.id === note.id)).toEqual(note);
  });
});
