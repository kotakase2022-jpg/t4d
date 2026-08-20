/**
 * 人的資本データ 20 ファイルの生成器。
 *
 * 「あらゆる事業所・国・言語・様式・ファイル形式（CSV / PDF）」に加えて、
 * **国ごとに定義がズレている**状態を再現する。
 *
 * 人的資本は環境データと違い、同じ名前の指標でも算定基準が国・法域ごとに違う。
 * 例: 「女性管理職比率」の分母が
 *   - 日本 …… 課長相当職以上
 *   - 米国 …… EEO-1 の Officials and Managers
 *   - ドイツ … 全 Führungsebene（チームリーダーを含む）
 *   - インド … 社内等級 Band 4 以上
 * 数字だけ見て同じ指標へ丸めると、比較できない値が混ざる。
 * そこで各ファイルに定義の但し書きを入れ、AI 側（mock-provider の
 * `detectDefinitionNotes`）が「定義が自社基準と異なる可能性」を警告して
 * 確信度を下げ、**人の確認を挟む**ことを確かめられるようにしている。
 *
 * すべて架空データ。決定論的（同じ入力から必ず同じファイル）。
 */

import { buildSimplePdf, csv, encodeSjis, utf8Bom, type DatasetFile } from './hetero-dataset';

/** 1,234.5 形式 */
function fmtEn(n: number, digits = 1): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 1.234,5 形式（ドイツ語圏） */
function fmtDe(n: number, digits = 1): string {
  const [intPart, decPart] = fmtEn(n, digits).split('.');
  const grouped = (intPart ?? '').split(',').join('.');
  return decPart === undefined ? grouped : `${grouped},${decPart}`;
}

/** 1 234,5 形式（フランス語圏） */
function fmtFr(n: number, digits = 1): string {
  return fmtEn(n, digits).replace(/,/g, ' ').replace(/\./g, ',');
}

export async function buildHumanCapitalDataset(): Promise<DatasetFile[]> {
  const files: DatasetFile[] = [];

  const table = (name: string, mimeType: string, bytes: Uint8Array) =>
    files.push({ name, mimeType, bytes, kind: 'table' });
  const csvFile = (name: string, rows: (string | number)[][], sep = ',') =>
    table(name, 'text/csv', utf8Bom(csv(rows, sep)));
  const sjisFile = (name: string, rows: (string | number)[][]) =>
    table(name, 'text/csv', encodeSjis(csv(rows)));
  const pdf = (name: string, lines: string[]) =>
    files.push({ name, mimeType: 'application/pdf', bytes: buildSimplePdf(lines), kind: 'pdf' });

  // ====================================================================
  // 日本（01〜05）
  // ====================================================================

  csvFile('HC01_日本_本社_人的資本_年次.csv', [
    ['人的資本データ 年次報告'],
    ['作成: 人事部 人事企画課 ／ 対象: 2026年度（2026-04-01〜2027-03-31）'],
    ['定義: 管理職は課長相当職以上。従業員数は期末時点の正社員（出向者を除く）'],
    [],
    ['拠点', '項目', '値', '単位', '期間', '定義', '基準日'],
    ['本社', '従業員数', 480, '人', 'FY2026', '正社員・期末時点', '2027-03-31'],
    ['本社', '女性従業員数', 168, '人', 'FY2026', '正社員・期末時点', '2027-03-31'],
    ['本社', '管理職数', 126, '人', 'FY2026', '課長相当職以上', '2027-03-31'],
    ['本社', '女性管理職数', 23, '人', 'FY2026', '課長相当職以上', '2027-03-31'],
    ['本社', '女性管理職比率', 18.3, '%', 'FY2026', '課長相当職以上を分母とする', '2027-03-31'],
    ['本社', '新規採用者数', 48, '人', 'FY2026', '正社員（新卒＋中途）', ''],
    ['本社', '離職率', 6.2, '%', 'FY2026', '自己都合のみ', ''],
    ['本社', '平均勤続年数', 12.8, '年', 'FY2026', '正社員・期末時点', '2027-03-31'],
  ]);

  sjisFile('HC02_日本_東日本工場_人員構成_SJIS.csv', [
    ['事業所', '項目', '値', '単位', '期間', '備考'],
    ['東日本工場', '従業員数', 480, '人', 'FY2026', '正社員のみ'],
    ['東日本工場', '女性従業員数', 96, '人', 'FY2026', '正社員のみ'],
    ['東日本工場', '管理職数', 58, '人', 'FY2026', '課長相当職以上'],
    ['東日本工場', '女性管理職数', 7, '人', 'FY2026', '課長相当職以上'],
    ['東日本工場', '新規採用者数', 34, '人', 'FY2026', '技能職を含む'],
    ['東日本工場', '平均勤続年数', 15.2, '年', 'FY2026', ''],
    ['東日本工場', '一人あたり研修時間', 18.4, '時間', 'FY2026', '技能研修を含む'],
  ]);

  csvFile('HC03_日本_人事部_育児休業と多様性.csv', [
    ['拠点', '項目', '値', '単位', '期間', '定義・注記'],
    ['本社', '女性管理職比率', 24.6, '%', 'FY2026', '部長相当職以上を分母とした場合の参考値'],
    [
      '本社',
      '男女賃金格差',
      76.4,
      '%',
      'FY2026',
      '男性の平均賃金を100とした女性の平均賃金（平均値）',
    ],
    ['全社', '男女賃金格差', 74.1, '%', 'FY2026', '正社員のみ・平均値ベース'],
    ['全社', '男女賃金格差', 81.2, '%', 'FY2026', 'パートタイム含む・中央値ベース'],
    ['全社', '女性従業員数', 386, '人', 'FY2026', '正社員・期末時点'],
  ]);

  csvFile('HC04_日本_安全衛生_労働災害.csv', [
    ['安全衛生年報'],
    ['環境安全部 ／ 集計基準: 休業 1 日以上の労働災害'],
    [],
    ['拠点', '項目', '値', '単位', '期間', '総労働時間', '定義'],
    [
      '東日本工場',
      '労働災害度数率（LTIFR）',
      1.42,
      '件/百万時間',
      'FY2026',
      962000,
      '休業災害のみ',
    ],
    [
      '西日本工場',
      '労働災害度数率（LTIFR）',
      0.98,
      '件/百万時間',
      'FY2026',
      742000,
      '休業災害のみ',
    ],
    ['本社', '労働災害度数率（LTIFR）', 0.21, '件/百万時間', 'FY2026', 864000, '休業災害のみ'],
  ]);

  csvFile('HC05_日本_研修実績.csv', [
    ['拠点', '項目', '値', '単位', '期間', '内訳'],
    ['本社', '一人あたり研修時間', 24.6, '時間', 'FY2026', '階層別研修＋自己啓発'],
    ['東日本工場', '一人あたり研修時間', 18.4, '時間', 'FY2026', '技能研修中心'],
    ['西日本工場', '一人あたり研修時間', 16.2, '時間', 'FY2026', '技能研修中心'],
    ['全社', '一人あたり研修時間', 20.1, '時間', 'FY2026', '全社平均'],
  ]);

  // ====================================================================
  // 米国（06〜08）— EEO-1 の職種区分で「管理職」の定義が異なる
  // ====================================================================

  csvFile('HC06_US_HR_headcount.csv', [
    ['US Human Capital Report — FY2026'],
    ['Prepared by: People Operations, US Region'],
    ['Note: Manager category follows EEO-1 "Officials and Managers" classification'],
    [],
    ['Site', 'Metric', 'Value', 'Unit', 'Period', 'Definition'],
    ['US Sales Office', 'Headcount', 214, 'FTE', 'FY2026', 'Full-time equivalent, year end'],
    ['US Sales Office', 'Female employees', 96, 'FTE', 'FY2026', 'Full-time equivalent'],
    [
      'US Sales Office',
      'Managers',
      42,
      'FTE',
      'FY2026',
      'EEO-1 Officials and Managers (First/Mid Level)',
    ],
    [
      'US Sales Office',
      'Female managers',
      15,
      'FTE',
      'FY2026',
      'EEO-1 Officials and Managers (First/Mid Level)',
    ],
    [
      'US Sales Office',
      'Women in management',
      35.7,
      '%',
      'FY2026',
      'Denominator = EEO-1 Officials and Managers',
    ],
  ]);

  csvFile('HC07_US_diversity_and_turnover.csv', [
    ['Site', 'Metric', 'Value', 'Unit', 'Period', 'Definition'],
    ['US Sales Office', 'Turnover rate', 14.8, '%', 'FY2026', 'Voluntary only'],
    ['US Sales Office', 'Turnover rate', 19.2, '%', 'FY2026', 'Voluntary and involuntary combined'],
    ['US Sales Office', 'New hires', 38, 'FTE', 'FY2026', 'Including contractors converted'],
    ['US Sales Office', 'Average tenure', 4.2, 'years', 'FY2026', 'Year end'],
    ['US Warehouse', 'Turnover rate', 26.4, '%', 'FY2026', 'Voluntary only'],
  ]);

  csvFile('HC08_US_pay_equity.csv', [
    ['Site', 'Metric', 'Value', 'Unit', 'Period', 'Definition'],
    [
      'US Sales Office',
      'Gender pay ratio',
      94.2,
      '%',
      'FY2026',
      'Median, adjusted for role and level',
    ],
    ['US Sales Office', 'Gender pay ratio', 81.6, '%', 'FY2026', 'Median, unadjusted (raw)'],
    ['US Warehouse', 'Gender pay ratio', 97.1, '%', 'FY2026', 'Median, adjusted'],
  ]);

  // ====================================================================
  // 英国（09）— 法定の Gender Pay Gap 開示（mean と median の両方）
  // ====================================================================

  csvFile('HC09_UK_gender_pay_gap_report.csv', [
    ['UK Gender Pay Gap Report (statutory disclosure)'],
    ['Snapshot date: 5 April 2026 ／ Entity: UK Branch'],
    ['Note: A positive figure means men are paid more than women'],
    [],
    ['Site', 'Metric', 'Value', 'Unit', 'Period', 'Definition'],
    ['UK Branch', 'Gender pay gap', 12.4, '%', 'FY2026', 'Mean hourly pay gap'],
    ['UK Branch', 'Gender pay gap', 9.8, '%', 'FY2026', 'Median hourly pay gap'],
    ['UK Branch', 'Headcount', 128, 'FTE', 'FY2026', 'Relevant employees at snapshot date'],
    ['UK Branch', 'Female employees', 61, 'FTE', 'FY2026', 'Relevant employees at snapshot date'],
    ['UK Branch', 'Women in management', 31.2, '%', 'FY2026', 'Upper quartile of pay distribution'],
  ]);

  // ====================================================================
  // ドイツ（10〜11）— Führungskräfte は全管理層を含む／法定クオータ
  // ====================================================================

  csvFile(
    'HC10_DE_Personalbericht.csv',
    [
      ['Standort', 'Kennzahl', 'Wert', 'Einheit', 'Zeitraum', 'Definition'],
      [
        'EU Sales Office',
        'Mitarbeiterzahl',
        fmtDe(148, 0),
        'Personen',
        'GJ2026',
        'Stichtag 31.12.',
      ],
      [
        'EU Sales Office',
        'Mitarbeiterinnen',
        fmtDe(64, 0),
        'Personen',
        'GJ2026',
        'Stichtag 31.12.',
      ],
      [
        'EU Sales Office',
        'Führungskräfte',
        fmtDe(38, 0),
        'Personen',
        'GJ2026',
        'Alle Führungsebenen einschließlich Teamleiter',
      ],
      [
        'EU Sales Office',
        'Weibliche Führungskräfte',
        fmtDe(14, 0),
        'Personen',
        'GJ2026',
        'Alle Führungsebenen einschließlich Teamleiter',
      ],
      [
        'EU Sales Office',
        'Frauenanteil in Führungspositionen',
        fmtDe(36.8),
        '%',
        'GJ2026',
        'Nenner: alle Führungsebenen',
      ],
      ['EU Sales Office', 'Fluktuationsrate', fmtDe(8.4), '%', 'GJ2026', 'Freiwillige Abgänge'],
      [
        'EU Sales Office',
        'Betriebszugehörigkeit',
        fmtDe(9.6),
        'Jahre',
        'GJ2026',
        'Jahresdurchschnitt',
      ],
    ],
    ';',
  );

  csvFile(
    'HC11_DE_Frauenquote_Aufsichtsrat.csv',
    [
      ['Gremium', 'Kennzahl', 'Wert', 'Einheit', 'Zeitraum', 'Rechtsgrundlage'],
      [
        'Aufsichtsrat',
        'Frauenquote',
        fmtDe(33.3),
        '%',
        'GJ2026',
        'FüPoG II (gesetzliche Quote 30%)',
      ],
      ['Vorstand', 'Frauenquote', fmtDe(25.0), '%', 'GJ2026', 'FüPoG II'],
      [
        'Erste Führungsebene',
        'Frauenanteil in Führungspositionen',
        fmtDe(28.6),
        '%',
        'GJ2026',
        'Selbstverpflichtung',
      ],
      [
        'Zweite Führungsebene',
        'Frauenanteil in Führungspositionen',
        fmtDe(34.2),
        '%',
        'GJ2026',
        'Selbstverpflichtung',
      ],
    ],
    ';',
  );

  // ====================================================================
  // フランス（12〜13）— Index de l'égalité professionnelle
  // ====================================================================

  csvFile(
    'HC12_FR_bilan_social.csv',
    [
      ['Site', 'Indicateur', 'Valeur', 'Unité', 'Période', 'Définition'],
      ['Bureau Paris', 'Effectif', fmtFr(96, 0), 'personnes', 'EX2026', 'Effectif au 31/12'],
      [
        'Bureau Paris',
        'Effectif féminin',
        fmtFr(44, 0),
        'personnes',
        'EX2026',
        'Effectif au 31/12',
      ],
      [
        'Bureau Paris',
        'Cadres',
        fmtFr(31, 0),
        'personnes',
        'EX2026',
        'Statut cadre (convention collective)',
      ],
      [
        'Bureau Paris',
        'Femmes cadres',
        fmtFr(12, 0),
        'personnes',
        'EX2026',
        'Statut cadre (convention collective)',
      ],
      [
        'Bureau Paris',
        'Part des femmes cadres',
        fmtFr(38.7),
        '%',
        'EX2026',
        'Dénominateur : statut cadre',
      ],
      [
        'Bureau Paris',
        'Écart de rémunération',
        fmtFr(4.2),
        '%',
        'EX2026',
        "Index de l'égalité professionnelle (écart de rémunération)",
      ],
      ['Bureau Paris', 'Heures de formation', fmtFr(21.4), 'heures', 'EX2026', 'Par salarié'],
    ],
    ';',
  );

  csvFile(
    'HC13_FR_effectifs_lyon.csv',
    [
      ['Site', 'Indicateur', 'Valeur', 'Unité', 'Période', 'Commentaire'],
      ['Entrepôt Lyon', 'Effectif', fmtFr(58, 0), 'personnes', 'EX2026', 'CDI uniquement'],
      ['Entrepôt Lyon', 'Effectif féminin', fmtFr(19, 0), 'personnes', 'EX2026', 'CDI uniquement'],
      ['Entrepôt Lyon', 'Taux de rotation', fmtFr(11.8), '%', 'EX2026', 'Départs volontaires'],
      ['Entrepôt Lyon', 'Ancienneté', fmtFr(6.4), 'ans', 'EX2026', 'Moyenne au 31/12'],
    ],
    ';',
  );

  // ====================================================================
  // 中国（14〜15）
  // ====================================================================

  csvFile('HC14_CN_人力资源报表.csv', [
    ['站点', '指标', '数值', '单位', '期间', '口径说明'],
    ['供应商工厂A', '员工总数', 862, '人', '2026财年', '期末在册员工'],
    ['供应商工厂A', '女性员工', 341, '人', '2026财年', '期末在册员工'],
    ['供应商工厂A', '管理职人数', 74, '人', '2026财年', '主管及以上'],
    ['供应商工厂A', '女性管理职人数', 18, '人', '2026财年', '主管及以上'],
    ['供应商工厂A', '女性管理职比例', 24.3, '%', '2026财年', '分母为主管及以上'],
    ['供应商工厂A', '离职率', 18.6, '%', '2026财年', '含主动离职与被动离职'],
    ['供应商工厂A', '平均司龄', 3.8, '年', '2026财年', '期末'],
  ]);

  csvFile('HC15_CN_员工培训与安全.csv', [
    ['站点', '指标', '数值', '单位', '期间', '备注'],
    ['供应商工厂A', '人均培训时长', 32.4, '小时', '2026财年', '含入职培训'],
    ['供应商工厂B', '人均培训时长', 26.8, '小时', '2026财年', '含入职培训'],
    ['供应商工厂A', '工伤事故频率', 2.14, '件/百万工时', '2026财年', '损失工时事故'],
    ['供应商工厂B', '工伤事故频率', 1.86, '件/百万工时', '2026财年', '损失工时事故'],
  ]);

  // ====================================================================
  // インド・ブラジル（16〜17）— 社内等級 / ポルトガル語
  // ====================================================================

  csvFile('HC16_IN_HR_report.csv', [
    ['India Operations — Human Capital Summary FY2026'],
    ['Note: Managerial cadre is defined as Band 4 and above (internal grading)'],
    [],
    ['Site', 'Metric', 'Value', 'Unit', 'Period', 'Definition'],
    [
      'India Development Center',
      'Headcount',
      486,
      'Nos.',
      'FY2026',
      'On-roll employees as on 31 Mar',
    ],
    ['India Development Center', 'Female employees', 172, 'Nos.', 'FY2026', 'On-roll employees'],
    ['India Development Center', 'Managers', 68, 'Nos.', 'FY2026', 'Band 4 and above'],
    ['India Development Center', 'Female managers', 16, 'Nos.', 'FY2026', 'Band 4 and above'],
    [
      'India Development Center',
      'Women in management',
      23.5,
      '%',
      'FY2026',
      'Denominator: Band 4 and above',
    ],
    [
      'India Development Center',
      'Attrition rate',
      16.2,
      '%',
      'FY2026',
      'Voluntary only, annualised',
    ],
    [
      'India Development Center',
      'Training hours',
      41.8,
      'hours',
      'FY2026',
      'Per employee, including e-learning',
    ],
  ]);

  csvFile(
    'HC17_BR_relatorio_RH.csv',
    [
      ['Unidade', 'Indicador', 'Valor', 'Unidade de medida', 'Periodo', 'Definicao'],
      [
        'Escritorio Sao Paulo',
        'Numero de empregados',
        fmtEn(142, 0),
        'pessoas',
        'EX2026',
        'Efetivo em 31/12',
      ],
      [
        'Escritorio Sao Paulo',
        'Empregadas mulheres',
        fmtEn(64, 0),
        'pessoas',
        'EX2026',
        'Efetivo em 31/12',
      ],
      [
        'Escritorio Sao Paulo',
        'Cargos de gestao',
        fmtEn(28, 0),
        'pessoas',
        'EX2026',
        'Coordenacao e acima',
      ],
      [
        'Escritorio Sao Paulo',
        'Mulheres em cargos de gestao',
        fmtEn(9, 0),
        'pessoas',
        'EX2026',
        'Coordenacao e acima',
      ],
      [
        'Escritorio Sao Paulo',
        'Taxa de rotatividade',
        fmtEn(13.4),
        '%',
        'EX2026',
        'Desligamentos voluntarios',
      ],
    ],
    ';',
  );

  // ====================================================================
  // PDF（18〜20）— Latin 文字のみ（日本語 PDF は pdf.js が復元できない）
  // ====================================================================

  pdf('HC18_US_HR_annual_report.pdf', [
    'Human Capital Report FY2026 - US Region',
    'Entity: Aomi Technology US Inc.',
    'Reporting period: 1 Apr 2026 - 31 Mar 2027',
    'Prepared by: People Operations',
    '',
    'Metric                          Value      Unit       Definition',
    'Headcount                        214.0     FTE        Full-time equivalent, year end',
    'Female employees                  96.0     FTE        Full-time equivalent',
    'Managers                          42.0     FTE        EEO-1 Officials and Managers',
    'Female managers                   15.0     FTE        EEO-1 Officials and Managers',
    'Women in management               35.7     %          Denominator: Officials and Managers',
    'New hires                         38.0     FTE        Including converted contractors',
    'Turnover rate (voluntary)         14.8     %          Voluntary separations only',
    'Turnover rate (total)             19.2     %          Voluntary and involuntary',
    'Average tenure                     4.2     years      Year end',
    'Training hours per employee       28.4     hours      Including e-learning',
    'Gender pay ratio (unadjusted)     81.6     %          Median, raw',
    'Gender pay ratio (adjusted)       94.2     %          Median, adjusted for role and level',
    '',
    'Note: US manager definition follows EEO-1 job categories and is broader than',
    'the Japan definition (section chief and above). Figures are not directly comparable.',
  ]);

  pdf('HC19_DE_Personalbericht.pdf', [
    'Personalbericht Geschaeftsjahr 2026 - Region Europa',
    'Gesellschaft: Aomi Technology Europe GmbH',
    'Berichtszeitraum: 01.01.2026 - 31.12.2026',
    '',
    'Kennzahl                         Wert       Einheit    Definition',
    'Mitarbeiterzahl                   148       Personen   Stichtag 31.12.',
    'Mitarbeiterinnen                   64       Personen   Stichtag 31.12.',
    'Fuehrungskraefte                   38       Personen   Alle Fuehrungsebenen',
    'Weibliche Fuehrungskraefte         14       Personen   Alle Fuehrungsebenen',
    'Frauenanteil in Fuehrung         36,8      %          Nenner: alle Fuehrungsebenen',
    'Fluktuationsrate                  8,4      %          Freiwillige Abgaenge',
    'Betriebszugehoerigkeit            9,6      Jahre      Jahresdurchschnitt',
    'Schulungsstunden je MA           22,1      Stunden    Einschliesslich E-Learning',
    'Unfallhaeufigkeit (LTIFR)         0,86     je Mio h   Ausfalltage ab 1 Tag',
    '',
    'Hinweis: Die Definition "Fuehrungskraft" umfasst in Deutschland alle',
    'Fuehrungsebenen einschliesslich Teamleiter. Ein direkter Vergleich mit',
    'der japanischen Definition (ab Abteilungsleiter) ist nicht moeglich.',
  ]);

  pdf('HC20_Global_HR_factbook.pdf', [
    'Global Human Capital Factbook FY2026',
    'Aomi Technology Group - all regions',
    '',
    'Region        Headcount  Female  Managers  Female mgr  Women in mgmt  Definition of manager',
    'Japan               1330     386       187          34         18.2 %  Section chief and above',
    'United States        214      96        42          15         35.7 %  EEO-1 Officials and Managers',
    'United Kingdom       128      61        24           8         33.3 %  Grade 6 and above',
    'Germany              148      64        38          14         36.8 %  All leadership levels',
    'France                96      44        31          12         38.7 %  Cadre status',
    'India                486     172        68          16         23.5 %  Band 4 and above',
    'Brazil               142      64        28           9         32.1 %  Coordination level and above',
    'China                862     341        74          18         24.3 %  Supervisor and above',
    '',
    'IMPORTANT - comparability caveat',
    'The "women in management" ratio is NOT comparable across regions because the',
    'denominator differs by country. Group-level consolidation requires restating each',
    'region to the group definition (section chief and above) before aggregation.',
    '',
    'Group total headcount: 3,406',
    'Group total female employees: 1,228 (36.1 %)',
  ]);

  return files;
}
