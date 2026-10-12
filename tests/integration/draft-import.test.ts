import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, at, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  BlockConflictError,
  autosaveWorkingBody,
  saveBlockVersion,
} from '@/lib/services/disclosure-block';
import {
  DRAFT_AI_PARAGRAPH_PREFIX,
  DRAFT_HUMAN_PARAGRAPH_PREFIX,
  FOREIGN_WORKING_BODY_REASON,
  draftBodyToBlockBody,
  importDraftToProject,
  listDraftImportOptions,
  splitDraftParagraphs,
} from '@/lib/services/draft-import';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, RoleKey, SsbjDisclosureDraft } from '@/types/domain';

/**
 * SSBJ・CSRD の節ドラフトを開示プロジェクトの原稿へ取り込む（トライアル対応 NF-19。int:draft-import）。
 *
 *  - 取り込めるのは確定した本文だけ。節の新しい版は下書き（承認は引き継がない）
 *  - AI の草案に由来する段落は印（段落 ID の接頭辞）と版の変更理由で残す
 *  - 同じ年度でその基準を持つプロジェクトだけ。他テナント・権限なしは断る
 *  - 選択肢の読込は書かない
 */

let fixture: FixtureDb;
let db: DemoDbClient;

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
const contributor = () => ctxFor('site-user@demo.local', ['site_contributor']);
/** 同じ組織で節を編集する別の人 */
const colleague = () => ctxFor('reviewer@demo.local', ['reviewer']);
const COLLEAGUE_TEXT = '別の人が書き直したガバナンスの本文（架空）。';
const WORKING_TEXT = '別の人が作業中の本文（架空・版になっていない）。';
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const AI_P1 = '取締役会は、気候関連のリスク及び機会を監督しています（架空・デモ生成）。';
const AI_P2 = 'サステナビリティ委員会が四半期ごとに審議します（架空・デモ生成）。';
const HUMAN_P2 =
  'サステナビリティ委員会が四半期ごとに審議し、取締役会へ報告します（架空・人が修正）。';
const HUMAN_P3 = '報酬との連動は検討中です（架空・人が追記）。';

const DRAFT_ID = fid('ssbj_disclosure_draft', 'test/governance');

function pushSsbjDraft(overrides: Partial<SsbjDisclosureDraft> = {}): SsbjDisclosureDraft {
  const draft: SsbjDisclosureDraft = {
    id: DRAFT_ID,
    organizationId: ORG_IDS.aomi,
    reportingPeriodId: PERIOD_IDS.fy2026,
    area: 'governance',
    body: `${AI_P1}\n\n${HUMAN_P2}\n\n${HUMAN_P3}`,
    aiBody: `${AI_P1}\n\n${AI_P2}`,
    coveredItemCodes: ['気候-10', '気候-11', '存在しない-99'],
    gaps: [],
    aiRunId: fid('ai_run', 'test/ssbj-draft'),
    aiConfidence: 0.6,
    aiWarnings: [],
    aiGeneratedAt: at(3),
    confirmedAt: at(2),
    confirmedBy: userId('sustainability@demo.local'),
    createdAt: at(3),
    updatedAt: at(2),
    createdBy: userId('sustainability@demo.local'),
    updatedBy: userId('sustainability@demo.local'),
    ...overrides,
  };
  fixture.ssbjDisclosureDrafts.push(draft);
  return draft;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('段落の分け方と AI 由来の印', () => {
  it('空行で段落に分け、AI の草案と同じ段落だけに印を付ける', () => {
    expect(splitDraftParagraphs('a\n\nb\n\n\nc')).toEqual(['a', 'b', 'c']);
    expect(splitDraftParagraphs('a\nb')).toEqual(['a', 'b']);
    const { body, aiParagraphs } = draftBodyToBlockBody(
      `${AI_P1}\n\n${HUMAN_P2}`,
      `${AI_P1}\n\n${AI_P2}`,
      true,
    );
    expect(aiParagraphs).toBe(1);
    expect(body.paragraphs.map((p) => p.id)).toEqual([
      `${DRAFT_AI_PARAGRAPH_PREFIX}1`,
      `${DRAFT_HUMAN_PARAGRAPH_PREFIX}2`,
    ]);
    // AI の実行が無いドラフト（人が書いた本文）には印を付けない
    expect(draftBodyToBlockBody(AI_P1, AI_P1, false).aiParagraphs).toBe(0);
    // 原稿の AI 下書き専用の検査に掛からないよう、段落の aiRunId は付けない
    expect(body.paragraphs.every((p) => p.aiRunId === undefined)).toBe(true);
  });
});

describe('SSBJ 開示ドラフト → 開示プロジェクトの原稿', () => {
  it('確定本文を専用の節の版 1（下書き）として取り込み、要求事項・AI 由来の印を残す', async () => {
    pushSsbjDraft();
    const result = await importDraftToProject(db, author(), {
      source: 'ssbj',
      draftId: DRAFT_ID,
      projectId: IDS.projects.fy2026,
      baseVersionId: null,
    });
    expect(result.created).toBe(true);
    expect(result.block.sectionKey).toBe('ssbj_draft_governance');
    expect(result.block.status).toBe('draft');
    expect(result.block.projectId).toBe(IDS.projects.fy2026);
    const items = fixture.disclosureItems.filter((i) =>
      result.block.requirementItemIds.includes(i.id),
    );
    expect(items.map((i) => i.code).sort()).toEqual(['気候-10', '気候-11']);
    expect(result.skippedCodes).toEqual(['存在しない-99']);
    expect(result.version.versionNo).toBe(1);
    expect(result.aiParagraphs).toBe(1);
    expect(result.version.changeReason).toContain('AI の草案に由来する段落 1 件');
    expect(result.version.body.paragraphs.map((p) => p.id)).toEqual([
      `${DRAFT_AI_PARAGRAPH_PREFIX}1`,
      `${DRAFT_HUMAN_PARAGRAPH_PREFIX}2`,
      `${DRAFT_HUMAN_PARAGRAPH_PREFIX}3`,
    ]);
    expect(result.version.plainText).toContain(HUMAN_P3);
    // 取り込みは人の版（AI が版を確定する経路ではない）
    expect(result.version.origin).toBe('human');
    expect(result.version.createdBy).toBe(userId('sustainability@demo.local'));

    // 同じ本文をもう一度取り込んでも版は増えない（本文が変わっていない）
    await expect(
      importDraftToProject(db, author(), {
        source: 'ssbj',
        draftId: DRAFT_ID,
        projectId: IDS.projects.fy2026,
        baseVersionId: result.version.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // ドラフトを直して確定し直すと、同じ節の新しい版（下書き）になる
    const stored = fixture.ssbjDisclosureDrafts.find((d) => d.id === DRAFT_ID)!;
    stored.body = `${stored.body}\n\n追記（架空）。`;
    const second = await importDraftToProject(db, author(), {
      source: 'ssbj',
      draftId: DRAFT_ID,
      projectId: IDS.projects.fy2026,
      baseVersionId: result.version.id,
    });
    expect(second.created).toBe(false);
    expect(second.block.id).toBe(result.block.id);
    expect(second.version.versionNo).toBe(2);
  });

  it('確定していない本文・レビュー中の節には取り込まない', async () => {
    pushSsbjDraft({ confirmedAt: null, confirmedBy: null });
    await expect(
      importDraftToProject(db, author(), {
        source: 'ssbj',
        draftId: DRAFT_ID,
        projectId: IDS.projects.fy2026,
        baseVersionId: null,
      }),
    ).rejects.toThrow(/確定した本文だけ/);
    const options = await listDraftImportOptions(db, author(), {
      source: 'ssbj',
      periodId: PERIOD_IDS.fy2026,
    });
    const option = options.find((o) => o.draftId === DRAFT_ID)!;
    expect(option.confirmed).toBe(false);
    expect(option.targets[0]?.blockedReason).toMatch(/確定した本文だけ/);
    expect(option.targets[0]?.existingBlock).toBeNull();

    const draft = fixture.ssbjDisclosureDrafts.find((d) => d.id === DRAFT_ID)!;
    draft.confirmedAt = at(1);
    const imported = await importDraftToProject(db, author(), {
      source: 'ssbj',
      draftId: DRAFT_ID,
      projectId: IDS.projects.fy2026,
      baseVersionId: null,
    });
    const index = fixture.disclosureBlocks.findIndex((b) => b.id === imported.block.id);
    fixture.disclosureBlocks[index] = {
      ...fixture.disclosureBlocks[index]!,
      status: 'review_requested',
    };
    draft.body = `${draft.body}\n\n追記（架空）。`;
    await expect(
      importDraftToProject(db, author(), {
        source: 'ssbj',
        draftId: DRAFT_ID,
        projectId: IDS.projects.fy2026,
        baseVersionId: imported.version.id,
      }),
    ).rejects.toThrow(/レビュー中/);
  });

  it('他テナント・権限なし・基準を持たないプロジェクトは断る', async () => {
    pushSsbjDraft();
    await expect(
      importDraftToProject(db, otherTenant(), {
        source: 'ssbj',
        draftId: DRAFT_ID,
        projectId: IDS.projects.fy2026,
        baseVersionId: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      importDraftToProject(db, contributor(), {
        source: 'ssbj',
        draftId: DRAFT_ID,
        projectId: IDS.projects.fy2026,
        baseVersionId: null,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // 年度が違うプロジェクト（FY2025）には取り込まない
    await expect(
      importDraftToProject(db, author(), {
        source: 'ssbj',
        draftId: DRAFT_ID,
        projectId: IDS.projects.fy2025,
        baseVersionId: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('確認した後に別の版が保存された節・別の人が自動保存した節には取り込まない（黙って置き換え・破棄しない）', async () => {
    pushSsbjDraft();
    const first = await importDraftToProject(db, author(), {
      source: 'ssbj',
      draftId: DRAFT_ID,
      projectId: IDS.projects.fy2026,
      baseVersionId: null,
    });
    // 画面が見せた選択肢（版 1）
    const [option] = (
      await listDraftImportOptions(db, author(), { source: 'ssbj', periodId: PERIOD_IDS.fy2026 })
    ).filter((o) => o.draftId === DRAFT_ID);
    const shown = option!.targets[0]!.existingBlock!;
    expect(shown.currentVersionId).toBe(first.version.id);

    // その後に別の人が版 2 を保存した
    await saveBlockVersion(db, colleague(), {
      blockId: first.block.id,
      baseVersionId: first.version.id,
      body: {
        paragraphs: [
          { id: 'c1', kind: 'paragraph', children: [{ t: 'text', text: COLLEAGUE_TEXT }] },
        ],
      },
      changeReason: '別の人の修正（架空）',
    });
    const stored = fixture.ssbjDisclosureDrafts.find((d) => d.id === DRAFT_ID)!;
    stored.body = stored.body + '\n\n追記（架空）。';
    await expect(
      importDraftToProject(db, author(), {
        source: 'ssbj',
        draftId: DRAFT_ID,
        projectId: IDS.projects.fy2026,
        baseVersionId: shown.currentVersionId,
        knownWorkingSavedAt: shown.workingSavedAt,
      }),
    ).rejects.toBeInstanceOf(BlockConflictError);
    const afterConflict = fixture.disclosureBlocks.find((b) => b.id === first.block.id)!;
    const v2 = fixture.disclosureBlockVersions.find(
      (v) => v.id === afterConflict.currentVersionId,
    )!;
    expect(v2.versionNo).toBe(2);
    expect(v2.plainText).toContain(COLLEAGUE_TEXT);

    // 別の人が版 2 の上で作業中の本文を自動保存した（版になっていない）
    const autosaved = await autosaveWorkingBody(db, colleague(), {
      blockId: first.block.id,
      baseVersionId: v2.id,
      body: {
        paragraphs: [
          { id: 'c2', kind: 'paragraph', children: [{ t: 'text', text: WORKING_TEXT }] },
        ],
      },
    });
    expect(autosaved.status).toBe('saved');
    const [reloaded] = (
      await listDraftImportOptions(db, author(), { source: 'ssbj', periodId: PERIOD_IDS.fy2026 })
    ).filter((o) => o.draftId === DRAFT_ID);
    const target = reloaded!.targets[0]!;
    expect(target.blockedReason).toBe(FOREIGN_WORKING_BODY_REASON);
    await expect(
      importDraftToProject(db, author(), {
        source: 'ssbj',
        draftId: DRAFT_ID,
        projectId: IDS.projects.fy2026,
        baseVersionId: target.existingBlock!.currentVersionId,
        knownWorkingSavedAt: target.existingBlock!.workingSavedAt,
      }),
    ).rejects.toThrow(/ほかの人が自動保存した作業中の本文/);
    // 別の人の作業中の本文は消えていない・版も増えていない
    const block = fixture.disclosureBlocks.find((b) => b.id === first.block.id)!;
    expect(JSON.stringify(block.workingBody)).toContain(WORKING_TEXT);
    expect(block.currentVersionId).toBe(v2.id);
  });

  it('選択肢の読込は書かない', async () => {
    pushSsbjDraft();
    const guarded = new WriteDetectingDbClient(db);
    const options = await listDraftImportOptions(guarded, author(), {
      source: 'ssbj',
      periodId: PERIOD_IDS.fy2026,
    });
    expect(options.find((o) => o.draftId === DRAFT_ID)?.targets.map((t) => t.projectId)).toEqual([
      IDS.projects.fy2026,
    ]);
    expect(guarded.writes).toEqual([]);
  });
});

describe('CSRD 節ドラフト → 開示プロジェクトの原稿', () => {
  it('CSRD を基準に持つプロジェクトが無ければ取り込めない（40a には入れない）', async () => {
    const draft = fixture.csrdDisclosureDrafts.find((d) => d.id === CSRD_IDS.drafts.esrs2)!;
    draft.confirmedAt = at(1);
    draft.confirmedBy = userId('sustainability@demo.local');
    const options = await listDraftImportOptions(db, author(), {
      source: 'csrd',
      periodId: PERIOD_IDS.fy2026,
    });
    expect(options.find((o) => o.draftId === draft.id)?.targets).toEqual([]);
    await expect(
      importDraftToProject(db, author(), {
        source: 'csrd',
        draftId: draft.id,
        projectId: IDS.projects.fy2026,
        baseVersionId: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('CSRD の基準を付けたプロジェクトには、人が書いた確定本文を（AI 由来の印なしで）取り込む', async () => {
    const csrdVersion = fixture.frameworkVersions.find(
      (v) => v.id === fid('framework_version', 'csrd/2026'),
    )!;
    fixture.projectFrameworks.push({
      ...fixture.projectFrameworks.find((f) => f.id === IDS.projectFrameworks.fy2026Ssbj)!,
      id: fid('project_framework', 'test/FY2026/csrd'),
      frameworkVersionId: csrdVersion.id,
      purpose: 'csrd_eu_entity',
      applicabilityStatus: 'candidate',
      currentDecisionId: null,
      conditions: {},
    });
    const draft = fixture.csrdDisclosureDrafts.find((d) => d.id === CSRD_IDS.drafts.esrs2)!;
    draft.confirmedAt = at(1);
    draft.confirmedBy = userId('sustainability@demo.local');
    const result = await importDraftToProject(db, author(), {
      source: 'csrd',
      draftId: draft.id,
      projectId: IDS.projects.fy2026,
      baseVersionId: null,
    });
    expect(result.block.sectionKey).toBe('csrd_draft_esrs2');
    expect(result.block.frameworkVersionId).toBe(csrdVersion.id);
    expect(result.aiParagraphs).toBe(0);
    expect(result.version.changeReason).not.toContain('AI');
    expect(
      fixture.disclosureItems
        .filter((i) => result.block.requirementItemIds.includes(i.id))
        .map((i) => i.code),
    ).toEqual(['ESRS2-GOV-1']);
  });
});
