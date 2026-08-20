import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * exceljs が解決する uuid が **CommonJS 互換**であることを守る。
 *
 * 経緯: `pnpm-workspace.yaml` の overrides が uuid を全体で 11 以降へ引き上げていたため、
 * CommonJS の exceljs が ESM only の uuid を `require()` できず、
 * **本番（Vercel）でのみ Excel 取込が PROCESSING_FAILED で全滅**していた。
 *
 * ローカルの Node 22+ は "require(esm)" に対応しており ESM でも require できてしまうため、
 * 実際に require して確かめる形では再現しない（＝テストにならない）。
 * そこで「解決された uuid が ESM only ではないこと」をパッケージ定義から検証する。
 * これなら overrides が再び全体へ適用された時点でローカルでも落ちる。
 */
describe('exceljs が使う uuid は CommonJS 互換であること', () => {
  const require = createRequire(import.meta.url);

  /** 実際に落ちていたファイルと同じ位置から uuid を解決する */
  function resolveUuidPackageJson(): string {
    const from = require.resolve('exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js');
    return createRequire(from).resolve('uuid/package.json');
  }

  it('uuid が ESM only（type: module かつ CJS エントリ無し）ではない', () => {
    const pkgPath = resolveUuidPackageJson();
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version: string;
      type?: string;
      main?: string;
      exports?: Record<string, unknown>;
    };

    const requireEntry = (pkg.exports?.['.'] as Record<string, unknown> | undefined)?.['require'];
    const hasCjsEntry = Boolean(pkg.main) || Boolean(requireEntry);

    expect(
      hasCjsEntry,
      `exceljs は CommonJS なので require('uuid') できる必要がある（解決された uuid@${pkg.version} は ESM only）`,
    ).toBe(true);
  });

  it('exceljs 本体と Workbook が読める', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('sheet');
    ws.addRow(['拠点', '項目', '値']);
    ws.addRow(['本社', '電力使用量', 3120.5]);
    const buffer = await wb.xlsx.writeBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});
