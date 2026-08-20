/**
 * 異種データ 50 ファイルを書き出し、zip にまとめる（機能追加要望 ①の納品物）。
 *
 *   pnpm exec tsx scripts/generate-heterogeneous-dataset.ts <出力先ディレクトリ> [--zip <出力先zip>]
 *
 * すべて架空データ。`scripts/hetero-dataset.ts` が唯一の生成元
 * （integration / E2E テストと同一のファイル群になる）。
 *
 * zip は JSZip で作る。JSZip は各エントリに UTF-8 フラグ（general purpose bit 11）を立てるため、
 * 日本語・中国語のファイル名が Windows / macOS のどちらで展開しても化けない。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildHeterogeneousDataset, type DatasetFile } from './hetero-dataset';
import { buildZip } from './zip';

/** 納品物に同梱する説明。UTF-8 BOM 付きで書き、メモ帳でも化けないようにする。 */
function buildReadme(files: DatasetFile[]): string {
  const list = files
    .map((f, i) => {
      const kind = f.name.endsWith('.pdf')
        ? 'PDF'
        : f.name.endsWith('.xlsx')
          ? 'Excel'
          : f.name.endsWith('.tsv')
            ? 'TSV'
            : 'CSV';
      return `${String(i + 1).padStart(2, '0')}. [${kind}] ${f.name}`;
    })
    .join('\r\n');

  return `T4D 異種データサンプル（50 ファイル）
========================================

拠点・部門・カテゴリごとにフォーマット・言語・文字コードが全く異なるデータ群を
再現したサンプルです。すべて架空データで、実在の企業・取引先とは関係ありません。


■ 何を試すためのものか
------------------------------------------------------------------
現場から集まる非財務データは、拠点ごと・部門ごとに書式がばらばらです。
通常はシステムへ取り込む前に「列を揃える」「単位を統一する」「文字コードを直す」
といった事前加工が必要になり、ここが最大の手間になります。

このサンプルは、その事前加工を **一切せずに** そのまま投入して、
AI がどこまで自動で仕分けできるかを確かめるためのものです。


■ 使い方
------------------------------------------------------------------
1. TERRAST for Disclosure（https://terrast-t4d.vercel.app ）にデモログイン
2. 左メニューの「データ収集」を開く
3. この zip を展開したフォルダのファイルを **全選択してそのままドロップ**
4. 取込ジョブが自動で解析し、プレビューに仕分け結果が並びます

判断に迷った行だけが「要確認」として残ります。取込を確定すると、その対応が
学習され（事前学習）、次回から同じ書式のファイルはより高い確信度で仕分けられます。


■ 含まれる多様性
------------------------------------------------------------------
言語      : 日本語 / 英語 / ドイツ語 / フランス語 / 中国語（簡体字）
形式      : CSV（カンマ区切り・セミコロン区切り）/ TSV / Excel（単一・複数シート）/ PDF
文字コード: UTF-8（BOM 付き）/ Shift_JIS
数値表記  : 1,234.5（日英）/ 1.234,5（独）/ 1 234,5（仏）/ 全角数字
レイアウト: 標準形 / 前文つき / タイトル行つき / 月別列 / 転置 / ゴミ行混在 / 合計行つき
単位の揺れ: t-CO2e / kg-CO2e / MWh / kWh / m3 / GJ / 千m3 / 人 / FTE
列名の揺れ: 拠点・場所・Site・Standort・站点 ／ 項目・データ種別・Kennzahl・指标 など


■ 意図的に「そのままでは確定できない」ファイル
------------------------------------------------------------------
すべてが自動で通るわけではありません。次のものは AI が確信を持てず、
「要確認」として人の判断を待ちます（勝手に確定しないことの確認用です）。

・38_サプライヤーA_kgCO2e.csv  … 単位が kg-CO2e（指標定義は t-CO2e）
・39_設備課_kWh表記.csv        … 単位が kWh（指標定義は MWh）
・40_全角数字.csv              … 数値・単位・期間がすべて全角
・41_列名が不明瞭.csv          … 「電気」「水」「ごみ」など列名から指標を断定できない
・42_混在_ゴミ行あり.csv       … メモ行・区切り線・合計行が混在
・43_調達部_supplier_report.csv … "2.845" が 2.845 か 2,845 か判別できない
・36 / 37 の転置レイアウト      … 指標が行、拠点が列に並ぶ


■ 文字化けについて
------------------------------------------------------------------
・UTF-8 のテキストファイルは **すべて BOM 付き**です。Excel でそのまま開いても
  日本語が化けません。
・Shift_JIS のファイル（06〜08）は、現場の古い基幹システムからの出力を想定した
  ものです。ファイル名に SJIS と入れています。Excel はそのまま開けます。
  テキストエディタで開く場合のみ、文字コードに Shift_JIS を指定してください。
・PDF（46〜50）は Latin 文字（英語・ドイツ語）で作成しています。海外拠点・
  サプライヤーからの請求書を想定しています。


■ ファイル一覧
------------------------------------------------------------------
${list}


生成元: scripts/generate-heterogeneous-dataset.ts（決定論的。何度実行しても同一内容）
`.replace(/\n/g, '\r\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outDir = args[0];
  const zipIndex = args.indexOf('--zip');
  const zipPath = zipIndex >= 0 ? args[zipIndex + 1] : null;

  if (!outDir) {
    console.error(
      '使い方: pnpm exec tsx scripts/generate-heterogeneous-dataset.ts <出力先> [--zip <zipパス>]',
    );
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const files = await buildHeterogeneousDataset();
  for (const file of files) {
    await writeFile(join(outDir, file.name), file.bytes);
  }

  const readme = buildReadme(files);
  const readmeBytes = new TextEncoder().encode('﻿' + readme);
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
