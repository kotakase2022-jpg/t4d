/**
 * サプライヤーデータ取込のデモ用サンプルファイル（すべて架空データ）。
 *
 * 「多様なフォーマット・言語の素データが自動仕訳される」ことを見せるための 3 ファイル:
 *  1. EcoVadis 風の英語 CSV（割当排出量 = 排出量データ）
 *  2. 手計算ワークシートの日本語 CSV（前置き行・合計行・注記行付き = 排出量データ）
 *  3. 独語混じりのセミコロン区切り CSV（独式数値・物理量／金額の素データ）
 *
 * `server-only` を付けない純粋モジュール。Route Handler（ダウンロード配布）と
 * E2E テスト（生成した内容をそのままアップロード）が同じ実装を使う。
 * 生成は決定論（乱数・現在時刻を使わない）。
 */

export interface SupplierDemoFile {
  key: 'ecovadis' | 'manual' | 'activity';
  fileName: string;
  title: string;
  description: string;
  mimeType: 'text/csv';
  /** UTF-8 BOM 付き（Excel でそのまま開けるように） */
  content: string;
}

const BOM = '﻿';

/** RFC4180 で引用する（デモデータに数式は含めないが、カンマ・引用符は守る） */
function cell(value: string): string {
  return /[",\r\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csv(rows: string[][], separator: ',' | ';' = ','): string {
  return BOM + rows.map((row) => row.map(cell).join(separator)).join('\r\n') + '\r\n';
}

export function buildSupplierDemoFiles(): SupplierDemoFile[] {
  return [
    {
      key: 'ecovadis',
      fileName: 'ecovadis_carbon_export_fy2026.csv',
      title: 'EcoVadis 風出力（英語）',
      description:
        '評価プラットフォームからの割当排出量エクスポートを模した英語 CSV。排出量データとして自動仕訳されます。',
      mimeType: 'text/csv',
      content: csv([
        [
          'Supplier code',
          'Company name',
          'Country',
          'Assessment date',
          'Scope 3 Cat.1 allocated emissions (tCO2e)',
          'Carbon score',
        ],
        ['SUP-16', 'Verte Logistique SA', 'France', '2026-11-30', '8.4', '62'],
        ['SUP-17', 'Pine Ridge Components Inc.', 'United States', '2026-11-30', '11.2', '55'],
        ['SUP-21', 'Nordlicht Chemie GmbH', 'Germany', '2026-11-30', '9.1', '71'],
        ['SUP-25', 'Silverbirch Materials Ltd.', 'United Kingdom', '2026-11-30', '5.6', '48'],
      ]),
    },
    {
      key: 'manual',
      fileName: 'サプライヤー排出量_手計算_FY2026.csv',
      title: '手計算ワークシート（日本語）',
      description:
        '帳票名などの前置き行・合計行・注記行を含む手計算シート。明細だけが排出量データとして取り込まれます。',
      mimeType: 'text/csv',
      content: csv([
        ['サプライヤー排出量 手計算ワークシート（調達部）'],
        ['作成日: 2027-04-05 ／ 対象期間: FY2026'],
        ['サプライヤーコード', '品目', '排出量(t-CO2e)', '算定方法', '備考'],
        ['SUP-18', '印刷物', '3.2', '燃料法', 'ヒアリングシート回収済み'],
        ['SUP-19', '金型', '6.9', '電力按分', '2027-03 検針分まで'],
        ['SUP-20', '電子材料', '7.4', 'サプライヤー報告', '一次データ'],
        ['SUP-22', 'ばね部品', '2.8', '金額按分の手計算', '概算'],
        ['合計', '', '20.3', '', ''],
        ['※ 手計算のため確定時に再確認してください', '', '', '', ''],
      ]),
    },
    {
      key: 'activity',
      fileName: 'lieferanten_rohdaten_gj2026.csv',
      title: '素データ（独式・セミコロン区切り）',
      description:
        '物理量（kWh・m3・L・kg）と金額の素データが混在する独式 CSV（1.234,5 形式）。単位から原単位を自動解決し、候補が複数の行は紐づけ待ちになります。',
      mimeType: 'text/csv',
      content: csv(
        [
          ['Supplier code', 'Position', 'Menge', 'Einheit', 'Betrag (JPY k)', 'Zeitraum'],
          ['SUP-23', 'Dieselkraftstoff Transport', '3.120,0', 'L', '', 'GJ2026'],
          ['SUP-27', 'Strombezug Werk 2', '28.400,0', 'kWh', '', 'GJ2026'],
          ['SUP-28', 'Erdgas Prozesswaerme', '2.150,5', 'm3', '', 'GJ2026'],
          ['SUP-24', 'Verpackung Karton', '1.480,0', 'kg', '', 'GJ2026'],
          ['SUP-29', 'Elektronikmaterial Beschaffung', '', '', '5.200,0', 'GJ2026'],
        ],
        ';',
      ),
    },
  ];
}
