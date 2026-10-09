import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS, SCOPE1_CORRECTION } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { detectFileUpdates, FILE_UPDATE_DEFAULT_DECISION } from '@/lib/services/disclosure-recheck';
import { buildRequirementRows, getProject } from '@/lib/services/disclosure-project';
import { listDataPointUsage, listDerivedAttention, listFileUsage } from '@/lib/services/impact';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, DataPointVersion, RoleKey } from '@/types/domain';

/**
 * 変更の影響先と保存しない通知（トライアル対応 NF-16。int:impact-usage）。
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
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);
const contributor = () => ctxFor('site-user@demo.local', ['site_contributor']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const METRICS = IDS.blocks.fy2026Metrics.block;
const GOVERNANCE = IDS.blocks.fy2026Governance.block;

/** 上流の数値に新しい承認済みの版ができた状態（取込・訂正・承認の代わり） */
function approveNewScope1Version(value: number): DataPointVersion {
  const dpId = SCOPE1_CORRECTION.dataPointId;
  const dp = fixture.dataPoints.find((d) => d.id === dpId)!;
  const versions = fixture.dataPointVersions.filter((v) => v.dataPointId === dpId);
  const base = versions[versions.length - 1]!;
  const version: DataPointVersion = {
    ...base,
    id: fid('data_point_version', `${dpId}/impact-test/${versions.length + 1}`),
    versionNo: versions.length + 1,
    value,
    status: 'approved',
    changeReason: 'テスト: 承認後の訂正（架空）',
    createdAt: new Date().toISOString(),
  };
  fixture.dataPointVersions.push(version);
  const index = fixture.dataPoints.findIndex((d) => d.id === dpId);
  fixture.dataPoints[index] = { ...dp, currentVersionId: version.id, value, status: 'approved' };
  return version;
}

function snapshotHashes(): string[] {
  return fixture.reportSnapshots.map((s) => `${s.id}:${s.contentHash}`).sort();
}

describe('Data Point の影響先', () => {
  it('Scope1 を引用する節・スナップショット・Data Room の共有を返す', async () => {
    const usage = await listDataPointUsage(db, author(), SCOPE1_CORRECTION.dataPointId);
    expect(usage.disclosureHidden).toBe(false);
    const metrics = usage.blocks.find((b) => b.blockId === METRICS);
    expect(metrics).toBeDefined();
    expect(metrics!.usage).toContain('current');
    expect(metrics!.citedRefIds).toContain(SCOPE1_CORRECTION.citedVersionId);
    // 引用中の版（v1）は現在の版（v2）ではない
    expect(metrics!.upToDate).toBe(false);
    expect(usage.counts.blocks).toBe(usage.blocks.length);
    expect(usage.counts.approvedReports).toBe(
      usage.snapshots.filter((s) => s.snapshotKind === 'approved').length,
    );
    // HQ の Scope1 は許諾範囲内・承認済みなので Data Room で共有中
    expect(usage.dataRoomEngagementIds.length).toBeGreaterThan(0);
    expect(usage.counts.sharedWithAssurance).toBeGreaterThanOrEqual(1);
  });

  it('開示の閲覧権限が無い人には節・スナップショットを出さない', async () => {
    const usage = await listDataPointUsage(db, contributor(), SCOPE1_CORRECTION.dataPointId);
    expect(usage.disclosureHidden).toBe(true);
    expect(usage.blocks).toEqual([]);
    expect(usage.snapshots).toEqual([]);
  });

  it('他組織の Data Point は見つからない', async () => {
    await expect(
      listDataPointUsage(db, otherTenant(), SCOPE1_CORRECTION.dataPointId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('読み取りだけで書き込まない', async () => {
    const guarded = new WriteDetectingDbClient(db);
    await listDataPointUsage(guarded, author(), SCOPE1_CORRECTION.dataPointId);
    await listDerivedAttention(guarded, author());
    await listDerivedAttention(guarded, approver());
    expect(guarded.writes).toEqual([]);
  });
});

describe('保存しない通知（要再確認）', () => {
  it('Scope1 の新しい版の承認で、担当者と最終承認者にそれぞれ 1 件ずつ出る', async () => {
    const hashesBefore = snapshotHashes();
    approveNewScope1Version(1234.5);
    const forAuthor = (await listDerivedAttention(db, author())).filter(
      (a) => a.blockId === METRICS,
    );
    const forApprover = (await listDerivedAttention(db, approver())).filter(
      (a) => a.blockId === METRICS,
    );
    expect(forAuthor).toHaveLength(1);
    expect(forAuthor[0]!.roles).toEqual(['owner']);
    expect(forAuthor[0]!.reasons).toContain('upstream_updated');
    expect(forApprover).toHaveLength(1);
    expect(forApprover[0]!.roles).toEqual(['final_approver']);
    // 承認済みのスナップショットは変わらない
    expect(snapshotHashes()).toEqual(hashesBefore);
  });

  it('担当と最終承認者を兼ねても 1 件にまとめる（重複除去）', async () => {
    const project = fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2026)!;
    project.finalApproverUserId = author().userId;
    const entries = (await listDerivedAttention(db, author())).filter((a) => a.blockId === METRICS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.roles).toEqual(['owner', 'final_approver']);
  });

  it('他組織の人には出ない', async () => {
    const entries = await listDerivedAttention(db, otherTenant());
    const aomiBlocks = new Set(
      fixture.disclosureBlocks.filter((b) => b.organizationId === ORG_IDS.aomi).map((b) => b.id),
    );
    expect(entries.some((e) => aomiBlocks.has(e.blockId))).toBe(false);
  });

  it('開示の閲覧権限が無い人には空', async () => {
    expect(await listDerivedAttention(db, contributor())).toEqual([]);
  });
});

describe('資料の新版（P1）', () => {
  function committeeFile() {
    const anchor = fixture.sourceAnchors.find((a) => a.id === IDS.anchors.committeeGovernance1)!;
    const version = fixture.fileVersions.find((v) => v.id === anchor.fileVersionId)!;
    return { anchor, version, fileId: version.fileId };
  }

  it('引用位置の資料に新しい版ができると「上流に新版あり（資料）」として導出される', async () => {
    const { version, fileId } = committeeFile();
    const block = fixture.disclosureBlocks.find((b) => b.id === GOVERNANCE)!;
    expect(await detectFileUpdates(db, author(), block)).toEqual([]);
    const usageBefore = await listFileUsage(db, author(), fileId);
    expect(usageBefore.blocks.map((b) => b.blockId)).toContain(GOVERNANCE);
    expect(usageBefore.blocks.find((b) => b.blockId === GOVERNANCE)!.upToDate).toBe(true);

    fixture.fileVersions.push({
      ...version,
      id: fid('file_version', `${fileId}/impact-test/2`),
      versionNo: version.versionNo + 1,
      sha256: 'f'.repeat(64),
      createdAt: new Date().toISOString(),
    });
    const updates = await detectFileUpdates(db, author(), block);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]!.latestVersionNo).toBe(version.versionNo + 1);
    expect(updates[0]!.paragraphIds.length).toBeGreaterThan(0);
    expect(FILE_UPDATE_DEFAULT_DECISION).toBe('return_to_owner');

    const attention = (await listDerivedAttention(db, author())).find(
      (a) => a.blockId === GOVERNANCE,
    );
    expect(attention?.reasons).toContain('file_updated');
    const usageAfter = await listFileUsage(db, author(), fileId);
    expect(usageAfter.blocks.find((b) => b.blockId === GOVERNANCE)!.upToDate).toBe(false);
  });

  it('要求事項タブの「要再確認」も資料の新版を数える（概要のチップと同じ集合。区分は変えない）', async () => {
    const { version, fileId } = committeeFile();
    const block = fixture.disclosureBlocks.find((b) => b.id === GOVERNANCE)!;
    const rowsOf = async () => {
      const detail = await getProject(db, author(), block.projectId);
      const view = detail.frameworks.find((f) => f.version.id === block.frameworkVersionId)!;
      return (await buildRequirementRows(db, author(), detail, view)).rows.filter((r) =>
        block.requirementItemIds.includes(r.item.id),
      );
    };
    const before = await rowsOf();
    expect(before.length).toBeGreaterThan(0);
    const beforeFlags = new Map(before.map((r) => [r.item.id, r.flags.recheck]));
    const beforeCategories = new Map(before.map((r) => [r.item.id, r.coverage.category]));

    fixture.fileVersions.push({
      ...version,
      id: fid('file_version', `${fileId}/impact-test/rows`),
      versionNo: version.versionNo + 1,
      sha256: 'e'.repeat(64),
      createdAt: new Date().toISOString(),
    });
    const after = await rowsOf();
    for (const row of after) {
      expect(row.flags.recheck, row.item.code).toBe(true);
      // 資料の新版は節の鮮度・区分を変えない（recheck_decisions に記録できないため。Stage A の方針）
      expect(row.coverage.category, row.item.code).toBe(beforeCategories.get(row.item.id));
    }
    expect([...beforeFlags.values()].every((flag) => flag === false)).toBe(true);
  });

  it('他組織の資料は見つからない', async () => {
    const { fileId } = committeeFile();
    await expect(listFileUsage(db, otherTenant(), fileId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
