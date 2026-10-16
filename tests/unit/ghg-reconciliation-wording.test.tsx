import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { HONESTY_TEXT } from '@/components/shared/honesty-badge';
import { GHG_FIXED_NOTICES, GhgNotice } from '@/components/shared/ghg-notices';
import { GHG_RECONCILIATION_FLASH } from '@/components/shared/flash-messages/ghg-reconciliation';
import {
  ItemBreakdown,
  MainCauseBadge,
} from '@/app/enterprise/ghg/calculation/reconciliation/_components/item-parts';
import {
  orderPresetLabel,
  ATTRIBUTION_ORDER_PRESET_KEYS,
} from '@/app/enterprise/ghg/calculation/reconciliation/_components/reconcile-options';
import { itemVerdict } from '@/lib/domain/ghg/attribution';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb } from '@/lib/fixtures/store';
import { ghgCause } from '@/lib/ui/status/ghgCause';
import { ghgReconItem } from '@/lib/ui/status/ghgReconItem';

/**
 * 照合の語（plan K8・Q23・unit:ghg-reconciliation-wording）。
 *
 * 照合の画面・出力・通知は「整合性の確認」「差異の原因」の語で書き、判定・見出し・ボタンに「一致」を使わない。
 * 「一致」が出てよいのは、一致を保証しないことを述べる否定の文だけ（固定文 N3・整合性の確認のバッジ）。
 *  - スライス S4 のソース（画面・Server Action・サービス・出力・通知・画面の登録）に否定の文の外の「一致」が無い
 *  - 判定（許容差内・要確認・原因を確認済み・原因不明〔残差〕・片側のみ）と原因の語に「一致」が無い
 *  - 画面に出す部品（固定文・展開行・通知）を描いた文字にも否定の文の外の「一致」が無い
 */

/** 「一致」を含んでよい否定の言い回しは 1 つだけ（固定文 N3 の本文と見出し・整合性の確認のバッジ。plan K8） */
const NEGATIONS = ['一致を保証するものではありません'];

function strayMatches(text: string): number {
  let rest = text;
  for (const phrase of NEGATIONS) rest = rest.split(phrase).join('');
  return rest.split('一致').length - 1;
}

const ROOT = process.cwd();

function listFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(join(ROOT, path)).isDirectory() ? listFiles(path) : [path];
  });
}

const S4_SOURCES = [
  ...listFiles('src/app/enterprise/ghg/calculation/reconciliation'),
  'src/app/api/exports/ghg-reconciliation/route.ts',
  'src/lib/services/ghg/baseline-import.ts',
  'src/lib/services/ghg/reconciliation-notes.ts',
  'src/lib/services/ghg/what-if.ts',
  'src/lib/exports/ghg-reconciliation.ts',
  'src/components/shared/flash-messages/ghg-reconciliation.ts',
  'src/components/shared/route-catalog-ext/s4.ts',
];

describe('照合の語に「一致」を使わない', () => {
  it('スライス S4 のソースに「一致」が無い（否定の固定文は共通の部品から読む）', () => {
    expect(S4_SOURCES.length).toBeGreaterThanOrEqual(12);
    for (const file of S4_SOURCES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(strayMatches(text), file).toBe(0);
    }
  });

  it('判定と原因の語（状態の登録簿）に「一致」が無い', () => {
    for (const entry of [...Object.values(ghgReconItem), ...Object.values(ghgCause)]) {
      expect(entry.label).not.toContain('一致');
      expect(entry.description ?? '').not.toContain('一致');
    }
    expect(Object.values(ghgReconItem).map((e) => e.label)).toEqual([
      '許容差内',
      '要確認',
      '原因を確認済み',
      '原因不明（残差）',
      '片側のみ',
    ]);
  });

  it('固定文 N3 と整合性の確認のバッジは「一致を保証するものではありません」と述べる（否定の文だけ）', () => {
    expect(GHG_FIXED_NOTICES.N3).toContain('一致を保証するものではありません');
    expect(strayMatches(GHG_FIXED_NOTICES.N3)).toBe(0);
    expect(HONESTY_TEXT['consistency-check'].detail).toContain('一致を保証するものではありません');
    expect(strayMatches(HONESTY_TEXT['consistency-check'].label)).toBe(0);
    for (const id of ['N3', 'N4', 'N8'] as const) {
      const { container } = render(<GhgNotice id={id} />);
      expect(strayMatches(container.textContent ?? ''), id).toBe(0);
    }
  });

  it('通知・原因を揃える順序の選択肢に「一致」が無い', () => {
    const params = new URLSearchParams({ rows: '19', items: '243', outside: '64' });
    for (const build of Object.values(GHG_RECONCILIATION_FLASH)) {
      expect(build(params)).not.toContain('一致');
    }
    for (const key of ATTRIBUTION_ORDER_PRESET_KEYS) {
      expect(orderPresetLabel(key)).not.toContain('一致');
    }
  });

  it('展開行（原因別の寄与・残差・確認の記録）を描いた文字に「一致」が無い', () => {
    const fixture = createFixtureDb();
    const recon = fixture.ghgReconciliations.find((r) => r.id === GHG_FIXTURE_IDS.reconciliation)!;
    const residual = recon.result!.items.find((i) => itemVerdict(i, []) === 'unexplained')!;
    const view = { ...residual, verdict: 'unexplained' as const, latestNote: null, notes: [] };
    const { container } = render(
      <>
        <ItemBreakdown item={view} userName={() => '確認者'} whatIfHref="#whatif" />
        <MainCauseBadge item={view} />
      </>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('原因不明（残差）');
    expect(text).toContain('この項目で仮説の再計算をする（保存しません）');
    expect(strayMatches(text)).toBe(0);
  });
});
