import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ENGAGEMENT_IDS, ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { parseSharedReportCopy } from '@/lib/domain/report-copy';
import { buildReportTrace } from '@/lib/domain/report-trace';
import {
  describeReportNoteTarget,
  loadClientAssuranceComments,
  loadEngagementReviewNotes,
  loadSharedReportList,
  loadSharedReportView,
  recordSharedReportView,
  SHARED_REPORT_VIEW_RESOURCE,
  sharedReportTrace,
} from '@/lib/services/assurance';
import { createReportNote, respondToNote } from '@/lib/services/assurance-notes';
import { shareReportSnapshot, withdrawSharedReport } from '@/lib/services/report-share';
import type { AuthorizationContext, RoleKey, SharedReportCopy } from '@/types/domain';

/**
 * 保証連携の画面が使う読み取り（T3。NF-20・NF-21 の画面部分）。
 *  - 保証側: 開示レポートの一覧（コメント数・整合）・内容（トレース・コメント）・レビュー Note の対象と回答
 *  - 企業側: 保証側のコメント（クライアントへ共有したものだけ・対象の段落/数値・プロジェクトで絞る）
 *  - 書き込みは中核サービス（assurance-notes.ts・report-share.ts）。ここは読むだけで、監査法人の行を更新しない
 */

let fixture: FixtureDb;
let db: DemoDbClient;
let copy: SharedReportCopy;

const ENG = ENGAGEMENT_IDS.main;

function enterprise(email: string, roleKeys: RoleKey[], organizationId: string = ORG_IDS.aomi) {
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
  } satisfies AuthorizationContext;
}

function firm(email: string, roleKeys: RoleKey[], engagementIds: string[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aoba,
      organizationType: 'assurance_firm',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds,
    demo: true,
  };
}

const admin = () => enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
const author = () => enterprise('sustainability@demo.local', ['sustainability_manager']);
const otherTenant = () =>
  enterprise('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
const manager = () => firm('assurance-manager@demo.local', ['assurance_manager'], [ENG]);
const unassigned = () => firm('assurance-manager@demo.local', ['assurance_manager'], []);

function content() {
  return parseSharedReportCopy(copy.copy)!;
}

function firstParagraph() {
  const unit = sharedReportTrace(content()).units.find((u) => u.kind === 'paragraph')!;
  return { blockId: unit.blockId, paragraphId: unit.paragraphId, unit };
}

function firstMetric() {
  const unit = sharedReportTrace(content()).units.find(
    (u) => u.kind === 'number' && u.dataPointVersionId !== null,
  )!;
  return { dataPointVersionId: unit.dataPointVersionId!, unit };
}

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  copy = await shareReportSnapshot(db, admin(), {
    snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    engagementId: ENG,
  });
});

describe('開示レポート（保証側）', () => {
  it('一覧は共有中の写しだけで、コメント数と整合（写しのハッシュ）を出す', async () => {
    const paragraph = firstParagraph();
    await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: {
        kind: 'report_paragraph',
        blockId: paragraph.blockId,
        paragraphId: paragraph.paragraphId,
      },
      body: '根拠の版を確認させてください。',
      sharedWithClient: false,
    });
    const [row, ...rest] = await loadSharedReportList(db, manager(), ENG);
    expect(rest).toHaveLength(0);
    expect(row!.copy.id).toBe(copy.id);
    expect(row!.integrityOk).toBe(true);
    expect(row!.label).toBe(`No.${content().snapshotNo} ${content().label}`);
    expect(row!.noteCount).toBe(1);
    expect(row!.openNoteCount).toBe(1);

    // 写しが共有時と違えば「整合しない」（画面は内容を出さない）
    fixture.sharedReportCopies.find((c) => c.id === copy.id)!.copy = {
      ...copy.copy,
      label: '書き換え',
    };
    const [tampered] = await loadSharedReportList(db, manager(), ENG);
    expect(tampered!.integrityOk).toBe(false);

    await withdrawSharedReport(db, admin(), { copyId: copy.id });
    expect(await loadSharedReportList(db, manager(), ENG)).toHaveLength(0);
  });

  it('未アサイン・企業のユーザーは一覧・内容を読めない', async () => {
    await expect(loadSharedReportList(db, unassigned(), ENG)).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadSharedReportList(db, admin(), ENG)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      loadSharedReportView(db, unassigned(), { engagementId: ENG, copyId: copy.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('内容はトレース（NF-14 と同じ純関数）とコメントを持ち、閲覧を監査ログに 1 件残す', async () => {
    const view = await loadSharedReportView(db, manager(), { engagementId: ENG, copyId: copy.id });
    expect(view.integrityOk).toBe(true);
    expect(view.notes).toEqual([]);
    // 写しのトレースは buildReportTrace と同じ（定性情報の根拠は写しに無いので空集合で数える）
    const expected = buildReportTrace({
      blocks: view.content.blocks,
      metricValues: view.content.metricValues,
      narrativeVersionsWithEvidence: new Set(),
    });
    const trace = sharedReportTrace(view.content);
    expect(trace.summary).toEqual(expected.summary);
    expect(trace.units.map((u) => u.traceId)).toEqual(expected.units.map((u) => u.traceId));
    expect(trace.narrativeEvidenceUnknown).toBe(view.content.narrativeVersionIds.length > 0);

    await recordSharedReportView(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      label: view.label,
    });
    const events = fixture.auditEvents.filter(
      (e) => e.eventType === 'record_viewed' && e.resourceType === SHARED_REPORT_VIEW_RESOURCE,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.resourceId).toBe(copy.id);
    expect(events[0]!.afterSummary).toBe(`開示レポート ${view.label} を表示`);
  });

  it('コメントの対象を「節 段落 n／数値」と追跡番号で表す（写しに無い対象はその旨）', () => {
    const paragraph = firstParagraph();
    const label = describeReportNoteTarget(
      {
        targetType: 'report_paragraph',
        targetCopyId: copy.id,
        targetBlockId: paragraph.blockId,
        targetParagraphId: paragraph.paragraphId,
        targetDataPointVersionId: null,
      },
      content(),
    )!;
    expect(label.kind).toBe('report_paragraph');
    expect(label.traceId).toBe(paragraph.unit.traceId);
    expect(label.place).toBe(`${paragraph.unit.blockTitle} 段落 ${paragraph.unit.paragraphNo}`);
    expect(label.excerpt.length).toBeGreaterThan(0);

    const metric = firstMetric();
    const metricLabel = describeReportNoteTarget(
      {
        targetType: 'report_metric',
        targetCopyId: copy.id,
        targetBlockId: null,
        targetParagraphId: null,
        targetDataPointVersionId: metric.dataPointVersionId,
      },
      content(),
    )!;
    const mv = content().metricValues.find(
      (m) => m.dataPointVersionId === metric.dataPointVersionId,
    )!;
    expect(metricLabel.place).toBe(`${mv.metricName} ／ ${mv.unitName} ／ ${mv.periodCode}`);
    expect(metricLabel.traceId).toBe(metric.unit.traceId);

    const missing = describeReportNoteTarget(
      {
        targetType: 'report_paragraph',
        targetCopyId: copy.id,
        targetBlockId: paragraph.blockId,
        targetParagraphId: 'no-such-paragraph',
        targetDataPointVersionId: null,
      },
      content(),
    )!;
    expect(missing.traceId).toBeNull();
    expect(missing.place).toContain('段落が写しに見つかりません');
    // 案件全体へのコメントは対象の表示なし
    expect(
      describeReportNoteTarget(
        {
          targetType: 'engagement',
          targetCopyId: null,
          targetBlockId: null,
          targetParagraphId: null,
          targetDataPointVersionId: null,
        },
        content(),
      ),
    ).toBeNull();
  });
});

describe('レビュー Note（保証側）の対象と回答', () => {
  it('段落・数値のコメントに対象と企業の回答が付き、内部限定は企業側の状態を持たない', async () => {
    const paragraph = firstParagraph();
    const shared = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: {
        kind: 'report_paragraph',
        blockId: paragraph.blockId,
        paragraphId: paragraph.paragraphId,
      },
      body: '要求事項との対応を説明してください。',
      sharedWithClient: true,
    });
    const internal = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: { kind: 'report_metric', dataPointVersionId: firstMetric().dataPointVersionId },
      body: '再計算の対象にする。',
      sharedWithClient: false,
    });
    await respondToNote(db, author(), {
      noteId: shared.id,
      body: '対応表の 3 行目をご覧ください。',
    });

    const entries = await loadEngagementReviewNotes(db, manager(), ENG);
    const sharedEntry = entries.find((e) => e.note.id === shared.id)!;
    expect(sharedEntry.clientState).toBe('answered');
    expect(sharedEntry.responses.map((r) => r.body)).toEqual(['対応表の 3 行目をご覧ください。']);
    expect(sharedEntry.target?.traceId).toBe(paragraph.unit.traceId);
    const internalEntry = entries.find((e) => e.note.id === internal.id)!;
    expect(internalEntry.clientState).toBeNull();
    expect(internalEntry.target?.kind).toBe('report_metric');
    // 案件全体のレビュー Note（Fixture）は対象なし
    expect(
      entries.filter((e) => e.note.targetCopyId === null).every((e) => e.target === null),
    ).toBe(true);
    // 回答しても監査法人の行（review_notes）は変わらない
    expect(fixture.reviewNotes.find((n) => n.id === shared.id)!.status).toBe('open');
  });

  it('未アサインの人はレビュー Note を読めない', async () => {
    await expect(loadEngagementReviewNotes(db, unassigned(), ENG)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('保証側のコメント（企業側）', () => {
  async function seedNotes() {
    const paragraph = firstParagraph();
    const shared = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: {
        kind: 'report_paragraph',
        blockId: paragraph.blockId,
        paragraphId: paragraph.paragraphId,
      },
      body: '要求事項との対応を説明してください。',
      sharedWithClient: true,
    });
    const internal = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: { kind: 'report_metric', dataPointVersionId: firstMetric().dataPointVersionId },
      body: '法人内部のメモ',
      sharedWithClient: false,
    });
    return { shared, internal, paragraph };
  }

  it('クライアントへ共有されたコメントだけを、対象とプロジェクト付きで出す', async () => {
    const { shared, internal, paragraph } = await seedNotes();
    const rows = await loadClientAssuranceComments(db, author());
    expect(rows.some((r) => r.note.id === internal.id)).toBe(false);
    const row = rows.find((r) => r.note.id === shared.id)!;
    expect(row.state).toBe('unanswered');
    expect(row.target?.traceId).toBe(paragraph.unit.traceId);
    expect(row.projectId).toBe(content().projectId);
    expect(row.projectName).toBe(content().frameworkVersions[0]!.projectName);
    expect(row.engagement.id).toBe(ENG);

    // プロジェクトで絞る（レビュー・承認タブ）
    const inProject = await loadClientAssuranceComments(db, author(), {
      projectId: content().projectId,
    });
    expect(inProject.map((r) => r.note.id)).toEqual([shared.id]);
    expect(
      await loadClientAssuranceComments(db, author(), {
        projectId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual([]);

    await respondToNote(db, author(), { noteId: shared.id, body: '回答します。' });
    const answered = await loadClientAssuranceComments(db, author());
    expect(answered.find((r) => r.note.id === shared.id)!.state).toBe('answered');
  });

  it('他のテナントには出ない・開示の閲覧権限が要る', async () => {
    await seedNotes();
    expect(await loadClientAssuranceComments(db, otherTenant())).toEqual([]);
    const supplier = enterprise('sustainability@demo.local', ['supplier_contributor']);
    await expect(loadClientAssuranceComments(db, supplier)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
