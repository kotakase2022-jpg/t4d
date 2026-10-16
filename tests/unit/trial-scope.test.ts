import { describe, expect, it } from 'vitest';
import {
  isPdf,
  scopeSignals,
  SEPARATE_CONSULTATION_KINDS,
  signalCountLabel,
  STANDARD_SCOPE_ITEMS,
  type ScopeSignalInput,
} from '@/lib/domain/trial-scope';
import { buildTrialReportSheets } from '@/lib/exports/trial-report';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { summarizeScenarios } from '@/lib/services/trial-evaluation';
import { summarizeOpenIssues } from '@/lib/services/trial-feedback';
import { loadTrialProgram, loadTrialScopeSignals } from '@/lib/services/trial-program';
import { summarizeTimings } from '@/lib/services/trial-timing';
import { TRIAL_SCOPE_KINDS, type AuthorizationContext } from '@/types/domain';

function adminCtx(): AuthorizationContext {
  return {
    userId: userId('enterprise-admin@demo.local'),
    email: 'enterprise-admin@demo.local',
    displayName: '管理者',
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys: ['enterprise_admin'],
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

/**
 * 無償の範囲と別途協議の 4 区分の信号（plan CR-23・unit:trial-scope）。
 *  - 目安の内外・目安なし・数えられない（製品に機能が無い）を区別する。推測で「範囲内」と書かない
 *  - OCR が要る PDF は 1 件でも標準機能の外（目安の内外にかかわらず）
 *  - 改善管理表で別途協議とした要望は区分ごとに数え、区分の無いものはどこにも数えない
 *  - 金額を扱わない
 */

function input(overrides: {
  sites?: Partial<ScopeSignalInput['sites']>;
  pdf?: Partial<ScopeSignalInput['pdf']>;
  feedback?: Partial<ScopeSignalInput['feedback']>;
}): ScopeSignalInput {
  return {
    sites: { trialSites: 5, plannedSites: 5, outsideUnits: 0, outsideRows: 0, ...overrides.sites },
    pdf: {
      ingestionPdf: 0,
      needsOcr: 0,
      registeredPdf: 0,
      threshold: 20,
      periodLabel: 'トライアルの期間 2026-07-15〜2027-01-11',
      ...overrides.pdf,
    },
    feedback: {
      byKind: {
        site_expansion: 0,
        bulk_primary_data: 0,
        system_integration: 0,
        custom_development: 0,
      },
      unclassified: 0,
      ...overrides.feedback,
    },
  };
}

const byKind = (signals: ReturnType<typeof scopeSignals>) =>
  Object.fromEntries(signals.map((s) => [s.kind, s]));

describe('scopeSignals', () => {
  it('4 区分を改善管理表の区分と同じ値・並びで返す', () => {
    const signals = scopeSignals(input({}));
    expect(signals.map((s) => s.kind)).toEqual([...TRIAL_SCOPE_KINDS]);
    expect(SEPARATE_CONSULTATION_KINDS).toEqual(TRIAL_SCOPE_KINDS);
    expect(signals.map((s) => s.label)).toEqual([
      '大幅な拠点追加',
      '大量の PDF 等の一次データ処理',
      '外部システムとの個別連携',
      '新規機能の個別開発',
    ]);
  });

  it('何も超えていなければ: 拠点・PDF は目安の範囲内、連携は数えられない、新規開発は目安なし', () => {
    const s = byKind(scopeSignals(input({})));
    expect(s.site_expansion!.state).toBe('within');
    expect(s.bulk_primary_data!.state).toBe('within');
    expect(s.system_integration!.state).toBe('not_measured');
    expect(s.system_integration!.count).toBe(0);
    expect(s.custom_development!.state).toBe('no_threshold');
  });

  it('拠点: 計画の対象拠点数を超えた・トライアルの拠点の外にデータがある・要望がある、のどれでも超過', () => {
    expect(byKind(scopeSignals(input({ sites: { trialSites: 6 } }))).site_expansion!.state).toBe(
      'over',
    );
    const outside = byKind(
      scopeSignals(input({ sites: { outsideUnits: 2, outsideRows: 26 } })),
    ).site_expansion!;
    expect(outside.state).toBe('over');
    expect(outside.detail).toContain('トライアルの拠点の外の 2 拠点に対象期間のデータ 26 件');
    const requested = byKind(
      scopeSignals(
        input({
          feedback: {
            byKind: {
              site_expansion: 1,
              bulk_primary_data: 0,
              system_integration: 0,
              custom_development: 0,
            },
          },
        }),
      ),
    ).site_expansion!;
    expect(requested.state).toBe('over');
    expect(requested.detail).toContain('改善管理表で別途協議とした要望 1 件');
  });

  it('拠点: 計画の拠点数が未設定なら目安なし。全社（拠点の指定なし）も目安なし', () => {
    expect(
      byKind(scopeSignals(input({ sites: { plannedSites: null } }))).site_expansion!.state,
    ).toBe('no_threshold');
    const all = byKind(
      scopeSignals(input({ sites: { trialSites: null, plannedSites: 3 } })),
    ).site_expansion!;
    expect(all.state).toBe('no_threshold');
    expect(all.detail).toContain('全社');
    expect(signalCountLabel(all)).toBe('—');
  });

  it('PDF: 取込と資料の合計を目安と比べる。目安が無ければ目安なし', () => {
    const over = byKind(
      scopeSignals(input({ pdf: { ingestionPdf: 15, registeredPdf: 6 } })),
    ).bulk_primary_data!;
    expect(over.count).toBe(21);
    expect(over.state).toBe('over');
    expect(signalCountLabel(over)).toBe('21 件 / 目安 20');
    const exact = byKind(
      scopeSignals(input({ pdf: { ingestionPdf: 14, registeredPdf: 6 } })),
    ).bulk_primary_data!;
    expect(exact.state).toBe('within');
    const none = byKind(scopeSignals(input({ pdf: { threshold: null } }))).bulk_primary_data!;
    expect(none.state).toBe('no_threshold');
    expect(signalCountLabel(none)).toBe('0 件（目安なし）');
  });

  it('PDF: OCR が要るものは 1 件でも、目安の内でも・目安が無くても標準機能の外', () => {
    for (const threshold of [20, null]) {
      const s = byKind(
        scopeSignals(input({ pdf: { ingestionPdf: 1, needsOcr: 1, threshold } })),
      ).bulk_primary_data!;
      expect(s.state).toBe('over');
      expect(s.detail).toContain('標準機能の外（OCR）');
      expect(s.detail).toContain('製品に OCR はありません');
    }
  });

  it('件数 0 のときも 0 と出す（記録が無いことを隠さない）。数えた期間を書く', () => {
    const s = byKind(scopeSignals(input({}))).bulk_primary_data!;
    expect(s.count).toBe(0);
    expect(s.measured).toContain('トライアルの期間 2026-07-15〜2027-01-11');
    expect(signalCountLabel(byKind(scopeSignals(input({}))).site_expansion!)).toBe(
      '5 拠点 / 目安 5',
    );
  });

  it('改善管理表: 連携・新規開発は要望があれば超過。区分の無い別途協議はどこにも数えず、そう書く', () => {
    const s = byKind(
      scopeSignals(
        input({
          feedback: {
            byKind: {
              site_expansion: 0,
              bulk_primary_data: 0,
              system_integration: 2,
              custom_development: 1,
            },
            unclassified: 3,
          },
        }),
      ),
    );
    expect(s.system_integration!).toMatchObject({ state: 'over', count: 2 });
    expect(s.custom_development!).toMatchObject({ state: 'over', count: 1 });
    expect(s.custom_development!.detail).toContain('区分の無い別途協議 3 件');
    expect(s.site_expansion!.state).toBe('within');
  });
});

describe('検証結果の XLSX の「集計」（トライアル概要と同じ関数の結果）', () => {
  it('無償の範囲の合意と 4 区分の行（状態・件数／目安・数えたもの）。改善管理表に別途協議の区分の列', async () => {
    const fixture = createFixtureDb();
    const db = new DemoDbClient(fixture);
    const ctx = adminCtx();
    const program = await loadTrialProgram(db, ctx);
    const [scenarios, feedback, timings, scope] = await Promise.all([
      summarizeScenarios(db, ctx),
      summarizeOpenIssues(db, ctx),
      summarizeTimings(db, ctx),
      loadTrialScopeSignals(db, ctx, program),
    ]);
    const sheets = buildTrialReportSheets({
      scenarios,
      feedback,
      timings,
      target: null,
      demo: true,
      build: 'test',
      generatedAt: '2026-10-16T00:00:00.000Z',
      scope: {
        agreement: program?.agreements.freeScope ?? null,
        signals: scope.signals,
        unclassifiedSeparate: scope.unclassifiedSeparate,
      },
    });
    const rowsOf = (name: string) => {
      const sheet = sheets.find((s) => s.name === name)!;
      return sheet.rows.map((row) =>
        Object.fromEntries(sheet.columns.map((c) => [c.header, c.value(row)])),
      );
    };
    const summary = rowsOf('集計');
    expect(summary.find((r) => r['項目'] === '無償の範囲の合意')?.['値']).toMatch(/^合意済み/);
    const scopeRows = summary.filter((r) => String(r['項目']).startsWith('別途協議の区分: '));
    expect(scopeRows.map((r) => r['項目'])).toEqual([
      '別途協議の区分: 大幅な拠点追加',
      '別途協議の区分: 大量の PDF 等の一次データ処理',
      '別途協議の区分: 外部システムとの個別連携',
      '別途協議の区分: 新規機能の個別開発',
    ]);
    expect(scopeRows[1]!['値']).toBe('目安の範囲内（0 件 / 目安 20）');
    expect(scopeRows[2]!['値']).toBe('数えられない（0 件（目安なし））');
    expect(scopeRows[3]!['値']).toBe('別途協議の目安を超過（1 件（目安なし））');
    expect(JSON.stringify(summary)).not.toMatch(/\d円/);
    const notes = rowsOf('注記').map((r) => r['注記']);
    expect(notes.some((n) => String(n).includes('別途協議の候補であって確定ではありません'))).toBe(
      true,
    );
    expect(rowsOf('改善管理表').map((r) => r['別途協議の区分'])).toContain('新規機能の個別開発');
  });
});

describe('標準機能の一覧・PDF の判定', () => {
  it('標準機能は製品の事実だけ（金額・無償の語を含まない）。算定と照合を含む', () => {
    const text = STANDARD_SCOPE_ITEMS.join('\n');
    expect(text).toContain('Scope1・2 の算定');
    expect(text).toContain('既存の算定結果との照合');
    expect(text).not.toMatch(/円|無償|有償|料金/);
  });

  it('PDF は MIME の種類か拡張子で見分ける', () => {
    expect(isPdf({ mimeType: 'application/pdf', originalName: 'a.bin' })).toBe(true);
    expect(isPdf({ mimeType: 'application/octet-stream', originalName: '請求書.PDF' })).toBe(true);
    expect(isPdf({ mimeType: 'text/csv', originalName: 'a.csv' })).toBe(false);
  });
});
