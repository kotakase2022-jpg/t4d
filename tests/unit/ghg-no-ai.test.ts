import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 算定に AI を使わない（plan §0.2-3・CR-30。2026-10-16 の要望 ⑥）。係数の解決・換算・丸め・区分・トンキロ・
 * 照合・差異の分解はすべて決定論の規則で、算定データを AI の提供元へ送らない。
 * `src/lib/domain/ghg/**`・`src/lib/services/ghg/**` が AI の層（src/lib/ai）・OpenAI の SDK を import しないことを
 * 静的に確かめる（呼ぶ経路が無ければ送れない）。
 */

const ROOTS = ['src/lib/domain/ghg', 'src/lib/services/ghg'];
const FORBIDDEN = [
  /from\s+['"]@\/lib\/ai(\/|['"])/,
  /from\s+['"]openai['"]/,
  /require\(['"]openai['"]\)/,
  /services\/ai-assist/,
  /services\/copilot/,
];

function filesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('算定・照合は AI を使わない', () => {
  const files = ROOTS.flatMap(filesUnder);

  it('対象のファイルがある（空振りテストでないことの確認）', () => {
    expect(files.some((f) => f.replace(/\\/g, '/').endsWith('domain/ghg/calculate.ts'))).toBe(true);
    expect(files.some((f) => f.replace(/\\/g, '/').endsWith('services/ghg/calculation.ts'))).toBe(
      true,
    );
  });

  it.each(files)('%s は AI の層・OpenAI の SDK を import しない', (file) => {
    const text = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN) expect(text, String(pattern)).not.toMatch(pattern);
  });
});
