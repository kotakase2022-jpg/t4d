import { beforeEach, describe, expect, it } from 'vitest';
import {
  USAGE_HIDDEN_TEXT,
  confirmedMappings,
  usageItemCount,
  usageSectionTitle,
  usageSummaryText,
  visibleMappedItems,
} from '@/app/enterprise/data/[dataPointId]/usage';
import { ENGAGEMENT_IDS, ORG_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { listShareTargets, listSnapshotShares } from '@/lib/services/disclosure-export';
import { listDataPointUsage, listFileUsage } from '@/lib/services/impact';
import { hasOption } from '@/lib/services/organization-options';
import { createReportNote } from '@/lib/services/assurance-notes';
import { shareReportSnapshot, withdrawSharedReport } from '@/lib/services/report-share';
import { asSnapshotDetail } from '@/lib/services/report-snapshot';
import type { AuthorizationContext, FrameworkKey, RoleKey, Uuid } from '@/types/domain';

/**
 * 影響先の画面部分（トライアル対応 NF-16・NF-38・NF-20 の企業側。int:impact-usage の画面部分）。
 * データの詳細・資料の詳細の「この数値（資料）を使っている原稿・レポート」、承認済みの値を修正する
 * 確認ダイアログの影響の要約、開示マッピングの CDP の出し分け、出力タブの共有の状態。
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

const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);

/** FY2025 の承認済みスナップショットが固定した数値の Data Point */
function fy2025DataPointId(): Uuid {
  const row = fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!;
  return row.metricValues[0]!.dataPointId;
}

describe('データの詳細: この数値を使っている原稿・レポート', () => {
  it('影響の要約（確認ダイアログと同じ言い方）と見出しの件数', async () => {
    const usage = await listDataPointUsage(db, author(), fy2025DataPointId());
    expect(usage.snapshots.map((s) => s.snapshotId)).toContain(FY2025_APPROVED_SNAPSHOT_ID);
    expect(usageItemCount(usage)).toBe(usage.blocks.length + usage.snapshots.length);
    expect(usageSummaryText(usage.counts)).toBe(
      `影響する節 ${usage.counts.blocks}・承認済みレポート ${usage.counts.approvedReports}・保証側へ共有中 ${usage.counts.sharedWithAssurance}`,
    );
  });

  it('開示の閲覧権限が無い人には、影響先の件数を 0 と出さず「表示しません」とする', async () => {
    const siteUser = ctxFor('site-user@demo.local', ['site_contributor']);
    const usage = await listDataPointUsage(db, siteUser, fy2025DataPointId());
    expect(usage.disclosureHidden).toBe(true);
    const text = usageSummaryText(usage.counts, { disclosureHidden: usage.disclosureHidden });
    expect(text).toBe(USAGE_HIDDEN_TEXT);
    expect(text).not.toMatch(/影響する節 0/);
    const title = usageSectionTitle('数値', usageItemCount(usage), usage.disclosureHidden);
    expect(title).not.toContain('（0）');
    expect(title).toContain('権限が無いため表示しません');
    // 閲覧できる人には従来どおり件数を出す
    expect(usageSectionTitle('資料', 3, false)).toBe('この資料を使っている原稿・レポート（3）');
  });

  it('承認済みレポートを保証側へ共有すると「保証側へ共有中」に数え、取り下げると外れる', async () => {
    const dpId = fy2025DataPointId();
    const before = await listDataPointUsage(db, author(), dpId);
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENGAGEMENT_IDS.main,
    });
    const shared = await listDataPointUsage(db, author(), dpId);
    const snap = shared.snapshots.find((s) => s.snapshotId === FY2025_APPROVED_SNAPSHOT_ID)!;
    expect(snap.sharedEngagementIds).toEqual([ENGAGEMENT_IDS.main]);
    expect(shared.counts.sharedWithAssurance).toBeGreaterThanOrEqual(1);

    // 出力タブの共有の状態（案件コード・共有者・取り下げ）
    const shares = await listSnapshotShares(db, author(), [FY2025_APPROVED_SNAPSHOT_ID]);
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      copyId: copy.id,
      engagementCode: 'ENG-2026-001',
      withdrawnAt: null,
    });

    await withdrawSharedReport(db, admin(), { copyId: copy.id });
    const withdrawn = await listDataPointUsage(db, author(), dpId);
    expect(
      withdrawn.snapshots.find((s) => s.snapshotId === FY2025_APPROVED_SNAPSHOT_ID)!
        .sharedEngagementIds,
    ).toEqual([]);
    expect(withdrawn.counts.sharedWithAssurance).toBe(before.counts.sharedWithAssurance);
    expect(
      (await listSnapshotShares(db, author(), [FY2025_APPROVED_SNAPSHOT_ID]))[0]!.withdrawnAt,
    ).not.toBeNull();
  });

  it('共有した写しへの保証側のコメント（クライアントへ共有したもの）の件数と未回答の件数', async () => {
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENGAGEMENT_IDS.main,
    });
    const detail = asSnapshotDetail(
      fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!,
    );
    const block = detail.blocks.find((b) => b.body.paragraphs.some((p) => p.kind === 'paragraph'))!;
    const paragraph = block.body.paragraphs.find((p) => p.kind === 'paragraph')!;
    const firm: AuthorizationContext = {
      userId: userId('assurance-manager@demo.local'),
      email: 'assurance-manager@demo.local',
      displayName: 'x',
      workspace: {
        organizationId: ORG_IDS.aoba,
        organizationType: 'assurance_firm',
        organizationName: 'テスト',
        roleKeys: ['assurance_manager'],
        unitScopeIds: [],
      },
      engagementIds: [ENGAGEMENT_IDS.main],
      demo: true,
    };
    for (const sharedWithClient of [true, false]) {
      await createReportNote(db, firm, {
        engagementId: ENGAGEMENT_IDS.main,
        copyId: copy.id,
        target: { kind: 'report_paragraph', blockId: block.blockId, paragraphId: paragraph.id },
        body: 'テスト: 根拠の版を確認させてください。',
        sharedWithClient,
      });
    }
    const [share] = await listSnapshotShares(db, author(), [FY2025_APPROVED_SNAPSHOT_ID]);
    // 法人の内部のコメント（クライアントへ共有しないもの）は数えない
    expect(share).toMatchObject({ noteCount: 1, unansweredCount: 1 });
  });

  it('共有できる案件は許諾の管理の権限を持つ人にだけ出す（有効な許諾のある自社の案件）', async () => {
    expect((await listShareTargets(db, admin())).map((t) => t.code)).toEqual(['ENG-2026-001']);
    expect(await listShareTargets(db, reviewer())).toEqual([]);
  });
});

describe('開示マッピングの CDP の出し分け（NF-38）', () => {
  function mappedItemsOf(code: string) {
    const metric = metricId('AOMI', code);
    const itemIds = fixture.disclosureMappings
      .filter((m) => m.organizationId === ORG_IDS.aomi && m.metricId === metric)
      .map((m) => m.itemId);
    const items = fixture.disclosureItems.filter((i) => itemIds.includes(i.id));
    const keyByVersion = new Map<Uuid, FrameworkKey | undefined>(
      items.map((i) => {
        const version = fixture.frameworkVersions.find((v) => v.id === i.frameworkVersionId);
        return [
          i.frameworkVersionId,
          fixture.frameworks.find((f) => f.id === version?.frameworkId)?.key,
        ];
      }),
    );
    return { items, keyByVersion };
  }

  it('契約のある組織は CDP の項目も出し、契約が無ければ CDP だけを外す（SSBJ・CSRD は残す）', async () => {
    const { items, keyByVersion } = mappedItemsOf('scope1');
    const keys = (list: typeof items) =>
      [...new Set(list.map((i) => keyByVersion.get(i.frameworkVersionId)))].sort();
    expect(keys(items)).toEqual(['cdp', 'csrd', 'ssbj']);

    expect(await hasOption(db, author(), 'cdp')).toBe(true);
    expect(keys(visibleMappedItems(items, keyByVersion, { cdpContracted: true }))).toEqual([
      'cdp',
      'csrd',
      'ssbj',
    ]);

    // 契約の行を無効にした組織（運営が設定。顧客は書けない）
    const option = fixture.organizationOptions.find(
      (o) => o.organizationId === ORG_IDS.aomi && o.optionKey === 'cdp',
    )!;
    option.enabled = false;
    expect(await hasOption(db, author(), 'cdp')).toBe(false);
    expect(keys(visibleMappedItems(items, keyByVersion, { cdpContracted: false }))).toEqual([
      'csrd',
      'ssbj',
    ]);
  });
});

describe('開示マッピングの確定の有無', () => {
  it('確定を外した（確定日時の無い）対応付けは出さない', () => {
    const metric = metricId('AOMI', 'scope1');
    const mappings = fixture.disclosureMappings.filter(
      (m) => m.organizationId === ORG_IDS.aomi && m.metricId === metric,
    );
    expect(mappings.length).toBeGreaterThan(1);
    expect(confirmedMappings(mappings)).toHaveLength(mappings.length);
    const removed = [
      { ...mappings[0]!, confirmedAt: null, confirmedBy: null },
      ...mappings.slice(1),
    ];
    expect(confirmedMappings(removed).map((m) => m.id)).toEqual(mappings.slice(1).map((m) => m.id));
  });
});

describe('資料の詳細: この資料を使っている原稿・レポート', () => {
  it('引用位置を経由して引用している節・定性情報・スナップショットの件数', async () => {
    const anchor = fixture.sourceAnchors.find((a) => a.id === IDS.anchors.committeeGovernance1)!;
    const version = fixture.fileVersions.find((v) => v.id === anchor.fileVersionId)!;
    const usage = await listFileUsage(db, author(), version.fileId);
    expect(usage.disclosureHidden).toBe(false);
    expect(usage.blocks.length).toBeGreaterThan(0);
    expect(usageItemCount(usage)).toBe(usage.blocks.length + usage.snapshots.length);
    expect(usageSummaryText(usage.counts)).toContain(`影響する節 ${usage.blocks.length}`);
  });
});
