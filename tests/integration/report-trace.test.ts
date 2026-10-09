import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { parseDocx } from '@/lib/imports/docx-text';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { exportReportSnapshot, exportSnapshotTrace } from '@/lib/services/disclosure-export';
import { readXlsxSheets } from '@/lib/services/export-reconciliation';
import { createReviewDraftSnapshot } from '@/lib/services/report-snapshot';
import { loadSnapshotTrace } from '@/lib/services/report-trace';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * スナップショットの内容とトレース（トライアル対応 NF-14。int:report-trace）。
 * FY2025 の承認済みスナップショット（Fixture・v2）で件数と追跡率を固定し、画面・DOCX・XLSX の
 * 追跡番号が一致することを確かめる。読むだけで書かない。
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

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);
/** 閲覧だけの役割（出力の権限なし） */
const viewer = () => ctxFor('reviewer@demo.local', ['viewer']);
const contributor = () => ctxFor('site-user@demo.local', ['site_contributor']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const FY2025 = IDS.projects.fy2025;

describe('FY2025 の承認済みスナップショットのトレース', () => {
  it('件数と追跡率を固定する（写しだけから決まる）', async () => {
    const view = await loadSnapshotTrace(db, approver(), {
      projectId: FY2025,
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    });
    expect(view.integrityOk).toBe(true);
    // FY2025 はトライアル計画の対象外のプロジェクト（選定ケースは FY2026）なので全件
    expect(view.caseSource).toBe('all');
    expect(view.summary.label).toBe('2 / 5（段落 1 / 4・数値 1 / 1）');
    // Fixture の FY2025 の写しには引用位置（出典印）が無く、数値参照の無い段落は根拠なしになる
    expect(view.units.filter((u) => !u.traceable).map((u) => [u.traceId, u.reasons])).toEqual([
      ['T-G-1', ['no_evidence']],
      ['T-G-2', ['no_evidence']],
      ['T-MT-2', ['no_evidence']],
    ]);
    expect(view.units.filter((u) => u.traceable).map((u) => u.traceId)).toEqual([
      'T-MT-1',
      'T-MT-1-N1',
    ]);
    // 承認者・日時は写しに固定した承認の記録から出す
    for (const unit of view.units.filter((u) => u.kind === 'paragraph')) {
      expect(unit.approvedBy).not.toBeNull();
      expect(unit.approvedAt).not.toBeNull();
    }
  });

  it('段落を選ぶと、要求事項・承認版（承認者・日時）・根拠を返す。追跡番号で探せる', async () => {
    const first = await loadSnapshotTrace(db, approver(), {
      projectId: FY2025,
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    });
    const unit = first.units.find((u) => u.kind === 'paragraph')!;
    const view = await loadSnapshotTrace(db, approver(), {
      projectId: FY2025,
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      unit: unit.traceId,
      query: unit.traceId,
    });
    expect(view.selected?.unit.traceId).toBe(unit.traceId);
    expect(view.selected?.requirements.length).toBeGreaterThan(0);
    expect(view.selected?.approval.isApprovedVersion).toBe(true);
    expect(view.selected?.approval.approvedByName).toBeTruthy();
    expect(view.selected?.approval.approvedAt).toBe(unit.approvedAt);
    expect(view.search?.hits.map((u) => u.traceId)).toContain(unit.traceId);
    // 出力と同じ文字列（描画した段落）でも探せる
    const paragraphText = view.blocks
      .flatMap((b) => b.paragraphs)
      .find((p) => p.unit?.traceId === unit.traceId)!.text;
    const byText = await loadSnapshotTrace(db, approver(), {
      projectId: FY2025,
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      query: paragraphText.slice(0, 12),
    });
    expect(byText.search?.hits.map((u) => u.traceId)).toContain(unit.traceId);
  });

  it('追跡番号は画面・社内確認用 DOCX・XLSX のトレースで一致する', async () => {
    const view = await loadSnapshotTrace(db, approver(), {
      projectId: FY2025,
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    });
    const screenIds = view.units.filter((u) => u.kind === 'paragraph').map((u) => u.traceId);
    expect(screenIds.length).toBeGreaterThan(0);

    const docx = await exportReportSnapshot(db, approver(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      format: 'docx',
      audience: 'internal',
      frameworkVersionId: view.framework!.frameworkVersionId,
    });
    const paragraphs = (await parseDocx(docx.bytes)).paragraphs;
    const docxIds = paragraphs.flatMap((p) =>
      [...p.matchAll(/［(T-[A-Z0-9]+-\d+)］$/g)].map((m) => m[1]!),
    );
    expect(docxIds).toEqual(screenIds);
    // 巻末の追跡表にも同じ番号（段落・数値）
    const all = view.units.map((u) => u.traceId);
    const tableStart = paragraphs.indexOf('追跡表（社内確認用）');
    expect(tableStart).toBeGreaterThan(0);
    for (const id of all) expect(paragraphs.slice(tableStart)).toContain(id);

    // 対外用 DOCX の本文には追跡番号を出さない（ブックマークだけ）
    const external = await exportReportSnapshot(db, approver(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      format: 'docx',
      audience: 'external',
      frameworkVersionId: view.framework!.frameworkVersionId,
    });
    expect((await parseDocx(external.bytes)).paragraphs.join('\n')).not.toMatch(/［T-/);

    const xlsx = await exportReportSnapshot(db, approver(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      format: 'xlsx',
      audience: 'internal',
    });
    const trace = (await readXlsxSheets(xlsx.bytes)).get('トレース')!;
    expect(trace.slice(1).map((row) => row[0])).toEqual(all);

    // 追跡表の単独の出力（トレース画面の副操作）も同じ番号
    const traceXlsx = await exportSnapshotTrace(db, approver(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      frameworkVersionId: view.framework!.frameworkVersionId,
    });
    const sheet = (await readXlsxSheets(traceXlsx.bytes)).get('トレース')!;
    expect(sheet.slice(1).map((row) => row[0])).toEqual(all);
    // 出力の記録には足さない（監査ログだけ）
    expect(
      fixture.exportArtifacts.filter((a) => a.snapshotId === FY2025_APPROVED_SNAPSHOT_ID),
    ).toHaveLength(3);
  });
});

describe('選定ケースとトライアル計画', () => {
  it('FY2026 の草稿はトライアル計画の選定ケースが既定の分母になり、全件・指定コードに切り替えられる', async () => {
    const snapshot = await createReviewDraftSnapshot(db, author(), IDS.projects.fy2026);
    const byCase = await loadSnapshotTrace(db, author(), {
      projectId: IDS.projects.fy2026,
      snapshotId: snapshot.id,
    });
    expect(byCase.caseSource).toBe('trial_program');
    expect(byCase.trialCaseCodes).toEqual(
      expect.arrayContaining(['気候-10', '気候-11', '気候-19', '気候-47(1)']),
    );
    const all = await loadSnapshotTrace(db, author(), {
      projectId: IDS.projects.fy2026,
      snapshotId: snapshot.id,
      caseMode: 'all',
    });
    expect(all.caseSource).toBe('all');
    expect(all.summary.all.total).toBeGreaterThanOrEqual(byCase.summary.all.total);
    const only = await loadSnapshotTrace(db, author(), {
      projectId: IDS.projects.fy2026,
      snapshotId: snapshot.id,
      codes: ['気候-47(1)'],
    });
    expect(only.caseSource).toBe('query');
    expect(only.summary.selectedCodes).toEqual(['気候-47(1)']);
    expect(only.summary.all.total).toBeLessThanOrEqual(all.summary.all.total);
    // 草稿の未承認の節は「未承認の版」として追跡できない
    expect(all.units.some((u) => u.reasons.includes('not_approved'))).toBe(true);
  });
});

describe('権限とテナント', () => {
  it('開示の閲覧権限が無ければ ID の有無より先に断り、他テナント・別プロジェクトは見つからない', async () => {
    await expect(
      loadSnapshotTrace(db, contributor(), {
        projectId: FY2025,
        snapshotId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      loadSnapshotTrace(db, otherTenant(), {
        projectId: FY2025,
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      loadSnapshotTrace(db, approver(), {
        projectId: IDS.projects.fy2026,
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // 閲覧だけの役割（出力の権限なし）でも内容とトレースは見られる。追跡表の出力は断る
    const view = await loadSnapshotTrace(db, viewer(), {
      projectId: FY2025,
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    });
    expect(view.units.length).toBeGreaterThan(0);
    await expect(
      exportSnapshotTrace(db, viewer(), { snapshotId: FY2025_APPROVED_SNAPSHOT_ID }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('読むだけで書き込まない', async () => {
    const guarded = new WriteDetectingDbClient(db);
    await loadSnapshotTrace(guarded, approver(), {
      projectId: FY2025,
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      query: 'T-',
    });
    expect(guarded.writes).toEqual([]);
  });
});
