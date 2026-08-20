/**
 * RLS 静的チェック（CI ガード）。
 *
 *   pnpm check:rls
 *
 * `pnpm test:rls` が「実際に遮断できること」を検証するのに対し、
 * 本スクリプトは「RLS を有効化し忘れたテーブル」「RLS を無効化する記述」を
 * マイグレーション SQL から機械的に検出する。
 *
 * 指示書 11 章「RLS を無効化した暫定実装を残さないでください」への対応。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase', 'migrations');

/** RLS 不要なテーブル（存在しない。将来追加する場合はここへ理由付きで列挙する）。 */
const RLS_EXEMPT: ReadonlySet<string> = new Set();

async function readAllMigrations(): Promise<string> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const contents = await Promise.all(
    files.map((f) => readFile(path.join(MIGRATIONS_DIR, f), 'utf8')),
  );
  return contents.join('\n');
}

function findCreatedTables(sql: string): string[] {
  const out: string[] = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const name = raw.replace(/"/g, '');
    // 他スキーマ（auth / storage）のテーブルは対象外
    if (name.includes('.')) continue;
    out.push(name);
  }
  return out;
}

function findRlsEnabled(sql: string): Set<string> {
  const out = new Set<string>();
  const re = /alter\s+table\s+([a-z0-9_."]+)\s+enable\s+row\s+level\s+security/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const raw = match[1];
    if (raw) out.add(raw.replace(/"/g, ''));
  }
  return out;
}

function findPolicies(sql: string): Map<string, number> {
  const counts = new Map<string, number>();
  const re = /create\s+policy\s+"?[a-z0-9_]+"?\s+on\s+([a-z0-9_."]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const name = raw.replace(/"/g, '');
    if (name.includes('.')) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

async function main() {
  const sql = await readAllMigrations();
  const problems: string[] = [];

  // 1. RLS を無効化する記述がないこと
  const disableRe = /disable\s+row\s+level\s+security/gi;
  if (disableRe.test(sql)) {
    problems.push('`DISABLE ROW LEVEL SECURITY` が含まれています。RLS を無効化してはいけません。');
  }

  // 2. すべての public テーブルで RLS が有効になっていること
  const tables = findCreatedTables(sql);
  const enabled = findRlsEnabled(sql);
  const policies = findPolicies(sql);

  for (const table of tables) {
    if (RLS_EXEMPT.has(table)) continue;
    if (!enabled.has(table)) {
      problems.push(`テーブル ${table} で RLS が有効化されていません。`);
      continue;
    }
    if (!policies.has(table)) {
      problems.push(
        `テーブル ${table} に RLS ポリシーが 1 件もありません（全アクセス不可になります）。`,
      );
    }
  }

  // 3. Evidence Bucket が public になっていないこと
  if (
    /insert\s+into\s+storage\.buckets[\s\S]*?\('evidence-private',\s*'evidence-private',\s*true\)/i.test(
      sql,
    )
  ) {
    problems.push('evidence-private バケットが public になっています。');
  }

  console.log(`検査対象テーブル: ${tables.length} 件 / RLS 有効: ${enabled.size} 件`);
  console.log(`ポリシー定義: ${[...policies.values()].reduce((a, b) => a + b, 0)} 件`);

  if (problems.length > 0) {
    console.error('\n✗ RLS 静的チェックに失敗しました:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log('\n✓ RLS 静的チェックに合格しました。');
}

main().catch((error) => {
  console.error('check-rls に失敗しました:', error);
  process.exit(1);
});
