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
      const kind = f.name.endsWith('.pdf') ? 'PDF' : 'CSV';
      return `${String(i + 1).padStart(2, '0')}. [${kind}] ${f.name}`;
    })
    .join('\r\n');

  return `T4D 人的資本データサンプル（20 ファイル）
==========================================

事業所・国・言語・様式・ファイル形式がばらばらな人的資本データの
サンプルです。すべて架空データで、実在の企業・従業員とは関係ありません。


■ このサンプルの主眼は「定義のズレ」です
------------------------------------------------------------------
人的資本は、環境データと違い **同じ名前の指標でも国ごとに算定基準が違います**。
たとえば「女性管理職比率」の分母は:

  日本      … 課長相当職以上
  米国      … EEO-1 の Officials and Managers（First/Mid Level）
  英国      … Grade 6 以上／賃金分布の上位四分位
  ドイツ    … 全 Führungsebene（チームリーダーを含む）
  フランス  … cadre ステータス（労働協約上の区分）
  インド    … 社内等級 Band 4 以上
  中国      … 主管以上
  ブラジル  … Coordenacao 以上

数字だけを見て同じ指標へ丸めると、比較できない値が混ざります。
このサンプルでは各ファイルに定義の但し書きを入れており、
取り込むと AI が **「定義が自社基準と異なる可能性があります」と警告し、
確信度を下げて「要確認」に倒す**ことを確認できます。
勝手に確定しないことが、人的資本データでは特に重要です。

同じ考え方で、次のような定義差も含めています。

  ・離職率        … 自己都合のみ ／ 会社都合を含む
  ・男女賃金格差  … 平均値ベース ／ 中央値ベース ／ 職位調整後 ／ 未調整
  ・従業員数      … 期末時点 ／ 期中平均 ／ FTE（常勤換算）／ パート含む
  ・平均勤続年数  … 期末時点 ／ 年度平均


■ 使い方
------------------------------------------------------------------
1. TERRAST for Disclosure（https://terrast-t4d.vercel.app ）にデモログイン
2. 左メニューの「データ収集」を開く
3. この zip を展開したフォルダのファイルを **全選択してそのままドロップ**
4. プレビューで、指標・拠点が自動で割り当てられ、
   定義がズレている行に警告が付くことを確認してください


■ 含まれる多様性
------------------------------------------------------------------
国・地域  : 日本 / 米国 / 英国 / ドイツ / フランス / 中国 / インド / ブラジル
言語      : 日本語 / 英語 / ドイツ語 / フランス語 / 中国語（簡体字）/ ポルトガル語
形式      : CSV（カンマ区切り・セミコロン区切り）/ PDF
文字コード: UTF-8（BOM 付き）/ Shift_JIS
数値表記  : 1,234.5（日英）/ 1.234,5（独）/ 1 234,5（仏）
単位の揺れ: 人 / FTE / Personen / personnes / Nos. / pessoas / 時間 / 小時 / heures / 年 / ans
列名の揺れ: 拠点・事業所・Site・Standort・站点・Unidade ／ 項目・Kennzahl・Indicateur・指标

対象指標  : 従業員数 / 女性従業員数 / 管理職数 / 女性管理職数 / 女性管理職比率 /
            新規採用者数 / 離職率 / 平均勤続年数 / 一人あたり研修時間 /
            労働災害度数率（LTIFR）/ 男女賃金格差


■ 文字化けについて
------------------------------------------------------------------
・UTF-8 のテキストは **すべて BOM 付き**です。Excel でそのまま開いても化けません。
・HC02 のみ Shift_JIS です（古い人事システムからの出力を想定）。
・PDF は Latin 文字で作成しています（日本語 PDF は文字埋め込みが必要なため）。


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
