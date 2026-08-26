import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb } from '@/lib/fixtures/store';
import { createIngestionJob, processIngestionJob } from '@/lib/imports/service';
import { parseCsv } from '@/lib/imports/parsers';
import { parseFlexibleNumber } from '@/lib/imports/number';
import type { AuthorizationContext, IngestionRow, RoleKey } from '@/types/domain';
import { buildHumanCapitalDataset } from '../../scripts/human-capital-dataset';

/**
 * 人事システムの生出力（v3）を、事前加工なしで正しく取り込めることの検証。
 *
 * v3 のファイルには、実在の帳票が持つ次の癖をそのまま入れてある。
 *   - 表の前後に帳票名・出力条件・注記・件数の行が付く
 *   - 明細と同じ列構成で小計・合計行が混ざる
 *   - ゼロ埋めコード・階層コード・和暦・前年同期の列・セル内改行
 *
 * ここで確かめるのは「読めること」ではなく、**誤った値を静かに取り込まないこと**。
 */

let db: DemoDbClient;

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

/** 20 ファイルを取り込み、行とファイル名の対応を返す */
async function ingestAll(idempotencyKey: string): Promise<{
  rows: IngestionRow[];
  fileNameOf: (row: IngestionRow) => string;
}> {
  const ctx = manager();
  const files = await buildHumanCapitalDataset();
  const job = await createIngestionJob(db, ctx, {
    reportingPeriodId: PERIOD_IDS.fy2026,
    unitId: null,
    idempotencyKey,
    files: files.map((f) => ({ name: f.name, type: f.mimeType, bytes: f.bytes })),
  });
  await processIngestionJob(db, ctx, job.id);
  const rows = await db.select('ingestionRows', { where: { jobId: job.id } });
  const jobFiles = await db.select('ingestionJobFiles', { where: { jobId: job.id } });
  const byId = new Map(jobFiles.map((f) => [f.id, f.originalName]));
  return { rows, fileNameOf: (row) => byId.get(row.jobFileId) ?? '' };
}

beforeEach(() => {
  db = new DemoDbClient(createFixtureDb());
});

describe('人事システム出力の体裁', () => {
  it('前置きブロックの帳票名・出力条件がデータ行に混ざらない', async () => {
    const { rows, fileNameOf } = await ingestAll('hris-preamble');
    const hc01 = rows.filter((r) => fileNameOf(r).startsWith('HC01'));
    expect(hc01.length).toBeGreaterThan(0);

    // ヘッダーは「部門コード…」の行であって「在籍者集計表」ではない
    expect(Object.keys(hc01[0]!.raw)).toContain('部門コード');
    for (const row of hc01) {
      const joined = Object.values(row.raw).join(' ');
      expect(joined).not.toContain('出力日時');
      expect(joined).not.toContain('在籍者集計表');
    }
  });

  it('後置きの注記・件数行はデータ行にならない', async () => {
    const { rows } = await ingestAll('hris-trailer');
    for (const row of rows) {
      const first = Object.values(row.raw).find((v) => v !== '') ?? '';
      expect(first, `注記行が取込対象になっている: ${first}`).not.toMatch(
        /^(※|レコード件数|出力件数|Total records|Datensätze|记录数|以上$|End of report)/,
      );
    }
  });

  it('2 段ヘッダーのファイルで列が失われない（1 段目のシステムキーを列名にする）', async () => {
    const { rows, fileNameOf } = await ingestAll('hris-two-row-header');
    const hc17 = rows.filter((r) => fileNameOf(r).startsWith('HC17'));
    expect(hc17.length).toBeGreaterThan(0);
    const headers = Object.keys(hc17[0]!.raw);
    expect(headers).toContain('HEADCOUNT');
    expect(headers).toContain('FEMALE_MANAGERS');
    // 2 段目の表示ラベル行はデータ行として残る（捨てない）
    expect(hc17.some((r) => r.raw['HEADCOUNT'] === 'Headcount')).toBe(true);
  });

  it('セル内改行を含む自由記述が 1 行として保たれる', async () => {
    const { rows, fileNameOf } = await ingestAll('hris-multiline');
    const hc04 = rows.filter((r) => fileNameOf(r).startsWith('HC04'));
    const withNewline = hc04.filter((r) => (r.raw['退職事由詳細'] ?? '').includes('\n'));
    expect(withNewline.length, 'セル内改行の行が 1 件も無い').toBeGreaterThan(20);
    for (const row of withNewline) {
      expect(row.raw['退職事由詳細']).toContain('面談実施日');
      // 改行で行が割れていない＝退職年月日が同じ行に残っている
      expect(row.raw['退職年月日']).toMatch(/^\d{8}$/);
    }
  });

  it('Shift_JIS と各国の数値表記が判定される', async () => {
    const ctx = manager();
    const files = await buildHumanCapitalDataset();
    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: PERIOD_IDS.fy2026,
      unitId: null,
      idempotencyKey: 'hris-encoding',
      files: files.map((f) => ({ name: f.name, type: f.mimeType, bytes: f.bytes })),
    });
    await processIngestionJob(db, ctx, job.id);
    const jobFiles = await db.select('ingestionJobFiles', { where: { jobId: job.id } });

    const sjis = jobFiles.find((f) => f.originalName.includes('SJIS'));
    expect(sjis?.detectedEncoding).toContain('Shift_JIS');
    // 20 ファイルすべてが解析でき、失敗が無い
    for (const f of jobFiles) expect(f.parseStatus, f.originalName).toBe('parsed');
  });
});

describe('集計行（小計・合計）の扱い', () => {
  it('小計・合計行が検知され、明細と一緒に自動確定されない', async () => {
    const { rows, fileNameOf } = await ingestAll('hris-total-rows');

    const totals = rows.filter((r) => r.warnings.some((w) => w.includes('集計行')));
    // 帳票ごとの小計・合計。日本語・英語・独語・仏語・中国語の各様式で検知される
    expect(totals.length, '集計行が検知されていない').toBeGreaterThan(50);

    const files = new Set(totals.map(fileNameOf).map((n) => n.slice(0, 4)));
    for (const expected of ['HC01', 'HC09', 'HC11', 'HC13', 'HC15', 'HC17']) {
      expect(files.has(expected), `${expected} の集計行が検知されていない`).toBe(true);
    }

    // 集計行は既定でチェックされない（preview-table は status === 'mapped' だけを既定 ON にする）
    for (const row of totals) {
      expect(row.status, `${row.sourceLocator} の集計行が自動確定される`).not.toBe('mapped');
    }

    // 警告文は理由（二重計上）を明示する
    expect(totals[0]!.warnings[0]).toContain('二重計上');
  });

  it('明細だけを足し上げると帳票の合計行と一致する（データの整合）', async () => {
    const files = await buildHumanCapitalDataset();
    const hc01 = files.find((f) => f.name.startsWith('HC01'));
    expect(hc01).toBeDefined();
    const table = parseCsv(hc01!.bytes);

    const isTotalRow = (r: Record<string, string>) =>
      /小計|計$|＜総合計＞|総合計/.test(r['部門名'] ?? '');

    const detailRegular = table.rows
      .filter((r) => !isTotalRow(r) && r['雇用区分'] === '正社員')
      .reduce((s, r) => s + (parseFlexibleNumber(r['在籍者数'] ?? '') ?? 0), 0);

    const grand = table.rows.find((r) => (r['部門名'] ?? '').includes('総合計'));
    expect(grand, '総合計行が見つからない').toBeDefined();
    const grandValue = parseFlexibleNumber(grand!['在籍者数'] ?? '');

    // 明細の合計＝帳票の総合計。両方を確定すると 2 倍になる、という前提が成立している
    expect(detailRegular).toBe(grandValue);
    expect(detailRegular).toBe(506);
  });
});

describe('数字に見えるが値ではない列', () => {
  it('ゼロ埋めの部門コードが人数として取り込まれない', async () => {
    const { rows, fileNameOf } = await ingestAll('hris-code-column');
    const hc11 = rows.filter((r) => fileNameOf(r).startsWith('HC11'));
    expect(hc11.length).toBeGreaterThan(0);

    for (const row of hc11) {
      const code = row.raw['Abteilungscode'] ?? '';
      if (!/^0\d+$/.test(code)) continue;
      // "0110" が 110 として値に入っていないこと
      expect(row.value, `部門コード ${code} が値として取り込まれている`).not.toBe(Number(code));
      // 原文はゼロ埋めのまま保たれる（原資料との突合に必要）
      expect(row.raw['Abteilungscode']).toBe(code);
    }
  });

  it('「前年同期」の列が当年の値として取り込まれない', async () => {
    const { rows, fileNameOf } = await ingestAll('hris-previous-year');
    const hc15 = rows.filter((r) => fileNameOf(r).startsWith('HC15'));
    const detail = hc15.filter((r) => (r.raw['部门编码'] ?? '') !== '');
    expect(detail.length).toBeGreaterThan(0);

    for (const row of detail) {
      const previous = parseFlexibleNumber(row.raw['上年同期用工总数'] ?? '');
      const current = parseFlexibleNumber(row.raw['在册人数(正式员工)'] ?? '');
      if (previous === null || current === null || previous === current) continue;
      expect(row.value, '前年同期の値が当年値として取り込まれている').not.toBe(previous);
    }
  });

  it('和暦・8 桁の日付が数値として取り込まれない', async () => {
    const { rows, fileNameOf } = await ingestAll('hris-dates');
    const hc03 = rows.filter((r) => fileNameOf(r).startsWith('HC03'));
    expect(hc03.length).toBeGreaterThan(0);

    const wareki = hc03.filter((r) => (r.raw['入社年月日'] ?? '').startsWith('令和'));
    expect(wareki.length, '和暦の行が無い').toBeGreaterThan(10);

    for (const row of hc03) {
      const date = row.raw['入社年月日'] ?? '';
      if (!/^\d{8}$/.test(date)) continue;
      // 20260401 が 20,260,401 として台帳へ入らない
      expect(row.value, `日付 ${date} が値として取り込まれている`).not.toBe(Number(date));
    }
  });
});

describe('集計範囲（バウンダリ）の宣言が前置きブロックにしかない場合', () => {
  it('ファイル冒頭の集計条件が全行のバウンダリ判定に効く', async () => {
    const files = await buildHumanCapitalDataset();
    const hc01 = files.find((f) => f.name.startsWith('HC01'));
    const table = parseCsv(hc01!.bytes);

    // 「正社員のみを集計対象とする」は前置きブロックにしか書かれていない
    expect(table.preamble.join(' ')).toContain('正社員のみ');
    expect(table.rows.every((r) => !Object.values(r).join(' ').includes('正社員のみ'))).toBe(true);

    // 取込結果では、雇用範囲の差として検知される
    const { rows } = await ingestAll('hris-preamble-boundary');
    const employmentConflicts = rows.filter((r) =>
      r.warnings.some((w) => w.includes('バウンダリ差異（雇用範囲）')),
    );
    expect(employmentConflicts.length, '雇用範囲の差が検知されていない').toBeGreaterThan(0);
  });
});
