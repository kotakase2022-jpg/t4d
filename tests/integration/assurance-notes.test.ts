import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ENGAGEMENT_IDS, ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { parseSharedReportCopy } from '@/lib/domain/report-copy';
import { ValidationError } from '@/lib/errors/user-facing';
import {
  clientNoteStateOf,
  createReportNote,
  listNotesForClient,
  listNotesForCopy,
  noteBodyLimit,
  respondToNote,
} from '@/lib/services/assurance-notes';
import { loadEngagementReviewNotes } from '@/lib/services/assurance';
import { shareReportSnapshot, withdrawSharedReport } from '@/lib/services/report-share';
import type { AuthorizationContext, RoleKey, SharedReportCopy } from '@/types/domain';

/**
 * 保証側のコメント（段落・数値）と企業側の回答（トライアル対応 NF-21。int:assurance-notes）。
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
const viewer = () => enterprise('enterprise-admin@demo.local', ['viewer']);
const otherTenant = () =>
  enterprise('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
const manager = () => firm('assurance-manager@demo.local', ['assurance_manager'], [ENG]);
const unassigned = () => firm('assurance-manager@demo.local', ['assurance_manager'], []);

function firstParagraph() {
  const content = parseSharedReportCopy(copy.copy)!;
  for (const block of content.blocks) {
    const p = block.body.paragraphs.find((x) => x.kind === 'paragraph');
    if (p) return { blockId: block.blockId, paragraphId: p.id };
  }
  throw new Error('no paragraph');
}

function firstMetric() {
  const content = parseSharedReportCopy(copy.copy)!;
  return content.metricValues[0]!.dataPointVersionId;
}

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  copy = await shareReportSnapshot(db, admin(), {
    snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    engagementId: ENG,
  });
});

describe('起票（保証側）', () => {
  it('共有中の写しの段落・数値にコメントできる（既定は法人内部限定）', async () => {
    const paragraph = firstParagraph();
    const note = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: { kind: 'report_paragraph', ...paragraph },
      body: '根拠資料の版を確認させてください。',
      sharedWithClient: false,
    });
    expect(note.targetType).toBe('report_paragraph');
    expect(note.targetCopyId).toBe(copy.id);
    expect(note.targetBlockId).toBe(paragraph.blockId);
    expect(note.sharedWithClient).toBe(false);

    const metric = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: { kind: 'report_metric', dataPointVersionId: firstMetric() },
      body: '算定方法の説明をお願いします。',
      sharedWithClient: true,
    });
    expect(metric.targetDataPointVersionId).toBe(firstMetric());
    const listed = await listNotesForCopy(db, manager(), { engagementId: ENG, copyId: copy.id });
    expect(listed.map((n) => n.note.id).sort()).toEqual([note.id, metric.id].sort());
  });

  it('企業が共有を取り下げると、保証側のコメント一覧に写しの本文（段落の抜粋）を出さない', async () => {
    const paragraph = firstParagraph();
    const note = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: { kind: 'report_paragraph', ...paragraph },
      body: '根拠資料の版を確認させてください。',
      sharedWithClient: false,
    });
    const before = (await loadEngagementReviewNotes(db, manager(), ENG)).find(
      (e) => e.note.id === note.id,
    )!;
    expect(before.target!.excerpt).not.toBe('');
    expect(before.target!.reportLabel).not.toBeNull();

    await withdrawSharedReport(db, admin(), { copyId: copy.id });
    const after = (await loadEngagementReviewNotes(db, manager(), ENG)).find(
      (e) => e.note.id === note.id,
    )!;
    // コメント自体は保証側の記録として残るが、取り下げた写しの本文は出さない（DB の SELECT ポリシーと同じ）
    expect(after.target!.excerpt).toBe('');
    expect(after.target!.reportLabel).toBeNull();
    expect(after.target!.place).toContain('見つかりません');
  });

  it('写しに無い段落・数値は対象にできない', async () => {
    await expect(
      createReportNote(db, manager(), {
        engagementId: ENG,
        copyId: copy.id,
        target: { kind: 'report_paragraph', blockId: firstParagraph().blockId, paragraphId: 'x' },
        body: '確認',
        sharedWithClient: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createReportNote(db, manager(), {
        engagementId: ENG,
        copyId: copy.id,
        target: {
          kind: 'report_metric',
          dataPointVersionId: '00000000-0000-4000-8000-000000000000',
        },
        body: '確認',
        sharedWithClient: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('未アサイン・企業側は起票できない。Demo Mode の本文は 400 字まで', async () => {
    const input = {
      engagementId: ENG,
      copyId: copy.id,
      target: { kind: 'report_paragraph' as const, ...firstParagraph() },
      body: '確認',
      sharedWithClient: true,
    };
    await expect(createReportNote(db, unassigned(), input)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createReportNote(db, admin(), input)).rejects.toBeInstanceOf(AuthorizationError);
    expect(noteBodyLimit({ demo: true })).toBe(400);
    expect(noteBodyLimit({ demo: false })).toBe(2000);
    await expect(
      createReportNote(db, manager(), { ...input, body: 'あ'.repeat(401) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('企業側の閲覧と回答', () => {
  it('クライアントへ共有しないコメントは企業に見えず、回答もできない', async () => {
    const internal = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: { kind: 'report_paragraph', ...firstParagraph() },
      body: '法人内部のメモ',
      sharedWithClient: false,
    });
    const notes = await listNotesForClient(db, author());
    expect(notes.some((n) => n.note.id === internal.id)).toBe(false);
    await expect(
      respondToNote(db, author(), { noteId: internal.id, body: '回答' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('共有されたコメントに回答すると「回答済み」になり、保証側の行は更新しない', async () => {
    const shared = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: { kind: 'report_metric', dataPointVersionId: firstMetric() },
      body: '算定方法の説明をお願いします。',
      sharedWithClient: true,
    });
    const before = structuredClone(fixture.reviewNotes.find((n) => n.id === shared.id)!);
    let entries = await listNotesForClient(db, author());
    expect(entries.find((e) => e.note.id === shared.id)?.state).toBe('unanswered');

    const response = await respondToNote(db, author(), {
      noteId: shared.id,
      body: '排出係数は前年と同じです（架空）。',
    });
    expect(response.respondedBy).toBe(author().userId);
    entries = await listNotesForClient(db, author());
    const entry = entries.find((e) => e.note.id === shared.id)!;
    expect(entry.state).toBe('answered');
    expect(entry.responses.map((r) => r.id)).toEqual([response.id]);
    // 監査法人の行（review_notes）は企業の操作で変わらない
    expect(fixture.reviewNotes.find((n) => n.id === shared.id)).toEqual(before);
    // 保証側からも回答が見える
    const firmView = await listNotesForCopy(db, manager(), { engagementId: ENG, copyId: copy.id });
    expect(firmView.find((n) => n.note.id === shared.id)?.responses).toHaveLength(1);
    expect(fixture.auditEvents.some((e) => e.eventType === 'review_note_responded')).toBe(true);
  });

  it('閲覧だけの役割は回答できない。他社は見えない', async () => {
    const shared = await createReportNote(db, manager(), {
      engagementId: ENG,
      copyId: copy.id,
      target: { kind: 'report_metric', dataPointVersionId: firstMetric() },
      body: '確認',
      sharedWithClient: true,
    });
    expect((await listNotesForClient(db, viewer())).some((e) => e.note.id === shared.id)).toBe(
      true,
    );
    await expect(
      respondToNote(db, viewer(), { noteId: shared.id, body: '回答' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await listNotesForClient(db, otherTenant())).toEqual([]);
    await expect(
      respondToNote(db, otherTenant(), { noteId: shared.id, body: '回答' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('クリア済みは「クリア」', () => {
    expect(clientNoteStateOf({ status: 'cleared' }, [])).toBe('cleared');
    expect(clientNoteStateOf({ status: 'open' }, [{ id: 'r' }])).toBe('answered');
    expect(clientNoteStateOf({ status: 'open' }, [])).toBe('unanswered');
  });
});
