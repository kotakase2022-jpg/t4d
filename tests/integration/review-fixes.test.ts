import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { addComment, resolveMentions } from '@/lib/services/comments';
import { issuePasswordResetLink } from '@/lib/services/identity';
import { transitionDataPoint } from '@/lib/services/data-point-workflow';
import { buildTemplateWorkbook } from '@/lib/services/data-entry';
import { validateDataPoints } from '@/lib/validation/data-point-rules';
import { isCountedInTotals } from '@/lib/services/aggregation';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 独立最終レビュー（2026-08-18）で確定した所見の回帰テスト。
 * いずれも修正前は失敗する（＝欠陥を捉えている）ことを確認して残している。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(
  email: string,
  organizationId: string,
  roleKeys: RoleKey[],
  unitScopeIds: string[] = [],
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () => ctxFor('enterprise-admin@demo.local', ORG_IDS.aomi, ['enterprise_admin']);
const siteUser = () => ctxFor('site-user@demo.local', ORG_IDS.aomi, ['site_contributor']);
const reviewer = () => ctxFor('reviewer@demo.local', ORG_IDS.aomi, ['reviewer']);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('REV-01 パスワード再設定リンクは自組織メンバーにしか発行できない', () => {
  it('他組織（監査法人・別企業）の利用者には発行しない', async () => {
    await expect(
      issuePasswordResetLink(db, admin(), 'assurance-partner@demo.local', 'http://127.0.0.1:3000'),
    ).rejects.toThrow(/自組織のメンバーに見つかりません/);
    await expect(
      issuePasswordResetLink(
        db,
        admin(),
        'other-enterprise-admin@demo.local',
        'http://127.0.0.1:3000',
      ),
    ).rejects.toThrow(/自組織のメンバーに見つかりません/);
  });

  it('自組織メンバーでも member.manage が無ければ発行できない', async () => {
    await expect(
      issuePasswordResetLink(db, siteUser(), 'reviewer@demo.local', 'http://127.0.0.1:3000'),
    ).rejects.toThrow();
  });

  it('自組織メンバーなら照合を通過する（Demo Mode では Supabase 専用エラーで止まる）', async () => {
    // 「他組織」ではなく「Supabase Mode 専用」で落ちることが、照合通過の証拠になる
    await expect(
      issuePasswordResetLink(db, admin(), 'reviewer@demo.local', 'http://127.0.0.1:3000'),
    ).rejects.toThrow(/Supabase Mode でのみ/);
  });
});

describe('REV-02 内部取引の明細行は保証側へ共有されない', () => {
  it('Data Room / 母集団に内部取引行が入らない', () => {
    const intercompany = fixture.dataPoints.filter((dp) => !isCountedInTotals(dp));
    expect(intercompany.length).toBeGreaterThan(0); // fixture に明細行がある前提

    const intercompanyIds = new Set(intercompany.map((dp) => dp.id));
    for (const item of fixture.dataRoomItems) {
      expect(intercompanyIds.has(item.sourceId)).toBe(false);
    }
    for (const item of fixture.populationItems) {
      expect(intercompanyIds.has(item.sourceDataPointId)).toBe(false);
    }
  });

  it('母集団の欠損件数が未承認分を隠さない', () => {
    const population = fixture.populations[0];
    expect(population).toBeDefined();
    expect(population!.missingCount).toBeGreaterThan(0);
  });
});

describe('REV-03 前年比の照合は boundary を跨がない', () => {
  it('内部取引の明細行が前年の連結値と比較されない', () => {
    const metric = fixture.metrics.find(
      (m) => m.organizationId === ORG_IDS.aomi && m.code === 'scope3_cat1',
    )!;
    const units = fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi);
    const current = fixture.dataPoints.filter(
      (dp) =>
        dp.organizationId === ORG_IDS.aomi &&
        dp.reportingPeriodId === PERIOD_IDS.fy2026 &&
        dp.metricId === metric.id,
    );
    const previous = fixture.dataPoints.filter(
      (dp) =>
        dp.organizationId === ORG_IDS.aomi &&
        dp.reportingPeriodId === PERIOD_IDS.fy2025 &&
        dp.metricId === metric.id,
    );

    const results = validateDataPoints({
      dataPoints: current,
      previousPeriodDataPoints: previous,
      metrics: [metric],
      units,
      periods: fixture.periods,
      evidenceCountByDataPoint: new Map(
        current.map((dp) => [
          dp.id,
          fixture.evidenceLinks.filter((l) => l.targetType === 'data_point' && l.targetId === dp.id)
            .length,
        ]),
      ),
      detectedAt: new Date().toISOString(),
    });

    const intercompanyIds = new Set(
      current.filter((dp) => !isCountedInTotals(dp)).map((d) => d.id),
    );
    const bogus = results.filter(
      (r) => r.ruleKey === 'yoy_deviation' && intercompanyIds.has(r.dataPointId),
    );
    expect(bogus).toEqual([]);
  });
});

describe('REV-04 標準テンプレートは hqOnly をデータモデルで判定する', () => {
  it('拠点別に集める従業員数は拠点行が出て、本社限定の Scope3 Cat.1 は本社行だけ出る', async () => {
    const metrics = fixture.metrics.filter(
      (m) => m.organizationId === ORG_IDS.aomi && ['employees', 'scope3_cat1'].includes(m.code),
    );
    const units = fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi);
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;

    const bytes = await buildTemplateWorkbook(metrics, units, period, []);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('データ入力')!;

    const employeesName = metrics.find((m) => m.code === 'employees')!.name;
    const scope3Name = metrics.find((m) => m.code === 'scope3_cat1')!.name;

    const rows: Array<{ unit: string; metric: string }> = [];
    ws.eachRow((row, i) => {
      if (i === 1) return;
      rows.push({ unit: String(row.getCell(1).value), metric: String(row.getCell(2).value) });
    });

    const employeesUnits = rows.filter((r) => r.metric === employeesName).map((r) => r.unit);
    const scope3Units = rows.filter((r) => r.metric === scope3Name).map((r) => r.unit);

    expect(employeesUnits.length).toBeGreaterThan(1); // 拠点別に収集するので拠点行が出る
    expect(employeesUnits).toContain('東日本工場');
    expect(scope3Units).toEqual(['本社']); // 本社限定
  });
});

describe('REV-05 メンションは正規化衝突時に全員へ届く', () => {
  it('表示名が正規化後に同一の 2 名がいれば両方へ解決する', () => {
    const members = [
      { userId: 'u1', displayName: '田中 太郎' },
      { userId: 'u2', displayName: '田中太郎' },
      { userId: 'u3', displayName: '佐藤 花子' },
    ];
    expect(resolveMentions('@田中太郎 確認をお願いします', members).sort()).toEqual(['u1', 'u2']);
    expect(resolveMentions('@佐藤花子 よろしく', members)).toEqual(['u3']);
  });
});

describe('REV-06 コメントの権限は対象の種別に合わせる', () => {
  it('開示権限の無いロールは開示回答へコメントできない', async () => {
    const response = fixture.disclosureResponses.find((r) => r.organizationId === ORG_IDS.aomi)!;
    await expect(
      addComment(db, siteUser(), {
        targetType: 'disclosure_response',
        targetId: response.id,
        body: '直叩きのコメント',
        href: '/enterprise/disclosures/cdp',
      }),
    ).rejects.toThrow();
  });

  it('Data Point へのコメントは従来どおり data.read で行える', async () => {
    const dp = fixture.dataPoints.find(
      (d) => d.organizationId === ORG_IDS.aomi && d.unitId === UNIT_IDS.east,
    )!;
    const comment = await addComment(db, siteUser(), {
      targetType: 'data_point',
      targetId: dp.id,
      body: '拠点担当からの補足です。',
      href: `/enterprise/data/${dp.id}`,
    });
    expect(comment.body).toBe('拠点担当からの補足です。');
  });
});

describe('REV-07 遷移コメントも通常コメントと同じ検証を通る', () => {
  it('2000 文字を超える差戻し理由は拒否される', async () => {
    const target = fixture.dataPoints.find(
      (d) => d.organizationId === ORG_IDS.aomi && d.status === 'submitted',
    );
    expect(target).toBeDefined();

    await expect(
      transitionDataPoint(db, reviewer(), {
        dataPointId: target!.id,
        to: 'returned',
        comment: 'あ'.repeat(2001),
      }),
    ).rejects.toThrow(/2000 文字以内/);
  });
});

describe('REV-07b 空白だけの差戻し理由は例外にせずコメント無しとして扱う', () => {
  it('空白のみの comment で遷移しても成功し、コメントは作られない', async () => {
    const target = fixture.dataPoints.find(
      (d) => d.organizationId === ORG_IDS.aomi && d.status === 'submitted',
    )!;
    const before = fixture.comments.length;
    await transitionDataPoint(db, reviewer(), {
      dataPointId: target.id,
      to: 'returned',
      comment: '   ',
    });
    expect(fixture.comments.length).toBe(before);
    const after = await db.findById('dataPoints', target.id);
    expect(after!.status).toBe('returned');
  });
});

describe('REV-08 内部取引の明細行に Evidence が紐づく', () => {
  it('Evidence 必須指標の承認済み行が Evidence 無しにならない', () => {
    const intercompany = fixture.dataPoints.filter((dp) => !isCountedInTotals(dp));
    for (const dp of intercompany) {
      const links = fixture.evidenceLinks.filter(
        (l) => l.targetType === 'data_point' && l.targetId === dp.id,
      );
      expect(links.length).toBeGreaterThan(0);
    }
  });
});
