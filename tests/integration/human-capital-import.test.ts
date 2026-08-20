import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { metricId, ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { createIngestionJob, processIngestionJob } from '@/lib/imports/service';
import type { AuthorizationContext, RoleKey } from '@/types/domain';
import { buildHumanCapitalDataset } from '../../scripts/human-capital-dataset';

/**
 * 人的資本データ 20 ファイルの取込。
 *
 * 環境データと違い、人的資本は**国ごとに定義が違う**。
 * 指標は当てつつ、定義差のある行は確定させず「要確認」に倒すことを確かめる。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

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

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('人的資本データ 20 ファイルの一括取込', () => {
  it('全ファイルが解析され、多言語の人的資本指標が自動で仕分けされる', async () => {
    const ctx = manager();
    const files = await buildHumanCapitalDataset();
    expect(files).toHaveLength(20);

    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: null,
      idempotencyKey: 'hc-20',
      files: files.map((f) => ({ name: f.name, type: f.mimeType, bytes: f.bytes })),
    });
    await processIngestionJob(db, ctx, job.id);

    const jobFiles = await db.select('ingestionJobFiles', { where: { jobId: job.id } });
    expect(jobFiles).toHaveLength(20);
    for (const jf of jobFiles) {
      expect(jf.parseStatus, jf.originalName).not.toBe('failed');
    }

    // PDF 3 件はテキスト抽出できる
    const pdfs = jobFiles.filter((f) => f.originalName.endsWith('.pdf'));
    expect(pdfs).toHaveLength(3);
    for (const pdf of pdfs) {
      expect(pdf.parseStatus, pdf.originalName).toBe('parsed');
    }

    // Shift_JIS が検出される
    const sjis = jobFiles.find((f) => f.originalName.includes('SJIS'));
    expect(sjis?.detectedEncoding).toContain('Shift_JIS');

    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });
    expect(rows.length).toBeGreaterThanOrEqual(60);

    // 7 割以上が指標へ自動マッピングされる
    const mapped = rows.filter((r) => r.metricId !== null);
    const rate = mapped.length / rows.length;
    expect(rate, `自動仕分け率 ${(rate * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.7);
  });

  it('多言語の「女性管理職比率」が同じ指標へ寄せられる', async () => {
    const ctx = manager();
    const files = await buildHumanCapitalDataset();
    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: null,
      idempotencyKey: 'hc-ratio',
      files: files.map((f) => ({ name: f.name, type: f.mimeType, bytes: f.bytes })),
    });
    await processIngestionJob(db, ctx, job.id);
    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });

    const ratioId = metricId('AOMI', 'female_manager_ratio');
    const labels = [
      '女性管理職比率', // 日本語
      'Women in management', // 英語（米国）
      'Frauenanteil in Führungspositionen', // ドイツ語
      'Part des femmes cadres', // フランス語
      '女性管理职比例', // 中国語
    ];
    for (const label of labels) {
      const hit = rows.find((r) => Object.values(r.raw).some((v) => v.includes(label)));
      expect(hit, `「${label}」の行が見つからない`).toBeDefined();
      expect(hit!.metricId, `「${label}」が女性管理職比率へ寄せられていない`).toBe(ratioId);
    }
  });

  it('定義が自社基準と異なる行は警告つきで「要確認」になる（勝手に確定しない）', async () => {
    const ctx = manager();
    const files = await buildHumanCapitalDataset();
    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: null,
      idempotencyKey: 'hc-def',
      files: files.map((f) => ({ name: f.name, type: f.mimeType, bytes: f.bytes })),
    });
    await processIngestionJob(db, ctx, job.id);
    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });

    const cases: Array<{ contains: string; why: string }> = [
      { contains: 'EEO-1 Officials and Managers', why: '米国 EEO-1 の職種区分' },
      { contains: 'Alle Führungsebenen einschließlich Teamleiter', why: 'ドイツの全管理層' },
      { contains: 'Band 4 and above', why: 'インドの社内等級' },
      { contains: '部長相当職以上', why: '管理職の範囲が部長以上' },
      { contains: 'Voluntary only', why: '離職率が自己都合のみ' },
      { contains: 'Median, unadjusted (raw)', why: '賃金格差が中央値ベース' },
    ];

    for (const c of cases) {
      const hit = rows.find((r) => Object.values(r.raw).some((v) => v.includes(c.contains)));
      expect(hit, `「${c.contains}」の行が見つからない`).toBeDefined();
      expect(hit!.warnings.join(' '), `${c.why}: 定義差の警告が無い`).toContain(
        '定義が自社基準と異なる可能性',
      );
      expect(hit!.status, `${c.why}: 勝手に確定してはいけない`).not.toBe('ready');
    }
  });

  it('定義差が無い行は通常どおり高い確信度で仕分けされる', async () => {
    const ctx = manager();
    const files = await buildHumanCapitalDataset();
    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: null,
      idempotencyKey: 'hc-plain',
      files: files.map((f) => ({ name: f.name, type: f.mimeType, bytes: f.bytes })),
    });
    await processIngestionJob(db, ctx, job.id);
    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });

    // 研修時間（定義の但し書きが無い行）
    const training = rows.find(
      (r) =>
        Object.values(r.raw).some((v) => v.includes('一人あたり研修時間')) &&
        Object.values(r.raw).some((v) => v.includes('階層別研修')),
    );
    expect(training).toBeDefined();
    expect(training!.metricId).toBe(metricId('AOMI', 'training_hours'));
    expect(training!.warnings.join(' ')).not.toContain('定義が自社基準と異なる可能性');
    expect(training!.confidence).toBeGreaterThan(0.6);
  });
});
