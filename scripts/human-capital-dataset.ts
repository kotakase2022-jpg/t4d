/**
 * 人的資本データ 20 ファイルの生成器 v3（人事システムの生出力を再現）。
 *
 * v2 は「集計済みの表」に近く、実務で受け取る帳票とは手触りが違った。
 * v3 では、実在の人事・給与システムの出力に共通する体裁をそのまま持ち込む。
 *
 * 1. **帳票としての体裁**
 *    - 表の前に帳票名・会社名・出力日時・抽出条件が並ぶ（奉行の[汎用データ作成]は
 *      「タイトル情報出力」が既定で有効。行数は抽出条件の数で毎回変わる）
 *    - 表の中に小計・合計行が明細と同じ列構成で混ざる（同じく「計行出力」が既定で有効）
 *    - 表の後ろに ※注記・以上・レコード件数が付く
 *
 * 2. **機械が吐いた列とコード**
 *    - `EBAS001` `SWDF010` のような機械的な列名（奉行の OBC 受入形式）
 *    - ゼロ埋めコード `0001` と、ハイフンで階層を埋め込んだ部門コード `100-10-01`
 *      （PCA 給与 DX の部門情報は 9 階層・区切りはハイフン）
 *    - Workday の `Worker > Job > EEO-1 Job Category` のようなパス型列名
 *
 * 3. **表記のゆれ**
 *    - 和暦（令和8年4月1日 / R8.4.1）と西暦 8 桁（20260401）の混在
 *    - 100 倍スケールの暗黙小数と 60 進の勤怠時間（PCA 出面データ）
 *    - セル内改行を含む自由記述（退職事由）
 *    - Shift_JIS / セミコロン区切り / `1.234,5`・`1 234,5` のロケール表記
 *
 * 4. **バウンダリ（集計範囲）のズレ**
 *    同じ名前の指標でも、国・拠点ごとに雇用範囲・管理職定義・期間基準・算定方法・
 *    離職範囲・連結範囲が食い違う。しかも**その宣言は前置きブロックにしか無い**ことが多い。
 *    取込側は `src/lib/imports/boundary.ts` がこれを検知し、同じ指標に異なるバウンダリが
 *    混在したら要確認へ倒す。
 *
 * すべて架空データ。決定論的（同じ入力から必ず同じファイル）。
 * PDF は Latin-1 の範囲しか出せないため英文にしている（`buildSimplePdf` の制約）。
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
const intBetween = (r: () => number, min: number, max: number): number =>
  Math.floor(min + r() * (max - min + 1));
const between = (r: () => number, min: number, max: number): number =>
  Math.round((min + r() * (max - min)) * 10) / 10;

// ----------------------------------------------------------------------
// 書式ヘルパー
// ----------------------------------------------------------------------

/** 1,234.5 形式（日英） */
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

/** 1 234,5 形式（フランス語圏。桁区切りはノーブレークスペース） */
function fmtFr(n: number, digits = 1): string {
  const [intPart, decPart] = fmtEn(n, digits).split('.');
  const grouped = (intPart ?? '').split(',').join(' ');
  return decPart === undefined ? grouped : `${grouped},${decPart}`;
}

const zeroPad = (n: number, width: number): string => String(n).padStart(width, '0');

/** 和暦。令和は 2019 年が元年 */
function wareki(year: number, month: number, day: number, style: 'long' | 'short'): string {
  const r = year - 2018;
  return style === 'long' ? `令和${r}年${month}月${day}日` : `R${r}.${month}.${day}`;
}

/** 西暦 8 桁（YYYYMMDD）。人事システムが好む形式 */
const ymd8 = (y: number, m: number, d: number): string => `${y}${zeroPad(m, 2)}${zeroPad(d, 2)}`;

const KANA = [
  'ｱｵｼﾏ',
  'ﾋｶﾞｼ',
  'ﾆｼﾑﾗ',
  'ｷﾀｶﾞﾜ',
  'ﾐﾅﾐ',
  'ｻｻｷ',
  'ﾜﾀﾅﾍﾞ',
  'ﾀｶﾊｼ',
  'ｲﾄｳ',
  'ﾅｶﾞｲ',
  'ﾓﾘﾀ',
  'ｸﾎﾞﾀ',
  'ｼﾐｽﾞ',
  'ﾊｾｶﾞﾜ',
  'ｱﾍﾞ',
  'ｲｼｲ',
] as const;
const GIVEN_KANA = [
  'ﾀﾛｳ',
  'ﾊﾅｺ',
  'ｹﾝｲﾁ',
  'ﾐﾄﾞﾘ',
  'ﾘｮｳ',
  'ｱｵｲ',
  'ｿｳﾀ',
  'ﾕｲ',
  'ﾀｸﾐ',
  'ｻｸﾗ',
  'ﾚﾝ',
  'ﾋﾏﾘ',
] as const;
const SURNAME = [
  '青島',
  '東',
  '西村',
  '北川',
  '南',
  '佐々木',
  '渡辺',
  '高橋',
  '伊藤',
  '永井',
  '森田',
  '窪田',
  '清水',
  '長谷川',
  '安部',
  '石井',
] as const;
const GIVEN = [
  '太郎',
  '花子',
  '健一',
  '緑',
  '涼',
  '葵',
  '颯太',
  '結衣',
  '拓海',
  '桜',
  '蓮',
  '陽葵',
] as const;

// ----------------------------------------------------------------------
// 真値マスター
//
// 全ファイルがここを参照する。明細を足し上げると小計・合計・他ファイルの
// サマリーと一致する（取込側が「明細と合計の二重計上」を検知できることを
// 検証するには、両者が本当に一致している必要がある）。
// ----------------------------------------------------------------------

interface DeptSpec {
  /** 事業部コード-部コード-課コード */
  code: string;
  division: string;
  name: string;
  /** 正社員の人数（男性, 女性） */
  regular: [number, number];
  /** 契約社員 */
  contract: [number, number];
  /** パートタイム */
  parttime: [number, number];
  /** 派遣（受入）。正社員のみの集計には入らない */
  dispatch: [number, number];
  /** 課長相当職以上（男性, 女性） */
  managers: [number, number];
}

/** 本社 12 部門。正社員合計 506 名（男性 331 / 女性 175） */
const HQ_DEPTS: DeptSpec[] = [
  {
    code: '100-10-01',
    division: '経営管理本部',
    name: '経営企画部',
    regular: [22, 11],
    contract: [1, 2],
    parttime: [0, 3],
    dispatch: [0, 2],
    managers: [6, 1],
  },
  {
    code: '100-10-02',
    division: '経営管理本部',
    name: '財務経理部',
    regular: [18, 16],
    contract: [1, 3],
    parttime: [0, 4],
    dispatch: [0, 3],
    managers: [5, 2],
  },
  {
    code: '100-20-01',
    division: '経営管理本部',
    name: '人事総務部',
    regular: [14, 19],
    contract: [2, 4],
    parttime: [1, 6],
    dispatch: [0, 4],
    managers: [4, 3],
  },
  {
    code: '100-20-02',
    division: '経営管理本部',
    name: '法務・知的財産部',
    regular: [9, 8],
    contract: [0, 1],
    parttime: [0, 1],
    dispatch: [0, 1],
    managers: [3, 1],
  },
  {
    code: '200-10-01',
    division: '営業本部',
    name: '第一営業部',
    regular: [41, 18],
    contract: [3, 4],
    parttime: [0, 5],
    dispatch: [1, 3],
    managers: [9, 1],
  },
  {
    code: '200-10-02',
    division: '営業本部',
    name: '第二営業部',
    regular: [34, 15],
    contract: [2, 3],
    parttime: [0, 4],
    dispatch: [1, 2],
    managers: [8, 1],
  },
  {
    code: '200-20-01',
    division: '営業本部',
    name: '海外営業部',
    regular: [26, 14],
    contract: [1, 2],
    parttime: [0, 2],
    dispatch: [0, 1],
    managers: [6, 2],
  },
  {
    code: '300-10-01',
    division: '技術本部',
    name: '製品開発部',
    regular: [58, 21],
    contract: [4, 2],
    parttime: [0, 2],
    dispatch: [3, 2],
    managers: [12, 2],
  },
  {
    code: '300-10-02',
    division: '技術本部',
    name: '生産技術部',
    regular: [44, 12],
    contract: [3, 1],
    parttime: [0, 1],
    dispatch: [4, 1],
    managers: [10, 1],
  },
  {
    code: '300-20-01',
    division: '技術本部',
    name: '品質保証部',
    regular: [27, 16],
    contract: [2, 2],
    parttime: [0, 3],
    dispatch: [1, 2],
    managers: [7, 2],
  },
  {
    code: '400-10-01',
    division: '生産本部',
    name: '調達部',
    regular: [21, 13],
    contract: [1, 2],
    parttime: [0, 2],
    dispatch: [1, 2],
    managers: [5, 1],
  },
  {
    code: '400-10-02',
    division: '生産本部',
    name: '物流部',
    regular: [17, 12],
    contract: [2, 3],
    parttime: [1, 5],
    dispatch: [2, 3],
    managers: [4, 1],
  },
];

const HC_MASTER = {
  /** 日本 3 拠点の正社員数。合計 1,240 名（研修時間の分母） */
  japanRegular: { hq: 506, east: 494, west: 240 },
  /** 海外拠点の正社員数 */
  overseasRegular: { us: 214, de: 142, fr: 118, uk: 96, cn: 310, inr: 268 },
  /** 連結（持分法 JV を除く）と JV 込みの総従業員数 */
  consolidatedExclJv: 2506,
  consolidatedInclJv: 2692,
  /** 本社の女性管理職比率（課長相当職以上ベース） */
  hqFemaleManagerRatio: 15.1,
} as const;

const sum2 = (t: [number, number]) => t[0] + t[1];

// ----------------------------------------------------------------------
// 帳票の体裁を組み立てるヘルパー
// ----------------------------------------------------------------------

type Cell = string | number;

/**
 * 前置きブロック・表・後置きブロックを 1 枚の CSV にする。
 *
 * 前置きの行は本体と同じ列数まで空セルで埋める。実際の帳票がそうなっており
 * （帳票の 1 行を CSV の 1 行として吐くため）、取込側のヘッダー検出は
 * 「列数が本体と揃っているか」を手掛かりにしている。
 */
function report(options: {
  preamble: string[];
  header: Cell[];
  body: Cell[][];
  trailer: string[];
  sep?: string;
}): string {
  const width = options.header.length;
  const padded = (line: string): Cell[] => [
    line,
    ...Array<string>(Math.max(0, width - 1)).fill(''),
  ];
  const rows: Cell[][] = [
    ...options.preamble.map(padded),
    options.header,
    ...options.body,
    ...options.trailer.map(padded),
  ];
  return csv(rows, options.sep ?? ',');
}

// ----------------------------------------------------------------------
// HC01 本社 在籍者集計表（奉行風・小計と合計を含む）
// ----------------------------------------------------------------------

function buildHc01(): string {
  const r = rng(0x48430101);
  const body: Cell[][] = [];

  const EMPLOYMENT: Array<{ key: keyof DeptSpec; label: string }> = [
    { key: 'regular', label: '正社員' },
    { key: 'contract', label: '契約社員' },
    { key: 'parttime', label: 'パートタイム' },
    { key: 'dispatch', label: '派遣（受入）' },
  ];

  let divisionRegular = 0;
  let previousDivision = '';
  const divisionTotals = new Map<string, number>();

  for (const dept of HQ_DEPTS) {
    if (previousDivision !== '' && previousDivision !== dept.division) {
      body.push([
        '',
        `${previousDivision} 計`,
        '',
        '',
        divisionRegular,
        '',
        '',
        '',
        ymd8(2027, 3, 31),
      ]);
      divisionTotals.set(previousDivision, divisionRegular);
      divisionRegular = 0;
    }
    previousDivision = dept.division;

    for (const emp of EMPLOYMENT) {
      const counts = dept[emp.key] as [number, number];
      const genders: Array<[string, number]> = [
        ['男性', counts[0]],
        ['女性', counts[1]],
      ];
      for (const [gender, count] of genders) {
        if (count === 0) continue;
        const managers =
          emp.key === 'regular' ? (gender === '男性' ? dept.managers[0] : dept.managers[1]) : 0;
        body.push([
          dept.code,
          dept.name,
          emp.label,
          gender,
          count,
          managers === 0 ? '-' : managers,
          between(r, 34.2, 46.8),
          between(r, 7.4, 18.6),
          ymd8(2027, 3, 31),
        ]);
      }
    }
    // 部門小計（正社員のみ。帳票の小計は雇用区分をまたがない）
    body.push([
      '',
      `${dept.name} 小計`,
      '正社員',
      '',
      sum2(dept.regular),
      sum2(dept.managers),
      '',
      '',
      ymd8(2027, 3, 31),
    ]);
    divisionRegular += sum2(dept.regular);
  }

  body.push(['', `${previousDivision} 計`, '', '', divisionRegular, '', '', '', ymd8(2027, 3, 31)]);
  divisionTotals.set(previousDivision, divisionRegular);

  const grandTotal = [...divisionTotals.values()].reduce((s, v) => s + v, 0);
  const totalManagers = HQ_DEPTS.reduce((s, d) => s + sum2(d.managers), 0);
  body.push(['', '＜総合計＞', '正社員', '', grandTotal, totalManagers, '', '', ymd8(2027, 3, 31)]);

  return report({
    preamble: [
      '在籍者集計表（部門別・雇用区分別）',
      '青海テクノロジー株式会社',
      `出力日時:${wareki(2027, 4, 1, 'long')} 09:12`,
      '出力条件:対象=本社 / 基準日=2027-03-31 / 在籍者のみ',
      '出力条件:雇用区分=正社員のみを集計対象とする（派遣・受入出向は参考表示）',
      '出力条件:管理職=課長相当職以上',
      '',
    ],
    header: [
      '部門コード',
      '部門名',
      '雇用区分',
      '性別',
      '在籍者数',
      'うち管理職',
      '平均年齢',
      '平均勤続年数',
      '基準日',
    ],
    body,
    trailer: [
      '※ 在籍者数は基準日時点。休職者を含み、受入出向者を含まない。',
      '※ 管理職は課長相当職以上。部長相当職以上を分母とした場合の女性管理職比率は別紙のとおり。',
      `レコード件数: ${body.length}`,
      '以上',
    ],
  });
}

// ----------------------------------------------------------------------
// HC02 東日本工場 月次人員推移（Shift_JIS・勤怠システム出力）
// ----------------------------------------------------------------------

function buildHc02(): string {
  const r = rng(0x48430202);
  const body: Cell[][] = [];
  const months = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

  const CATEGORIES = [
    { code: '01', label: '正社員', base: 494 },
    { code: '02', label: '契約社員', base: 62 },
    { code: '03', label: 'パートタイム', base: 38 },
    { code: '04', label: '派遣（受入）', base: 44 },
  ];

  let hires = 0;
  let leavers = 0;
  let totalHours = 0;

  for (const cat of CATEGORIES) {
    let headcount = cat.base;
    let catIn = 0;
    let catOut = 0;
    let catHours = 0;
    for (const m of months) {
      const y = m >= 4 ? 2026 : 2027;
      const inCount = intBetween(r, 0, cat.code === '01' ? 7 : 3);
      const outCount = intBetween(r, 0, cat.code === '01' ? 6 : 3);
      headcount = headcount + inCount - outCount;
      const hours = Math.round(headcount * between(r, 148, 172));
      if (cat.code === '01') {
        hires += inCount;
        leavers += outCount;
      }
      catIn += inCount;
      catOut += outCount;
      catHours += hours;
      totalHours += hours;
      body.push([
        `${y}${zeroPad(m, 2)}`,
        cat.code,
        cat.label,
        headcount,
        inCount,
        outCount,
        hours,
        // 休業災害は 0 の月が多い。0 は本物の値であって欠測ではない
        intBetween(r, 0, 100) > 92 ? 1 : 0,
        wareki(y, m, 1, 'short'),
      ]);
    }
    body.push(['', cat.code, `${cat.label} 小計`, headcount, catIn, catOut, catHours, '', '']);
  }

  body.push(['', '', '合計', '', hires, leavers, totalHours, '', '']);

  return report({
    preamble: [
      '月次人員推移表',
      '青海テクノロジー株式会社 東日本工場',
      `出力日時:${ymd8(2027, 4, 2)} 06:30`,
      '集計対象:2026年度（4月起点） / 雇用区分別 / 実労働時間を含む',
      '',
    ],
    header: [
      '対象年月',
      '区分コード',
      '雇用区分',
      '月末在籍者数',
      '入社',
      '退社',
      '延べ実労働時間',
      '休業災害件数',
      '基準日',
    ],
    body,
    trailer: [
      '※ 延べ実労働時間は所定内・所定外の合計（単位:時間）。',
      '※ 休業災害件数が 0 の月は災害が発生しなかったことを示す（未集計ではない）。',
      `レコード件数: ${body.length}`,
    ],
  });
}

// ----------------------------------------------------------------------
// HC03 採用者明細（社員単位・和暦と西暦の混在）
// ----------------------------------------------------------------------

function buildHc03(): string {
  const r = rng(0x48430303);
  const body: Cell[][] = [];
  const ROUTES = ['新卒', '中途', '再雇用', 'アルムナイ'] as const;
  const GRADES = ['G1', 'G2', 'G3', 'M1', 'M2', 'S1'] as const;

  for (let i = 0; i < 88; i += 1) {
    const dept = pick(r, HQ_DEPTS);
    const route = pick(r, ROUTES);
    const month = route === '新卒' ? 4 : intBetween(r, 4, 12);
    const year = month >= 4 ? 2026 : 2027;
    const day = intBetween(r, 1, 28);
    const gender = r() > 0.62 ? '女性' : '男性';
    const surname = pick(r, SURNAME);
    const given = pick(r, GIVEN);
    body.push([
      zeroPad(3001 + i, 6),
      `${pick(r, KANA)} ${pick(r, GIVEN_KANA)}`,
      `${surname} ${given}`,
      dept.code,
      dept.name,
      route,
      pick(r, GRADES),
      gender,
      // 入社日は和暦（人事システムの既定）と西暦 8 桁が混ざる
      i % 3 === 0 ? wareki(year, month, day, 'long') : ymd8(year, month, day),
      intBetween(r, 22, 48),
      route === '新卒' ? '-' : `${intBetween(r, 1, 18)}年`,
      '正社員',
    ]);
  }

  body.push(['', '', '合計', '', '', '', '', '', '', '', '', body.length]);

  return report({
    preamble: [
      '採用者明細一覧',
      '青海テクノロジー株式会社 人事総務部',
      `出力日時:${wareki(2027, 4, 3, 'long')} 14:05`,
      '抽出条件:入社日 2026/04/01 - 2027/03/31 / 雇用区分=正社員',
      '抽出条件:出向受入・派遣を含まない',
      '',
    ],
    header: [
      '社員番号',
      '氏名カナ',
      '氏名',
      '所属コード',
      '所属名称',
      '採用区分',
      '等級',
      '性別',
      '入社年月日',
      '年齢',
      '前職経験年数',
      '雇用区分',
    ],
    body,
    trailer: [
      '※ 新規採用者数は本表の明細件数と一致する。',
      '※ 氏名は仮名。実在の人物とは関係ありません。',
      `出力件数: ${body.length - 1}`,
      '以上',
    ],
  });
}

// ----------------------------------------------------------------------
// HC04 退職者一覧（セル内改行を含む自由記述つき）
// ----------------------------------------------------------------------

function buildHc04(): string {
  const r = rng(0x48430404);
  const body: Cell[][] = [];
  const REASONS = [
    ['自己都合', '転職（同業他社）'],
    ['自己都合', '家庭の事情'],
    ['自己都合', '進学・留学'],
    ['会社都合', '事業所閉鎖に伴う配置転換不能'],
    ['定年', '定年退職（65歳）'],
    ['契約満了', '有期労働契約の期間満了'],
  ] as const;

  let voluntary = 0;
  for (let i = 0; i < 64; i += 1) {
    const dept = pick(r, HQ_DEPTS);
    const reason = pick(r, REASONS);
    if (reason[0] === '自己都合') voluntary += 1;
    const month = intBetween(r, 4, 12);
    const year = month >= 4 ? 2026 : 2027;
    const day = intBetween(r, 1, 28);
    body.push([
      zeroPad(1200 + i * 3, 6),
      `${pick(r, KANA)} ${pick(r, GIVEN_KANA)}`,
      dept.code,
      dept.name,
      r() > 0.58 ? '女性' : '男性',
      reason[0],
      // 面談記録はセル内改行を含む（CSV では引用符で囲まれる）
      `${reason[1]}\n面談実施日: ${wareki(year, month, Math.max(1, day - 3), 'short')}\n引継: 完了`,
      ymd8(year, month, day),
      `${intBetween(r, 1, 22)}年${intBetween(r, 0, 11)}ヶ月`,
      intBetween(r, 24, 64),
      '正社員',
    ]);
  }

  const total = body.length;
  body.push(['', '', '', '合計', '', '', '', '', '', '', total]);

  return report({
    preamble: [
      '退職者一覧表',
      '青海テクノロジー株式会社 人事総務部',
      `出力日時:${ymd8(2027, 4, 3)} 15:40`,
      '抽出条件:退職日 2026/04/01 - 2027/03/31',
      `集計基準:離職率は自己都合のみ（定年・会社都合・契約満了を除く）。該当 ${voluntary} 名`,
      '',
    ],
    header: [
      '社員番号',
      '氏名カナ',
      '所属コード',
      '所属名称',
      '性別',
      '退職事由区分',
      '退職事由詳細',
      '退職年月日',
      '勤続年数',
      '年齢',
      '雇用区分',
    ],
    body,
    trailer: [
      `※ 離職率 ${((voluntary / HC_MASTER.japanRegular.hq) * 100).toFixed(1)} % は自己都合のみ（定年・会社都合・契約満了を除く）を分子とした値。`,
      '※ 会社都合・全事由を含む離職率は別集計。',
      `レコード件数: ${total}`,
    ],
  });
}

// ----------------------------------------------------------------------
// HC05 研修受講記録（Excel 2 シート: コース台帳 / 受講明細）
// ----------------------------------------------------------------------

function buildHc05Sheets(): Array<{ name: string; rows: Cell[][] }> {
  const r = rng(0x48430505);
  const CATEGORIES = [
    'コンプライアンス',
    '技術',
    'マネジメント',
    '語学',
    '安全衛生',
    'DX',
  ] as const;

  const courses: Cell[][] = [];
  let totalHours = 0;
  let totalAttendees = 0;

  for (let i = 0; i < 48; i += 1) {
    const category = pick(r, CATEGORIES);
    const attendees = intBetween(r, 12, 240);
    const hoursEach = between(r, 1, 16);
    const hours = Math.round(attendees * hoursEach * 10) / 10;
    totalHours += hours;
    totalAttendees += attendees;
    courses.push([
      `CRS-${zeroPad(101 + i, 4)}`,
      `${category}研修 第${(i % 6) + 1}期`,
      category,
      i % 4 === 0 ? '必須' : '任意',
      attendees,
      Math.round(attendees * between(r, 0.82, 1.0)),
      hours,
      hoursEach,
      `${ymd8(2026, 4, 1)}-${ymd8(2027, 3, 31)}`,
    ]);
  }

  courses.push([
    '',
    '合計',
    '',
    '',
    totalAttendees,
    '',
    Math.round(totalHours * 10) / 10,
    '',
    'FY2026',
  ]);

  const perHead = Math.round((totalHours / 1240) * 10) / 10;
  const summary: Cell[][] = [
    ['全社', '一人あたり研修時間', perHead, '時間', 'FY2026', '正社員 1,240 名で除した値'],
    ['全社', '総研修時間', Math.round(totalHours * 10) / 10, '時間', 'FY2026', 'コース台帳の合計'],
    ['全社', '延べ受講者数', totalAttendees, '人', 'FY2026', 'コース台帳の合計'],
  ];

  // 受講明細（社員 × コース）。実際の LMS 出力に近い粒度
  const detail: Cell[][] = [];
  for (let i = 0; i < 320; i += 1) {
    const course = intBetween(r, 101, 148);
    const dept = pick(r, HQ_DEPTS);
    detail.push([
      zeroPad(1000 + i, 6),
      `${pick(r, KANA)} ${pick(r, GIVEN_KANA)}`,
      dept.code,
      dept.name,
      `CRS-${zeroPad(course, 4)}`,
      between(r, 1, 16),
      r() > 0.12 ? '修了' : '未修了',
      ymd8(2026, intBetween(r, 4, 12), intBetween(r, 1, 28)),
    ]);
  }

  return [
    {
      name: 'コース台帳',
      rows: [
        ['研修受講記録（コース別集計）', '', '', '', '', '', '', '', ''],
        ['青海テクノロジー株式会社 人材開発課', '', '', '', '', '', '', '', ''],
        ['集計対象:正社員のみ / 2026年度', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', ''],
        [
          'コースID',
          'コース名',
          'カテゴリ',
          '必須区分',
          '受講者数',
          '修了者数',
          '総受講時間',
          '一人あたり時間',
          '実施期間',
        ],
        ...courses,
        ['', '', '', '', '', '', '', '', ''],
        ['拠点', '指標', '値', '単位', '対象期間', '算定根拠'],
        ...summary,
      ],
    },
    {
      name: '受講明細',
      rows: [
        [
          '社員番号',
          '氏名カナ',
          '所属コード',
          '所属名称',
          'コースID',
          '受講時間',
          '修了区分',
          '受講日',
        ],
        ...detail,
      ],
    },
  ];
}

// ----------------------------------------------------------------------
// HC06 等級別賃金・男女別（平均値と中央値、集計範囲が 2 ブロック）
// ----------------------------------------------------------------------

function buildHc06(): string {
  const r = rng(0x48430606);
  const GRADES = ['S3', 'S2', 'S1', 'M3', 'M2', 'M1', 'G4', 'G3', 'G2', 'G1'] as const;
  const body: Cell[][] = [];

  let maleTotal = 0;
  let femaleTotal = 0;
  let maleCount = 0;
  let femaleCount = 0;

  for (const grade of GRADES) {
    const base = 4_200_000 + GRADES.indexOf(grade) * 480_000;
    const menCount = intBetween(r, 8, 62);
    const womenCount = intBetween(r, 4, 38);
    const menPay = Math.round(base * between(r, 0.98, 1.12));
    const womenPay = Math.round(base * between(r, 0.9, 1.04));
    maleTotal += menPay * menCount;
    femaleTotal += womenPay * womenCount;
    maleCount += menCount;
    femaleCount += womenCount;
    body.push([
      grade,
      '男性',
      menCount,
      fmtEn(menPay, 0),
      fmtEn(Math.round(menPay * 0.97), 0),
      '正社員のみ・平均値ベース',
      'FY2026',
    ]);
    body.push([
      grade,
      '女性',
      womenCount,
      fmtEn(womenPay, 0),
      fmtEn(Math.round(womenPay * 0.98), 0),
      '正社員のみ・平均値ベース',
      'FY2026',
    ]);
  }

  const maleAvg = maleTotal / maleCount;
  const femaleAvg = femaleTotal / femaleCount;
  const gapRegular = Math.round((femaleAvg / maleAvg) * 1000) / 10;

  body.push([
    '全等級',
    '合計',
    maleCount + femaleCount,
    fmtEn(Math.round(maleAvg), 0),
    fmtEn(Math.round(femaleAvg), 0),
    '正社員のみ・平均値ベース',
    'FY2026',
  ]);
  body.push([
    '全等級',
    '男女賃金格差',
    '',
    `${gapRegular}`,
    '',
    '正社員のみ・平均値ベース（女性/男性）',
    'FY2026',
  ]);
  // パートタイムを含めた場合は格差が広がる。同じ指標で集計範囲が違う行を混ぜる
  body.push([
    '全等級',
    '男女賃金格差',
    '',
    '74.1',
    '',
    'パートタイムを含む・平均値ベース（女性/男性）',
    'FY2026',
  ]);

  return report({
    preamble: [
      '等級別賃金台帳（男女別）',
      '青海テクノロジー株式会社 人事総務部',
      `出力日時:${ymd8(2027, 4, 5)} 11:20`,
      '集計対象:正社員のみ / 平均値ベース / 年間支給総額（賞与含む）',
      '',
    ],
    header: ['等級', '性別', '人数', '平均年間賃金', '中央値年間賃金', '集計範囲', '対象期間'],
    body,
    trailer: [
      '※ 男女賃金格差は女性の平均年間賃金 ÷ 男性の平均年間賃金。',
      '※ パートタイムを含む場合の値は集計範囲が異なるため単純比較できない。',
      `レコード件数: ${body.length}`,
    ],
  });
}

// ----------------------------------------------------------------------
// HC07 EHS 年次報告（PDF・英文）
// ----------------------------------------------------------------------

function buildHc07(): string[] {
  const r = rng(0x48430707);
  const lines: string[] = [
    'Occupational Health and Safety Annual Report FY2026',
    'Aomi Technology Corporation - East Japan Plant',
    'Report generated: 2027-04-06 08:15  /  Prepared by: EHS Department',
    'Scope: all workers on site, including dispatched and contract workers',
    'Reporting basis: fiscal year starting 1 April',
    '',
    'Month      Headcount   Hours worked   Lost-time injuries   Non-lost-time   Lost days',
  ];

  const months = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
  let totalHours = 0;
  let lti = 0;
  let lostDays = 0;
  for (const m of months) {
    const y = m >= 4 ? 2026 : 2027;
    const headcount = intBetween(r, 620, 660);
    const hours = Math.round(headcount * between(r, 150, 168));
    const injuries = intBetween(r, 0, 100) > 88 ? 1 : 0;
    const minor = intBetween(r, 0, 3);
    const days = injuries === 1 ? intBetween(r, 4, 48) : 0;
    totalHours += hours;
    lti += injuries;
    lostDays += days;
    lines.push(
      `${y}-${zeroPad(m, 2)}      ${String(headcount).padStart(5)}     ${fmtEn(hours, 0).padStart(11)}   ${String(injuries).padStart(6)}              ${String(minor).padStart(5)}        ${String(days).padStart(5)}`,
    );
  }

  const ltifr = Math.round((lti / totalHours) * 1_000_000 * 100) / 100;
  const severity = Math.round((lostDays / totalHours) * 1_000_000) / 1000;

  lines.push(
    '',
    'Annual summary',
    `Total hours worked                    ${fmtEn(totalHours, 0)}`,
    `Lost-time injuries                    ${lti}`,
    `LTIFR (per million hours worked)      ${ltifr}`,
    `Lost days                             ${lostDays}`,
    `Severity rate                         ${severity}`,
    'Health and safety committee meetings  12',
    'Health check-up completion rate       99.2 %',
    '',
    'Note: figures cover all workers including dispatched and contract workers,',
    'and therefore differ from the regular-employee-only headcount reports.',
    'Total records: 12',
    'End of report',
  );
  return lines;
}

// ----------------------------------------------------------------------
// HC08 人事 KPI サマリー（日本語・縦持ち。開示用に人事が作る表）
// ----------------------------------------------------------------------

function buildHc08(): string {
  const body: Cell[][] = [
    [
      'HC-001',
      '従業員数',
      HC_MASTER.japanRegular.hq,
      '人',
      '正社員のみ・期末時点',
      '本社',
      'FY2026',
    ],
    [
      'HC-002',
      '女性従業員数',
      HQ_DEPTS.reduce((s, d) => s + d.regular[1], 0),
      '人',
      '正社員のみ・期末時点',
      '本社',
      'FY2026',
    ],
    [
      'HC-003',
      '管理職数',
      HQ_DEPTS.reduce((s, d) => s + sum2(d.managers), 0),
      '人',
      '課長相当職以上',
      '本社',
      'FY2026',
    ],
    [
      'HC-004',
      '女性管理職数',
      HQ_DEPTS.reduce((s, d) => s + d.managers[1], 0),
      '人',
      '課長相当職以上',
      '本社',
      'FY2026',
    ],
    [
      'HC-005',
      '女性管理職比率',
      HC_MASTER.hqFemaleManagerRatio,
      '%',
      '課長相当職以上を分母とした値',
      '本社',
      'FY2026',
    ],
    [
      'HC-006',
      '女性管理職比率',
      8.4,
      '%',
      '部長相当職以上を分母とした場合の参考値',
      '本社',
      'FY2026',
    ],
    ['HC-007', '新規採用者数', 88, '人', '正社員・入社日ベース', '本社', 'FY2026'],
    [
      'HC-008',
      '離職率',
      6.2,
      '%',
      '自己都合のみ（定年・会社都合・契約満了を除く）',
      '本社',
      'FY2026',
    ],
    ['HC-009', '平均勤続年数', 12.8, '年', '正社員のみ・期末時点', '本社', 'FY2026'],
    ['HC-010', '平均年齢', 41.3, '歳', '正社員のみ・期末時点', '本社', 'FY2026'],
    ['HC-011', '育児休業取得率（女性）', 98.1, '%', '出産者に対する取得者の割合', '本社', 'FY2026'],
    [
      'HC-012',
      '育児休業取得率（男性）',
      42.7,
      '%',
      '配偶者出産者に対する取得者の割合',
      '本社',
      'FY2026',
    ],
    ['HC-013', '年次有給休暇取得率', 71.4, '%', '正社員のみ', '本社', 'FY2026'],
    ['HC-014', '障害者雇用率', 2.6, '%', '法定算定方式', '全社', 'FY2026'],
    ['HC-015', '労働組合加入率', 78.2, '%', '正社員のみ', '全社', 'FY2026'],
  ];

  return report({
    preamble: [
      '人的資本 KPI サマリー（開示用）',
      '青海テクノロジー株式会社 サステナビリティ推進部',
      `出力日時:${wareki(2027, 4, 8, 'long')} 10:00`,
      '集計対象:2026年度（4月起点） / 正社員のみ（注記のあるものを除く）',
      '',
    ],
    header: ['指標コード', '指標名', '値', '単位', '算定基準', '対象組織', '対象期間'],
    body,
    trailer: [
      '※ 女性管理職比率は課長相当職以上を基準とする。部長相当職以上を分母とした場合の参考値も併記。',
      '※ 離職率は自己都合のみを分子とする。',
      `レコード件数: ${body.length}`,
      '以上',
    ],
  });
}

// ----------------------------------------------------------------------
// HC09 US EEO-1 Component 1（Workday のパス型列名）
// ----------------------------------------------------------------------

function buildHc09(): string {
  const r = rng(0x48430909);
  const JOB_CATEGORIES = [
    'Executive/Senior Level Officials and Managers',
    'First/Mid-Level Officials and Managers',
    'Professionals',
    'Technicians',
    'Sales Workers',
    'Administrative Support Workers',
    'Craft Workers',
    'Operatives',
    'Laborers and Helpers',
    'Service Workers',
  ] as const;
  const RACES = [
    'White',
    'Black or African American',
    'Hispanic or Latino',
    'Asian',
    'Two or More Races',
  ] as const;

  const body: Cell[][] = [];
  let grandTotal = 0;
  let managerMale = 0;
  let managerFemale = 0;

  for (const category of JOB_CATEGORIES) {
    let categoryTotal = 0;
    for (const race of RACES) {
      for (const gender of ['Male', 'Female'] as const) {
        const count = intBetween(r, 0, category.includes('Officials') ? 8 : 14);
        if (count === 0) continue;
        categoryTotal += count;
        grandTotal += count;
        if (category.includes('Officials and Managers')) {
          if (gender === 'Male') managerMale += count;
          else managerFemale += count;
        }
        body.push([
          'Aomi Technology USA, Inc.',
          category,
          race,
          gender,
          count,
          gender === 'Male' ? 'Exempt' : 'Non-exempt',
          pick(r, ['CA', 'TX', 'IL', 'NC'] as const),
          `P-${zeroPad(intBetween(r, 1000, 9999), 6)}`,
          'CY2026',
        ]);
      }
    }
    body.push(['', `${category} Totals`, '', '', categoryTotal, '', '', '', 'CY2026']);
  }

  const ratio = Math.round((managerFemale / (managerMale + managerFemale)) * 1000) / 10;
  body.push(['', 'Report Totals', '', '', grandTotal, '', '', '', 'CY2026']);
  body.push([
    '',
    'Women in management (EEO-1 Officials and Managers)',
    '',
    '',
    ratio,
    '%',
    '',
    '',
    'CY2026',
  ]);

  return report({
    preamble: [
      'EEO-1 Component 1 Report',
      'Aomi Technology USA, Inc. (EIN 00-0000000, NAICS 334413)',
      'Run date: 01/15/2027 09:41 (America/Chicago)',
      'Payroll period: 1 Oct 2026 - 31 Dec 2026',
      'Scope: Regular full-time employees only',
      '',
    ],
    header: [
      'Worker > Employment Details > Establishment',
      'Worker > Job > EEO-1 Job Category',
      'Worker > Personal > Race/Ethnicity',
      'Worker > Personal > Gender',
      'Headcount',
      'Worker > Employment Details > FLSA Status',
      'Worker > Employment Details > Work State',
      'Position ID',
      'Period',
    ],
    body,
    trailer: [
      'Note: Officials and Managers includes first/mid-level officials.',
      'Note: reporting period is the calendar year (CY2026).',
      `Total records: ${body.length}`,
      'End of report',
    ],
  });
}

// ----------------------------------------------------------------------
// HC10 US Pay Equity Statement（PDF・英文）
// ----------------------------------------------------------------------

function buildHc10(): string[] {
  const r = rng(0x48431010);
  const lines: string[] = [
    'Pay Equity Statement CY2026',
    'Aomi Technology USA, Inc.',
    'Run date: 01/20/2027  /  Source: ADP Workforce Now',
    'Scope: Regular full-time employees only, base pay excluding equity awards',
    'Basis: median hourly pay (unadjusted)',
    '',
    'Job level        Headcount   Median base (USD)   Mean base (USD)   Gap vs male',
  ];

  const LEVELS = ['Executive', 'Director', 'Manager', 'Professional', 'Support'] as const;
  for (const level of LEVELS) {
    for (const gender of ['Male', 'Female'] as const) {
      const headcount = intBetween(r, 6, 48);
      const median = intBetween(r, 62_000, 210_000);
      const mean = Math.round(median * between(r, 0.98, 1.08));
      const gap = gender === 'Female' ? `${between(r, 88, 99)} %` : '-';
      lines.push(
        `${level.padEnd(16)} ${String(headcount).padStart(6)}     ${fmtEn(median, 0).padStart(12)}      ${fmtEn(mean, 0).padStart(12)}     ${gap.padStart(8)}`,
      );
    }
  }

  lines.push(
    '',
    'Summary',
    'Median gender pay gap (all employees)   8.2 %',
    'Mean gender pay gap (all employees)     11.4 %',
    'Proportion of women receiving bonus     72.9 %',
    'Turnover rate (voluntary + involuntary) 14.8 %',
    'Turnover rate (voluntary only)          9.6 %',
    '',
    'Note: the gap is calculated on median hourly pay, not on mean pay.',
    'Note: turnover includes all reasons (voluntary and involuntary terminations).',
    'Total records: 10',
    'End of report',
  );
  return lines;
}

// ----------------------------------------------------------------------
// HC11 DE Personalbericht（セミコロン区切り・1.234,5 形式）
// ----------------------------------------------------------------------

function buildHc11(): string {
  const r = rng(0x48431111);
  const ABTEILUNGEN = [
    ['0110', 'Geschäftsführung'],
    ['0120', 'Finanzen'],
    ['0210', 'Vertrieb Nord'],
    ['0220', 'Vertrieb Süd'],
    ['0310', 'Entwicklung'],
    ['0320', 'Produktion'],
    ['0410', 'Qualitätssicherung'],
    ['0420', 'Logistik'],
  ] as const;

  const body: Cell[][] = [];
  let total = 0;
  let managers = 0;
  let femaleManagers = 0;

  for (const [code, name] of ABTEILUNGEN) {
    let abteilungAnzahl = 0;
    let abteilungFk = 0;
    for (const art of ['Vollzeit', 'Teilzeit', 'Befristet'] as const) {
      for (const geschlecht of ['männlich', 'weiblich'] as const) {
        const anzahl = intBetween(r, 1, art === 'Vollzeit' ? 22 : 8);
        total += art === 'Vollzeit' ? anzahl : 0;
        abteilungAnzahl += anzahl;
        const fk = art === 'Vollzeit' ? intBetween(r, 0, 4) : 0;
        managers += fk;
        abteilungFk += fk;
        if (geschlecht === 'weiblich') femaleManagers += fk;
        body.push([
          code,
          name,
          art,
          geschlecht,
          fmtDe(anzahl, 0),
          fk === 0 ? '-' : fmtDe(fk, 0),
          fmtDe(between(r, 34, 49), 1),
          fmtDe(between(r, 4, 16), 1),
          art === 'Vollzeit' ? 'Vollzeitkräfte' : 'einschließlich Teilzeit',
          '31.03.2027',
        ]);
      }
    }
    body.push([
      '',
      `${name} Zwischensumme`,
      '',
      '',
      fmtDe(abteilungAnzahl, 0),
      fmtDe(abteilungFk, 0),
      '',
      '',
      '',
      '31.03.2027',
    ]);
  }

  const anteil = Math.round((femaleManagers / Math.max(1, managers)) * 1000) / 10;
  body.push([
    '',
    'Gesamtsumme',
    'Vollzeit',
    '',
    fmtDe(total, 0),
    fmtDe(managers, 0),
    '',
    '',
    '',
    '31.03.2027',
  ]);
  body.push([
    '',
    'Frauenanteil in Führungspositionen',
    '',
    '',
    fmtDe(anteil, 1),
    '%',
    '',
    '',
    'alle Führungsebenen einschließlich Teamleiter',
    'GJ2026',
  ]);

  return report({
    preamble: [
      'Personalbericht Geschäftsjahr 2026',
      'Aomi Technology GmbH',
      'Stand: 31.03.2027',
      'Abgrenzung: alle Führungsebenen einschließlich Teamleiter',
      'Berichtszeitraum: Geschaeftsjahr (GJ2026)',
      '',
    ],
    header: [
      'Abteilungscode',
      'Abteilung',
      'Beschäftigungsart',
      'Geschlecht',
      'Anzahl',
      'Führungskräfte',
      'Durchschnittsalter',
      'Betriebszugehörigkeit',
      'Abgrenzung',
      'Stichtag',
    ],
    body,
    trailer: [
      'Hinweis: Frauenanteil in Führungspositionen wird auf alle Führungsebenen einschließlich Teamleiter bezogen.',
      `Datensätze: ${body.length}`,
    ],
    sep: ';',
  });
}

// ----------------------------------------------------------------------
// HC12 DE Weiterbildungsnachweis（セミコロン区切り）
// ----------------------------------------------------------------------

function buildHc12(): string {
  const r = rng(0x48431212);
  const body: Cell[][] = [];
  let stunden = 0;
  let kosten = 0;

  for (let i = 0; i < 34; i += 1) {
    const teilnehmer = intBetween(r, 4, 68);
    const gesamt = Math.round(teilnehmer * between(r, 2, 14) * 10) / 10;
    const cost = Math.round(gesamt * between(r, 40, 120));
    stunden += gesamt;
    kosten += cost;
    body.push([
      `WB-${zeroPad(200 + i, 4)}`,
      `Schulung ${i + 1}`,
      pick(r, ['Compliance', 'Technik', 'Führung', 'Sprache', 'Arbeitssicherheit'] as const),
      i % 5 === 0 ? 'Pflicht' : 'Freiwillig',
      fmtDe(teilnehmer, 0),
      fmtDe(gesamt, 1),
      fmtDe(Math.round((gesamt / teilnehmer) * 10) / 10, 1),
      fmtDe(cost, 2),
      'GJ2026',
    ]);
  }

  body.push([
    '',
    'Gesamtsumme',
    '',
    '',
    '',
    fmtDe(Math.round(stunden * 10) / 10, 1),
    '',
    fmtDe(kosten, 2),
    'GJ2026',
  ]);

  return report({
    preamble: [
      'Weiterbildungsnachweis GJ2026',
      'Aomi Technology GmbH',
      'Erstellt: 01.04.2027',
      'Abgrenzung: alle Beschäftigten einschließlich Teilzeit',
      '',
    ],
    header: [
      'Kurs-ID',
      'Kursbezeichnung',
      'Kategorie',
      'Pflicht/Freiwillig',
      'Teilnehmer',
      'Gesamtstunden',
      'Stunden je Teilnehmer',
      'Kosten (EUR)',
      'Zeitraum',
    ],
    body,
    trailer: [`Datensätze: ${body.length - 1}`],
    sep: ';',
  });
}

// ----------------------------------------------------------------------
// HC13 FR Bilan social（1 234,5 形式・cadres 基準）
// ----------------------------------------------------------------------

function buildHc13(): string {
  const r = rng(0x48431313);
  const SERVICES = [
    ['0100', 'Direction générale'],
    ['0200', 'Commercial'],
    ['0300', 'Recherche et développement'],
    ['0400', 'Production'],
    ['0500', 'Logistique'],
    ['0600', 'Administration'],
  ] as const;

  const body: Cell[][] = [];
  let effectifTotal = 0;
  let cadres = 0;
  let femmesCadres = 0;

  for (const [code, name] of SERVICES) {
    for (const categorie of ['Cadres', 'Agents de maîtrise', 'Employés'] as const) {
      for (const sexe of ['Homme', 'Femme'] as const) {
        const effectif = intBetween(r, 2, 18);
        effectifTotal += effectif;
        if (categorie === 'Cadres') {
          cadres += effectif;
          if (sexe === 'Femme') femmesCadres += effectif;
        }
        body.push([
          code,
          name,
          categorie,
          sexe,
          fmtFr(effectif, 0),
          fmtFr(between(r, 3, 19), 1),
          fmtFr(between(r, 88, 99), 1),
          '2026',
        ]);
      }
    }
    body.push(['', `${name} Sous-total`, '', '', '', '', '', '2026']);
  }

  const part = Math.round((femmesCadres / Math.max(1, cadres)) * 1000) / 10;
  body.push(['', 'Total général', '', '', fmtFr(effectifTotal, 0), '', '', '2026']);
  body.push(['', 'Part des femmes cadres', '', '', fmtFr(part, 1), '%', '', '2026']);

  return report({
    preamble: [
      'Bilan social / BDESE - Exercice 2026',
      'Aomi Technology SAS',
      'Date de génération: 01/04/2027',
      'Périmètre: exercice fiscal 2026',
      'Catégorie: cadres au sens de la convention collective',
      '',
    ],
    header: [
      'Code service',
      'Service',
      'Catégorie socio-professionnelle',
      'Sexe',
      'Effectif',
      'Ancienneté moyenne',
      'Écart de rémunération (moyenne)',
      'Periode',
    ],
    body,
    trailer: [
      "Note: l'index de l'égalité professionnelle est calculé sur les cadres.",
      `Nombre d'enregistrements: ${body.length}`,
    ],
  });
}

// ----------------------------------------------------------------------
// HC14 UK Gender Pay Gap（法定様式・縦持ち）
// ----------------------------------------------------------------------

function buildHc14(): string {
  const body: Cell[][] = [
    ['Mean gender pay gap in hourly pay', 11.9, '%', 'mean hourly pay'],
    ['Median gender pay gap in hourly pay', 8.2, '%', 'median hourly pay'],
    ['Mean bonus gender pay gap', 21.4, '%', 'mean bonus pay'],
    ['Median bonus gender pay gap', 14.7, '%', 'median bonus pay'],
    ['Proportion of males receiving a bonus payment', 81.3, '%', 'headcount'],
    ['Proportion of females receiving a bonus payment', 72.9, '%', 'headcount'],
    ['Proportion of males in lower quartile', 44.1, '%', 'quartile'],
    ['Proportion of females in lower quartile', 55.9, '%', 'quartile'],
    ['Proportion of males in lower middle quartile', 52.7, '%', 'quartile'],
    ['Proportion of females in lower middle quartile', 47.3, '%', 'quartile'],
    ['Proportion of males in upper middle quartile', 61.4, '%', 'quartile'],
    ['Proportion of females in upper middle quartile', 38.6, '%', 'quartile'],
    ['Proportion of males in upper quartile', 72.8, '%', 'quartile'],
    ['Proportion of females in upper quartile', 27.2, '%', 'quartile'],
    ['Women in management (all people managers)', 31.6, '%', 'headcount'],
  ];

  return report({
    preamble: [
      'Gender Pay Gap Report 2026',
      'Aomi Technology UK Ltd.',
      'Snapshot date: 5 April 2026',
      `Relevant employees: ${HC_MASTER.overseasRegular.uk}`,
      'Scope: full-pay relevant employees only, including part-time',
      '',
    ],
    header: ['Measure', 'Value', 'Unit', 'Basis'],
    body,
    trailer: [
      'Written statement: confirmed by a director of the company.',
      'Note: figures are calculated on median hourly pay as required by the regulations.',
      `Total records: ${body.length}`,
    ],
  });
}

// ----------------------------------------------------------------------
// HC15 CN 人事月报（前年同期の列を持つ＝値の取り違えの罠）
// ----------------------------------------------------------------------

function buildHc15(): string {
  const r = rng(0x48431515);
  const DEPTS = [
    ['0110', '综合管理部'],
    ['0210', '销售一部'],
    ['0220', '销售二部'],
    ['0310', '技术开发部'],
    ['0320', '生产一部'],
    ['0330', '生产二部'],
    ['0410', '质量管理部'],
    ['0420', '物流部'],
  ] as const;

  const body: Cell[][] = [];
  let regular = 0;
  let withDispatch = 0;
  let managers = 0;
  let femaleManagers = 0;

  for (const [code, name] of DEPTS) {
    const formal = intBetween(r, 18, 62);
    const dispatch = intBetween(r, 4, 26);
    const female = Math.round(formal * between(r, 0.28, 0.52));
    const mgr = intBetween(r, 2, 9);
    const femaleMgr = intBetween(r, 0, Math.max(1, Math.floor(mgr / 2)));
    regular += formal;
    withDispatch += formal + dispatch;
    managers += mgr;
    femaleManagers += femaleMgr;
    body.push([
      code,
      name,
      formal,
      formal + dispatch,
      female,
      mgr,
      femaleMgr,
      Math.round((femaleMgr / Math.max(1, mgr)) * 1000) / 10,
      intBetween(r, 0, 9),
      intBetween(r, 0, 7),
      // 前年同期の列。左から走査すると当年値と取り違える
      Math.round((formal + dispatch) * between(r, 0.92, 1.06)),
      '2026',
    ]);
    body.push(['', `${name} 小计`, formal, formal + dispatch, '', '', '', '', '', '', '', '2026']);
  }

  const ratio = Math.round((femaleManagers / Math.max(1, managers)) * 1000) / 10;
  body.push([
    '',
    '合计',
    regular,
    withDispatch,
    '',
    managers,
    femaleManagers,
    ratio,
    '',
    '',
    '',
    '2026',
  ]);
  body.push(['', '女性管理职比率', '', '', '', '', '', ratio, '', '', '', '2026']);

  return report({
    preamble: [
      '人事月报（华东工厂）',
      '青海科技(华东)有限公司',
      '导出时间:2027-04-01 08:00',
      '统计口径:用工总数含劳务派遣人员 / 管理职为主管以上',
      '统计期间:2026年 1月-12月（历年）',
      '',
    ],
    header: [
      '部门编码',
      '部门名称',
      '在册人数(正式员工)',
      '用工总数(含劳务派遣)',
      '其中女性',
      '管理职(主管以上)',
      '女性管理职',
      '女性管理职比率',
      '入职',
      '离职(含试用期)',
      '上年同期用工总数',
      '统计期间',
    ],
    body,
    trailer: [
      '※ 劳务派遣人员按用工总数口径统计，不计入在册人数。',
      '※ 离职率按含试用期口径计算。',
      `记录数: ${body.length}`,
    ],
  });
}

// ----------------------------------------------------------------------
// HC16 CN 培训台账
// ----------------------------------------------------------------------

function buildHc16(): string {
  const r = rng(0x48431616);
  const body: Cell[][] = [];
  let hours = 0;

  for (let i = 0; i < 72; i += 1) {
    const attendees = intBetween(r, 6, 88);
    const each = between(r, 1, 12);
    const total = Math.round(attendees * each * 10) / 10;
    hours += total;
    body.push([
      `PX-${zeroPad(300 + i, 4)}`,
      `培训课程 ${i + 1}`,
      pick(r, ['合规', '技术', '管理', '语言', '安全'] as const),
      i % 6 === 0 ? '必修' : '选修',
      attendees,
      total,
      each,
      ymd8(2026, intBetween(r, 1, 12), intBetween(r, 1, 28)),
      '2026',
    ]);
  }

  body.push(['', '合计', '', '', '', Math.round(hours * 10) / 10, '', '', '2026']);
  body.push([
    '',
    '人均培训时长',
    '',
    '',
    '',
    Math.round((hours / HC_MASTER.overseasRegular.cn) * 10) / 10,
    '小时',
    '',
    '2026',
  ]);

  return report({
    preamble: [
      '培训台账',
      '青海科技(华东)有限公司 人力资源部',
      '导出时间:2027-01-15',
      '统计口径:在册正式员工 / 历年',
      '',
    ],
    header: [
      '课程编码',
      '课程名称',
      '类别',
      '必修/选修',
      '参加人数',
      '总培训时长',
      '人均时长',
      '开课日期',
      '统计期间',
    ],
    body,
    trailer: ['※ 人均培训时长按在册正式员工人数计算。', `记录数: ${body.length - 2}`],
  });
}

// ----------------------------------------------------------------------
// HC17 IN HR MIS（2 段ヘッダー: 機械キー + 表示ラベル）
// ----------------------------------------------------------------------

function buildHc17(): string {
  const r = rng(0x48431717);
  const DEPTS = ['Corporate', 'Sales', 'Engineering', 'Manufacturing', 'Quality', 'Support'];
  const body: Cell[][] = [];
  let total = 0;
  let managers = 0;
  let femaleManagers = 0;

  for (const dept of DEPTS) {
    for (const band of ['Band 1', 'Band 2', 'Band 3', 'Band 4', 'Band 5', 'Band 6'] as const) {
      for (const gender of ['Male', 'Female'] as const) {
        const headcount = intBetween(r, 2, 26);
        total += headcount;
        const isManager = band === 'Band 4' || band === 'Band 5' || band === 'Band 6';
        if (isManager) {
          managers += headcount;
          if (gender === 'Female') femaleManagers += headcount;
        }
        body.push([
          'Active',
          `IN${zeroPad(intBetween(r, 1, 9999), 6)}`,
          dept,
          band,
          gender,
          headcount,
          isManager ? headcount : 0,
          isManager && gender === 'Female' ? headcount : 0,
          between(r, 8, 22),
          between(r, 2, 9),
          pick(r, ['Bengaluru', 'Pune', 'Chennai'] as const),
          'CY2026',
        ]);
      }
    }
  }

  const ratio = Math.round((femaleManagers / Math.max(1, managers)) * 1000) / 10;
  body.push(['', '', 'Grand Total', '', '', total, managers, femaleManagers, '', '', '', 'CY2026']);
  body.push([
    '',
    '',
    'Women in management (Band 4 and above)',
    '',
    '',
    '',
    '',
    ratio,
    '',
    '',
    '',
    'CY2026',
  ]);

  // 1 段目は SAP SuccessFactors のシステムキー、2 段目が表示ラベル
  const systemKeys: Cell[] = [
    'STATUS',
    'USERID',
    'DEPARTMENT',
    'BAND',
    'GENDER',
    'HEADCOUNT',
    'MANAGERS',
    'FEMALE_MANAGERS',
    'ATTRITION_RATE',
    'AVG_TENURE',
    'LOCATION',
    'PERIOD',
  ];
  const labels: Cell[] = [
    'Status',
    'User ID',
    'Department',
    'Band',
    'Gender',
    'Headcount',
    'Managers',
    'Female managers',
    'Attrition rate',
    'Average tenure',
    'Location',
    'Period',
  ];

  return report({
    preamble: [
      'HR MIS Report CY2026',
      'Aomi Technology India Private Limited',
      'Generated: 15-Jan-2027 11:20 IST',
      'Scope: on-roll employees only, excludes contractors',
      'Managers are defined as Band 4 and above',
      '',
    ],
    header: systemKeys,
    body: [labels, ...body],
    trailer: [
      'Note: Managers are defined as Band 4 and above. Reporting period is the calendar year (CY2026).',
      `Total records: ${body.length}`,
    ],
  });
}

// ----------------------------------------------------------------------
// HC18 APAC HR ダッシュボード（Excel 3 シート）
// ----------------------------------------------------------------------

function buildHc18Sheets(): Array<{ name: string; rows: Cell[][] }> {
  const entities: Cell[][] = [
    [
      'JP-HQ',
      'Japan',
      'LE-1001',
      100,
      'full',
      '2027-03-31',
      'COMPANY',
      506,
      498.2,
      506,
      24,
      31,
      34.6,
      74,
      15.1,
    ],
    [
      'JP-EAST',
      'Japan',
      'LE-1002',
      100,
      'full',
      '2027-03-31',
      'COMPANY',
      494,
      486.5,
      494,
      62,
      44,
      22.1,
      58,
      8.6,
    ],
    [
      'JP-WEST',
      'Japan',
      'LE-1003',
      100,
      'full',
      '2027-03-31',
      'PCA',
      240,
      236.0,
      240,
      18,
      12,
      26.7,
      29,
      10.3,
    ],
    [
      'US',
      'United States',
      'LE-2001',
      100,
      'full',
      '2026-12-31',
      'Workday',
      214,
      211.4,
      214,
      8,
      16,
      38.3,
      43,
      21.8,
    ],
    [
      'DE',
      'Germany',
      'LE-3001',
      100,
      'full',
      '2027-03-31',
      'SAP HCM',
      142,
      133.8,
      142,
      12,
      9,
      41.5,
      26,
      32.4,
    ],
    [
      'FR',
      'France',
      'LE-3002',
      100,
      'full',
      '2026-12-31',
      'SAP HCM',
      118,
      114.2,
      118,
      9,
      6,
      44.1,
      21,
      28.6,
    ],
    [
      'UK',
      'United Kingdom',
      'LE-3003',
      100,
      'full',
      '2026-04-05',
      'Workday',
      96,
      91.7,
      96,
      14,
      4,
      46.9,
      18,
      31.6,
    ],
    [
      'CN',
      'China',
      'LE-4001',
      100,
      'full',
      '2026-12-31',
      'Local HR',
      310,
      310.0,
      310,
      0,
      82,
      36.1,
      47,
      19.4,
    ],
    [
      'IN',
      'India',
      'LE-4002',
      100,
      'full',
      '2026-12-31',
      'SuccessFactors',
      268,
      265.3,
      268,
      6,
      22,
      29.5,
      51,
      24.7,
    ],
    [
      'APAC-JV',
      'Thailand',
      'LE-4003',
      49,
      'equity',
      '2026-12-31',
      'Local HR',
      186,
      183.1,
      180,
      6,
      34,
      41.9,
      22,
      18.2,
    ],
  ];

  const subsidiaries = entities
    .filter((e) => e[4] === 'full')
    .reduce((s, e) => s + Number(e[7]), 0);
  const jv = Number(entities.find((e) => e[4] === 'equity')?.[7] ?? 0);

  const withSubtotals: Cell[][] = [
    ...entities.slice(0, 3),
    ['', 'Japan Subtotal', '', '', '', '', '', 1240, '', '', '', '', '', '', ''],
    ...entities.slice(3, 9),
    ['', 'Overseas Subtotal', '', '', '', '', '', subsidiaries - 1240, '', '', '', '', '', '', ''],
    ...entities.slice(9),
    [
      '',
      'Total (consolidated subsidiaries only)',
      '',
      '',
      '',
      '',
      '',
      subsidiaries,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
  ];

  return [
    {
      name: 'Entities',
      rows: [
        ['APAC HR Dashboard FY2026', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        [
          'Aomi Technology Group - Regional HQ',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ],
        ['Generated: 2027-04-10', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        [
          'Scope: consolidated subsidiaries and equity-method JV',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        [
          'Entity',
          'Country',
          'Legal Entity ID',
          'Ownership %',
          'Consolidation Method',
          'Reporting Date',
          'Source System',
          'Employees',
          'FTE',
          'Permanent',
          'Fixed-term',
          'Outsourced',
          'Female %',
          'Managers',
          'Female Managers %',
        ],
        ...withSubtotals,
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        [
          'Note: JV is accounted for under the equity method and is not consolidated.',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ],
        [
          `Total records: ${entities.length}`,
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ],
      ],
    },
    {
      name: 'Summary',
      rows: [
        ['Measure', 'Value', 'Unit', 'Basis'],
        [
          'Total employees (subsidiaries only)',
          subsidiaries,
          'persons',
          'consolidated subsidiaries only',
        ],
        [
          'Total employees (incl. equity-method JV at 100%)',
          subsidiaries + jv,
          'persons',
          'including equity-method JV',
        ],
        [
          'Total employees (JV at 49% proportional)',
          subsidiaries + Math.round(jv * 0.49),
          'persons',
          'JV (49% owned) proportional',
        ],
        ['Reporting date range', '2026-04-05 to 2027-03-31', 'date', 'mixed reporting dates'],
      ],
    },
    {
      name: 'Legend',
      rows: [
        ['Field', 'Value', 'Meaning'],
        ['Consolidation Method', 'full', 'Fully consolidated subsidiary'],
        ['Consolidation Method', 'equity', 'Equity-method associate or JV (not consolidated)'],
        ['Consolidation Method', 'proportionate', 'Proportionally consolidated'],
        ['Reporting Date', '2026-04-05', 'UK statutory snapshot date (5 April)'],
      ],
    },
  ];
}

// ----------------------------------------------------------------------
// HC19 エンゲージメントサーベイ（Excel 2 シート・セル内改行の多値）
// ----------------------------------------------------------------------

function buildHc19Sheets(): Array<{ name: string; rows: Cell[][] }> {
  const r = rng(0x48431919);
  const REGIONS = ['Japan', 'Americas', 'EMEA', 'APAC'] as const;
  const CATEGORIES = [
    'Engagement',
    'Manager quality',
    'Career growth',
    'Wellbeing',
    'Inclusion',
    'Compensation',
  ] as const;

  const scores: Cell[][] = [];
  for (const region of REGIONS) {
    let regionResponses = 0;
    for (const category of CATEGORIES) {
      const responses = intBetween(r, 80, 420);
      regionResponses += responses;
      scores.push([
        region,
        `${region} entities`,
        category,
        `Q-${zeroPad(CATEGORIES.indexOf(category) + 1, 2)}`,
        between(r, 3.1, 4.6),
        responses,
        `${between(r, 62, 94)} %`,
        'FY2026',
      ]);
    }
    scores.push([region, `${region} Subtotal`, '', '', '', regionResponses, '', 'FY2026']);
  }
  scores.push(['All', 'Overall', '', '', 3.9, '', '', 'FY2026']);

  const detail: Cell[][] = [];
  for (let i = 0; i < 180; i += 1) {
    const dist = [
      intBetween(r, 0, 12),
      intBetween(r, 2, 24),
      intBetween(r, 10, 60),
      intBetween(r, 20, 110),
      intBetween(r, 8, 46),
    ];
    detail.push([
      pick(r, REGIONS),
      pick(r, CATEGORIES),
      `Q-${zeroPad(intBetween(r, 1, 6), 2)}`,
      // 多値セル（1〜5 の分布を改行で持つ）
      dist.join('\n'),
      dist.reduce((s, v) => s + v, 0),
    ]);
  }

  return [
    {
      name: 'Scores',
      rows: [
        ['Employee Engagement Survey FY2026', '', '', '', '', '', '', ''],
        ['Aomi Technology Group', '', '', '', '', '', '', ''],
        ['Survey period: 2026-11-01 to 2026-11-30', '', '', '', '', '', '', ''],
        ['Scope: all workers including fixed-term and part-time', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', ''],
        [
          'Region',
          'Entity',
          'Category',
          'Question Code',
          'Score (1-5)',
          'Responses',
          'Response Rate',
          'Period',
        ],
        ...scores,
        ['', '', '', '', '', '', '', ''],
        ['Total records: 24', '', '', '', '', '', '', ''],
      ],
    },
    {
      name: 'Response Detail',
      rows: [
        ['Region', 'Category', 'Question Code', 'Score Distribution (1..5)', 'Responses'],
        ...detail,
      ],
    },
  ];
}

// ----------------------------------------------------------------------
// HC20 Global Human Capital Summary（PDF・英文）
// ----------------------------------------------------------------------

function buildHc20(): string[] {
  const lines: string[] = [
    'Human Capital Disclosure Summary CY2026',
    'Aomi Technology Group',
    'Prepared by: Sustainability Department  /  Generated: 2027-04-12',
    'Reporting basis: calendar year (CY2026)',
    'Scope: all workers including dispatched and contract workers,',
    '       consolidated subsidiaries and equity-method JV',
    '',
    'Indicator                                    Value        Unit     Basis',
    'Total employees (consolidated, excl. JV)     2,506        persons  all workers',
    'Total employees (incl. equity-method JV)     2,692        persons  incl. equity-method JV',
    'Employees in Japan                           1,240        persons  regular employees only',
    'Female employees ratio                       31.8         %        all workers',
    'Women in management                          19.7         %        all people managers',
    'New hires                                    412          persons  all workers',
    'Turnover rate (voluntary + involuntary)      12.4         %        all reasons',
    'Turnover rate (voluntary only)               8.1          %        voluntary only',
    'Average tenure                               9.8          years    all workers',
    'Training hours per employee                  17.8         hours    regular employees only',
    'LTIFR                                        1.42         per Mhr  all workers',
    'Gender pay gap (median)                      8.2          %        median hourly pay',
    '',
    'Reconciliation',
    'Consolidated employees excluding JV          2,506',
    'Equity-method JV (100% basis)                  186',
    'Consolidated employees including JV          2,692',
    'Of which Japan sites (HQ 506 + East 494 + West 240) 1,240',
    '',
    'Note: figures are prepared on a calendar-year basis and therefore differ',
    'from the fiscal-year based Japanese reports (FY2026, starting 1 April).',
    'Note: the Japanese site figures cover regular employees only, whereas the',
    'group totals include dispatched and contract workers.',
    'Total records: 12',
    'End of report',
  ];
  return lines;
}

// ----------------------------------------------------------------------
// 組み立て
// ----------------------------------------------------------------------

const CSV_MIME = 'text/csv';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function buildHumanCapitalDataset(): Promise<DatasetFile[]> {
  const files: DatasetFile[] = [];

  const table = (name: string, mimeType: string, bytes: Uint8Array) =>
    files.push({ name, mimeType, bytes, kind: 'table' });
  const pdf = (name: string, lines: string[]) =>
    files.push({ name, mimeType: 'application/pdf', bytes: buildSimplePdf(lines), kind: 'pdf' });

  table('HC01_日本_本社_在籍者集計表_FY2026.csv', CSV_MIME, utf8Bom(buildHc01()));
  table('HC02_日本_東日本工場_月次人員推移_SJIS.csv', CSV_MIME, encodeSjis(buildHc02()));
  table('HC03_日本_本社_採用者明細_FY2026.csv', CSV_MIME, utf8Bom(buildHc03()));
  table('HC04_日本_全社_退職者一覧_FY2026.csv', CSV_MIME, utf8Bom(buildHc04()));
  table('HC05_日本_研修受講記録_FY2026.xlsx', XLSX_MIME, await buildXlsx(buildHc05Sheets()));
  table('HC06_日本_等級別賃金_男女別_FY2026.csv', CSV_MIME, utf8Bom(buildHc06()));
  pdf('HC07_EHS_Annual_Report_FY2026.pdf', buildHc07());
  table('HC08_日本_人事KPIサマリー_FY2026.csv', CSV_MIME, utf8Bom(buildHc08()));
  table('HC09_US_EEO1_Component1_CY2026.csv', CSV_MIME, utf8Bom(buildHc09()));
  pdf('HC10_US_Pay_Equity_Statement_CY2026.pdf', buildHc10());
  table('HC11_DE_Personalbericht_GJ2026.csv', CSV_MIME, utf8Bom(buildHc11()));
  table('HC12_DE_Weiterbildungsnachweis_GJ2026.csv', CSV_MIME, utf8Bom(buildHc12()));
  table('HC13_FR_Bilan_social_2026.csv', CSV_MIME, utf8Bom(buildHc13()));
  table('HC14_UK_Gender_Pay_Gap_2026.csv', CSV_MIME, utf8Bom(buildHc14()));
  table('HC15_CN_华东工厂_人事月报_2026.csv', CSV_MIME, utf8Bom(buildHc15()));
  table('HC16_CN_培训台账_2026.csv', CSV_MIME, utf8Bom(buildHc16()));
  table('HC17_IN_HR_MIS_CY2026.csv', CSV_MIME, utf8Bom(buildHc17()));
  table('HC18_APAC_HR_Dashboard_FY2026.xlsx', XLSX_MIME, await buildXlsx(buildHc18Sheets()));
  table('HC19_Global_Engagement_Survey_FY2026.xlsx', XLSX_MIME, await buildXlsx(buildHc19Sheets()));
  pdf('HC20_Global_Human_Capital_Summary_CY2026.pdf', buildHc20());

  return files;
}
