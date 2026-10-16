import { beforeAll, describe, expect, it } from 'vitest';
import {
  GHG_FIXED_NOTICES,
  companyRuleNoticeText,
  loadFactorNoticeText,
} from '@/components/shared/ghg-notices';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { toCsv } from '@/lib/exports';
import {
  buildGhgCalculationSheet,
  exportGhgCalculationCsv,
  ghgCalculationColumns,
  ghgCalculationFileName,
  ghgCalculationNotes,
  type GhgCalculationExportContext,
} from '@/lib/exports/ghg-calculation';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type {
  GhgCalculationLine,
  GhgCalculationRun,
  ReportingPeriod,
  RoleKey,
} from '@/types/domain';

/**
 * 算定明細 CSV（plan E18・CR-15・unit:ghg-calculation-export）。
 *  - 列は画面の算定行と同じ値（記録に残した値。表示で丸め直さない）
 *  - 表の後に空行と注記の行。注記は画面と同じ固定文（N1・N5・N7・N9）を ghg-notices の関数から作る
 */

let run: GhgCalculationRun;
let lines: GhgCalculationLine[];
let period: ReportingPeriod;
let context: GhgCalculationExportContext;

beforeAll(() => {
  const db = createFixtureDb();
  run = db.ghgCalculationRuns.find((r) => r.id === GHG_FIXTURE_IDS.run)!;
  lines = db.ghgCalculationLines.filter((l) => l.runId === run.id);
  period = db.periods.find((p) => p.id === GHG_FIXTURE_IDS.period)!;
  const units = db.units.filter((u) => run.unitIds.includes(u.id));
  context = {
    run,
    period,
    units: new Map(units.map((u) => [u.id, u])),
    ruleNames: new Map(db.ghgClassificationRules.map((r) => [r.id, `${r.code} ${r.name}`])),
    appliedRules: [],
    minLoadPct: 10,
    demo: true,
  };
});

function parse(csv: string): string[][] {
  // 注記の文に「,」が無いことを前提にしない（"…" で囲まれた値の中の , を分けない）
  return csv
    .replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '')
    .split('\r\n')
    .filter((line, i, all) => !(i === all.length - 1 && line === ''))
    .map((line) => {
      const cells: string[] = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]!;
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else if (ch === '"') quoted = false;
          else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          cells.push(cur);
          cur = '';
        } else cur += ch;
      }
      cells.push(cur);
      return cells;
    });
}

describe('算定明細 CSV の列', () => {
  it('列の見出し（拠点・月・活動・方法・活動量→換算後・係数〔値・年度・版・経路〕・未丸め・丸め後・既定区分・報告区分・警告）', () => {
    expect(ghgCalculationColumns(context).map((c) => c.header)).toEqual([
      '算定の記録',
      '期間',
      '拠点コード',
      '拠点',
      '国',
      '月',
      '活動',
      '算定方法',
      '活動量',
      '活動量の単位',
      '換算後の量',
      '換算後の単位',
      '換算の段',
      '輸送トンキロ（t·km）',
      '燃料使用原単位（未丸め）',
      '燃料使用原単位（L/t·km）',
      '積載率（%）',
      '積載率の出所',
      '燃料（L）',
      '排出係数',
      '排出係数の単位',
      '単位発熱量',
      '炭素排出係数',
      '係数の年度',
      '係数セット',
      '係数セットの版',
      '係数の解決経路',
      '排出量（未丸め・t-CO2e）',
      '排出量（行の丸め後・t-CO2e）',
      '既定区分（GHG プロトコル）',
      '報告区分（組織の算定ルール）',
      '区分規則',
      '警告',
    ]);
  });

  it('1 算定行 1 行。値は記録の値（2 進の誤差だけ落とす）。輸送の行は t·km・原単位・積載率の出所', () => {
    const rows = parse(toCsv(buildGhgCalculationSheet(lines, context)));
    const header = rows[0]!;
    const col = (name: string) => header.indexOf(name);
    const body = rows.slice(1, 1 + lines.length);
    expect(body).toHaveLength(lines.length);
    expect(body.every((r) => r[col('算定の記録')] === `#${run.id.slice(0, 8)}`)).toBe(true);
    expect(body.every((r) => r[col('期間')] === 'CY2025')).toBe(true);
    const transportIndex = lines.findIndex((l) => l.method === 'tonkm_improved');
    const transport = body[transportIndex]!;
    expect(transport[col('算定方法')]).toBe('改良トンキロ法');
    // 2.2×180 の 2 進の誤差（396.00000000000006）は落とす
    expect(transport[col('活動量')]).toBe('396');
    expect(transport[col('輸送トンキロ（t·km）')]).toBe('396');
    expect(transport[col('積載率の出所')]).toBe('実測');
    expect(Number(transport[col('排出量（未丸め・t-CO2e）')])).toBeCloseTo(
      lines[transportIndex]!.emissionsUnrounded,
      12,
    );
    expect(transport[col('既定区分（GHG プロトコル）')]).toBe('Scope3 カテゴリ4');
    // 行の段の丸めが無い方針では、丸め後の列は空（未丸めと同じ値を丸め後として書かない）
    expect(transport[col('排出量（行の丸め後・t-CO2e）')]).toBe('');
    const defaultLine = lines.findIndex((l) => l.warnings.includes('default_load_factor'));
    expect(body[defaultLine]![col('積載率の出所')]).toBe('見なし（原単位表）');
    expect(body[defaultLine]![col('警告')]).toBe('見なし積載率（原単位表）');
  });
});

describe('注記（画面と同じ固定文）', () => {
  it('Demo は N9、見なし・下限の行があれば N7。承認済みの規則で再分類が無ければ N1 は出さない', () => {
    const notes = ghgCalculationNotes(lines, context);
    expect(notes).toContain(GHG_FIXED_NOTICES.N9);
    const defaultRows = lines.filter((l) => l.warnings.includes('default_load_factor')).length;
    const flooredRows = lines.filter((l) => l.warnings.includes('load_floored')).length;
    expect(notes).toContain(loadFactorNoticeText({ defaultRows, minLoadPct: 10, flooredRows }));
    expect(notes.some((n) => n.startsWith('報告区分は、組織が承認した算定ルール'))).toBe(false);
    // 海外拠点の輸送が無ければ N5 も出さない
    expect(notes).not.toContain(GHG_FIXED_NOTICES.N5);
    expect(ghgCalculationNotes(lines, { ...context, demo: false })).not.toContain(
      GHG_FIXED_NOTICES.N9,
    );
  });

  it('承認済みの規則で報告区分を変えた記録は N1（規則名・承認日・承認者）を載せる', () => {
    const applied = {
      ruleName: '委託物流を Scope1 とする（テスト）',
      approvedAt: '2026-10-16T00:30:00.000Z',
      approverName: '承 花子',
    };
    const notes = ghgCalculationNotes(lines, { ...context, appliedRules: [applied] });
    expect(notes).toContain(companyRuleNoticeText(applied));
  });

  it('海外拠点の輸送の行があれば N5', () => {
    const overseas = lines.map((l) =>
      l.method === 'tonkm_improved'
        ? { ...l, methodDetail: { ...l.methodDetail, overseas: true } }
        : l,
    );
    expect(ghgCalculationNotes(overseas, context)).toContain(GHG_FIXED_NOTICES.N5);
  });

  it('表の後に空行、続けて 1 列目「注記」・2 列目に文。記録・入力ハッシュ・エンジンの版も残す', () => {
    const rows = parse(toCsv(buildGhgCalculationSheet(lines, context)));
    const blank = rows[1 + lines.length]!;
    expect(blank.every((cell) => cell === '')).toBe(true);
    const notes = rows.slice(2 + lines.length);
    expect(notes.length).toBe(ghgCalculationNotes(lines, context).length);
    expect(notes.every((r) => r[0] === '注記')).toBe(true);
    expect(notes.map((r) => r[1])).toContain(GHG_FIXED_NOTICES.N9);
    const last = notes[notes.length - 1]![1]!;
    expect(last).toContain(run.inputHash.slice(0, 12));
    expect(last).toContain(run.engineVersion);
  });

  it('ファイル名は期間のコードと記録の短縮 ID', () => {
    expect(ghgCalculationFileName(period, run)).toBe(`算定明細_CY2025_${run.id.slice(0, 8)}.csv`);
  });
});

describe('exportGhgCalculationCsv（E18 の本体）', () => {
  function ctxFor(email: string, roleKeys: RoleKey[], organizationId = ORG_IDS.aomi) {
    return {
      userId: userId(email),
      email,
      displayName: email,
      workspace: {
        organizationId,
        organizationType: 'enterprise' as const,
        organizationName: 'テスト',
        roleKeys,
        unitScopeIds: [],
      },
      engagementIds: [],
      demo: true,
    };
  }

  it('出力の権限で CSV を作り、監査ログ export_created を残す。権限が無ければ断り、他社の記録は見つからない', async () => {
    const fixture = createFixtureDb();
    const db = new DemoDbClient(fixture);
    const author = ctxFor('sustainability@demo.local', ['sustainability_manager']);
    const result = await exportGhgCalculationCsv(db, author, GHG_FIXTURE_IDS.run);
    if (!result.ok) throw new Error('出力できるはず');
    expect(result.rowCount).toBe(run.lineCount);
    expect(result.csv).toContain(GHG_FIXED_NOTICES.N9);
    expect(result.fileName).toBe(ghgCalculationFileName(period, run));
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'export_created' && e.resourceId === GHG_FIXTURE_IDS.run,
      ),
    ).toBe(true);
    await expect(
      exportGhgCalculationCsv(db, ctxFor('reviewer@demo.local', ['reviewer']), GHG_FIXTURE_IDS.run),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      exportGhgCalculationCsv(
        db,
        ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten),
        GHG_FIXTURE_IDS.run,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
