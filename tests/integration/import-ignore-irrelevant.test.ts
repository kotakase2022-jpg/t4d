import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { createIngestionJob, processIngestionJob } from '@/lib/imports/service';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 指標マスターと無関係な行を、警告を出さずに取り込み対象外にする。
 *
 * 社内ファイルには名簿・住所録・改版履歴がいくらでも混ざる。
 * それらに 1 行ずつ「指標を特定できませんでした」と警告を出していたため、
 * 本当に確認が要る行がその山に埋もれていた。
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

async function runImport(name: string, csv: string, key: string) {
  const job = await createIngestionJob(db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    unitId: UNIT_IDS.hq,
    idempotencyKey: key,
    files: [{ name, type: 'text/csv', bytes: new TextEncoder().encode('﻿' + csv) }],
  });
  await processIngestionJob(db, manager(), job.id);
  return {
    job: (await db.findById('ingestionJobs', job.id))!,
    rows: await db.select('ingestionRows', { where: { jobId: job.id } }),
    files: await db.select('ingestionJobFiles', { where: { jobId: job.id } }),
  };
}

describe('無関係な行の除外', () => {
  it('署名欄の行は警告を出さずに対象外にし、指標の行はそのまま取り込む', async () => {
    // 拠点別の集計表の末尾に作成者・承認者の欄が付いてくる、実際によくある形
    const csv = [
      '拠点,項目,値,単位',
      '本社,電力使用量,1240,MWh',
      '作成者,山田 太郎,,',
      '承認者,鈴木 花子,,',
    ].join('\r\n');

    const { rows } = await runImport('混在.csv', csv, 'mixed-1');

    const ignored = rows.filter((r) => r.status === 'ignored');
    expect(ignored).toHaveLength(2);
    // 静かに外す＝警告を 1 つも出さない
    for (const row of ignored) {
      expect(row.warnings).toEqual([]);
    }

    // 指標の行は今までどおり扱われる（巻き添えで消えていない）
    const kept = rows.filter((r) => r.status !== 'ignored');
    expect(kept).toHaveLength(1);
    expect(kept[0]?.value).toBe(1240);
  });

  it('外した行は消さずに残し、監査ログにも件数を残す', async () => {
    const csv = ['拠点,項目,値,単位', '本社,電力使用量,1240,MWh', '作成者,山田 太郎,,'].join(
      '\r\n',
    );

    const { job, rows } = await runImport('混在2.csv', csv, 'mixed-2');

    // 行そのものは残る（なぜ台帳に無いのかを後から辿れるようにするため）
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.status === 'ignored')).toBe(true);

    const audit = await db.select('auditEvents', {
      where: { resourceType: 'ingestion_job', resourceId: job.id },
    });
    const summaries = audit.map((a) => a.afterSummary ?? '').join(' ');
    expect(summaries).toContain('対象外 1 行');
  });

  it('要確認の件数に、対象外にした行を混ぜない', async () => {
    const csv = [
      '拠点,項目,値,単位',
      '本社,電力使用量,1240,MWh',
      '作成者,山田 太郎,,',
      '承認者,鈴木 花子,,',
      '配布先,経理部,,',
    ].join('\r\n');

    const { job, rows } = await runImport('混在3.csv', csv, 'mixed-3');

    expect(job.totalRows).toBe(4);
    // 署名欄 3 行は要確認に数えない。残る 1 行は既存データとの重複なので要確認に入る
    expect(rows.filter((r) => r.status === 'ignored')).toHaveLength(3);
    expect(job.warningRows).toBe(0);
  });

  it('同じ警告文が二重に並ばない', async () => {
    // AI 側も「指標を特定できませんでした」を返すため、以前は同じ文言が 2 回出て
    // 別々の問題があるように読めていた
    const csv = ['拠点,項目,値,単位', '本社,都市ガス使用量,320,MWh'].join('\r\n');

    const { rows } = await runImport('未知指標.csv', csv, 'dup-warn-1');

    const warnings = rows[0]?.warnings ?? [];
    expect(warnings.length).toBeGreaterThan(0);
    expect(new Set(warnings).size).toBe(warnings.length);
  });

  it('指標に近いのに特定できなかった行は、これまでどおり警告を出す', async () => {
    // 「圧縮空気」は指標マスターに無いが GJ が付いている。
    // 人が指標を選べば取り込める行なので、黙って外してはいけない
    const csv = ['拠点,項目,値,単位', '本社,圧縮空気（購入分）,18.4,GJ'].join('\r\n');

    const { rows } = await runImport('未知単位.csv', csv, 'unknown-1');

    expect(rows[0]?.status).toBe('needs_review');
    expect(rows[0]?.warnings.join(' ')).toContain('指標を特定できませんでした');
  });

  it('ほとんどが無関係なファイルは、静かに外さずファイル単位で伝える', async () => {
    const csv = [
      '社員番号,氏名,所属,役職',
      'A10231,山田 太郎,第一営業部,主任',
      'A10232,鈴木 花子,経理部,担当',
      'A10233,佐藤 次郎,製造部,班長',
      'A10234,田中 三郎,総務部,係長',
    ].join('\r\n');

    const { files, job } = await runImport('社員名簿.csv', csv, 'roster-1');

    expect(files[0]?.parseMessage ?? '').toContain('指標マスターに対応する数値が見つかりません');
    // 何も取り込めなかったが、失敗にはしない（資料としては保管する）
    expect(job.status).not.toBe('failed');
  });
});
