import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_MIN_VISIBLE_CONFIDENCE, withDisplayConfidence } from '@/lib/imports/demo-display';

/**
 * 一般取込プレビューのデモ表示（2026-09-15 指示④）。
 *
 * - 指標を特定できず・低確信（< 0.55）の行は demoHiddenLowConfidence の印が付き、
 *   プレビュー表では「取り込み対象外」の折りたたみへ回る（表示専用。
 *   保存された status・confidence は変えない）
 * - 指標が特定できた行は低確信でも隠さない（定義ズレ等の要確認・重複を含めて
 *   デモ表示 80〜97% に収まる）
 * - 通常モード（supabase）では畳まず、実測値のまま出す
 */

function row(status: string, confidence: number, metricId: string | null = 'metric-1') {
  return {
    confidence,
    status,
    metricId,
    sourceLocator: `row-${status}-${confidence}-${metricId ?? 'none'}`,
    raw: { 項目: 'x', 値: '1' },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withDisplayConfidence（デモモード）', () => {
  it('指標を特定できない低確信行は表示専用の印で「対象外」へ畳まれ、実測値は保持される', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_MODE', 'demo');
    const [miss1, miss2] = withDisplayConfidence([
      row('needs_review', 0.31, null),
      row('needs_review', 0.44, null),
    ]);
    for (const r of [miss1!, miss2!]) {
      expect(r.demoHiddenLowConfidence).toBe(true);
      expect(r.confidenceSource).toBe('measured');
      expect(r.displayConfidence).toBe(r.confidence); // 実測を書き換えない
      expect(r.status).toBe('needs_review'); // 保存状態は変えない
    }
  });

  it('指標が特定できた行は低確信（定義ズレ等）でも隠さず、80〜97% のデモ表示になる', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_MODE', 'demo');
    const rows = withDisplayConfidence([
      row('needs_review', 0.42), // 定義ズレ相当（指標あり）
      row('needs_review', DEMO_MIN_VISIBLE_CONFIDENCE),
      row('needs_review', 0.68),
      row('duplicate', 0.75),
      row('mapped', 0.88),
    ]);
    for (const r of rows) {
      expect(r.demoHiddenLowConfidence).toBeUndefined();
      expect(r.confidenceSource).toBe('demo_simulated');
      expect(r.displayConfidence).toBeGreaterThanOrEqual(0.8);
      expect(r.displayConfidence).toBeLessThanOrEqual(0.97);
    }
  });

  it('AI 未評価（confidence 0）の行は畳まず、実測 0% のまま出す', () => {
    // 行数上限の超過等で AI を通っていない行。「マスターと無関係」ではないので
    // 折りたたみへ回さず、帯へ写して 80% に見せることもしない
    vi.stubEnv('NEXT_PUBLIC_APP_MODE', 'demo');
    const [unevaluated] = withDisplayConfidence([row('needs_review', 0, null)]);
    expect(unevaluated!.demoHiddenLowConfidence).toBeUndefined();
    expect(unevaluated!.confidenceSource).toBe('measured');
    expect(unevaluated!.displayConfidence).toBe(0);
  });

  it('確定済み・対象外の行は指標なし・低確信でも畳み直さない', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_MODE', 'demo');
    const [confirmed, ignored] = withDisplayConfidence([
      row('confirmed', 0.3, null),
      row('ignored', 0.3, null),
    ]);
    expect(confirmed!.demoHiddenLowConfidence).toBeUndefined();
    expect(ignored!.demoHiddenLowConfidence).toBeUndefined();
  });
});

describe('withDisplayConfidence（通常モード）', () => {
  it('supabase モードでは畳まず、実測値をそのまま表示する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_MODE', 'supabase');
    const rows = withDisplayConfidence([row('needs_review', 0.42, null), row('mapped', 0.88)]);
    for (const r of rows) {
      expect(r.demoHiddenLowConfidence).toBeUndefined();
      expect(r.confidenceSource).toBe('measured');
      expect(r.displayConfidence).toBe(r.confidence);
    }
  });
});
