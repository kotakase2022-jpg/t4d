import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@/lib/authorization/can';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { buildImportPreview, confirmDisclosureImport } from '@/lib/services/disclosure-import';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 過去回答の Import・構造化（CDP-P0-003）の Integration テスト。
 * 実ファイル（CSV バイト列）を通し、保存結果まで検証する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(email: string, organizationId: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ORG_IDS.aomi, ['sustainability_manager']);
const otherOrg = () =>
  ctxFor('other-enterprise-admin@demo.local', ORG_IDS.soten, ['enterprise_admin']);

const CSV = [
  '質問コード,回答',
  'C0.1,当社は精密電子部品の設計・製造を行っています。',
  'C1.1,はい',
  'C99.9,存在しない質問コードの回答',
  'C1.2,',
].join('\r\n');

const csvBytes = () => new TextEncoder().encode(CSV);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('プレビュー生成', () => {
  it('CSV を質問単位へ分解し、一致状況を判定する', async () => {
    const preview = await buildImportPreview(db, manager(), {
      frameworkKey: 'cdp',
      targetPeriodId: PERIOD_IDS.fy2025,
      fileName: 'CDP2025_回答.csv',
      mimeType: 'text/csv',
      bytes: csvBytes(),
    });

    expect(preview.parsedAs).toBe('table');
    expect(preview.rows).toHaveLength(4);

    const byCode = new Map(preview.rows.map((r) => [r.itemCode, r]));
    expect(byCode.get('C0.1')?.status).toBe('matched');
    expect(byCode.get('C0.1')?.itemId).not.toBeNull();
    expect(byCode.get('C0.1')?.questionText).toContain('事業内容');
    expect(byCode.get('C0.1')?.locator).toBe('行 2');

    // マスターに無いコードは取り込ませない
    expect(byCode.get('C99.9')?.status).toBe('unknown_code');
    expect(byCode.get('C99.9')?.itemId).toBeNull();

    // 回答が空の行も取り込ませない
    expect(byCode.get('C1.2')?.status).toBe('empty_answer');
  });

  it('列を特定できない CSV は警告を返し、行は 0 件になる', async () => {
    const preview = await buildImportPreview(db, manager(), {
      frameworkKey: 'cdp',
      targetPeriodId: PERIOD_IDS.fy2025,
      fileName: 'wrong.csv',
      mimeType: 'text/csv',
      bytes: new TextEncoder().encode('拠点,値\nHQ,100'),
    });
    expect(preview.rows).toEqual([]);
    expect(preview.warnings.join(' ')).toContain('特定できませんでした');
  });

  it('許可されない拡張子は拒否する', async () => {
    await expect(
      buildImportPreview(db, manager(), {
        frameworkKey: 'cdp',
        targetPeriodId: PERIOD_IDS.fy2025,
        fileName: 'evil.exe',
        mimeType: 'application/octet-stream',
        bytes: csvBytes(),
      }),
    ).rejects.toThrow(/許可されていません/);
  });

  it('他組織の期間を指定すると 404 相当になる（テナント分離）', async () => {
    await expect(
      buildImportPreview(db, otherOrg(), {
        frameworkKey: 'cdp',
        targetPeriodId: PERIOD_IDS.fy2025,
        fileName: 'x.csv',
        mimeType: 'text/csv',
        bytes: csvBytes(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('開示の書き込み権限が無いロールは実行できない', async () => {
    const viewer = ctxFor('site-user@demo.local', ORG_IDS.aomi, ['viewer']);
    await expect(
      buildImportPreview(db, viewer, {
        frameworkKey: 'cdp',
        targetPeriodId: PERIOD_IDS.fy2025,
        fileName: 'x.csv',
        mimeType: 'text/csv',
        bytes: csvBytes(),
      }),
    ).rejects.toThrow();
  });
});

describe('取込の確定', () => {
  async function previewSelections() {
    const preview = await buildImportPreview(db, manager(), {
      frameworkKey: 'cdp',
      targetPeriodId: PERIOD_IDS.fy2025,
      fileName: 'CDP2025_回答.csv',
      mimeType: 'text/csv',
      bytes: csvBytes(),
    });
    return preview.rows
      .filter((r) => r.status === 'matched' && r.itemId)
      .map((r) => ({ itemId: r.itemId!, answerText: r.answerText }));
  }

  it('選択した行だけが過去期間へ保存され、当年度へ前年回答として紐付く', async () => {
    const ctx = manager();
    const selections = await previewSelections();
    expect(selections.length).toBeGreaterThan(0);

    const result = await confirmDisclosureImport(db, ctx, {
      targetPeriodId: PERIOD_IDS.fy2025,
      currentPeriodId: PERIOD_IDS.fy2026,
      selections,
    });

    expect(result.created + result.updated).toBe(selections.length);

    const past = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: PERIOD_IDS.fy2025 },
    });
    for (const sel of selections) {
      const saved = past.find((r) => r.itemId === sel.itemId);
      expect(saved?.answerText).toBe(sel.answerText);
      // 過年度の提出済み回答として承認済みで入る
      expect(saved?.status).toBe('approved');
    }

    // 当年度からは previousResponseId で辿れる
    const current = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: PERIOD_IDS.fy2026 },
    });
    for (const sel of selections) {
      const cur = current.find((r) => r.itemId === sel.itemId);
      if (!cur) continue;
      const pastId = past.find((r) => r.itemId === sel.itemId)?.id;
      expect(cur.previousResponseId).toBe(pastId);
    }
  });

  it('当年度の回答本文は書き換えない', async () => {
    const ctx = manager();
    const before = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: PERIOD_IDS.fy2026 },
      orderBy: { column: 'id' },
    });

    await confirmDisclosureImport(db, ctx, {
      targetPeriodId: PERIOD_IDS.fy2025,
      currentPeriodId: PERIOD_IDS.fy2026,
      selections: await previewSelections(),
    });

    const after = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: PERIOD_IDS.fy2026 },
      orderBy: { column: 'id' },
    });
    expect(after.map((r) => `${r.id}:${r.status}:${r.answerText ?? ''}`)).toEqual(
      before.map((r) => `${r.id}:${r.status}:${r.answerText ?? ''}`),
    );
  });

  it('取込は監査ログに残る', async () => {
    await confirmDisclosureImport(db, manager(), {
      targetPeriodId: PERIOD_IDS.fy2025,
      currentPeriodId: PERIOD_IDS.fy2026,
      selections: await previewSelections(),
    });
    const audits = await db.select('auditEvents', {
      where: { actorOrganizationId: ORG_IDS.aomi, resourceType: 'disclosure_response' },
    });
    expect(audits.some((a) => a.afterSummary?.includes('過去回答を取込'))).toBe(true);
  });

  it('取込先に当年度は指定できない', async () => {
    await expect(
      confirmDisclosureImport(db, manager(), {
        targetPeriodId: PERIOD_IDS.fy2026,
        currentPeriodId: PERIOD_IDS.fy2026,
        selections: await previewSelections(),
      }),
    ).rejects.toThrow(/当年度は指定できません/);
  });

  it('他組織のコンテキストでは期間が見つからない（テナント分離）', async () => {
    const selections = await previewSelections();
    await expect(
      confirmDisclosureImport(db, otherOrg(), {
        targetPeriodId: PERIOD_IDS.fy2025,
        currentPeriodId: PERIOD_IDS.fy2026,
        selections,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('2 回取り込んでも行が重複しない（同じ質問は上書き）', async () => {
    const ctx = manager();
    const selections = await previewSelections();
    await confirmDisclosureImport(db, ctx, {
      targetPeriodId: PERIOD_IDS.fy2025,
      currentPeriodId: PERIOD_IDS.fy2026,
      selections,
    });
    const afterFirst = await db.count('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: PERIOD_IDS.fy2025 },
    });

    const second = await confirmDisclosureImport(db, ctx, {
      targetPeriodId: PERIOD_IDS.fy2025,
      currentPeriodId: PERIOD_IDS.fy2026,
      selections: selections.map((s) => ({ ...s, answerText: `${s.answerText}（修正）` })),
    });
    const afterSecond = await db.count('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: PERIOD_IDS.fy2025 },
    });

    expect(afterSecond).toBe(afterFirst);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(selections.length);

    const past = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: PERIOD_IDS.fy2025 },
    });
    expect(past.find((r) => r.itemId === selections[0]!.itemId)?.answerText).toContain('（修正）');
  });
});
