/**
 * 人的資本データ 20 ファイルの生成器（人事システム出力想定・従業員 100 名以上規模）。
 *
 * 「あらゆる事業所・国・言語・様式・ファイル形式」に加えて、次の 2 つを再現する。
 *
 * 1. **人事システムからそのまま出力したような深さ**
 *    集計済みの数行ではなく、部門 × 雇用形態 × 男女のマトリクス、月次推移、
 *    採用・離職の明細（仮名 ID 単位）、研修台帳、等級別賃金など、
 *    実務で受け取る「生の帳票」に近い粒度にしている（1 ファイル 25〜100 行前後）。
 *
 * 2. **バウンダリ（集計範囲）のズレ**
 *    同じ名前の指標でも、国・拠点ごとに次が食い違う。
 *      - 雇用範囲   … 正社員のみ / 派遣・契約を含む / パートを含む
 *      - 管理職定義 … 課長以上 / チームリーダー含む / EEO-1 / Band 4+ / cadres / 主管以上
 *      - 期間基準   … 年度（4月起点） / 暦年 / 特定基準日
 *      - 算定方法   … 平均値 / 中央値
 *      - 離職の範囲 … 自己都合のみ / 会社都合を含む
 *      - 連結範囲   … 子会社のみ / 持分法適用会社を含む
 *    取込側は `src/lib/imports/boundary.ts` がこれらを検知し、同じ指標に
 *    異なるバウンダリが混在したら要確認へ倒す（数字だけ見て丸めない）。
 *
 * すべて架空データ。決定論的（同じ入力から必ず同じファイル）。
 */

import {
  buildSimplePdf,
  buildXlsx,
  csv,
  encodeSjis,
  utf8Bom,
  type DatasetFile,
} from './hetero-dataset';

// ----------------------------------------------------------------------
// 決定論的な擬似乱数（mulberry32）。Date.now / Math.random は使わない
// ----------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T =>
  list[Math.floor(r() * list.length)] ?? list[0]!;
const between = (r: () => number, min: number, max: number): number =>
  Math.round((min + r() * (max - min)) * 10) / 10;
const intBetween = (r: () => number, min: number, max: number): number =>
  Math.floor(min + r() * (max - min + 1));

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

const MONTHS_FY = [
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
  '2026-11',
  '2026-12',
  '2027-01',
  '2027-02',
  '2027-03',
];

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
  // 日本（HC01〜HC07）
  // ====================================================================

  // HC01: 本社 在籍者集計（部門 × 雇用形態 × 男女のマトリクス。HRIS の標準出力想定）
  {
    const r = rng(101);
    const departments = [
      '経営企画部',
      '人事部',
      '経理財務部',
      '法務部',
      '情報システム部',
      '研究開発部',
      '第一営業部',
      '第二営業部',
      '生産管理部',
      '品質保証部',
      '調達部',
      'サステナビリティ推進部',
    ];
    const rows: (string | number)[][] = [
      ['人事管理システム 在籍者集計表（部門別・雇用形態別・男女別）'],
      ['出力: 人事部 人事企画課 ／ 基準日: 2027-03-31（期末時点） ／ 出向者を除く'],
      ['定義: 管理職は課長相当職以上。従業員数は正社員のみを本表の合計とする'],
      [],
      ['部門', '雇用形態', '性別', '在籍者数', 'うち管理職', '平均年齢', '平均勤続年数', '期間'],
    ];
    let totalRegular = 0;
    let totalFemale = 0;
    let totalManagers = 0;
    let totalFemaleManagers = 0;
    for (const dept of departments) {
      for (const [empType, scale] of [
        ['正社員', 1],
        ['契約社員', 0.15],
        ['パートタイム', 0.1],
        ['派遣社員', 0.12],
      ] as const) {
        for (const gender of ['男性', '女性'] as const) {
          const base = intBetween(r, 12, 46);
          const count = Math.max(1, Math.round(base * scale * (gender === '女性' ? 0.55 : 1)));
          const managers =
            empType === '正社員' ? Math.round(count * (gender === '女性' ? 0.12 : 0.3)) : 0;
          if (empType === '正社員') {
            totalRegular += count;
            if (gender === '女性') totalFemale += count;
            totalManagers += managers;
            if (gender === '女性') totalFemaleManagers += managers;
          }
          rows.push([
            dept,
            empType,
            gender,
            count,
            managers,
            between(r, 29, 48),
            between(r, 3, 19),
            'FY2026',
          ]);
        }
      }
    }
    rows.push([]);
    rows.push(['集計（正社員のみ・期末時点）', '', '', '', '', '', '', '']);
    rows.push(['本社', '合計', '従業員数', totalRegular, '人', '', '', 'FY2026']);
    rows.push(['本社', '合計', '女性従業員数', totalFemale, '人', '', '', 'FY2026']);
    rows.push([
      '本社',
      '合計',
      '管理職数（課長相当職以上）',
      totalManagers,
      '人',
      '',
      '',
      'FY2026',
    ]);
    rows.push([
      '本社',
      '合計',
      '女性管理職数（課長相当職以上）',
      totalFemaleManagers,
      '人',
      '',
      '',
      'FY2026',
    ]);
    rows.push([
      '本社',
      '合計',
      '女性管理職比率',
      Math.round((totalFemaleManagers / totalManagers) * 1000) / 10,
      '%',
      '課長相当職以上を分母とする',
      '',
      'FY2026',
    ]);
    rows.push([
      '本社',
      '参考',
      '女性管理職比率（参考値）',
      Math.round((totalFemaleManagers / Math.max(1, Math.round(totalManagers * 0.4))) * 1000) / 10,
      '%',
      '部長相当職以上を分母とした場合',
      '',
      'FY2026',
    ]);
    csvFile('HC01_日本_本社_人事システム_在籍者集計.csv', rows);
  }

  // HC02: 東日本工場 月次人員推移（SJIS。工場の勤怠システム出力想定）
  {
    const r = rng(102);
    const rows: (string | number)[][] = [
      ['東日本工場 月次人員推移表（勤怠管理システム出力）'],
      ['対象: FY2026（2026-04～2027-03） ／ 在籍は各月末時点 ／ 派遣社員を含む就業者数も併記'],
      [],
      [
        '年月',
        '在籍者数（正社員のみ）',
        '就業者数（派遣を含む）',
        'うち女性',
        '入社',
        '退職',
        '平均残業時間',
        '有給取得率',
        '休業災害件数',
      ],
    ];
    let regular = 476;
    for (const month of MONTHS_FY) {
      const hires = intBetween(r, 0, 7);
      const exits = intBetween(r, 0, 5);
      regular = regular + hires - exits;
      rows.push([
        month,
        regular,
        regular + intBetween(r, 52, 68),
        Math.round(regular * 0.21),
        hires,
        exits,
        between(r, 8, 24),
        between(r, 48, 82),
        intBetween(r, 0, 1),
      ]);
    }
    rows.push([]);
    rows.push(['年間集計', '項目', '値', '単位', '期間', '備考', '', '', '']);
    rows.push([
      '東日本工場',
      '従業員数',
      regular,
      '人',
      'FY2026',
      '正社員のみ・期末時点',
      '',
      '',
      '',
    ]);
    rows.push([
      '東日本工場',
      '新規採用者数',
      34,
      '人',
      'FY2026',
      '技能職を含む（正社員のみ）',
      '',
      '',
      '',
    ]);
    rows.push(['東日本工場', '平均勤続年数', 15.2, '年', 'FY2026', '正社員のみ', '', '', '']);
    sjisFile('HC02_日本_東日本工場_月次人員推移_SJIS.csv', rows);
  }

  // HC03: 採用明細（採用管理システムの明細出力。仮名 ID 単位）
  {
    const r = rng(103);
    const rows: (string | number)[][] = [
      ['採用管理システム 入社者一覧（FY2026 確定）'],
      ['個人情報保護のため氏名は仮名 ID 化済み ／ 対象: 正社員（新卒＋中途）'],
      [],
      ['仮名ID', '採用区分', '職種', '配属部門', '入社日', '採用チャネル', '性別', '年齢層'],
    ];
    const jobs = ['研究開発', '生産技術', '営業', '経理', '人事', '情報システム', '品質保証'];
    const channels = ['新卒一括', '人材紹介', 'リファラル', '直接応募', 'スカウト'];
    const departments = ['研究開発部', '第一営業部', '生産管理部', '経理財務部', '情報システム部'];
    for (let i = 1; i <= 48; i += 1) {
      const isNewGrad = r() < 0.45;
      rows.push([
        `EMP-26${String(1000 + i)}`,
        isNewGrad ? '新卒' : '中途',
        pick(r, jobs),
        pick(r, departments),
        isNewGrad ? '2026-04-01' : `2026-${String(intBetween(r, 4, 12)).padStart(2, '0')}-01`,
        isNewGrad ? '新卒一括' : pick(r, channels),
        r() < 0.42 ? '女性' : '男性',
        pick(r, ['20-24', '25-29', '30-34', '35-39', '40-44']),
      ]);
    }
    rows.push([]);
    rows.push(['集計', '項目', '値', '単位', '期間', '備考', '', '']);
    rows.push(['本社', '新規採用者数', 48, '人', 'FY2026', '正社員のみ（新卒＋中途）', '', '']);
    csvFile('HC03_日本_本社_採用明細.csv', rows);
  }

  // HC04: 離職者一覧（事由別。離職率の分子の取り方が 2 通り載っている＝範囲差）
  {
    const r = rng(104);
    const rows: (string | number)[][] = [
      ['退職者一覧（人事管理システム出力・FY2026）'],
      ['仮名 ID 化済み ／ 事由コード: A=自己都合 B=会社都合 C=定年 D=契約満了'],
      [],
      ['仮名ID', '所属', '勤続年数', '事由コード', '退職日', '再雇用'],
    ];
    const reasons = ['A', 'A', 'A', 'A', 'B', 'C', 'D'] as const;
    let voluntary = 0;
    let all = 0;
    for (let i = 1; i <= 36; i += 1) {
      const reason = pick(r, reasons);
      all += 1;
      if (reason === 'A') voluntary += 1;
      rows.push([
        `EMP-R${String(2000 + i)}`,
        pick(r, ['本社', '東日本工場', '西日本工場']),
        between(r, 1, 28),
        reason,
        `2026-${String(intBetween(r, 4, 12)).padStart(2, '0')}-${String(intBetween(r, 1, 28)).padStart(2, '0')}`,
        reason === 'C' && r() < 0.6 ? '有' : '無',
      ]);
    }
    rows.push([]);
    rows.push(['集計', '項目', '値', '単位', '期間', '定義']);
    rows.push([
      '全社',
      '離職率',
      Math.round((voluntary / 1240) * 1000) / 10,
      '%',
      'FY2026',
      '自己都合のみ（定年・会社都合・契約満了を除く）',
    ]);
    rows.push([
      '全社',
      '離職率（参考）',
      Math.round((all / 1240) * 1000) / 10,
      '%',
      'FY2026',
      '全事由（会社都合・定年を含む）',
    ]);
    csvFile('HC04_日本_全社_離職者一覧.csv', rows);
  }

  // HC05: 研修台帳（LMS のコース別受講記録。2 シートの Excel）
  {
    const r = rng(105);
    const courseRows: (string | number)[][] = [
      [
        'コースID',
        'コース名',
        '分類',
        '対象部門',
        '受講者数',
        '総受講時間',
        '一人あたり時間',
        '実施形態',
      ],
    ];
    const categories = ['階層別', '技能', 'コンプライアンス', 'DX', '安全衛生', '語学'];
    const courseNames = [
      '新任管理職研修',
      '品質管理基礎',
      '情報セキュリティ',
      'データ分析入門',
      '危険予知訓練',
      'ビジネス英語',
      'ハラスメント防止',
      '設備保全実務',
      'プロジェクト管理',
      '財務会計基礎',
    ];
    let totalHours = 0;
    for (let i = 1; i <= 40; i += 1) {
      const attendees = intBetween(r, 8, 120);
      const hoursPer = between(r, 1.5, 16);
      const total = Math.round(attendees * hoursPer * 10) / 10;
      totalHours += total;
      courseRows.push([
        `TRN-${String(i).padStart(3, '0')}`,
        `${pick(r, courseNames)}（第${intBetween(r, 1, 4)}回）`,
        pick(r, categories),
        pick(r, ['全社', '本社', '東日本工場', '西日本工場']),
        attendees,
        total,
        hoursPer,
        pick(r, ['集合', 'オンライン', 'eラーニング']),
      ]);
    }
    const summaryRows: (string | number)[][] = [
      ['拠点', '項目', '値', '単位', '期間', '備考'],
      ['全社', '研修総時間', Math.round(totalHours), '時間', 'FY2026', '技能研修を含む'],
      [
        '全社',
        '一人あたり研修時間',
        Math.round((totalHours / 1240) * 10) / 10,
        '時間',
        'FY2026',
        '正社員 1,240 名で除した値',
      ],
      ['全社', '研修費用', 48200000, '円', 'FY2026', '外部講師・教材費を含む'],
    ];
    // 取込は先頭シートを解析するため、集計行は台帳シートの末尾にも載せる
    courseRows.push([]);
    courseRows.push(['集計', '項目', '値', '単位', '期間', '備考', '', '']);
    courseRows.push([
      '全社',
      '一人あたり研修時間',
      Math.round((totalHours / 1240) * 10) / 10,
      '時間',
      'FY2026',
      '正社員 1,240 名で除した値',
      '',
      '',
    ]);
    table(
      'HC05_日本_研修受講記録.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      await buildXlsx([
        { name: 'コース台帳', rows: courseRows },
        { name: '集計', rows: summaryRows },
      ]),
    );
  }

  // HC06: 等級別賃金（男女別。平均値と中央値、正社員のみとパート含むが併記＝算定方法の差）
  {
    const r = rng(106);
    const rows: (string | number)[][] = [
      ['等級別賃金集計表（給与システム出力・FY2026）'],
      ['年間賃金 = 基本給 + 賞与 + 諸手当（時間外手当を除く） ／ 単位: 千円'],
      [],
      ['等級', '性別', '人数', '平均年間賃金', '中央値年間賃金', '平均年齢'],
    ];
    const grades = ['G1', 'G2', 'G3', 'G4', 'G5', 'M1', 'M2', 'M3', 'E1'];
    for (const grade of grades) {
      const base = 3600 + grades.indexOf(grade) * 1150;
      for (const gender of ['男性', '女性'] as const) {
        const penalty = gender === '女性' ? 0.965 : 1;
        rows.push([
          grade,
          gender,
          intBetween(r, gender === '女性' ? 8 : 20, gender === '女性' ? 70 : 140),
          Math.round(base * penalty * (1 + r() * 0.06)),
          Math.round(base * penalty * (0.97 + r() * 0.04)),
          between(r, 27 + grades.indexOf(grade) * 2, 33 + grades.indexOf(grade) * 2),
        ]);
      }
    }
    rows.push([]);
    rows.push(['集計', '項目', '値', '単位', '期間', '定義']);
    rows.push(['全社', '男女賃金格差', 74.1, '%', 'FY2026', '正社員のみ・平均値ベース']);
    rows.push([
      '全社',
      '男女賃金格差（参考）',
      81.2,
      '%',
      'FY2026',
      'パートタイム含む・中央値ベース',
    ]);
    csvFile('HC06_日本_等級別賃金_男女.csv', rows);
  }

  // HC07: 安全衛生年報（PDF。月次の災害記録と度数率）
  {
    const r = rng(107);
    const lines = [
      '安全衛生年報 FY2026（環境安全部）',
      '集計基準: 休業 1 日以上の労働災害 ／ 対象: 正社員 + 構内請負・派遣を含む全就業者',
      '',
      '月次実績（東日本工場 / 西日本工場）',
      '年月  休業災害  不休災害  ヒヤリハット報告  総労働時間',
    ];
    let lost = 0;
    let hours = 0;
    for (const month of MONTHS_FY) {
      const l = intBetween(r, 0, 1);
      const n = intBetween(r, 0, 3);
      const h = intBetween(r, 14, 42);
      const t = intBetween(r, 152000, 166000);
      lost += l;
      hours += t;
      lines.push(`${month}   ${l} 件      ${n} 件      ${h} 件            ${fmtEn(t, 0)} 時間`);
    }
    const ltifr = Math.round((lost / hours) * 1e6 * 100) / 100;
    lines.push('');
    lines.push(`年間合計: 休業災害 ${lost} 件 ／ 総労働時間 ${fmtEn(hours, 0)} 時間`);
    lines.push(`労働災害度数率（LTIFR）: ${ltifr} 件/百万時間（休業 1 日以上・派遣を含む）`);
    lines.push('強度率: 0.02 ／ 死亡災害: 0 件');
    lines.push('');
    lines.push('※ 本書は架空のサンプルです。実在の企業・災害とは関係ありません。');
    pdf('HC07_日本_安全衛生年報.pdf', lines);
  }

  // ====================================================================
  // 米国（HC08〜HC10）
  // ====================================================================

  // HC08: US HRIS headcount export（EEO-1 職種区分。Regular FT のみ）
  {
    const r = rng(108);
    const rows: (string | number)[][] = [
      ['US Subsidiary - HRIS Headcount Export (Workday-style)'],
      ['Scope: Regular full-time employees only; excludes contractors and interns'],
      ['As of: 2026-12-31 (calendar year basis)'],
      [],
      ['Department', 'EEO-1 Job Category', 'Gender', 'Headcount', 'Avg Tenure (yrs)', 'Period'],
    ];
    const departments = ['Sales', 'Engineering', 'Operations', 'Finance', 'HR', 'Legal'];
    const categories = [
      'Officials and Managers (First/Mid-Level)',
      'Professionals',
      'Technicians',
      'Administrative Support',
    ];
    let total = 0;
    let female = 0;
    let managers = 0;
    let femaleManagers = 0;
    for (const dept of departments) {
      for (const category of categories) {
        for (const gender of ['Male', 'Female'] as const) {
          const count = intBetween(r, 2, 18);
          total += count;
          if (gender === 'Female') female += count;
          if (category.startsWith('Officials')) {
            managers += count;
            if (gender === 'Female') femaleManagers += count;
          }
          rows.push([dept, category, gender, count, between(r, 1, 12), 'CY2026']);
        }
      }
    }
    rows.push([]);
    rows.push(['Summary', 'Metric', 'Value', 'Unit', 'Period', 'Definition']);
    rows.push(['US Subsidiary', 'Total employees', total, 'people', 'CY2026', 'Regular FT only']);
    rows.push(['US Subsidiary', 'Female employees', female, 'people', 'CY2026', 'Regular FT only']);
    rows.push([
      'US Subsidiary',
      'Female Officials and Managers ratio',
      Math.round((femaleManagers / managers) * 1000) / 10,
      '%',
      'CY2026',
      'EEO-1 Officials and Managers (First/Mid-Level) as denominator',
    ]);
    csvFile('HC08_US_HRIS_headcount_export.csv', rows);
  }

  // HC09: US 月次入退社（会社都合を含む turnover＝離職範囲の差）
  {
    const r = rng(109);
    const rows: (string | number)[][] = [
      ['US Subsidiary - Monthly Hires & Terminations (HRIS export)'],
      ['Turnover includes voluntary AND involuntary terminations (calendar year)'],
      [],
      ['Month', 'Headcount (EOM)', 'Hires', 'Voluntary Terms', 'Involuntary Terms', 'Open Reqs'],
    ];
    let headcount = 214;
    let vol = 0;
    let invol = 0;
    for (let month = 1; month <= 12; month += 1) {
      const hires = intBetween(r, 1, 6);
      const v = intBetween(r, 0, 4);
      const i = intBetween(r, 0, 2);
      vol += v;
      invol += i;
      headcount = headcount + hires - v - i;
      rows.push([
        `2026-${String(month).padStart(2, '0')}`,
        headcount,
        hires,
        v,
        i,
        intBetween(r, 2, 9),
      ]);
    }
    const turnover = Math.round(((vol + invol) / headcount) * 1000) / 10;
    rows.push([]);
    rows.push(['Summary', 'Metric', 'Value', 'Unit', 'Period', 'Definition']);
    rows.push([
      'US Subsidiary',
      'Turnover rate',
      turnover,
      '%',
      'CY2026',
      'Voluntary + involuntary terminations / average headcount',
    ]);
    rows.push(['US Subsidiary', 'New hires', 38, 'people', 'CY2026', 'Regular FT only']);
    csvFile('HC09_US_turnover_monthly.csv', rows);
  }

  // HC10: US ペイエクイティ（中央値ベース＝算定方法の差）
  pdf('HC10_US_pay_equity_summary.pdf', [
    'US Subsidiary - Pay Equity Review Summary (CY2026)',
    'Methodology: MEDIAN base pay comparison, controlled for job level and location.',
    'Population: Regular full-time employees only.',
    '',
    'Job Level                     Median Pay Ratio (F/M)   Population',
    'Officials & Managers          97.2%                    64',
    'Professionals                 98.5%                    182',
    'Technicians                   99.1%                    77',
    'Administrative Support        98.8%                    41',
    '',
    'Company-wide gender pay gap (median, unadjusted): 5.8%',
    'Company-wide gender pay gap (mean, unadjusted): 7.4%',
    '',
    'Note: Fictitious sample document for demo purposes only.',
  ]);

  // ====================================================================
  // ドイツ（HC11〜HC12）
  // ====================================================================

  // HC11: 人事報告（チームリーダーを含む管理職定義＝定義差。セミコロン区切り・1.234,5）
  {
    const r = rng(111);
    const rows: (string | number)[][] = [
      ['Personalbericht GJ2026 - EU Sales Office (SAP HCM Export)'],
      ['Führungskräfte: alle Führungsebenen einschließlich Teamleiter'],
      ['Stichtag: 31.03.2027 / inkl. Teilzeitkräfte'],
      [],
      [
        'Abteilung',
        'Mitarbeiter gesamt',
        'davon Frauen',
        'Führungskräfte',
        'davon weibliche Führungskräfte',
        'Teilzeitquote (%)',
        'Zeitraum',
      ],
    ];
    const departments = ['Vertrieb', 'Marketing', 'Finanzen', 'Personal', 'IT', 'Kundendienst'];
    let total = 0;
    let managers = 0;
    let femaleManagers = 0;
    for (const dept of departments) {
      const count = intBetween(r, 12, 38);
      const women = Math.round(count * between(r, 0.3, 0.55) * 10) / 10;
      const leads = intBetween(r, 2, 7);
      const femaleLeads = intBetween(r, 0, Math.min(3, leads));
      total += count;
      managers += leads;
      femaleManagers += femaleLeads;
      rows.push([
        dept,
        count,
        Math.round(women),
        leads,
        femaleLeads,
        fmtDe(between(r, 8, 32)),
        'GJ2026',
      ]);
    }
    rows.push([]);
    rows.push(['Zusammenfassung', 'Kennzahl', 'Wert', 'Einheit', 'Zeitraum', 'Definition', '']);
    rows.push([
      'EU Sales Office',
      'Mitarbeiterzahl',
      total,
      'Personen',
      'GJ2026',
      'inkl. Teilzeit',
      '',
    ]);
    rows.push([
      'EU Sales Office',
      'Frauenanteil in Führungspositionen',
      fmtDe(Math.round((femaleManagers / managers) * 1000) / 10),
      '%',
      'GJ2026',
      'alle Führungsebenen einschließlich Teamleiter',
      '',
    ]);
    rows.push([
      'EU Sales Office',
      'Fluktuationsrate',
      fmtDe(8.4),
      '%',
      'GJ2026',
      'nur freiwillige Abgänge',
      '',
    ]);
    csvFile('HC11_DE_Personalbericht.csv', rows, ';');
  }

  // HC12: 研修台帳（ドイツ語。コース単位）
  {
    const r = rng(112);
    const rows: (string | number)[][] = [
      ['Weiterbildungskatalog GJ2026 - EU Sales Office'],
      [],
      ['Kurs-ID', 'Kursname', 'Kategorie', 'Teilnehmer', 'Stunden gesamt', 'Kosten (EUR)'],
    ];
    const courses = [
      'Compliance-Grundlagen',
      'Vertriebstraining',
      'Datenschutz (DSGVO)',
      'Führungskräfteentwicklung',
      'Projektmanagement',
      'Interkulturelle Kommunikation',
    ];
    let hours = 0;
    for (let i = 1; i <= 24; i += 1) {
      const attendees = intBetween(r, 4, 40);
      const total = between(r, 8, 120);
      hours += total;
      rows.push([
        `WB-${String(i).padStart(3, '0')}`,
        `${pick(r, courses)} ${intBetween(r, 1, 3)}`,
        pick(r, ['Pflicht', 'Fachlich', 'Führung', 'Sprachen']),
        attendees,
        fmtDe(total),
        fmtDe(between(r, 800, 9200), 2),
      ]);
    }
    rows.push([]);
    rows.push(['Zusammenfassung', 'Kennzahl', 'Wert', 'Einheit', 'Zeitraum', '']);
    rows.push([
      'EU Sales Office',
      'Schulungsstunden pro Mitarbeiter',
      fmtDe(Math.round((hours / 142) * 10) / 10),
      'Stunden',
      'GJ2026',
      '',
    ]);
    csvFile('HC12_DE_Weiterbildung.csv', rows, ';');
  }

  // ====================================================================
  // フランス（HC13）・英国（HC14）
  // ====================================================================

  // HC13: 社会報告書（cadres 区分＝定義差。1 234,5 形式）
  {
    const r = rng(113);
    const rows: (string | number)[][] = [
      ['Bilan Social 2026 - Bureau de Paris (extrait SIRH)'],
      ['Effectifs au 31/12/2026 / cadres selon la convention collective'],
      [],
      ['Catégorie (CSP)', 'Sexe', 'Effectif', 'Age moyen', 'Ancienneté moyenne', 'Période'],
    ];
    const categories = ['Cadres', 'Agents de maîtrise', 'Employés', 'Ouvriers'];
    let total = 0;
    let cadres = 0;
    let femmesCadres = 0;
    for (const category of categories) {
      for (const sexe of ['Hommes', 'Femmes'] as const) {
        const count = intBetween(r, 6, 34);
        total += count;
        if (category === 'Cadres') {
          cadres += count;
          if (sexe === 'Femmes') femmesCadres += count;
        }
        rows.push([
          category,
          sexe,
          count,
          fmtFr(between(r, 30, 47)),
          fmtFr(between(r, 3, 15)),
          'CY2026',
        ]);
      }
    }
    rows.push([]);
    rows.push(['Synthèse', 'Indicateur', 'Valeur', 'Unité', 'Période', 'Définition']);
    rows.push(['Bureau de Paris', 'Effectif total', total, 'personnes', 'CY2026', 'CDI + CDD']);
    rows.push([
      'Bureau de Paris',
      'Part des femmes cadres',
      fmtFr(Math.round((femmesCadres / cadres) * 1000) / 10),
      '%',
      'CY2026',
      'statut cadre (convention collective) comme dénominateur',
    ]);
    rows.push([
      'Bureau de Paris',
      "Index de l'égalité professionnelle",
      89,
      '/100',
      'CY2026',
      'calcul réglementaire (France)',
    ]);
    csvFile('HC13_FR_bilan_social.csv', rows);
  }

  // HC14: 英国 Gender Pay Gap（法定様式。中央値・基準日 5 April＝期間とバウンダリの差）
  csvFile('HC14_UK_gender_pay_gap_statutory.csv', [
    ['UK Gender Pay Gap Report (statutory disclosure format)'],
    ['Snapshot date: 5 April 2026 / all relevant employees including part-time'],
    [],
    ['Measure', 'Value', 'Unit', 'Period', 'Basis'],
    ['Gender pay gap (median hourly pay)', 8.2, '%', 'Snapshot 5 Apr 2026', 'median'],
    ['Gender pay gap (mean hourly pay)', 11.6, '%', 'Snapshot 5 Apr 2026', 'mean'],
    ['Bonus gap (median)', 14.3, '%', '12m to 5 Apr 2026', 'median'],
    ['Bonus gap (mean)', 18.9, '%', '12m to 5 Apr 2026', 'mean'],
    ['Proportion of women - upper quartile', 31.4, '%', 'Snapshot 5 Apr 2026', 'headcount'],
    ['Proportion of women - upper middle quartile', 38.2, '%', 'Snapshot 5 Apr 2026', 'headcount'],
    ['Proportion of women - lower middle quartile', 44.6, '%', 'Snapshot 5 Apr 2026', 'headcount'],
    ['Proportion of women - lower quartile', 52.8, '%', 'Snapshot 5 Apr 2026', 'headcount'],
    ['Women in management (Grade 6 and above)', 27.9, '%', 'Snapshot 5 Apr 2026', 'headcount'],
  ]);

  // ====================================================================
  // 中国（HC15〜HC16）
  // ====================================================================

  // HC15: 华东工厂 人事月报（劳务派遣を含む＝雇用範囲の差。主管以上＝管理職定義の差）
  {
    const r = rng(115);
    const rows: (string | number)[][] = [
      ['华东工厂 人事月报（人力资源系统导出）'],
      ['统计口径: 在职员工含劳务派遣 / 管理人员指主管以上'],
      [],
      [
        '月份',
        '在职员工（含劳务派遣）',
        '其中劳务派遣',
        '女性员工',
        '入职',
        '离职',
        '加班平均（小时）',
      ],
    ];
    let headcount = 356;
    for (let month = 1; month <= 12; month += 1) {
      const hires = intBetween(r, 2, 12);
      const exits = intBetween(r, 1, 9);
      headcount = headcount + hires - exits;
      rows.push([
        `2026-${String(month).padStart(2, '0')}`,
        headcount,
        intBetween(r, 55, 80),
        Math.round(headcount * 0.38),
        hires,
        exits,
        between(r, 12, 32),
      ]);
    }
    rows.push([]);
    rows.push(['汇总', '指标', '数值', '单位', '期间', '口径']);
    rows.push(['华东工厂', '员工总数', headcount, '人', 'CY2026', '含劳务派遣']);
    rows.push(['华东工厂', '女性管理职比率', 22.4, '%', 'CY2026', '主管以上为分母']);
    rows.push(['华东工厂', '流失率', 14.8, '%', 'CY2026', '含试用期离职']);
    csvFile('HC15_CN_华东工厂_人事月报.csv', rows);
  }

  // HC16: 培训台账（コース単位）
  {
    const r = rng(116);
    const rows: (string | number)[][] = [
      ['培训台账 2026年度 - 华东工厂'],
      [],
      ['课程编号', '课程名称', '类别', '参加人数', '总培训时长（小时）', '人均时长'],
    ];
    const courses = ['安全生产培训', '质量管理', '设备操作', '消防演练', '管理技能', '环保法规'],
      cats = ['必修', '技能', '管理'];
    let hours = 0;
    for (let i = 1; i <= 26; i += 1) {
      const attendees = intBetween(r, 12, 180);
      const per = between(r, 1, 8);
      const total = Math.round(attendees * per * 10) / 10;
      hours += total;
      rows.push([
        `PX-${String(i).padStart(3, '0')}`,
        `${pick(r, courses)}（${intBetween(r, 1, 4)}期）`,
        pick(r, cats),
        attendees,
        total,
        per,
      ]);
    }
    rows.push([]);
    rows.push(['汇总', '指标', '数值', '单位', '期间', '口径']);
    rows.push([
      '华东工厂',
      '人均培训时长',
      Math.round((hours / 380) * 10) / 10,
      '小时',
      'CY2026',
      '含劳务派遣员工',
    ]);
    csvFile('HC16_CN_培训台账.csv', rows);
  }

  // ====================================================================
  // インド（HC17）・APAC 統括（HC18）
  // ====================================================================

  // HC17: HR MIS（Band 等級＝定義差。暦年＝期間差。契約社員を別掲）
  {
    const r = rng(117);
    const rows: (string | number)[][] = [
      ['India Development Center - HR MIS Report (calendar year 2026)'],
      ['Managers defined as Band 4 and above / contract staff reported separately'],
      [],
      ['Band', 'Gender', 'On-roll Headcount', 'Contract Staff', 'Attrition (%)', 'Period'],
    ];
    let total = 0;
    let band4 = 0;
    let femaleBand4 = 0;
    for (let band = 1; band <= 8; band += 1) {
      for (const gender of ['Male', 'Female'] as const) {
        const count = intBetween(r, band >= 6 ? 2 : 8, band >= 6 ? 10 : 46);
        total += count;
        if (band >= 4) {
          band4 += count;
          if (gender === 'Female') femaleBand4 += count;
        }
        rows.push([
          `Band ${band}`,
          gender,
          count,
          band <= 3 ? intBetween(r, 0, 12) : 0,
          between(r, 6, 22),
          'CY2026',
        ]);
      }
    }
    rows.push([]);
    rows.push(['Summary', 'Metric', 'Value', 'Unit', 'Period', 'Definition']);
    rows.push([
      'India DC',
      'Total employees',
      total,
      'people',
      'CY2026',
      'On-roll only, excludes contract staff',
    ]);
    rows.push([
      'India DC',
      'Women in management',
      Math.round((femaleBand4 / band4) * 1000) / 10,
      '%',
      'CY2026',
      'Band 4 and above as denominator',
    ]);
    rows.push([
      'India DC',
      'Attrition rate',
      15.2,
      '%',
      'CY2026',
      'Voluntary, annualized (calendar year)',
    ]);
    csvFile('HC17_IN_HR_MIS_report.csv', rows);
  }

  // HC18: APAC ダッシュボード出力（持分法適用の JV を含む＝連結範囲の差。Excel 2 シート）
  {
    const r = rng(118);
    const matrix: (string | number)[][] = [
      [
        'Entity',
        'Ownership',
        'Consolidation',
        'Employees',
        'Female %',
        'Managers',
        'Female Managers %',
        'Period',
      ],
    ];
    const entities: Array<[string, string, string]> = [
      ['Aomi Singapore Pte.', '100%', 'Subsidiary'],
      ['Aomi Thailand Co.', '100%', 'Subsidiary'],
      ['Aomi Vietnam LLC', '85%', 'Subsidiary'],
      ['Aomi-Sunrise JV (India)', '49%', 'Equity method (JV)'],
      ['Aomi Malaysia SB', '100%', 'Subsidiary'],
    ];
    let totalInclJv = 0;
    for (const [entity, ownership, consolidation] of entities) {
      const count = intBetween(r, 45, 240);
      totalInclJv += count;
      matrix.push([
        entity,
        ownership,
        consolidation,
        count,
        between(r, 28, 52),
        intBetween(r, 6, 32),
        between(r, 12, 34),
        'FY2026',
      ]);
    }
    const summary: (string | number)[][] = [
      ['Region', 'Metric', 'Value', 'Unit', 'Period', 'Boundary note'],
      [
        'APAC',
        'Total employees',
        totalInclJv,
        'people',
        'FY2026',
        'Includes equity-method JV (49% owned)',
      ],
      [
        'APAC',
        'Women in management',
        24.8,
        '%',
        'FY2026',
        'All entities incl. JV, team leads included',
      ],
    ];
    table(
      'HC18_APAC_dashboard_export.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      await buildXlsx([
        { name: 'Entities', rows: matrix },
        { name: 'Summary', rows: summary },
      ]),
    );
  }

  // ====================================================================
  // グローバル（HC19〜HC20）
  // ====================================================================

  // HC19: エンゲージメントサーベイ（地域 × カテゴリのスコア表）
  {
    const r = rng(119);
    const rows: (string | number)[][] = [
      ['Global Engagement Survey 2026 - Vendor Export'],
      ['Scale: 0-100 favourable / response rate per region'],
      [],
      ['Region', 'Category', 'Score', 'vs Prior Year', 'Response Rate (%)', 'Period'],
    ];
    const regions = ['Japan', 'Americas', 'EMEA', 'China', 'India', 'APAC'];
    const categories = [
      'Engagement',
      'Wellbeing',
      'Growth Opportunity',
      'Manager Effectiveness',
      'Inclusion',
      'Safety Culture',
    ];
    for (const region of regions) {
      const responseRate = between(r, 68, 94);
      for (const category of categories) {
        rows.push([
          region,
          category,
          between(r, 58, 86),
          between(r, -4, 6),
          responseRate,
          'FY2026',
        ]);
      }
    }
    rows.push([]);
    rows.push(['Global', 'eNPS', intBetween(r, 4, 22), 'score', 'FY2026', '']);
    csvFile('HC19_Global_engagement_survey.csv', rows);
  }

  // HC20: 開示ドラフト用サマリー（PDF。暦年・全就業者ベース＝期間とバウンダリの差）
  pdf('HC20_Global_disclosure_summary.pdf', [
    'Human Capital Disclosure Summary (DRAFT) - Group Consolidated',
    'Basis: CALENDAR YEAR 2026 / all workers including temporary and dispatched staff',
    '',
    'Metric                              Value      Unit     Boundary',
    'Total workforce                     2,418      people   incl. temporary staff',
    'Female employees                    892        people   incl. temporary staff',
    'Women in management                 21.7       %        group definition: section manager+',
    'New hires                           214        people   all employment types',
    'Turnover rate                       9.8        %        all reasons, calendar year',
    'Average training hours              14.2       hours    per capita, all workers',
    'LTIFR                               1.18       /1M hrs  incl. contractors',
    'Gender pay gap                      22.1       %        mean, unadjusted, group-wide',
    '',
    'Note: figures on this draft use CALENDAR YEAR and include temporary staff.',
    'Site reports may use fiscal year and regular employees only - reconcile before disclosure.',
    '',
    'Fictitious sample for demo purposes only.',
  ]);

  return files;
}
