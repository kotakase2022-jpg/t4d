import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { metricId, ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  confirmIngestionJob,
  createIngestionJob,
  processIngestionJob,
} from '@/lib/imports/service';
import type { AuthorizationContext, RoleKey } from '@/types/domain';
import { buildHeterogeneousDataset } from '../../scripts/hetero-dataset';

/**
 * 異種データ 50 ファイルの一括取込（機能追加要望 ①）。
 *
 * 「フォーマット・言語が全く異なるデータ群を、事前加工なしで一括取り込みし、
 *  AI が自動仕分けする」ことを、実際に 50 ファイル全部を取込パイプラインへ
 * 通して検証する。Demo Mode（決定論的 Mock AI）での下限精度を固定する。
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

describe('50 ファイル一括取込', () => {
  it('事前加工なしで全ファイルが受理・解析され、大半の行が自動仕分けされる', async () => {
    const ctx = manager();
    const files = await buildHeterogeneousDataset();
    expect(files).toHaveLength(50);

    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: null, // 拠点は指定しない（ファイル内容から AI が推定する）
      idempotencyKey: 'hetero-50',
      files: files.map((f) => ({ name: f.name, type: f.mimeType, bytes: f.bytes })),
    });
    const done = await processIngestionJob(db, ctx, job.id);
    // 要確認行が残るのが正しい（転置レイアウト等）ので needs_review で完了する
    expect(['needs_review', 'completed']).toContain(done.status);

    // 全ファイルの解析結果: 失敗（unsupported / 取得不能）が 1 件も無い
    const jobFiles = await db.select('ingestionJobFiles', { where: { jobId: job.id } });
    expect(jobFiles).toHaveLength(50);
    const failed = jobFiles.filter((f) => f.parseStatus === 'failed');
    expect(failed.map((f) => f.originalName)).toEqual([]);

    // 表形式（45 ファイル）はすべて parsed
    const tableNames = new Set(files.filter((f) => f.kind === 'table').map((f) => f.name));
    for (const jf of jobFiles) {
      if (tableNames.has(jf.originalName)) {
        expect(jf.parseStatus, jf.originalName).toBe('parsed');
      }
    }

    // 手組み PDF は 5 件ともテキスト抽出に成功する
    const pdfFiles = jobFiles.filter((f) => f.originalName.endsWith('.pdf'));
    expect(pdfFiles).toHaveLength(5);
    for (const pdf of pdfFiles) {
      expect(pdf.parseStatus, pdf.originalName).toBe('parsed');
    }

    // Shift_JIS の文字コードが判定されている
    const sjis = jobFiles.find((f) => f.originalName.includes('SJIS'));
    expect(sjis?.detectedEncoding).toContain('Shift_JIS');

    // AI 仕分け: 表形式の行のうち 7 割以上が指標へ自動マッピングされる
    // （転置レイアウト等の「要確認になるのが正しい」ファイルを含んだ上での下限）
    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });
    expect(rows.length).toBeGreaterThanOrEqual(45);
    const mapped = rows.filter((r) => r.metricId !== null);
    const rate = mapped.length / rows.length;
    expect(rate, `自動仕分け率 ${(rate * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.7);

    // 多言語ファイルの具体例: 独語（セミコロン・小数点カンマ）が正しい値で仕分けされる
    const german = rows.find((r) => Object.values(r.raw).includes('Stromverbrauch'));
    expect(german).toBeDefined();
    expect(german!.metricId).toBe(metricId('AOMI', 'energy'));
    expect(german!.value).toBe(1234.5); // "1.234,5" → 1234.5
    expect(german!.unitId).toBe(UNIT_IDS.eu);

    // 中国語ファイルも仕分けされる
    const chinese = rows.find((r) => Object.values(r.raw).includes('用电量'));
    expect(chinese).toBeDefined();
    expect(chinese!.metricId).toBe(metricId('AOMI', 'energy'));

    // 説明行つき CSV: ヘッダーを読み飛ばした上で行が取れている
    const withPreamble = jobFiles.find((f) => f.originalName.includes('エネルギー報告'));
    expect(withPreamble?.parseMessage).toContain('説明行として読み飛ばしました');

    // カンマ入り数値（RFC4180 引用）が列ズレせず正しい値になる（レビュー指摘の再発防止）
    const wasteRow = rows.find((r) => Object.values(r.raw).includes('1,070.4'));
    expect(wasteRow?.value).toBe(1070.4);
    const kwhRow = rows.find((r) => Object.values(r.raw).includes('3,120,500'));
    expect(kwhRow?.value).toBe(3120500);
    // kWh は指標定義（MWh）と異なるため、単位警告つきで人の確認待ちになる
    // （既存 Data Point がある組合せは 'duplicate' 扱い。いずれも自動確定されない）
    expect(['needs_review', 'duplicate']).toContain(kwhRow?.status);
    expect(kwhRow?.warnings.join(' ')).toContain('単位');

    // 独式ドット桁区切り（"2.845"）は判別不能 → 値は入れず要確認（1/1000 汚染の防止）。
    // 指標・拠点は学習済みラベルから引き続き提案される
    const ambiguous = rows.find((r) => Object.values(r.raw).includes('2.845'));
    expect(ambiguous).toBeDefined();
    expect(ambiguous!.value).toBeNull();
    // 既存 Data Point がある組合せは 'duplicate'（これも人の確認待ち）になる
    expect(['needs_review', 'duplicate']).toContain(ambiguous!.status);
  }, 60_000);

  it('kg-CO2e など単位が指標定義と異なる行は警告付きで要確認になる（勝手に確定しない）', async () => {
    const ctx = manager();
    const files = await buildHeterogeneousDataset();
    const kgFile = files.find((f) => f.name.includes('kgCO2e'))!;

    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: null,
      idempotencyKey: 'hetero-kg',
      files: [{ name: kgFile.name, type: kgFile.mimeType, bytes: kgFile.bytes }],
    });
    await processIngestionJob(db, ctx, job.id);

    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });
    // kg-CO2e 表記の行が複数入っている。いずれも勝手に確定せず要確認になる。
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.status, JSON.stringify(row.raw)).toBe('needs_review');
      expect(row.warnings.join(' ')).toContain('単位');
    }
  });
});

describe('AI 入力の行数上限（コスト暴走の防止）', () => {
  it('上限を超える行は AI を通さず要確認として残り、ファイルにその旨が記録される', async () => {
    const ctx = manager();
    const lines = ['拠点,項目,値,単位'];
    for (let i = 0; i < 510; i += 1) {
      lines.push(`東日本工場,電力使用量,${100 + i},MWh`);
    }
    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: UNIT_IDS.east,
      idempotencyKey: 'cap-510',
      files: [
        {
          name: 'big.csv',
          type: 'text/csv',
          bytes: new TextEncoder().encode(lines.join('\r\n')),
        },
      ],
    });
    await processIngestionJob(db, ctx, job.id);

    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });
    expect(rows).toHaveLength(510);
    // 上限内は仕分けされ、超過分は要確認（勝手に捨てない）
    expect(rows.filter((r) => r.metricId !== null).length).toBe(500);
    expect(rows.filter((r) => r.status === 'needs_review').length).toBe(10);

    const jobFiles = await db.select('ingestionJobFiles', { where: { jobId: job.id } });
    expect(jobFiles[0]!.parseMessage).toContain('先頭 500 行まで');
  }, 30_000);
});

describe('事前学習（確定実績からの学習）', () => {
  it('人が確定したラベルは、次回から高確信度で自動仕分けされる', async () => {
    const ctx = manager();
    const steamCsv = new TextEncoder().encode(
      '拠点,項目,値,単位\r\n西日本工場,圧縮空気（購入分）,18.4,GJ',
    );

    // 1 回目: 「圧縮空気（購入分）」は辞書にも学習実績にも無く要確認になる
    const job1 = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: UNIT_IDS.west,
      idempotencyKey: 'learn-1',
      files: [{ name: 'steam1.csv', type: 'text/csv', bytes: steamCsv }],
    });
    await processIngestionJob(db, ctx, job1.id);
    const rows1 = await db.select('ingestionRows', { where: { jobId: job1.id } });
    expect(rows1[0]!.metricId).toBeNull();
    expect(rows1[0]!.status).toBe('needs_review');

    // 人が指標を選んで確定する（GJ → MWh 換算済みの値で登録する想定）
    await confirmIngestionJob(db, ctx, job1.id, [
      {
        rowId: rows1[0]!.id,
        include: true,
        metricId: metricId('AOMI', 'energy'),
        unitId: UNIT_IDS.west,
        value: 5.1,
        unitOfMeasure: 'MWh',
      },
    ]);

    // 2 回目: 同じラベルのファイルが来ると、確定実績から学習して自動仕分けされる
    const job2 = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: UNIT_IDS.west,
      idempotencyKey: 'learn-2',
      files: [{ name: 'steam2.csv', type: 'text/csv', bytes: steamCsv }],
    });
    await processIngestionJob(db, ctx, job2.id);

    const rows2 = await db.select('ingestionRows', { where: { jobId: job2.id } });
    expect(rows2[0]!.metricId).toBe(metricId('AOMI', 'energy'));
    expect(rows2[0]!.confidence).toBeGreaterThanOrEqual(0.9);

    // 学習を適用したことがファイルの解析メモに残る（UI から確認できる）
    const jobFiles2 = await db.select('ingestionJobFiles', { where: { jobId: job2.id } });
    expect(jobFiles2[0]!.parseMessage).toContain('事前学習');
  });

  it('学習は組織単位（他社の確定実績を参照しない）', async () => {
    const ctx = manager();
    const csvBytes = new TextEncoder().encode(
      '拠点,項目,値,単位\r\n西日本工場,圧縮空気（購入分）,18.4,GJ',
    );

    // 青海で確定を作る
    const job1 = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: UNIT_IDS.west,
      idempotencyKey: 'learn-own',
      files: [{ name: 'steam.csv', type: 'text/csv', bytes: csvBytes }],
    });
    await processIngestionJob(db, ctx, job1.id);
    const rows1 = await db.select('ingestionRows', { where: { jobId: job1.id } });
    await confirmIngestionJob(db, ctx, job1.id, [
      {
        rowId: rows1[0]!.id,
        include: true,
        metricId: metricId('AOMI', 'energy'),
        unitId: UNIT_IDS.west,
        value: 5.1,
        unitOfMeasure: 'MWh',
      },
    ]);

    // 蒼天（別テナント）の管理者が同じラベルを取り込んでも学習は効かない
    const otherCtx: AuthorizationContext = {
      userId: userId('other-enterprise-admin@demo.local'),
      email: 'other-enterprise-admin@demo.local',
      displayName: 'other',
      workspace: {
        organizationId: ORG_IDS.soten,
        organizationType: 'enterprise',
        organizationName: '蒼天マテリアル株式会社',
        roleKeys: ['enterprise_admin'],
        unitScopeIds: [],
      },
      engagementIds: [],
      demo: true,
    };
    const sotenPeriods = await db.select('periods', {
      where: { organizationId: ORG_IDS.soten },
    });
    const job2 = await createIngestionJob(db, otherCtx, {
      reportingPeriodId: sotenPeriods[0]!.id,
      unitId: null,
      idempotencyKey: 'learn-other',
      files: [{ name: 'steam.csv', type: 'text/csv', bytes: csvBytes }],
    });
    await processIngestionJob(db, otherCtx, job2.id);
    const rows2 = await db.select('ingestionRows', { where: { jobId: job2.id } });
    // 蒼天には確定実績が無いため、学習由来の高確信度マッピングは付かない
    expect(rows2[0]!.confidence).toBeLessThan(0.9);
  });
});
