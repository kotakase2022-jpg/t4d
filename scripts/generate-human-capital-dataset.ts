/**
 * 人的資本データ 20 ファイルを書き出し、zip にまとめる。
 *
 *   pnpm exec tsx scripts/generate-human-capital-dataset.ts <出力先> [--zip <zipパス>]
 *
 * すべて架空データ。`scripts/human-capital-dataset.ts` が唯一の生成元。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildHumanCapitalDataset } from './human-capital-dataset';
import type { DatasetFile } from './hetero-dataset';
import { buildZip } from './zip';

function buildReadme(files: DatasetFile[]): string {
  const list = files
    .map((f, i) => {
      const kind = f.name.endsWith('.pdf') ? 'PDF' : f.name.endsWith('.xlsx') ? 'XLSX' : 'CSV';
      return `${String(i + 1).padStart(2, '0')}. [${kind}] ${f.name}`;
    })
    .join('\r\n');

  return `T4D 人的資本データサンプル v2（20 ファイル・人事システム出力想定）
================================================================

従業員 100 名以上規模の企業が、各国の人事システムからそのまま出力した
帳票を想定したサンプルです（1 ファイル 25〜100 行前後）。
すべて架空データで、実在の企業・従業員とは関係ありません。

  ・部門 × 雇用形態 × 男女の在籍マトリクス（HRIS 標準出力）
  ・月次の人員推移（勤怠システム）／ 採用・離職の明細（仮名 ID 単位）
  ・研修台帳（LMS のコース別受講記録）／ 等級別賃金 × 男女
  ・安全衛生年報 ／ エンゲージメントサーベイのベンダー出力

■ このサンプルの主眼は「バウンダリ（集計範囲）のズレ」です
------------------------------------------------------------------
人的資本は、同じ名前の指標でも国・拠点ごとに集計範囲が食い違います。

  雇用範囲    … 正社員のみ（日本）／ 派遣を含む（中国・工場月報）／ パート含む（英国）
  管理職定義  … 課長以上（日本）／ EEO-1（米国）／ チームリーダー含む（独）
                ／ Band 4 以上（印）／ cadre（仏）／ 主管以上（中）
  期間基準    … 年度 4 月起点（日本）／ 暦年（米・中・印）／ 基準日 4/5（英）
  算定方法    … 平均値（日本）／ 中央値（米・英）
  離職の範囲  … 自己都合のみ（日本）／ 会社都合を含む（米国）
  連結範囲    … 子会社のみ ／ 持分法適用 JV を含む（APAC ダッシュボード）

まとめて取り込むと、T4D が **同じ指標に異なるバウンダリの行が混在している**
ことを検知し、「バウンダリ差異（雇用範囲）: …が混在しています」と警告して
要確認へ倒します。数字だけを見て丸めないことが人的資本データでは特に重要です。

■ 使い方
------------------------------------------------------------------
1. TERRAST for Disclosure（https://terrast-t4d.vercel.app ）にデモログイン
2. 左メニューの「データ収集」を開く
3. この zip を展開したフォルダのファイルを **全選択してそのままドロップ**
4. プレビューで、指標が自動仕分けされ、バウンダリの違う行に
   「バウンダリ差異」の警告が付くことを確認してください

■ 含まれる多様性
------------------------------------------------------------------
国・地域  : 日本 / 米国 / 英国 / ドイツ / フランス / 中国 / インド / APAC 統括
言語      : 日本語 / 英語 / ドイツ語 / フランス語 / 中国語（簡体字）
形式      : CSV（カンマ・セミコロン区切り）/ Excel（.xlsx）/ PDF
文字コード: UTF-8（BOM 付き）/ Shift_JIS
数値表記  : 1,234.5（日英）/ 1.234,5（独）/ 1 234,5（仏）

■ ファイル一覧
------------------------------------------------------------------
${list}


生成元: scripts/generate-human-capital-dataset.ts（決定論的）
`.replace(/\n/g, '\r\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outDir = args[0];
  const zipIndex = args.indexOf('--zip');
  const zipPath = zipIndex >= 0 ? args[zipIndex + 1] : null;

  if (!outDir) {
    console.error(
      '使い方: pnpm exec tsx scripts/generate-human-capital-dataset.ts <出力先> [--zip <zipパス>]',
    );
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const files = await buildHumanCapitalDataset();
  for (const file of files) {
    await writeFile(join(outDir, file.name), file.bytes);
  }

  const readmeBytes = new TextEncoder().encode('﻿' + buildReadme(files));
  await writeFile(join(outDir, 'README.txt'), readmeBytes);

  console.log(`✓ ${files.length} ファイル + README.txt を ${outDir} へ書き出しました。`);

  if (zipPath) {
    const zipBytes = buildZip([
      ...files.map((f) => ({ name: f.name, bytes: f.bytes })),
      { name: 'README.txt', bytes: readmeBytes },
    ]);
    await writeFile(zipPath, zipBytes);
    console.log(
      `✓ zip を ${zipPath} へ書き出しました（${(zipBytes.length / 1024).toFixed(1)} KB）。`,
    );
  }
}

void main();
