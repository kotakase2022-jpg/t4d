/**
 * 村田製作所向けデモ: Scope3 Cat.1 架空購買データ 20 ファイルの書き出し。
 *
 *   pnpm exec tsx scripts/generate-murata-dataset.ts
 *
 * 生成物:
 *   demo-data/murata-scope3-category1/upload/     … 投入用の 20 ファイルのみ（README 等は置かない）
 *   demo-data/murata-scope3-category1/reference/  … manifest・正解データ・デモ係数・デモ為替
 *   public/demo/murata-scope3-cat1-upload.zip     … 投入用 ZIP（20 ファイルのみ）
 *   public/demo/murata-scope3-cat1-full.zip       … 一式 ZIP（upload + reference + 手順書）
 *
 * すべて決定論（何度実行しても同一内容。ZIP のタイムスタンプも固定）。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MURATA_DEMO_FACTORS,
  MURATA_DEMO_FX_RATES,
  buildMurataExpectedRows,
  buildMurataExpectedTotals,
  buildMurataFileSpecs,
  buildMurataFiles,
} from './murata-dataset';
import { csv, utf8Bom } from './hetero-dataset';
import { buildZip, type ZipEntry } from './zip';

// リポジトリルートから `pnpm exec tsx scripts/...` で実行する前提
const ROOT = process.cwd();
const OUT_ROOT = join(ROOT, 'demo-data', 'murata-scope3-category1');
const UPLOAD_DIR = join(OUT_ROOT, 'upload');
const REFERENCE_DIR = join(OUT_ROOT, 'reference');
const PUBLIC_DEMO_DIR = join(ROOT, 'public', 'demo');
const DOCS_PATH = join(ROOT, 'docs', 'murata-scope3-demo.md');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main(): Promise<void> {
  const specs = buildMurataFileSpecs();
  const files = await buildMurataFiles(specs);
  const expectedRows = buildMurataExpectedRows(specs);
  const totals = buildMurataExpectedTotals(specs);

  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(REFERENCE_DIR, { recursive: true });
  await mkdir(PUBLIC_DEMO_DIR, { recursive: true });

  // 1) 投入用の 20 ファイル（このフォルダには他のファイルを置かない）
  for (const file of files) {
    await writeFile(join(UPLOAD_DIR, file.name), file.bytes);
  }

  // 2) manifest（ファイル名・ハッシュ・形式・言語・サプライヤー・明細数・期間・算定方式・デモ識別）
  const manifest = {
    dataset: 'murata-scope3-category1',
    generatedBy: 'scripts/generate-murata-dataset.ts（決定論・再実行で同一内容）',
    notice:
      'すべて架空のデモデータです。実在のサプライヤー・実測データ・第三者検証済みデータではありません。' +
      '係数（DEMO-EF-*）は架空の説明用係数で、実算定には使用できません。',
    period: '2025-04-01〜2026-03-31（架空年度）',
    fileCount: files.length,
    detailRowTotal: expectedRows.length,
    detailRowDefinition:
      '明細行 = 取込対象行（合計行・注記行・前置き行を除く）。各ファイル 12 行 × 20 ファイル = 240 行。',
    expectedGrandTotalTco2e: totals.grandTotal,
    files: files.map((file) => {
      const spec = file.spec;
      const perFile = totals.perFile.find((t) => t.fileName === file.name);
      return {
        fileName: file.name,
        sha256: sha256(file.bytes),
        format: spec.format.toUpperCase(),
        encoding:
          spec.format === 'csv' ? (spec.encoding === 'sjis' ? 'Shift_JIS' : 'UTF-8 BOM') : '—',
        language: spec.language,
        supplierCode: spec.supplierCode,
        supplierName: spec.supplierName,
        supplierCountry: spec.supplierCountry,
        detailRows: spec.rows.length,
        method: spec.method,
        expectedTotalTco2e: perFile?.total ?? null,
        specialRows: spec.rows
          .filter((r) => r.expectedResolution !== 'file')
          .map((r) => ({
            item: r.item,
            resolution: r.expectedResolution,
            expectedFactorCode: r.expectedFactorCode,
          })),
      };
    }),
  };
  await writeFile(
    join(REFERENCE_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  // 3) 正解データ（アプリ出力のコピーではなく、scripts/murata-dataset.ts 内の独立計算）
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const expectedCsv = csv([
    [
      'ファイル名',
      'サプライヤーコード',
      '品目',
      'データ種別',
      '正規化活動量',
      '正規化単位',
      '係数コード',
      '係数の決まり方',
      '期待排出量(t-CO2e)',
    ],
    ...expectedRows.map((row) => [
      row.fileName,
      row.supplierCode,
      row.item,
      row.dataType === 'monetary' ? '金額' : '物理量',
      round6(row.normalizedAmount),
      row.normalizedUnit,
      row.factorCode,
      row.resolution === 'file'
        ? '係数コード記載'
        : row.resolution === 'auto'
          ? '品目・単位から一意'
          : row.resolution === 'recommended'
            ? '推薦候補（初期選択のまま確定）'
            : '人が候補から選択（EF-PUR-PACK を選ぶ想定）',
      row.emissions,
    ]),
    [],
    ['# ファイル別合計（t-CO2e）'],
    ...totals.perFile.map((t) => [t.fileName, t.supplierCode, '', '', '', '', '', '合計', t.total]),
    ['# 20 ファイル合計', '', '', '', '', '', '', '', totals.grandTotal],
    [
      '# 注記: アプリの「一次データ合計」は既存デモの提出済み 13 社（143.1 t-CO2e）を含むため、投入後は 143.1 + 上記合計になる',
    ],
  ]);
  await writeFile(join(REFERENCE_DIR, 'expected-results.csv'), utf8Bom(expectedCsv));
  await writeFile(
    join(REFERENCE_DIR, 'expected-results.json'),
    JSON.stringify(
      {
        notice: '独立計算による正解データ（scripts/murata-dataset.ts）。',
        rows: expectedRows,
        perFile: totals.perFile,
        grandTotal: totals.grandTotal,
        appPrimaryTotalAfterImport: Math.round((143.1 + totals.grandTotal) * 10) / 10,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // 4) デモ係数・デモ為替
  const factorsCsv = csv([
    ['係数コード', '係数値', '分母（活動量単位）', '注意'],
    ...Object.entries(MURATA_DEMO_FACTORS).map(([code, f]) => [
      code,
      f.value,
      f.activityUnit,
      '架空の説明用係数。実在DB（IDEA・ecoinvent・環境省DB等）由来ではなく、実算定には使用不可',
    ]),
  ]);
  await writeFile(join(REFERENCE_DIR, 'demo-factors.csv'), utf8Bom(factorsCsv));

  const fxCsv = csv([
    ['通貨', '円/1通貨（デモ用固定レート）', '注意'],
    ...MURATA_DEMO_FX_RATES.map((r) => [
      r.currency,
      r.jpyPerUnit,
      'デモ用の架空固定レート。実際の市場レートではない。海外サプライヤーの参考単価の説明にのみ使用',
    ]),
  ]);
  await writeFile(join(REFERENCE_DIR, 'demo-fx-rates.csv'), utf8Bom(fxCsv));

  // 5) ZIP（投入用 = 20 ファイルのみ／一式 = upload + reference + 手順書）
  const uploadEntries: ZipEntry[] = files.map((f) => ({ name: f.name, bytes: f.bytes }));
  const uploadZip = buildZip(uploadEntries, new Date('2026-09-14T00:00:00Z'));
  await writeFile(join(PUBLIC_DEMO_DIR, 'murata-scope3-cat1-upload.zip'), uploadZip);

  const fullEntries: ZipEntry[] = [
    ...files.map((f) => ({ name: `upload/${f.name}`, bytes: f.bytes })),
    {
      name: 'reference/manifest.json',
      bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n'),
    },
    { name: 'reference/expected-results.csv', bytes: utf8Bom(expectedCsv) },
    { name: 'reference/demo-factors.csv', bytes: utf8Bom(factorsCsv) },
    { name: 'reference/demo-fx-rates.csv', bytes: utf8Bom(fxCsv) },
  ];
  try {
    const docs = await readFile(DOCS_PATH);
    fullEntries.push({ name: 'docs/murata-scope3-demo.md', bytes: new Uint8Array(docs) });
  } catch {
    console.warn(
      '△ docs/murata-scope3-demo.md が未作成のため、一式 ZIP に手順書は入っていません。',
    );
  }
  // 検証結果は検証の実施後に手で書く（生成物ではない）。あれば一式 ZIP へ同梱する
  try {
    const verification = await readFile(join(REFERENCE_DIR, 'verification-results.md'));
    fullEntries.push({
      name: 'reference/verification-results.md',
      bytes: new Uint8Array(verification),
    });
  } catch {
    console.warn('△ reference/verification-results.md が未作成のため、一式 ZIP には未同梱です。');
  }
  const fullZip = buildZip(fullEntries, new Date('2026-09-14T00:00:00Z'));
  await writeFile(join(PUBLIC_DEMO_DIR, 'murata-scope3-cat1-full.zip'), fullZip);

  console.log(
    `✓ upload/ へ ${files.length} ファイルを書き出しました（明細 ${expectedRows.length} 行）。`,
  );
  console.log(`✓ reference/ へ manifest・正解・係数・為替を書き出しました。`);
  console.log(
    `✓ 期待合計 ${totals.grandTotal} t-CO2e（投入後の一次データ合計 ${Math.round((143.1 + totals.grandTotal) * 10) / 10}）。`,
  );
  console.log(
    `✓ ZIP: murata-scope3-cat1-upload.zip ${(uploadZip.length / 1024).toFixed(1)} KB / murata-scope3-cat1-full.zip ${(fullZip.length / 1024).toFixed(1)} KB`,
  );
}

void main();
