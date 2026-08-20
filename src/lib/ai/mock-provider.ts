import { createRng, stableHash } from '@/lib/fixtures/ids';
import { normalizeLabel } from '@/lib/imports/learning';
import { parseFlexibleNumber } from '@/lib/imports/parsers';
import { AI_SCHEMAS, PROMPT_VERSIONS, type AiFeature, type AiOutputOf } from './schemas';
import { AiProviderError, type AiInvocation, type AiProvider, type AiResult } from './types';

/**
 * 決定論的 Mock AI Provider。
 *
 * - 同じ入力からは常に同じ出力を返す（テストの再現性のため）。
 * - 「AI が動いているように見えるだけ」を避けるため、
 *   実際に入力を読んで妥当な候補を組み立てる。
 * - UI には必ず「Mock / AI未接続」バッジを出す（`provider: 'mock'`）。
 */
export class MockAIProvider implements AiProvider {
  readonly kind = 'mock' as const;
  readonly model = 'mock-deterministic-v1';

  async run<F extends AiFeature>(invocation: AiInvocation<F>): Promise<AiResult<F>> {
    const seed = stableHash(
      `${invocation.feature}|${JSON.stringify(invocation.input)}|${invocation.inputReferenceIds.join(',')}`,
    );
    const rng = createRng(seed);
    const output = buildMockOutput(invocation, rng);

    const parsed = AI_SCHEMAS[invocation.feature].safeParse(output);
    if (!parsed.success) {
      throw new AiProviderError(
        `Mock 出力がスキーマに適合しませんでした: ${parsed.error.message}`,
        invocation.feature,
      );
    }

    const inputTokens = JSON.stringify(invocation.input).length / 4;
    const outputTokens = JSON.stringify(output).length / 4;

    return {
      output: parsed.data as AiOutputOf<F>,
      provider: 'mock',
      model: this.model,
      promptVersion: PROMPT_VERSIONS[invocation.feature],
      latencyMs: 12 + Math.floor(rng() * 40),
      tokenUsage: {
        input: Math.round(inputTokens),
        output: Math.round(outputTokens),
        total: Math.round(inputTokens + outputTokens),
      },
      estimatedCostUsd: 0,
    };
  }
}

interface MockRow {
  rowIndex?: number;
  raw?: Record<string, string>;
  metricCode?: string | null;
  unitCode?: string | null;
  periodCode?: string | null;
  value?: number | null;
  unitOfMeasure?: string | null;
}

/**
 * 項目名 → 指標コードの簡易辞書（Mock の「推定」根拠）。
 * 多言語（日英独仏中）に対応する（機能追加要望 ①: フォーマット・言語が異なるデータ群の自動仕分け）。
 */
const METRIC_HINTS: Array<[RegExp, string, string]> = [
  [
    /scope\s*1|直接排出|direkte emissionen|émissions directes|直接排放|范围[一1]/i,
    'scope1',
    't-CO2e',
  ],
  [
    /scope\s*2|購入電力|間接排出|strombezug|indirekte emissionen|électricité achetée|外购电力|范围[二2]/i,
    'scope2',
    't-CO2e',
  ],
  [
    /scope\s*3|購入した製品|カテゴリ\s*1|eingekaufte (waren|güter)|achats de biens|采购的?(商品|货物)|范围[三3]/i,
    'scope3_cat1',
    't-CO2e',
  ],
  [
    /エネルギー|electricity|energy|power consumption|電力使用|strom|energieverbrauch|énergie|électricité|能源|用电|耗电/i,
    'energy',
    'MWh',
  ],
  // 'eau' は単語境界を付ける（境界が無いと Bureau / Niveau などに誤爆する）
  [/用水|水使用|water|wasser|\beau\b|用水量|取水|耗水/i, 'water', 'm3'],
  [/廃棄物|waste|abfall|abfälle|déchets|废弃物|废物|垃圾/i, 'waste', 't'],
  [
    /従業員|employee|headcount|mitarbeiter|beschäftigte|effectif|salariés|员工|従業員数/i,
    'employees',
    '人',
  ],
  // --- 人的資本（多言語・多国。具体的な指標ほど先に置く） ---
  [
    /女性管理職比率|female manager(ial)? ratio|women in management|%\s*women in management|frauenanteil in führungspositionen|frauenquote|part des femmes cadres|女性管理[职職]比[例率]/i,
    'female_manager_ratio',
    '%',
  ],
  [
    /女性管理職数?|female managers|women managers|female officials and managers|weibliche führungskräfte|femmes cadres|女性管理[职職](人数|数)?/i,
    'female_managers',
    '人',
  ],
  [
    /女性従業員数?|female employees|women employees|female headcount|mitarbeiterinnen|weibliche mitarbeiter|effectif féminin|salariées|女性[员員]工/i,
    'female_employees',
    '人',
  ],
  [
    /新規採用|新卒|中途採用|new hires?|hiring|recruitment|neueinstellungen|einstellungen|embauches|recrutements|新[进進][员員]工|招聘/i,
    'new_hires',
    '人',
  ],
  [
    /離職率|退職率|turnover rate|attrition( rate)?|fluktuation(srate)?|taux de (rotation|turnover)|离职率|流失率/i,
    'turnover_rate',
    '%',
  ],
  [
    /平均勤続年数|average tenure|length of service|betriebszugehörigkeit|ancienneté|平均司[龄齡]|平均工[龄齡]/i,
    'avg_tenure',
    '年',
  ],
  [
    /研修時間|教育時間|training hours|learning hours|schulungsstunden|weiterbildungsstunden|heures de formation|培[训訓][时時][长長]|人均培[训訓]/i,
    'training_hours',
    '時間',
  ],
  [
    /ltifr|労働災害度数率|度数率|lost[- ]time injur|unfallh[äa]ufigkeit|taux de fr[ée]quence|工伤(事故)?[频頻]率|千人负伤率/i,
    'ltifr',
    '件/百万時間',
  ],
  [
    /男女(間)?賃金格差|賃金格差|gender pay gap|equal pay|pay ratio|entgeltgleichheit|lohnl[üu]cke|[ée]cart de r[ée]mun[ée]ration|index (de l')?[ée]galit[ée]|男女薪酬|薪酬差[距异異]/i,
    'gender_pay_gap',
    '%',
  ],
  [/管理職|managers|management|führungskräfte|cadres|管理[职職]/i, 'managers_total', '人'],
  [/女性役員/i, 'female_officers', '人'],
  [/役員/i, 'officers_total', '人'],
  [/取締役/i, 'directors_count', '人'],
];

const UNIT_HINTS: Array<[RegExp, string]> = [
  [/本社|headquarters|hq|head office|zentrale|siège|总部/i, 'HQ'],
  [/東日本|east/i, 'EAST'],
  [/西日本|west/i, 'WEST'],
  [/欧州|europe|münchen|munich|deutschland|germany|\beu\b|paris|france|lyon/i, 'EU'],
];

/**
 * 指標の「定義」が自社基準と違いうる表現。
 *
 * 人的資本は国・法域ごとに定義が異なる（例: 女性管理職比率の分母が
 * 「課長以上」か「部長以上」か「Officials and Managers」か）。
 * 数字だけを見て同じ指標へ丸めると、比較不能な値が混ざる。
 * 指標の当てはめ自体は行いつつ、**必ず人の確認を挟む**ための警告を出す。
 */
const DEFINITION_HINTS: Array<[RegExp, string]> = [
  [
    /部長(相当職?)?以上|director( level)? and above|ab bereichsleiter/i,
    '管理職の範囲が「部長以上」',
  ],
  [
    /officials and managers|eeo-?1|first[- /]?mid[- ]level/i,
    '米国 EEO-1 の職種区分（Officials and Managers）',
  ],
  [
    /führungskräfte（?全|alle führungsebenen|einschließlich teamleiter/i,
    '管理職の範囲に全管理層を含む',
  ],
  [/band\s*[0-9]+\s*(and above|以上)|grade\s*[a-z0-9]+\s*and above/i, '社内等級（Band/Grade）基準'],
  [/median|中央値/i, '中央値ベース（平均値ではない）'],
  [/mean(?!ing)|平均値ベース/i, '平均値ベース'],
  [/自己都合(のみ)?|voluntary( only)?|freiwillig/i, '自己都合のみ（会社都合を含まない）'],
  [
    /including (part[- ]time|contractors)|パート(タイム)?含む|派遣含む|契約社員含む/i,
    '正社員以外を含む',
  ],
  [
    /期中平均|年度平均|average (during|over) the (year|period)|jahresdurchschnitt/i,
    '期中平均（期末時点ではない）',
  ],
  [/full[- ]time equivalent|\bfte\b|常勤換算/i, 'FTE（常勤換算）ベース'],
];

/** 行のテキストから定義差の注意点を拾う（人的資本の指標にだけ付ける） */
function detectDefinitionNotes(text: string, metricCode: string | null): string[] {
  const HUMAN_CAPITAL = new Set([
    'employees',
    'female_employees',
    'managers_total',
    'female_managers',
    'female_manager_ratio',
    'new_hires',
    'turnover_rate',
    'avg_tenure',
    'training_hours',
    'ltifr',
    'gender_pay_gap',
  ]);
  if (!metricCode || !HUMAN_CAPITAL.has(metricCode)) return [];
  const notes: string[] = [];
  for (const [pattern, note] of DEFINITION_HINTS) {
    if (pattern.test(text)) notes.push(note);
  }
  return notes;
}

function guessMetric(text: string): { code: string | null; unit: string | null } {
  for (const [pattern, code, unit] of METRIC_HINTS) {
    if (pattern.test(text)) return { code, unit };
  }
  return { code: null, unit: null };
}

function guessUnit(text: string): string | null {
  for (const [pattern, code] of UNIT_HINTS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

function buildMockOutput<F extends AiFeature>(
  invocation: AiInvocation<F>,
  rng: () => number,
): unknown {
  const input = invocation.input;

  switch (invocation.feature) {
    case 'importMapping': {
      const rows = (input.rows as MockRow[] | undefined) ?? [];
      // 事前学習（過去に人が確定したラベル → 指標・拠点）。完全一致で最優先に適用する
      const learned =
        (input.learnedExamples as Array<{
          label: string;
          metricCode: string;
          unitCode: string | null;
        }>) ?? [];
      const learnedByLabel = new Map(learned.map((e) => [e.label, e]));

      const mapped = rows.map((row, index) => {
        const cells = Object.values(row.raw ?? {});
        const joined = cells.join(' ');
        const label = normalizeLabel(row.raw ?? {});
        const learnedHit = label ? learnedByLabel.get(label) : undefined;

        const metric = learnedHit
          ? { code: learnedHit.metricCode, unit: null }
          : guessMetric(joined);
        const unitCode =
          learnedHit?.unitCode ??
          guessUnit(joined) ??
          (input.defaultUnitCode as string | undefined) ??
          null;

        // 期間・年度らしきセルを数値として拾わない（"2026年度" → 2026 の誤検出防止）
        const numeric = cells
          .filter((v) => !/^(fy|cy)?\s*20\d{2}(年度?|[-/.].*)?$/i.test(v.normalize('NFKC').trim()))
          .map((v) => parseFlexibleNumber(v))
          .find((v): v is number => v !== null && v !== 0);
        const detectedUnit =
          cells.find((v) => /^((t|kg)-?CO2e?|MWh|kWh|m3|m³|kL|kg|t|人|%|GJ)$/i.test(v.trim())) ??
          metric.unit;

        const warnings: string[] = [];
        if (!metric.code) warnings.push('指標を特定できませんでした。手動で選択してください。');
        if (detectedUnit && metric.unit && detectedUnit !== metric.unit) {
          warnings.push(
            `単位が指標定義（${metric.unit}）と異なります（検出: ${detectedUnit}）。換算を確認してください。`,
          );
        }
        if (numeric === undefined) warnings.push('数値を検出できませんでした。');

        // 定義のズレ（国・法域ごとに算定基準が違う）を人へ知らせる。
        // 指標は当てるが確定はさせない。
        const definitionNotes = detectDefinitionNotes(joined, metric.code);
        for (const note of definitionNotes) {
          warnings.push(
            `定義が自社基準と異なる可能性があります: ${note}。確認のうえ確定してください。`,
          );
        }

        return {
          rowIndex: row.rowIndex ?? index,
          metricCode: metric.code,
          unitCode,
          periodCode: (input.periodCode as string | undefined) ?? null,
          value: numeric ?? null,
          unitOfMeasure: detectedUnit ?? null,
          // 学習済みラベルは確定実績に基づくため高確信度（それでも人の確認は必須）
          confidence: definitionNotes.length
            ? 0.42 + rng() * 0.1
            : learnedHit
              ? 0.95
              : metric.code
                ? 0.72 + rng() * 0.2
                : 0.2 + rng() * 0.2,
          warnings,
          sourceLocator: `行 ${(row.rowIndex ?? index) + 1}`,
        };
      });
      return {
        rows: mapped,
        confidence:
          mapped.length === 0 ? 0 : mapped.reduce((s, r) => s + r.confidence, 0) / mapped.length,
        warnings: mapped.some((r) => r.warnings.length > 0)
          ? ['一部の行で指標・単位を特定できませんでした。取込プレビューで確認してください。']
          : [],
        sources: [],
      };
    }

    case 'anomalyExplanation': {
      const anomalies = (input.anomalies as Array<Record<string, unknown>> | undefined) ?? [];
      return {
        findings: anomalies.map((a) => ({
          dataPointId: String(a.dataPointId ?? ''),
          likelyCause: String(
            a.ruleKey === 'unit_mismatch'
              ? '拠点テンプレートの単位欄が指標定義と異なる可能性があります（t と kg の取り違え）。'
              : a.ruleKey === 'yoy_deviation'
                ? '検針値の桁誤り、または対象範囲（新設ライン等）の変更が考えられます。'
                : a.ruleKey === 'ratio_numerator_exceeds_denominator'
                  ? '分母（総数）の集計範囲が分子と揃っていない可能性があります。'
                  : '入力元データの転記誤りが考えられます。',
          ),
          suggestedAction: String(
            a.ruleKey === 'unit_mismatch'
              ? '拠点へ単位の確認を依頼し、必要なら換算して再登録してください。'
              : '原資料（請求書・計測記録）と突合し、対象期間と対象範囲を確認してください。',
          ),
          severity: (a.severity as string) === 'error' ? 'high' : 'medium',
        })),
        confidence: 0.55 + rng() * 0.15,
        warnings: ['原因の推定です。必ず原資料で確認してください。'],
        sources: (input.sources as never[]) ?? [],
      };
    }

    case 'cdpQuestionMapping': {
      const items = (input.items as Array<{ code: string; text: string }> | undefined) ?? [];
      return {
        mappings: items.map((item) => {
          const metric = guessMetric(item.text);
          return {
            itemCode: item.code,
            metricCode: metric.code,
            rationale: metric.code
              ? `質問文に「${metric.code}」に相当する数値の記載要求があります。`
              : '定量指標との対応は検出できませんでした（記述式の可能性）。',
            confidence: metric.code ? 0.78 : 0.25,
          };
        }),
        confidence: 0.6 + rng() * 0.2,
        warnings: [],
        sources: [],
      };
    }

    case 'cdpDraftGeneration': {
      const itemCode = String(input.itemCode ?? '');
      const questionText = String(input.questionText ?? '');
      const answerType = String(input.answerType ?? 'text');
      const previousAnswer = input.previousAnswer as string | null | undefined;
      const metricValues =
        (input.metricValues as Array<{
          label: string;
          value: number;
          unit: string;
          periodLabel: string;
        }>) ?? [];
      const sources = (input.sources as never[]) ?? [];

      const numeric = metricValues[0]?.value ?? null;
      const missing: string[] = [];
      if (metricValues.length === 0 && answerType === 'numeric') {
        missing.push('対応する承認済み Data Point が見つかりませんでした。');
      }
      if (!previousAnswer) missing.push('前年度の回答がないため、継続性の記述は作成していません。');

      const draftText =
        answerType === 'numeric' && numeric !== null
          ? `${metricValues[0]?.periodLabel ?? '当期'}の実績値は ${numeric.toLocaleString('ja-JP')} ${metricValues[0]?.unit ?? ''} です。算定範囲は連結（本社・東日本工場・西日本工場）で、算定方法は前年度から変更していません。`
          : previousAnswer
            ? `${previousAnswer}\n\n（当年度更新案）上記に加え、報告対象期間における取り組み状況を反映してください。数値部分は承認済みデータで置き換える必要があります。`
            : `${questionText} に対する回答案です。承認済みデータおよび Evidence が不足しているため、確定前に担当者の追記が必要です。`;

      return {
        itemCode,
        draftText,
        draftNumeric: answerType === 'numeric' ? numeric : null,
        draftChoice: answerType === 'single_choice' && previousAnswer ? [previousAnswer] : [],
        changeSummary: previousAnswer
          ? '前年回答をベースに、当期の承認済みデータで数値を更新しました。'
          : '新規質問のため、前年回答からの引き継ぎはありません。',
        missingInformation: missing,
        confidence: numeric !== null ? 0.74 + rng() * 0.1 : 0.42 + rng() * 0.1,
        warnings: [
          'AI が生成した下書きです。人が内容を確認し、編集のうえ承認してください。',
          ...(missing.length > 0 ? ['不足情報があります。断定的な記述を避けてください。'] : []),
        ],
        sources,
      };
    }

    case 'evidenceMapping': {
      const fragments =
        (input.fragments as Array<{
          fileVersionId: string;
          page: number;
          text: string;
          locator: string | null;
        }>) ?? [];
      const targetCode = String(input.targetCode ?? '');
      return {
        candidates: fragments.slice(0, 5).map((f) => ({
          fileVersionId: f.fileVersionId,
          page: f.page,
          locator: f.locator,
          excerpt: f.text.slice(0, 120),
          targetKind: 'metric' as const,
          targetCode,
          confidence: 0.5 + rng() * 0.3,
        })),
        confidence: 0.55 + rng() * 0.2,
        warnings:
          fragments.length === 0 ? ['抽出済みテキストがありません。OCR／AI 解析要確認。'] : [],
        sources: [],
      };
    }

    case 'inconsistencyCheck': {
      const answers =
        (input.answers as Array<{
          itemCode: string;
          answer: string | null;
          previousAnswer: string | null;
          currentValue: number | null;
          previousValue: number | null;
          evidenceCount: number;
          required: boolean;
          status: string;
        }>) ?? [];

      type Issue = {
        kind:
          | 'missing_information'
          | 'stale_content'
          | 'period_mismatch'
          | 'contradiction'
          | 'evidence_gap';
        subject: string;
        detail: string;
        severity: 'high' | 'medium' | 'low';
      };
      const issues: Issue[] = [];

      for (const a of answers) {
        // 不足情報: 必須なのに未記入、または情報量が明らかに足りない
        if (a.required && (!a.answer || a.answer.trim().length < 20)) {
          issues.push({
            kind: 'missing_information',
            subject: a.itemCode,
            detail: '必須質問の回答が未記入、または情報量が不足しています。',
            severity: 'high',
          });
        }
        // 古い記述: 本文に過年度の年号が残っている
        if (a.answer && /20(1\d|2[0-4])年/.test(a.answer)) {
          issues.push({
            kind: 'stale_content',
            subject: a.itemCode,
            detail: '過年度の年号が本文に残っています。対象年度を確認してください。',
            severity: 'high',
          });
        }
        // 年度不一致: 前年回答をそのまま流用しているのに当年値が変化している
        if (a.answer && a.previousAnswer && a.answer.trim() === a.previousAnswer.trim()) {
          if (
            a.currentValue !== null &&
            a.previousValue !== null &&
            a.currentValue !== a.previousValue
          ) {
            issues.push({
              kind: 'period_mismatch',
              subject: a.itemCode,
              detail:
                '回答本文が前年度と同一ですが、紐づく数値は当年で変化しています。本文の更新漏れの可能性があります。',
              severity: 'high',
            });
          }
        }
        // 回答間の矛盾: 増減が大きいのに本文が「横ばい」「変化なし」と述べている
        if (
          a.answer &&
          a.currentValue !== null &&
          a.previousValue !== null &&
          a.previousValue !== 0
        ) {
          const change = Math.abs((a.currentValue - a.previousValue) / a.previousValue);
          if (change >= 0.1 && /(横ばい|変化はありません|変化なし|同水準)/.test(a.answer)) {
            issues.push({
              kind: 'contradiction',
              subject: a.itemCode,
              detail: `数値は前年比 ${Math.round(change * 100)}% 変動していますが、本文は横ばいと述べています。`,
              severity: 'high',
            });
          }
        }
        // Evidence 不足: 承認済みの回答に Evidence が 1 件も紐づいていない
        if (a.status === 'approved' && a.evidenceCount === 0) {
          issues.push({
            kind: 'evidence_gap',
            subject: a.itemCode,
            detail: '承認済みの回答に Evidence が紐づいていません。',
            severity: 'medium',
          });
        }
      }

      return {
        issues,
        confidence: 0.6 + rng() * 0.15,
        warnings: [],
        sources: [],
      };
    }

    case 'copilotChat': {
      type Snap = {
        periodLabel?: string;
        submissionDueDate?: string | null;
        metricYoY?: Array<{
          metricName: string;
          metricCode: string;
          unit: string;
          current: number | null;
          previous: number | null;
        }>;
        unitYoY?: Array<{
          metricName: string;
          unitName: string;
          current: number | null;
          previous: number | null;
        }>;
        collection?: { total: number; approved: number; draft: number; submitted: number };
        disclosures?: Array<{
          framework: string;
          requiredUnanswered: number;
          approved: number;
          total: number;
        }>;
        assurance?: { openPbcRequests: number };
      };
      const snap = (input.snapshot as Snap) ?? {};
      const question = String(input.question ?? '').normalize('NFKC');
      const metricsInfo = snap.metricYoY ?? [];

      const fmt = (n: number) => n.toLocaleString('ja-JP');
      const refs: Array<{ label: string; link: string | null }> = [];
      let answer: string;

      // 1) 指標名で聞かれたら承認済み集計と YoY を返す（根拠つき）
      const hit = metricsInfo.find((mm) => question.includes(mm.metricName.normalize('NFKC')));
      const scopeHit =
        hit ??
        (/scopes*1|スコープ1/i.test(question)
          ? metricsInfo.find((mm) => mm.metricCode === 'scope1')
          : /scopes*2|スコープ2/i.test(question)
            ? metricsInfo.find((mm) => mm.metricCode === 'scope2')
            : /scopes*3|スコープ3/i.test(question)
              ? metricsInfo.find((mm) => mm.metricCode === 'scope3_cat1')
              : undefined);
      if (scopeHit && scopeHit.current !== null) {
        const yoy =
          scopeHit.previous !== null && scopeHit.previous !== 0
            ? `（前年 ${fmt(scopeHit.previous)} ${scopeHit.unit} 比 ${(((scopeHit.current - scopeHit.previous) / scopeHit.previous) * 100).toFixed(1)}%）`
            : '';
        answer = `${snap.periodLabel ?? '当期'}の ${scopeHit.metricName} は承認済みデータの合計で ${fmt(scopeHit.current)} ${scopeHit.unit} です${yoy}。出典: 承認済み Data Point の全社集計。`;
        // 拠点内訳があれば上位を添える（単一画面では見えない切り口）
        const breakdown = (snap.unitYoY ?? [])
          .filter((u) => u.metricName === scopeHit.metricName && u.current !== null)
          .sort((a, b) => (b.current ?? 0) - (a.current ?? 0))
          .slice(0, 3);
        if (breakdown.length > 1) {
          answer +=
            ' 内訳上位: ' +
            breakdown.map((u) => `${u.unitName} ${fmt(u.current ?? 0)}`).join('、') +
            '。';
        }
        refs.push({ label: '非財務データ（承認済み）', link: '/enterprise/data?status=approved' });
        refs.push({ label: 'GHG 集計', link: '/enterprise/ghg' });
      } else if (/進捗|収集|承認率|状況/.test(question) && snap.collection) {
        const c = snap.collection;
        answer = `収集対象 ${c.total} 件のうち承認済み ${c.approved} 件、提出済み ${c.submitted} 件、下書き ${c.draft} 件です。提出期限は ${snap.submissionDueDate ?? '未設定'}。出典: 当期 Data Point の状態集計。`;
        refs.push({ label: 'ワークフロー', link: '/enterprise/workflows' });
      } else if (/cdp|csrd|開示|質問書/i.test(question) && (snap.disclosures ?? []).length > 0) {
        answer = (snap.disclosures ?? [])
          .map(
            (dd) =>
              `${dd.framework}: 全 ${dd.total} 項目中、承認済み ${dd.approved} 件・必須未回答 ${dd.requiredUnanswered} 件`,
          )
          .join('。');
        answer += '。出典: 開示ワークスペースの回答状態。';
        refs.push({ label: 'CDP', link: '/enterprise/disclosures/cdp' });
        refs.push({ label: 'CSRD', link: '/enterprise/disclosures/csrd' });
      } else if (/監査|pbc|依頼/i.test(question) && snap.assurance) {
        answer = `監査法人からの未対応依頼（PBC）は ${snap.assurance.openPbcRequests} 件です。出典: PBC の状態集計。`;
        refs.push({ label: 'ワークフロー（PBC）', link: '/enterprise/workflows' });
      } else {
        answer =
          'この質問には手元のスナップショット（承認済みデータ・収集状況・開示状況）から確実に答えられる情報がありません。推測では答えません。指標名（例: Scope1 直接排出）や「収集の進捗」「CDP の未回答」のように聞いていただくと、根拠つきで答えられます。';
      }

      return {
        answer,
        references: refs,
        suggestedQuestions: [
          'Scope1 の当年値と前年比は？',
          '収集の進捗と提出期限は？',
          'CDP の必須未回答は何件？',
        ],
        confidence: answer.startsWith('この質問には') ? 0.3 : 0.8 + rng() * 0.1,
        warnings: ['回答は承認済みデータのスナップショットに基づきます。操作や確定は行いません。'],
        sources: [],
      };
    }

    case 'insightDiscovery': {
      type YoY = {
        metricName: string;
        unit: string;
        current: number | null;
        previous: number | null;
      };
      type UnitYoY = YoY & { unitName: string };
      const metricYoY = (input.metricYoY as YoY[]) ?? [];
      const unitYoY = (input.unitYoY as UnitYoY[]) ?? [];
      const collection = (input.collection as {
        total: number;
        approved: number;
        draft: number;
        submitted: number;
      }) ?? { total: 0, approved: 0, draft: 0, submitted: 0 };
      const quality = (input.quality as {
        openValidationErrors: number;
        approvedWithoutEvidence: number;
      }) ?? {
        openValidationErrors: 0,
        approvedWithoutEvidence: 0,
      };
      const disclosures =
        (input.disclosures as Array<{
          framework: string;
          total: number;
          requiredUnanswered: number;
          approved: number;
        }>) ?? [];
      const assurance = (input.assurance as { openPbcRequests: number }) ?? { openPbcRequests: 0 };
      const dueDate = String(input.submissionDueDate ?? '');

      type Insight = {
        title: string;
        finding: string;
        implication: string;
        recommendedAction: string;
        category:
          | 'data_quality'
          | 'deadline_risk'
          | 'disclosure_gap'
          | 'trend_anomaly'
          | 'assurance_readiness'
          | 'efficiency';
        impact: 'high' | 'medium' | 'low';
        link: string | null;
      };
      const insights: Insight[] = [];
      const pct = (cur: number, prev: number) => Math.round(((cur - prev) / prev) * 1000) / 10;

      // 1. 全社トレンドと逆行する拠点（単一画面では気づきにくい相殺関係）
      for (const m of metricYoY) {
        if (m.current === null || m.previous === null || m.previous === 0) continue;
        const total = pct(m.current, m.previous);
        // 全社がほぼ横ばいだと「逆行」の意味が無い（符号比較が全拠点に誤発火する）
        if (Math.abs(total) < 1) continue;
        const contrarians = unitYoY.filter(
          (u) =>
            u.metricName === m.metricName &&
            u.current !== null &&
            u.previous !== null &&
            u.previous !== 0 &&
            // 全社が減少しているのに増加している（またはその逆）拠点
            Math.sign(u.current - u.previous) !== Math.sign(m.current! - m.previous!) &&
            Math.abs(pct(u.current, u.previous)) >= 5,
        );
        for (const u of contrarians.slice(0, 1)) {
          const unitChange = pct(u.current!, u.previous!);
          insights.push({
            title: `${u.unitName} の ${m.metricName} が全社トレンドと逆行しています`,
            finding:
              `全社の ${m.metricName} は前年比 ${total >= 0 ? '+' : ''}${total}% ですが、` +
              `${u.unitName} は ${unitChange >= 0 ? '+' : ''}${unitChange}% と逆方向に動いています。`,
            implication:
              '全社集計だけを見ていると、この拠点の変化が他拠点の改善を相殺している構図に気づけません。削減施策の効果測定を歪める可能性があります。',
            recommendedAction: `${u.unitName} の担当者に増減要因（操業度・設備・集計範囲の変更）を確認し、必要なら測定方法のメモを Data Point に残してください。`,
            category: 'trend_anomaly',
            impact: 'high',
            link: '/enterprise/data?status=approved',
          });
        }
      }

      // 2. 最大変動指標（説明準備ができていないと開示・保証の両方で詰まる）
      const swings = metricYoY
        .filter((m) => m.current !== null && m.previous !== null && m.previous !== 0)
        .map((m) => ({ m, change: pct(m.current!, m.previous!) }))
        .filter((x) => Math.abs(x.change) >= 10)
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
      for (const { m, change } of swings.slice(0, 1)) {
        insights.push({
          title: `${m.metricName} の前年比 ${change >= 0 ? '+' : ''}${change}% には説明が必要です`,
          finding: `${m.metricName} は ${m.previous} → ${m.current} ${m.unit}（${change >= 0 ? '+' : ''}${change}%）と大きく変動しています。`,
          implication:
            '10% を超える変動は CDP・保証手続の両方で必ず質問されます。増減理由が文書化されていないと、回答作成と監査対応が期末に集中します。',
          recommendedAction:
            '変動要因（事業拡大・範囲変更・算定方法変更）を今のうちに整理し、該当 Data Point の測定方法欄と Evidence に残してください。',
          category: 'assurance_readiness',
          impact: 'high',
          link: '/enterprise/ghg',
        });
      }

      // 3. 締切リスク: 未承認の残量と提出期限の衝突
      const unapproved = collection.total - collection.approved;
      if (collection.total > 0 && unapproved > collection.total * 0.2) {
        insights.push({
          title: `未承認データが ${unapproved} 件残っています（全体の ${Math.round((unapproved / collection.total) * 100)}%）`,
          finding: `収集対象 ${collection.total} 件のうち承認済みは ${collection.approved} 件。draft ${collection.draft} 件・submitted ${collection.submitted} 件が滞留しています。`,
          implication: `提出期限（${dueDate}）から逆算すると、レビュー担当の処理能力を超えて期末に承認作業が集中する恐れがあります。`,
          recommendedAction:
            'ワークフロー画面で滞留している submitted を確認し、レビュー担当の割当を前倒ししてください。',
          category: 'deadline_risk',
          impact: unapproved > collection.total * 0.5 ? 'high' : 'medium',
          link: '/enterprise/workflows',
        });
      }

      // 4. 開示ギャップ: 必須未回答
      for (const d of disclosures) {
        if (d.requiredUnanswered === 0) continue;
        insights.push({
          title: `${d.framework} の必須項目 ${d.requiredUnanswered} 件が未回答です`,
          finding: `${d.framework} の全 ${d.total} 項目のうち、必須の未回答が ${d.requiredUnanswered} 件あります（承認済みは ${d.approved} 件）。`,
          implication:
            '必須項目の未回答はスコアリングへ直接影響します。承認済みデータが既にある項目は、AI ドラフトで短時間で下書き化できます。',
          recommendedAction: `${d.framework} ワークスペースで未回答の必須項目から着手してください。データマッピング済みの項目は AI ドラフト生成が使えます。`,
          category: 'disclosure_gap',
          impact: 'medium',
          link: `/enterprise/disclosures/${d.framework.toLowerCase()}`,
        });
      }

      // 5. データ品質: Evidence 不足・未解決の検証エラー
      if (quality.approvedWithoutEvidence > 0) {
        insights.push({
          title: `Evidence 必須の承認済みデータ ${quality.approvedWithoutEvidence} 件に根拠が紐づいていません`,
          finding: `指標定義で Evidence 必須とされているのに、承認済みで Evidence リンクが 0 件のデータが ${quality.approvedWithoutEvidence} 件あります。`,
          implication:
            '保証手続で必ずサンプル要求される領域です。期中に紐づけておかないと、監査対応時に原本を探す作業が発生します。',
          recommendedAction:
            'Evidence 画面から該当ファイルをアップロードし、Data Point に紐づけてください。',
          category: 'data_quality',
          impact: 'medium',
          link: '/enterprise/evidence',
        });
      }
      if (quality.openValidationErrors > 0) {
        insights.push({
          title: `未解決の検証エラーが ${quality.openValidationErrors} 件あります`,
          finding: `単位不一致・比率超過などの検証エラーが ${quality.openValidationErrors} 件、未解決のまま残っています。`,
          implication:
            '誤った値のまま開示回答へ転記されると、後工程での修正コストが跳ね上がります。',
          recommendedAction:
            '非財務データ一覧を「検証エラー」で絞り込み、原資料と突合して修正してください。',
          category: 'data_quality',
          impact: 'high',
          link: '/enterprise/data?flag=validation_error',
        });
      }

      // 6. 監査法人からの未対応依頼
      if (assurance.openPbcRequests > 0) {
        insights.push({
          title: `監査法人からの未対応依頼（PBC）が ${assurance.openPbcRequests} 件あります`,
          finding: `対応待ちの資料依頼が ${assurance.openPbcRequests} 件あります。`,
          implication: '依頼への回答が遅れると保証手続全体が後ろ倒しになり、期末の負荷が増します。',
          recommendedAction: 'ワークフロー画面の PBC タブから期限の近いものに回答してください。',
          category: 'assurance_readiness',
          impact: 'medium',
          link: '/enterprise/workflows',
        });
      }

      const impactOrder = { high: 0, medium: 1, low: 2 } as const;
      insights.sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact]);

      return {
        insights: insights.slice(0, 6),
        confidence: 0.62 + rng() * 0.13,
        warnings: ['洞察は候補です。数値と要因は必ず原データで確認してください。'],
        sources: [],
      };
    }

    case 'assuranceEvidenceSummary': {
      const fragments = (input.fragments as Array<{ text: string; locator: string | null }>) ?? [];
      const label = String(input.subjectLabel ?? '対象');
      return {
        summary: `${label} に関する Evidence ${fragments.length} 件を確認しました。記載内容は対象期間の実績を示していますが、金額・数量の合計値は調書側で再計算して確認する必要があります。`,
        keyFigures: fragments.slice(0, 3).map((f, i) => ({
          label: `抽出値 ${i + 1}`,
          value: f.text.slice(0, 40),
          locator: f.locator,
        })),
        pointsToVerify: [
          'Evidence の対象期間が報告対象期間に一致しているか',
          '単位が指標定義と一致しているか',
          '合計値が明細の積み上げと一致するか',
        ],
        confidence: 0.5 + rng() * 0.2,
        warnings: [
          'これは要約であり、保証結論ではありません。手続の実施と結論は監査人が行ってください。',
        ],
        sources: (input.sources as never[]) ?? [],
      };
    }

    case 'assuranceChangeSummary': {
      const changes =
        (input.changes as Array<{ subject: string; before: string; after: string }>) ?? [];
      return {
        changes: changes.map((c) => ({
          subject: c.subject,
          before: c.before,
          after: c.after,
          possibleImpact:
            '固定時点の値と現在値に差異があります。母集団・サンプル・再計算結果への影響を確認してください。',
          suggestsRetest: true,
        })),
        confidence: 0.65 + rng() * 0.15,
        warnings: [
          '影響評価（no_impact / retest_required / issue_raised）は監査人が確定してください。',
        ],
        sources: (input.sources as never[]) ?? [],
      };
    }

    default: {
      const exhaustive: never = invocation.feature;
      throw new AiProviderError(`未対応の feature: ${String(exhaustive)}`, invocation.feature);
    }
  }
}
