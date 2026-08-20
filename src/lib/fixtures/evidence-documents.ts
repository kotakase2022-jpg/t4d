/**
 * Evidence の紙面（Fragment テキスト）を書類らしく組み立てる。
 *
 * Demo Mode の Fixture ファイルは実体（PDF/Excel のバイト列）を持たない。
 * 画面で見えるのは取込時に抽出した Fragment だけなので、そこが
 * 「1 ページ目。合計値および明細が記載されています」のような一文だと、
 * Evidence Viewer が実運用の見た目にならない。
 *
 * ここでは書類種別ごとに、発行者・番号・明細・合計まで含む**紙面のテキスト**を
 * 決定論的に組み立てる。値は架空だが、集計に使う代表値（電力量・排出量など）は
 * Fixture の Data Point と桁を揃えてあるので、突合の説明ができる。
 */

export interface EvidenceDocumentLine {
  /** 見出し / 明細 / 合計 / 注記。画面はこれで字面を変える */
  kind: 'title' | 'meta' | 'header' | 'row' | 'total' | 'note';
  text: string;
}

const YEN = (n: number) => `${n.toLocaleString('ja-JP')} 円`;

/** 期間ごとの係数（FY2025 と FY2026 で数字を変える） */
function factor(periodCode: string): number {
  return periodCode === 'FY2025' ? 1 : 0.94;
}

function powerInvoice(periodCode: string, page: number): EvidenceDocumentLine[] {
  const f = factor(periodCode);
  const kwh = Math.round(3_120_500 * f);
  const basic = 1_284_000;
  const usageCharge = Math.round(kwh * 24.6);
  const renewLevy = Math.round(kwh * 3.49);
  const total = basic + usageCharge + renewLevy;

  if (page === 1) {
    return [
      { kind: 'title', text: '電気ご使用量のお知らせ（電力需給契約に基づく請求書）' },
      { kind: 'meta', text: '発行: 中央電力株式会社 法人営業部' },
      { kind: 'meta', text: `請求番号: DENKI-${periodCode}-004128 ／ 発行日: 2027-04-10` },
      { kind: 'meta', text: '需要場所: 青海テクノロジー株式会社 本社ビル（東京都港区）' },
      { kind: 'meta', text: '契約種別: 高圧電力 A ／ 契約電力: 480 kW' },
      { kind: 'meta', text: `検針期間: ${periodCode} 通年（2026-04-01 〜 2027-03-31）` },
      { kind: 'header', text: '項目                          数量           単価         金額' },
      {
        kind: 'row',
        text: `基本料金                      480 kW         2,675.00     ${YEN(basic)}`,
      },
      {
        kind: 'row',
        text: `電力量料金（昼間）            ${kwh.toLocaleString('ja-JP')} kWh    24.60        ${YEN(usageCharge)}`,
      },
      {
        kind: 'row',
        text: `再エネ賦課金                  ${kwh.toLocaleString('ja-JP')} kWh     3.49        ${YEN(renewLevy)}`,
      },
      { kind: 'total', text: `合計使用電力量: ${kwh.toLocaleString('ja-JP')} kWh` },
      { kind: 'total', text: `ご請求金額（税込）: ${YEN(total)}` },
      {
        kind: 'note',
        text: '※ 本書は架空のサンプルです。実在の電力会社・契約とは関係ありません。',
      },
    ];
  }
  return [
    { kind: 'title', text: '月別ご使用量明細（2 ページ目）' },
    { kind: 'header', text: '検針月        使用電力量(kWh)    最大需要電力(kW)   力率' },
    ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map((m, i) => {
      const monthly = Math.round((kwh / 12) * (1 + Math.sin((i / 12) * Math.PI * 2) * 0.16));
      return {
        kind: 'row' as const,
        text: `${m >= 4 ? 2026 : 2027}年${String(m).padStart(2, ' ')}月     ${monthly.toLocaleString('ja-JP').padStart(11)}        ${(420 + (i % 5) * 12).toString().padStart(6)}      ${(96 + (i % 3)).toString()}%`,
      };
    }),
    { kind: 'total', text: `年間合計: ${kwh.toLocaleString('ja-JP')} kWh` },
    { kind: 'note', text: '※ CO2 排出係数 0.000434 t-CO2e/kWh（2026 年度・全国平均）' },
  ];
}

function fuelLog(periodCode: string, page: number): EvidenceDocumentLine[] {
  const f = factor(periodCode);
  const kl = Math.round(482.6 * f * 10) / 10;
  if (page === 1) {
    return [
      { kind: 'title', text: '燃料使用記録票（自家発電設備・社用車）' },
      { kind: 'meta', text: '作成: 設備管理課 ／ 承認: 工場長' },
      { kind: 'meta', text: `対象期間: ${periodCode}（2026-04-01 〜 2027-03-31）` },
      { kind: 'meta', text: '対象設備: 非常用発電機 2 基、ボイラー 3 基、社用車 24 台' },
      {
        kind: 'header',
        text: '燃料種別        使用量        単位     排出係数      排出量(t-CO2e)',
      },
      {
        kind: 'row',
        text: `A 重油          ${(kl * 0.62).toFixed(1).padStart(8)}      kL       2.710         ${(kl * 0.62 * 2.71).toFixed(1)}`,
      },
      {
        kind: 'row',
        text: `軽油            ${(kl * 0.24).toFixed(1).padStart(8)}      kL       2.585         ${(kl * 0.24 * 2.585).toFixed(1)}`,
      },
      {
        kind: 'row',
        text: `ガソリン        ${(kl * 0.14).toFixed(1).padStart(8)}      kL       2.322         ${(kl * 0.14 * 2.322).toFixed(1)}`,
      },
      { kind: 'total', text: `合計燃料使用量: ${kl.toFixed(1)} kL` },
      {
        kind: 'total',
        text: `Scope1 排出量（燃料由来）: ${(kl * 0.62 * 2.71 + kl * 0.24 * 2.585 + kl * 0.14 * 2.322).toFixed(1)} t-CO2e`,
      },
      {
        kind: 'note',
        text: '※ 排出係数は環境省「温室効果ガス排出量算定・報告・公表制度」準拠（架空値）',
      },
    ];
  }
  return [
    { kind: 'title', text: '給油記録（抜粋・2 ページ目）' },
    { kind: 'header', text: '日付          設備/車両        燃料      給油量(L)     記録者' },
    ...Array.from({ length: 10 }, (_, i) => ({
      kind: 'row' as const,
      text: `2026-${String(4 + (i % 9)).padStart(2, '0')}-${String(3 + i * 2).padStart(2, '0')}    ${i % 3 === 0 ? 'ボイラー1号' : i % 3 === 1 ? '発電機A' : `社用車 ${100 + i}`}      ${i % 3 === 2 ? 'ガソリン' : 'A重油  '}   ${(1200 + i * 137).toLocaleString('ja-JP').padStart(9)}     設備管理課`,
    })),
    { kind: 'note', text: '※ 全 248 件のうち先頭 10 件を表示（架空データ）' },
  ];
}

function wasteManifest(periodCode: string): EvidenceDocumentLine[] {
  const f = factor(periodCode);
  return [
    { kind: 'title', text: '産業廃棄物管理票（電子マニフェスト）交付等状況報告書' },
    { kind: 'meta', text: `交付番号: MF-${periodCode}-E-0412 ／ 報告年度: ${periodCode}` },
    { kind: 'meta', text: '排出事業者: 青海テクノロジー株式会社 東日本工場' },
    { kind: 'meta', text: '収集運搬業者: 東部環境サービス株式会社（許可番号 1182-A）' },
    { kind: 'meta', text: '処分業者: 東部リサイクルセンター（許可番号 2204-B）' },
    { kind: 'header', text: '廃棄物の種類            数量(t)     処理方法        処分場所' },
    {
      kind: 'row',
      text: `廃プラスチック類     ${(382.4 * f).toFixed(1).padStart(9)}     再生利用        東部RC 第2工場`,
    },
    {
      kind: 'row',
      text: `金属くず             ${(246.8 * f).toFixed(1).padStart(9)}     再生利用        東部RC 第1工場`,
    },
    {
      kind: 'row',
      text: `汚泥                 ${(124.2 * f).toFixed(1).padStart(9)}     中間処理(脱水)  東部RC 第3工場`,
    },
    {
      kind: 'row',
      text: `木くず               ${(89.6 * f).toFixed(1).padStart(9)}     再生利用        東部RC 第2工場`,
    },
    {
      kind: 'row',
      text: `廃油                 ${(41.2 * f).toFixed(1).padStart(9)}     中間処理(焼却)  東部RC 焼却施設`,
    },
    {
      kind: 'row',
      text: `その他産業廃棄物     ${(186.2 * f).toFixed(1).padStart(9)}     埋立            東部最終処分場`,
    },
    { kind: 'total', text: `合計排出量: ${(1070.4 * f).toFixed(1)} t` },
    { kind: 'total', text: `再生利用量: ${(842.1 * f).toFixed(1)} t（再生利用率 78.7%）` },
    {
      kind: 'note',
      text: '※ 本書は架空のサンプルです。実在の許可番号・事業者とは関係ありません。',
    },
  ];
}

function purchaseLedger(periodCode: string): EvidenceDocumentLine[] {
  const f = factor(periodCode);
  return [
    { kind: 'title', text: '購買実績台帳（Scope3 カテゴリ 1 算定用）' },
    { kind: 'meta', text: '作成: 調達部 ／ 出力日: 2027-04-15 ／ 出力システム: 購買管理システム' },
    { kind: 'meta', text: `対象期間: ${periodCode}` },
    {
      kind: 'header',
      text: '仕入先            品目区分          購買金額(千円)   排出係数   排出量(t-CO2e)',
    },
    ...[
      ['常盤精密工業', '精密加工部品', 42800, 0.00042],
      ['橙陽ケミカル', '樹脂・接着剤', 18600, 0.00081],
      ['白樺物流', '国内輸送', 9400, 0.00037],
      ['みなと包装資材', '包装資材', 6200, 0.00056],
      ['アルプス電子部品', '電子部品', 31500, 0.00042],
    ].map(([supplier, item, amount, ef]) => ({
      kind: 'row' as const,
      text: `${String(supplier).padEnd(16, '　')}${String(item).padEnd(14, '　')}${Math.round(
        Number(amount) * f,
      )
        .toLocaleString('ja-JP')
        .padStart(12)}   ${ef}    ${(Number(amount) * f * Number(ef)).toFixed(1).padStart(8)}`,
    })),
    { kind: 'total', text: `購買金額合計: ${Math.round(108500 * f).toLocaleString('ja-JP')} 千円` },
    { kind: 'total', text: `Scope3 Cat.1 排出量: ${(53.3 * f).toFixed(1)} t-CO2e（上位 5 社分）` },
    { kind: 'note', text: '※ うち グループ内取引 2,490.5 t-CO2e は連結時に控除対象（内部取引）' },
  ];
}

function hrData(periodCode: string): EvidenceDocumentLine[] {
  const f = periodCode === 'FY2025' ? 1 : 1.04;
  return [
    { kind: 'title', text: '人員構成表（人事システム出力）' },
    { kind: 'meta', text: '作成: 人事部 人事企画課 ／ 出力日: 2027-04-05' },
    { kind: 'meta', text: `基準日: ${periodCode === 'FY2025' ? '2026-03-31' : '2027-03-31'}` },
    { kind: 'meta', text: '定義: 管理職は課長相当職以上。従業員数は正社員（出向者を除く）' },
    { kind: 'header', text: '区分            男性      女性      合計      構成比' },
    {
      kind: 'row',
      text: `一般職        ${Math.round(212 * f)
        .toString()
        .padStart(6)}    ${Math.round(142 * f)
        .toString()
        .padStart(6)}    ${Math.round(354 * f)
        .toString()
        .padStart(6)}     73.8%`,
    },
    {
      kind: 'row',
      text: `管理職        ${Math.round(103 * f)
        .toString()
        .padStart(6)}    ${Math.round(23 * f)
        .toString()
        .padStart(6)}    ${Math.round(126 * f)
        .toString()
        .padStart(6)}     26.2%`,
    },
    {
      kind: 'total',
      text: `合計          ${Math.round(315 * f)
        .toString()
        .padStart(6)}    ${Math.round(165 * f)
        .toString()
        .padStart(6)}    ${Math.round(480 * f)
        .toString()
        .padStart(6)}    100.0%`,
    },
    {
      kind: 'total',
      text: `女性管理職比率: ${((23 / 126) * 100).toFixed(1)}%（分母: 課長相当職以上）`,
    },
    {
      kind: 'note',
      text: '※ 国により管理職の定義が異なるため、グループ連結時は定義の読み替えが必要',
    },
  ];
}

/** ファイル種別・期間・ページから紙面を組み立てる */
export function buildEvidenceDocument(
  fileKey: string,
  periodCode: string,
  page: number,
): EvidenceDocumentLine[] {
  switch (fileKey) {
    case 'power-invoice':
      return powerInvoice(periodCode, page);
    case 'fuel-log':
      return fuelLog(periodCode, page);
    case 'waste-manifest':
      return wasteManifest(periodCode);
    case 'purchase-ledger':
      return purchaseLedger(periodCode);
    case 'hr-data':
      return hrData(periodCode);
    default:
      return [
        { kind: 'title', text: '添付資料' },
        { kind: 'meta', text: `対象期間: ${periodCode} ／ ${page} ページ目` },
        { kind: 'note', text: '※ 架空のサンプルです。' },
      ];
  }
}

/** Fragment に保存する 1 本のテキスト（改行区切り）。画面側で行に分けて紙面表示する */
export function buildEvidenceText(fileKey: string, periodCode: string, page: number): string {
  return buildEvidenceDocument(fileKey, periodCode, page)
    .map((l) => l.text)
    .join('\n');
}
