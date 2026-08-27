import type { MetricDefinition } from '@/types/domain';

/**
 * 取り込んだ行が、指標マスターと関係のある行かどうかの判定。
 *
 * 実際の社内ファイルには、非財務データと無関係な行がいくらでも混ざる。
 * 人事システムの出力なら社員名簿、経理の集計表なら勘定科目、
 * 部門一覧・住所録・改版履歴。これらに対して 1 行ずつ
 * 「指標を特定できませんでした」と警告を出すと、本当に確認が要る行
 * （指標に近いのに特定できなかった行）が警告の山に埋もれる。
 *
 * そこで、指標マスターと語彙がまったく重ならない行は、警告を出さず
 * 取り込み対象外として静かに外す。
 *
 * 判定は規則ベースにする。AI にしないのは「なぜこの行を取り込まなかったか」を
 * 監査法人へ再現して説明する必要があるため（`row-role.ts`・`boundary.ts` と同じ方針）。
 *
 * 判定は**取り込む側へ倒す**。無関係と誤判定すると本物のデータが黙って消えるので、
 * 少しでも指標マスターと重なる語があれば関係ありとして残す。
 */

/** 語彙として短すぎて誤検知の元になる語（「人」「計」「率」など 1 文字）は捨てる */
const MIN_TOKEN_LENGTH = 2;

/**
 * 指標名を語へ割るときの区切り。
 * 「Scope3 Category 1（購入した製品・サービス）」→ scope3 / category / 購入した製品 / サービス
 */
const TOKEN_SEPARATOR = /[\s\u3000（）()［］[\]{}・/／,、,.。:：;；|"'’“”—–\-‐−~〜]+/u;

/**
 * どの指標にも属さないが、非財務データの行であることを示す語。
 * 指標名そのものが載っていなくても、この語があれば人が確認する価値がある。
 */
const DOMAIN_HINTS = [
  '排出',
  '使用量',
  '消費量',
  '取水',
  '排水',
  '廃棄',
  'リサイクル',
  '再生可能',
  '従業員',
  '社員',
  '管理職',
  '役員',
  '女性',
  '男性',
  '離職',
  '採用',
  '研修',
  '教育',
  '災害',
  '休業',
  '賃金',
  '給与',
  '報酬',
  '育児',
  '通報',
  '腐敗',
  '炭素',
  '気候',
  'エネルギー',
  '電力',
  '電気',
  'ガス',
  '燃料',
  '水',
  'scope',
  'co2',
  'ghg',
  'emission',
  'energy',
  'water',
  'waste',
  'employee',
  'headcount',
];

/**
 * 物理量・金額の単位。指標マスターに載っている単位だけでは足りない。
 *
 * 「圧縮空気（購入分）, 18.4, GJ」のように、**指標マスターにまだ無い**エネルギーでも
 * 単位が付いていれば、それは人が指標を選べば取り込める行であって、無関係な行ではない。
 * こういう行まで黙って外すと、本物のデータが台帳から消える。
 */
const MEASUREMENT_UNITS = new Set(
  [
    // エネルギー
    'kwh',
    'mwh',
    'gwh',
    'kw',
    'mw',
    'gj',
    'mj',
    'tj',
    'kj',
    'kl',
    'l',
    'リットル',
    'nm3',
    // 温室効果ガス
    't-co2',
    't-co2e',
    'tco2',
    'tco2e',
    'kg-co2',
    'kg-co2e',
    'co2t',
    // 質量・体積
    't',
    'kg',
    'g',
    'mg',
    'トン',
    'キログラム',
    'm3',
    '㎥',
    'm³',
    'm2',
    '㎡',
    // 割合・件数・時間・人
    '%',
    '％',
    'ppm',
    'ppb',
    '人',
    '名',
    '件',
    '回',
    '日',
    '時間',
    'h',
    'hr',
    'hrs',
    '人日',
    '人時',
    // 金額
    '円',
    '千円',
    '百万円',
    '億円',
    'jpy',
    'usd',
    'eur',
    '$',
    '€',
  ].map((u) => u.normalize('NFKC').toLowerCase()),
);

/** 「18.4 GJ」「120MWh」のように、数値の直後に単位が付いた書き方 */
const VALUE_WITH_UNIT =
  /\d\s*(kwh|mwh|gwh|gj|mj|tj|kj|t-?co2e?|tco2e?|m3|㎥|m³|kg|t|kl|l|%|％|ppm|人|名|件|時間|千円|百万円|億円|円)\b/i;

/**
 * 行のどこかに計量単位があるか。
 * 単位があるということは、それは何かを測った行であり、
 * 指標マスターに名前が無くても人が指標を選べば取り込める。
 *
 * 見るのは**セルの中身**であって列名ではない。「単位」という列がある表に
 * 名簿が紛れ込むと、その列に「主任」「担当」が入る。列名で判定すると
 * こうした行まで計量済みとみなしてしまい、除外がまったく効かなくなる。
 */
export function hasMeasurementUnit(raw: Record<string, string>): boolean {
  for (const value of Object.values(raw)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const normalized = normalize(value);

    // 単位そのものが 1 セルに入っている（「単位」列の中身）
    if (MEASUREMENT_UNITS.has(normalized)) return true;
    // 数値と単位が同じセルに入っている（「1,240 kWh」）
    if (VALUE_WITH_UNIT.test(normalized)) return true;
  }
  return false;
}

export interface MetricVocabulary {
  /** 指標コード（完全一致で照合） */
  codes: ReadonlySet<string>;
  /** 指標名・説明から取り出した語 */
  words: ReadonlySet<string>;
  /** 指標の単位（t-CO2e / MWh / m3 / 人 …） */
  units: ReadonlySet<string>;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(TOKEN_SEPARATOR)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TOKEN_LENGTH);
}

/**
 * 指標マスターから照合用の語彙を作る。
 * 説明文は入れない（「合計」「その他」のような一般語が混ざり、何でも一致してしまう）。
 */
export function buildMetricVocabulary(metrics: MetricDefinition[]): MetricVocabulary {
  const codes = new Set<string>();
  const words = new Set<string>();
  const units = new Set<string>();

  for (const metric of metrics) {
    codes.add(normalize(metric.code));
    for (const token of tokenize(metric.name)) words.add(token);
    const unit = normalize(metric.unit);
    if (unit.length > 0) units.add(unit);
    const baseUnit = normalize(metric.baseUnit);
    if (baseUnit.length > 0) units.add(baseUnit);
  }
  for (const hint of DOMAIN_HINTS) words.add(normalize(hint));

  return { codes, words, units };
}

/**
 * 行が指標マスターと関係するか。
 *
 * ヘッダー名も一緒に見る。値の側に指標名が無くても
 * 「電力使用量」という列名の下に数字が並ぶ形が実務では多いため。
 */
export function isRelevantToMetrics(
  raw: Record<string, string>,
  vocabulary: MetricVocabulary,
): boolean {
  // 計量単位があれば、指標マスターに名前が無くても取り込む余地のある行。
  // 「圧縮空気（購入分）, 18.4, GJ」を黙って外さないための歯止め
  if (hasMeasurementUnit(raw)) return true;

  for (const [header, value] of Object.entries(raw)) {
    for (const text of [header, value]) {
      if (typeof text !== 'string' || text.trim() === '') continue;
      const normalized = normalize(text);

      // 指標コードがそのまま入っている（scope1 など）
      if (vocabulary.codes.has(normalized)) return true;
      // 単位が入っている（t-co2e / mwh / m3）
      if (vocabulary.units.has(normalized)) return true;

      for (const token of tokenize(text)) {
        if (vocabulary.codes.has(token)) return true;
        if (vocabulary.units.has(token)) return true;
        if (vocabulary.words.has(token)) return true;
      }

      // 日本語は空白で切れないことが多いので、語の含有でも見る。
      // 「当年度の電力使用量について」のような文でも拾えるようにする
      for (const word of vocabulary.words) {
        if (word.length >= 3 && normalized.includes(word)) return true;
      }
    }
  }
  return false;
}

/**
 * 表全体のうち、これを超える割合が無関係と判定されたら「ファイルごと無関係」とみなす。
 *
 * 1 行ずつ黙って外すのは、無関係な行が少数混ざっている場合に限る。
 * ほとんどの行が外れるなら、それは指標マスターと関係のない資料を取り込んだか、
 * こちらの判定が壊れているかのどちらかで、どちらも人へ伝えるべきこと。
 */
export const IRRELEVANT_FILE_RATIO = 0.8;

/** ファイルごと無関係だったときに、1 回だけ出すメッセージ */
export const IRRELEVANT_FILE_MESSAGE =
  '指標マスターに対応する数値が見つかりませんでした。' +
  '資料としては保管しますが、数値の行としては取り込んでいません。';

/** 静かに外した行があることを、件数としてだけ伝えるメッセージ */
export function irrelevantRowsNote(count: number): string {
  return `指標マスターと関係の無い ${count} 行を取り込み対象外にしました（警告は出していません）`;
}
