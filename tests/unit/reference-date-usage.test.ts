import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 期限の基準日は src/lib/clock.ts の 1 か所から取る（W0 棚卸し O5、docs/disclosure-first.md §2-5）。
 *
 * これまで Service・画面が `FIXTURE_TODAY`（2026-08-14）を直接読んでおり、
 * Supabase Mode（本番）でも固定日で期限・超過を判定していた。
 * `FIXTURE_TODAY` を読んでよいのは、基準日を決める clock.ts・定義元の config.ts・
 * 基準日から相対に日付を作る Fixture だけ。
 */

const SRC = 'src';

/** FIXTURE_TODAY を読んでよいファイル（src からの相対パス、区切りは /） */
const ALLOWED = [
  'lib/config.ts',
  'lib/clock.ts',
  // Fixture は基準日からの相対で架空の日付を作る（デモの筋書きそのもの）
  'lib/fixtures/',
];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('FIXTURE_TODAY の直接参照', () => {
  it('clock.ts・config.ts・Fixture 以外は FIXTURE_TODAY を import しない', () => {
    const offenders = listSourceFiles(SRC)
      .map((path) => ({ path, rel: relative(SRC, path).split(sep).join('/') }))
      .filter(({ rel }) => !ALLOWED.some((allowed) => rel === allowed || rel.startsWith(allowed)))
      .filter(({ path }) =>
        /import\s*\{[^}]*\bFIXTURE_TODAY\b[^}]*\}\s*from\s*'@\/lib\/config'/.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('期限を扱う Service は基準日を clock.ts から受け取る', () => {
    for (const file of ['lib/services/enterprise-data.ts', 'lib/services/ssbj-gap.ts']) {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text, file).toContain("from '@/lib/clock'");
      expect(text, file).not.toMatch(/\bFIXTURE_TODAY\s*\)/);
    }
  });
});
