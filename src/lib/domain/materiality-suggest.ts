import type { MaterialityCategory } from '@/types/domain';

/**
 * 自由記述のマテリアリティ名から、当てはまりそうな区分を提示する。
 *
 * 利用者はまず自社の言葉でマテリアリティ（重要課題）を書く。
 * 「気候変動に伴う炭素価格の上昇」「熟練技術者の確保」——ここから
 * どの区分（環境・社会・ガバナンス）に当たるかを機械が候補として提示し、
 * **選ぶのは利用者**。マテリアリティ名 → 区分 → 項目（対象指標）の順に決まる。
 *
 * 判定は規則ベース。AI にしないのは、なぜその区分を提示したのかを
 * 画面上で根拠（一致した語）ごと見せるため（`row-role.ts` と同じ方針）。
 * クライアント側でも動かすので `server-only` を付けない（秘密情報を含まない）。
 */

export interface CategorySuggestion {
  category: MaterialityCategory;
  label: string;
  /** 入力文と一致した語。空なら根拠なし（それでも選べる） */
  matched: string[];
  /** この区分を選んだ場合に、項目（対象指標）として提案する指標コード */
  metricCodes: string[];
  /** どの SSBJ 基準に関わりやすいか（画面の補足表示用） */
  ssbjHint: string;
}

export interface MaterialitySuggestion {
  /** 一致した語がある区分を先頭に並べた候補（常に 3 区分すべて返す） */
  candidates: CategorySuggestion[];
  /** 最有力の区分。どの語にも一致しなければ null（利用者が自分で選ぶ） */
  top: MaterialityCategory | null;
}

const CATEGORY_LABELS: Record<MaterialityCategory, string> = {
  environment: '環境',
  social: '社会',
  governance: 'ガバナンス',
};

/**
 * 語 → (区分, 提案する指標) の対応表。
 *
 * 指標コードは指標マスター（SSBJ・CDP・CSRD から取り込んだ 60 指標）に実在する
 * ものだけを書く。ここに無いコードを書くと、画面の項目欄が空になる。
 */
interface KeywordRule {
  pattern: RegExp;
  category: MaterialityCategory;
  metricCodes: string[];
  /** 気候関連開示基準（テーマ別第2号）の対象になりやすい語か */
  climate?: boolean;
}

const KEYWORD_RULES: KeywordRule[] = [
  // --- 環境: 気候 ---
  {
    pattern:
      /気候|温暖化|カーボン|炭素|脱炭素|ghg|温室効果|排出|co2|ネットゼロ|移行リスク|物理的リスク/i,
    category: 'environment',
    metricCodes: ['scope1', 'scope2', 'scope3_total', 'energy'],
    climate: true,
  },
  {
    pattern: /エネルギー|電力|再生可能|再エネ|省エネ/i,
    category: 'environment',
    metricCodes: ['energy', 'energy_renewable', 'renewable_ratio'],
    climate: true,
  },
  // --- 環境: その他 ---
  {
    pattern: /水|取水|排水|渇水/i,
    category: 'environment',
    metricCodes: ['water', 'water_withdrawal', 'water_stress_withdrawal'],
  },
  {
    pattern: /廃棄物|リサイクル|資源循環|循環型|ごみ|ゴミ/i,
    category: 'environment',
    metricCodes: ['waste', 'waste_recycled', 'recycling_rate'],
  },
  {
    pattern: /生物多様性|自然資本|森林|生態系/i,
    category: 'environment',
    metricCodes: [],
  },
  {
    pattern: /汚染|化学物質|有害/i,
    category: 'environment',
    metricCodes: ['waste_hazardous'],
  },
  // --- 社会 ---
  {
    pattern: /人的資本|人材|採用|育成|教育|研修|定着|離職|エンゲージメント|技術者|熟練/i,
    category: 'social',
    metricCodes: ['employees', 'training_hours', 'turnover_rate', 'avg_tenure', 'new_hires'],
  },
  {
    pattern: /多様性|ダイバーシティ|女性|ジェンダー|賃金格差|登用/i,
    category: 'social',
    metricCodes: ['female_employees', 'female_manager_ratio', 'gender_pay_gap'],
  },
  {
    pattern: /安全|衛生|労働災害|健康|休業|メンタル/i,
    category: 'social',
    metricCodes: ['ltifr', 'work_related_injuries', 'work_related_fatalities'],
  },
  {
    pattern: /人権|強制労働|児童労働|ハラスメント/i,
    category: 'social',
    metricCodes: ['whistleblower_reports'],
  },
  {
    pattern: /サプライ|調達|取引先|供給網/i,
    category: 'social',
    metricCodes: ['scope3_cat1'],
  },
  {
    pattern: /育児|介護|両立|働き方/i,
    category: 'social',
    metricCodes: ['male_parental_leave_ratio'],
  },
  // --- ガバナンス ---
  {
    pattern: /ガバナンス|取締役|役員|経営体制|監督/i,
    category: 'governance',
    metricCodes: ['officers_total', 'female_officers', 'directors_count'],
  },
  {
    pattern: /コンプライアンス|腐敗|贈収賄|不正|倫理/i,
    category: 'governance',
    metricCodes: ['corruption_cases', 'whistleblower_reports'],
  },
  {
    pattern: /内部統制|リスク管理|情報セキュリティ|サイバー|データ保護|個人情報/i,
    category: 'governance',
    metricCodes: ['whistleblower_reports'],
  },
  {
    pattern: /税|開示体制|株主|資本/i,
    category: 'governance',
    metricCodes: [],
  },
];

/**
 * 自由記述からマテリアリティの区分候補を作る。
 *
 * 一致した語が多い区分ほど上に出す。どの語にも一致しない区分も候補として
 * 返す——機械の提示が外れていても、利用者が正しい区分を選べるようにするため。
 */
export function suggestMaterialityCategory(name: string): MaterialitySuggestion {
  const text = name.normalize('NFKC').trim();

  const perCategory = new Map<
    MaterialityCategory,
    { matched: string[]; metricCodes: string[]; climate: boolean }
  >([
    ['environment', { matched: [], metricCodes: [], climate: false }],
    ['social', { matched: [], metricCodes: [], climate: false }],
    ['governance', { matched: [], metricCodes: [], climate: false }],
  ]);

  if (text !== '') {
    for (const rule of KEYWORD_RULES) {
      const hit = text.match(rule.pattern);
      if (!hit || !hit[0]) continue;
      const entry = perCategory.get(rule.category)!;
      if (!entry.matched.includes(hit[0])) entry.matched.push(hit[0]);
      for (const code of rule.metricCodes) {
        if (!entry.metricCodes.includes(code)) entry.metricCodes.push(code);
      }
      if (rule.climate) entry.climate = true;
    }
  }

  const candidates: CategorySuggestion[] = (
    ['environment', 'social', 'governance'] as MaterialityCategory[]
  ).map((category) => {
    const entry = perCategory.get(category)!;
    return {
      category,
      label: CATEGORY_LABELS[category],
      matched: entry.matched,
      metricCodes: entry.metricCodes,
      ssbjHint: entry.climate
        ? '気候関連開示基準（テーマ別基準第2号）の開示対象になりやすい課題です。'
        : '一般開示基準（テーマ別基準第1号）に基づいて開示要否を検討する課題です。',
    };
  });

  // 一致数の多い順。同数なら元の並び（環境 → 社会 → ガバナンス）を保つ
  candidates.sort((a, b) => b.matched.length - a.matched.length);

  const top = candidates[0] && candidates[0].matched.length > 0 ? candidates[0].category : null;
  return { candidates, top };
}
