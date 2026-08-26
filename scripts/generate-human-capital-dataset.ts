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

  return `T4D 人的資本データサンプル v3（20 ファイル・人事システムの生出力）
================================================================

各国の人事・給与システムから **事前加工せずにそのまま出力した帳票** を
想定したサンプルです（20 ファイル・合計 860 行超）。
すべて架空データで、実在の企業・従業員とは関係ありません。

■ 実際の帳票が持つ「癖」をそのまま入れてあります
------------------------------------------------------------------
1. 帳票としての体裁
   ・表の前に帳票名・会社名・出力日時・抽出条件が数行（行数はファイルごとに違う）
   ・表の中に小計・合計行が明細と同じ列構成で混ざる
   ・表の後ろに ※注記・以上・レコード件数

2. 機械が吐いた列とコード
   ・STATUS / USERID / HEADCOUNT のような 2 段ヘッダー（システムキー＋表示ラベル）
   ・Worker > Job > EEO-1 Job Category のようなパス型の列名
   ・ゼロ埋めコード 0110 と、階層を埋め込んだ部門コード 100-10-01
   ・「上年同期用工总数」のような前年実績の列

3. 表記のゆれ
   ・和暦（令和8年4月1日 / R8.4.1）と西暦 8 桁（20260401）の混在
   ・セル内改行を含む自由記述（退職事由の面談記録）
   ・Shift_JIS / セミコロン区切り / 1.234,5（独）/ 1 234,5（仏）

4. バウンダリ（集計範囲）のズレ
   同じ名前の指標でも、国・拠点ごとに集計範囲が食い違います。

     雇用範囲    … 正社員のみ（日本）／ 派遣を含む（中国）／ パート含む（英国）
     管理職定義  … 課長以上（日本）／ EEO-1（米国）／ チームリーダー含む（独）
                   ／ Band 4 以上（印）／ cadres（仏）／ 主管以上（中）
     期間基準    … 年度 4 月起点（日本）／ 暦年（米・中・印）／ 基準日 4/5（英）
     算定方法    … 平均値（日本）／ 中央値（米・英）
     離職の範囲  … 自己都合のみ（日本）／ 会社都合を含む（米国）
     連結範囲    … 子会社のみ ／ 持分法適用 JV を含む（APAC）

   しかも、この宣言は **帳票の前置きブロックにしか書かれていない** ことが多く、
   明細行だけを見ても分かりません。

■ 取り込むと何が起きるか
------------------------------------------------------------------
・小計・合計行を検知し、「明細行と一緒に確定すると二重計上になります」と警告して
  既定のチェックを外します（73 行が該当）。
・前置きブロックの集計条件をファイル全体の文脈として読み、同じ指標に
  異なるバウンダリの行が混ざっていれば「バウンダリ差異（雇用範囲）: …」と警告します。
・ゼロ埋めコード 0110 を 110 人と読んだり、前年同期の列を当年値として
  取り込んだりしません（列の役割を判定してから値を取ります）。
・帳票名や「レコード件数: 312」をデータ行として並べません。

■ 使い方
------------------------------------------------------------------
1. TERRAST for Disclosure（https://terrast-t4d.vercel.app ）にデモログイン
2. 左メニューの「データ収集」を開く
3. この zip を展開したフォルダのファイルを **全選択してそのままドロップ**
4. プレビューで、指標の自動仕分け・集計行の警告・バウンダリ差異の警告を確認

■ 含まれる多様性
------------------------------------------------------------------
国・地域  : 日本 / 米国 / 英国 / ドイツ / フランス / 中国 / インド / APAC 統括
言語      : 日本語 / 英語 / ドイツ語 / フランス語 / 中国語（簡体字）
形式      : CSV（カンマ・セミコロン区切り）/ Excel（複数シート）/ PDF
文字コード: UTF-8（BOM 付き）/ Shift_JIS
数値表記  : 1,234.5（日英）/ 1.234,5（独）/ 1 234,5（仏）
想定システム: 奉行 / PCA / COMPANY / Workday / SAP HCM / SuccessFactors / ADP / LMS

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
