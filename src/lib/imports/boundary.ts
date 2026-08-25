/**
 * バウンダリ（集計範囲）の検知。
 *
 * 人的資本データは、同じ名前の指標でも国・拠点ごとに集計範囲が食い違う。
 * 数字だけを見て同じ指標へ丸めると、比較できない値が混ざったまま台帳に入る。
 *
 * ここでは行のテキストから「どの範囲で集計された値か」を規則ベースで拾い、
 * **同じ指標に異なるバウンダリが混在したとき**に警告を作る。
 * AI 判定にはしない（根拠が再現し、監査法人へ説明できるため。
 * 「連結対象のみ」タグと同じ方針）。
 *
 * 検知はカテゴリごとに行う。同じカテゴリで 2 つ以上のラベルが出たら差異とみなす。
 */

export type BoundaryCategory =
  | 'employment' // 雇用範囲
  | 'manager' // 管理職の定義
  | 'period' // 期間の基準
  | 'method' // 算定方法（平均値 / 中央値）
  | 'turnover' // 離職の範囲
  | 'consolidation'; // 連結の範囲

export const BOUNDARY_CATEGORY_LABEL: Record<BoundaryCategory, string> = {
  employment: '雇用範囲',
  manager: '管理職の定義',
  period: '期間の基準',
  method: '算定方法',
  turnover: '離職の範囲',
  consolidation: '連結の範囲',
};

interface BoundaryRule {
  category: BoundaryCategory;
  label: string;
  pattern: RegExp;
  /** このパターンも同時に現れたときだけ有効（誤検知の抑制） */
  requires?: RegExp;
}

/**
 * 検知規則。ラベルは日本語へ正規化する（多言語のファイルを 1 つの物差しで比べるため）。
 * パターンは「範囲の宣言」だけを拾い、指標名そのものには反応させない。
 */
const RULES: BoundaryRule[] = [
  // 雇用範囲
  {
    category: 'employment',
    label: '正社員のみ',
    pattern:
      /正社員のみ|正社員・期末|regular (full[- ]?time( employees)?|ft) only|excludes? contractors|on-?roll only|派遣.{0,4}除く/i,
  },
  {
    category: 'employment',
    label: '派遣・臨時を含む',
    pattern:
      /派遣を含む|派遣社員を含む|含労务派遣|含劳务派遣|labou?r dispatch|incl(uding|\.)? (temporary|dispatched|contract(ors)?)|temporary staff|all workers|全就業者/i,
  },
  {
    category: 'employment',
    label: 'パートタイムを含む',
    pattern:
      /パート(タイム)?(を)?含む|incl(uding|\.)? part[- ]?time|inkl\.? teilzeit|temps partiel inclus/i,
  },
  // 管理職の定義
  {
    category: 'manager',
    label: '課長相当職以上',
    pattern: /課長相当職?以上|section manager\+?|section manager and above/i,
  },
  {
    category: 'manager',
    label: '部長相当職以上',
    pattern: /部長相当職?以上|director( level)? and above/i,
  },
  {
    category: 'manager',
    label: 'チームリーダーを含む',
    pattern:
      /チームリーダー(を)?含む|einschließlich teamleiter|alle führungsebenen|team leads? included/i,
  },
  {
    category: 'manager',
    label: 'EEO-1（Officials and Managers）',
    pattern: /officials (and|&) managers|eeo-?1/i,
  },
  {
    category: 'manager',
    label: '社内等級基準（Band / Grade）',
    pattern: /band\s*\d\s*(and above|以上|\+)|grade\s*\d+\s*(and above|以上)/i,
  },
  { category: 'manager', label: 'cadre（労働協約上の区分）', pattern: /\bcadres?\b/i },
  { category: 'manager', label: '主管以上', pattern: /主管以上/ },
  // 期間の基準
  {
    category: 'period',
    label: '年度（4月起点）',
    pattern: /FY\s?20\d{2}|GJ\s?20\d{2}|年度|事業年度|exercice fiscal/i,
  },
  {
    category: 'period',
    label: '暦年',
    pattern: /CY\s?20\d{2}|暦年|calendar year|kalenderjahr|1月[〜～-]12月/i,
  },
  {
    category: 'period',
    label: '特定基準日（4月5日）',
    pattern: /snapshot (date:? )?5 apr(il)?|5 april/i,
  },
  // 算定方法（賃金系の文脈に限定。平均勤続年数などの「平均」を拾わないため）
  {
    category: 'method',
    label: '平均値ベース',
    pattern: /平均値|mean[,)]|mean basis|\(mean|mean hourly|mean, unadjusted|durchschnittswert/i,
    requires: /賃金|給与|報酬|pay|salary|salaire|entgelt|薪酬|bonus/i,
  },
  {
    category: 'method',
    label: '中央値ベース',
    pattern: /中央値|median/i,
    requires: /賃金|給与|報酬|pay|salary|salaire|entgelt|薪酬|bonus/i,
  },
  // 離職の範囲
  {
    category: 'turnover',
    label: '自己都合のみ',
    pattern: /自己都合のみ|voluntary(,| only)|nur freiwillige|freiwillige abgänge/i,
    requires: /離職|退職|turnover|attrition|fluktuation|離職率|离职|流失/i,
  },
  {
    category: 'turnover',
    label: '会社都合・全事由を含む',
    pattern: /全事由|会社都合を?含む|voluntary \+ involuntary|involuntary|all reasons|含试用期/i,
    requires: /離職|退職|turnover|attrition|terminations|離職率|离职|流失/i,
  },
  // 連結の範囲
  {
    category: 'consolidation',
    label: '持分法適用会社（JV）を含む',
    pattern:
      /持分法.{0,6}含む|equity[- ]method|incl(uding|\.)? (equity-method )?jv|jv \(49%|49% owned/i,
  },
];

export interface DetectedBoundary {
  category: BoundaryCategory;
  label: string;
}

/** 1 行ぶんのテキストからバウンダリ宣言を拾う */
export function detectBoundaries(text: string): DetectedBoundary[] {
  const found: DetectedBoundary[] = [];
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    if (rule.requires && !rule.requires.test(text)) continue;
    if (!found.some((f) => f.category === rule.category && f.label === rule.label)) {
      found.push({ category: rule.category, label: rule.label });
    }
  }
  return found;
}

export interface BoundaryRowInput {
  /** 行の識別子（警告の割り当てに使う） */
  id: string;
  /** 同一指標の判定キー（metricId） */
  metricId: string;
  /** 出所の表示名（ファイル名） */
  fileName: string;
  /** 判定対象のテキスト（raw の値と注記を結合したもの） */
  text: string;
}

/**
 * 同じ指標にバウンダリの異なる行が混在していないかを、取込ジョブ全体で調べる。
 *
 * 戻り値は 行ID → 警告文。差異が見つかったカテゴリのラベルを**持っている行**へ付ける
 * （宣言の無い行まで疑うと、ほぼ全行が要確認になってしまい警告が意味を失う）。
 */
export function findBoundaryConflicts(rows: BoundaryRowInput[]): Map<string, string[]> {
  interface Labelled {
    row: BoundaryRowInput;
    boundary: DetectedBoundary;
  }
  // metricId → category → label → 行とファイル
  const byMetric = new Map<string, Map<BoundaryCategory, Map<string, Labelled[]>>>();

  for (const row of rows) {
    const boundaries = detectBoundaries(row.text);
    if (boundaries.length === 0) continue;
    const categories = byMetric.get(row.metricId) ?? new Map();
    byMetric.set(row.metricId, categories);
    for (const boundary of boundaries) {
      const labels = categories.get(boundary.category) ?? new Map<string, Labelled[]>();
      categories.set(boundary.category, labels);
      const list = labels.get(boundary.label) ?? [];
      list.push({ row, boundary });
      labels.set(boundary.label, list);
    }
  }

  const warnings = new Map<string, string[]>();
  for (const categories of byMetric.values()) {
    for (const [category, labels] of categories) {
      if (labels.size < 2) continue; // 同じカテゴリに 1 種類なら差異なし

      const labelNames = [...labels.keys()];
      for (const [label, entries] of labels) {
        const others = labelNames.filter((name) => name !== label);
        const otherFiles = [
          ...new Set(
            [...labels.entries()]
              .filter(([name]) => name !== label)
              .flatMap(([, list]) => list.map((e) => e.row.fileName)),
          ),
        ];
        const message =
          `バウンダリ差異（${BOUNDARY_CATEGORY_LABEL[category]}）: ` +
          `この行は「${label}」ですが、同じ指標に「${others.join('」「')}」の行が混在しています` +
          `（${otherFiles.slice(0, 3).join(', ')}）。集計範囲を揃えてから確定してください。`;
        for (const entry of entries) {
          const list = warnings.get(entry.row.id) ?? [];
          if (!list.includes(message)) list.push(message);
          warnings.set(entry.row.id, list);
        }
      }
    }
  }
  return warnings;
}
