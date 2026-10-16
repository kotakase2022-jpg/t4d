import 'server-only';

import type { ExportSheet } from '@/lib/exports';
import { neutralizeFormula } from '@/lib/exports/disclosure-report';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import {
  FEEDBACK_CHANNEL_LABELS,
  reductionTargetLabel,
  TRIAL_MIN_SAMPLE,
  TRIAL_TASK_LABELS,
  TRIAL_THEME_LABELS,
  TRIAL_TIMING_METHOD_LABELS,
  TRIAL_TIMING_MODE_LABELS,
  verificationLabel,
  type ReductionTarget,
  type TaskReduction,
} from '@/lib/domain/trial-metrics';
import {
  SEPARATE_CONSULTATION_LABELS,
  signalCountLabel,
  type ScopeSignal,
} from '@/lib/domain/trial-scope';
import type { ScenarioSummary } from '@/lib/services/trial-evaluation';
import type { FeedbackOverview } from '@/lib/services/trial-feedback';
import type { TimingSummary } from '@/lib/services/trial-timing';
import { statusLabel } from '@/lib/ui/status/registry';
import type { TrialAgreement } from '@/types/domain';

/**
 * 検証結果・改善管理表の XLSX（トライアル対応 NF-33・NF-34・NF-35。スライド 11 の成果物 #02）。
 *
 * シート: シナリオ結果・操作と工数・改善管理表・作業時間・集計・注記。
 *  - 集計に、無償の範囲の合意と別途協議の 4 区分の信号（トライアル概要と同じ関数の結果。金額は出さない）
 *  - 率は件数（n）と測り方を併記し、件数不足は率を出さない（画面と同じ関数の結果をそのまま書く）
 *  - 実施者の氏名は出さない（役割名だけ。共有先で個人を評価しないため）
 *  - 利用者が入力した文字列は数式として解釈されないよう無害化する（neutralizeFormula）
 *  - Demo Mode の出力には「架空のトライアル記録」の注記を必ず入れる
 */

export interface TrialReportInput {
  scenarios: ScenarioSummary;
  feedback: FeedbackOverview;
  timings: TimingSummary;
  target: ReductionTarget | null;
  demo: boolean;
  /** 出力した環境の版 */
  build: string;
  generatedAt: string;
  /** 無償の範囲の合意と別途協議の 4 区分の信号（trial-program.ts の loadTrialScopeSignals） */
  scope?: {
    agreement: TrialAgreement | null;
    signals: ScopeSignal[];
    unclassifiedSeparate: number;
  };
}

const text = (value: string | null | undefined): string => neutralizeFormula(value ?? '');

export const TRIAL_REPORT_SHEET_NAMES = [
  'シナリオ結果',
  '操作と工数',
  '改善管理表',
  '作業時間',
  '作業時間（作業ごと）',
  '集計',
  '注記',
] as const;

/** 出力の固定の注記（画面の注記と同じ趣旨） */
export function trialReportNotes(input: { demo: boolean; build: string; generatedAt: string }) {
  const notes = [
    `出力日時: ${formatJst(input.generatedAt)}・環境の版: ${input.build}`,
    `率は件数（n）を併記しています。件数が ${TRIAL_MIN_SAMPLE} 件に満たない項目は率を出していません（「件数不足（n=…）」）。`,
    '作業時間の短縮率は、現行と T4D の両方が 3 件以上のときだけ出しています。「記録からの推定」は待ち時間を含む参考値です。',
    '目標は結果とは別に示しています（目標を達成したかの判定はしていません）。',
    '判定は評価者が記録したものです。測定値の候補はアプリが出しますが、判定は人が行います。',
    '利用者の操作は自動で追跡していません。実施・作業時間は人が記録したものです。',
    '別途協議の区分の「別途協議の目安を超過」は別途協議の候補であって確定ではありません（操作は止めていません）。金額は扱っていません。',
  ];
  if (input.demo) {
    notes.unshift('架空のトライアル記録です。実測値・実際の効果ではありません（デモデータ）。');
  }
  return notes;
}

function reductionColumns(prefix: '現行' | 'T4D', side: 'baseline' | 't4d') {
  return [
    {
      key: `${side}Median`,
      header: `${prefix}（1 単位あたり分・中央値）`,
      value: (r: TaskReduction) => (r[side].median === null ? null : round1(r[side].median!)),
      numeric: true,
    },
    {
      key: `${side}N`,
      header: `${prefix}の件数`,
      value: (r: TaskReduction) => r[side].n,
      numeric: true,
    },
    {
      key: `${side}Methods`,
      header: `${prefix}の測り方`,
      value: (r: TaskReduction) =>
        r[side].methods.map((m) => TRIAL_TIMING_METHOD_LABELS[m]).join('・') || '—',
    },
  ];
}

/** 集計の行: 無償の範囲の合意と別途協議の 4 区分（区分ごとに状態・件数／目安・数えたもの） */
function scopeRows(
  scope: TrialReportInput['scope'],
): Array<{ item: string; value: string; note: string }> {
  if (!scope) return [];
  const agreement = scope.agreement;
  return [
    {
      item: '無償の範囲の合意',
      value: agreement?.agreedOn ? `合意済み（${formatJstDate(agreement.agreedOn)}）` : '未合意',
      note: text(agreement?.note),
    },
    ...scope.signals.map((signal) => ({
      item: `別途協議の区分: ${signal.label}`,
      value: `${statusLabel('trialScopeSignal', signal.state)}（${signalCountLabel(signal)}）`,
      note: [signal.measured, signal.detail].filter((v) => v !== '').join('。'),
    })),
    ...(scope.unclassifiedSeparate > 0
      ? [
          {
            item: '別途協議（区分なし）',
            value: `${scope.unclassifiedSeparate} 件`,
            note: 'どの区分にも数えていません（改善管理表で区分を選んでください）',
          },
        ]
      : []),
  ];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- シートごとに行の型が異なる
export function buildTrialReportSheets(input: TrialReportInput): ExportSheet<any>[] {
  const { scenarios, feedback, timings } = input;
  const scenarioCode = new Map(scenarios.rows.map((r) => [r.scenario.id, r.scenario.code]));
  const runs = scenarios.rows.flatMap((row) => row.runs);

  const summaryRows: Array<{ item: string; value: string; note: string }> = [
    {
      item: '自力完遂率（全シナリオ）',
      value: scenarios.completion.label,
      note: '訂正された記録を除く実施',
    },
    {
      item: '問い合わせ回数（1 実施あたり）',
      value: scenarios.inquiry.label,
      note: '',
    },
    {
      item: '合格率（判定済みのシナリオ）',
      value: scenarios.pass.label,
      note: `未判定 ${scenarios.pass.notJudged} 件は分母に入れていません`,
    },
    {
      item: '必須要件 × 重大 × 未解決',
      value: `${feedback.summary.mandatoryCriticalOpen} 件`,
      note: '本導入の条件（0 件であること）',
    },
    { item: '未解決の課題', value: `${feedback.summary.unresolved} 件`, note: '' },
    { item: '良かった点', value: `${feedback.summary.positive} 件`, note: '' },
    {
      item: 'AI に関する意見',
      value: `${feedback.aiOpinions.length} 件`,
      note: 'AI の候補の不採用の理由',
    },
    {
      item: '作業時間の短縮の目標',
      value: reductionTargetLabel(input.target),
      note: '結果とは別に示す',
    },
    ...scopeRows(input.scope),
    ...timings.tasks.map((task) => ({
      item: `作業時間: ${TRIAL_TASK_LABELS[task.taskKey]}`,
      value: task.label,
      note: `現行 n=${task.baseline.n}・T4D n=${task.t4d.n}${
        task.baseline.includesLogEstimate || task.t4d.includesLogEstimate
          ? '・記録からの推定（参考値）を含む'
          : ''
      }`,
    })),
  ];

  return [
    {
      name: 'シナリオ結果',
      columns: [
        { key: 'code', header: 'コード', value: (r) => text(r.scenario.code) },
        {
          key: 'theme',
          header: 'テーマ',
          value: (r) => TRIAL_THEME_LABELS[r.scenario.theme as keyof typeof TRIAL_THEME_LABELS],
        },
        { key: 'title', header: 'シナリオ', value: (r) => text(r.scenario.title) },
        { key: 'role', header: '対象役割', value: (r) => text(r.scenario.targetRole) },
        {
          key: 'criterion',
          header: '判定の目安',
          value: (r) => text(r.scenario.acceptanceCriterion),
        },
        { key: 'runs', header: '実施数', value: (r) => r.effectiveRunCount, numeric: true },
        { key: 'completion', header: '自力完遂率（n）', value: (r) => r.completion.label },
        { key: 'inquiry', header: '問い合わせ（1 実施あたり）', value: (r) => r.inquiry.label },
        {
          key: 'judgement',
          header: '判定',
          value: (r) => statusLabel('trialJudgement', r.state),
        },
        { key: 'measured', header: '測定値', value: (r) => text(r.latest?.measuredValue) },
        { key: 'reason', header: '判定の理由', value: (r) => text(r.latest?.reason) },
        {
          key: 'judgedAt',
          header: '判定日時',
          value: (r) => (r.latest ? formatJst(r.latest.judgedAt) : ''),
        },
      ],
      rows: scenarios.rows,
    },
    {
      name: '操作と工数',
      columns: [
        {
          key: 'scenario',
          header: 'シナリオ',
          value: (r) => text(scenarioCode.get(r.scenarioId) ?? ''),
        },
        { key: 'endedAt', header: '実施日時', value: (r) => formatJst(r.endedAt ?? r.createdAt) },
        { key: 'role', header: '役割', value: (r) => text(r.performedRole) },
        {
          key: 'completion',
          header: '完了の区分',
          value: (r) => statusLabel('trialCompletion', r.completion),
        },
        { key: 'minutes', header: '所要分', value: (r) => r.minutes, numeric: true },
        { key: 'help', header: '問い合わせ回数', value: (r) => r.helpCount, numeric: true },
        { key: 'ease', header: '分かりやすさ（1〜5）', value: (r) => r.easeRating, numeric: true },
        { key: 'comment', header: 'コメント', value: (r) => text(r.comment) },
        {
          key: 'evidence',
          header: '証跡',
          value: (r) => text(typeof r.evidence.url === 'string' ? r.evidence.url : ''),
        },
        { key: 'env', header: '環境の版', value: (r) => text(r.environmentVersion) },
        {
          key: 'superseded',
          header: '訂正',
          value: (r) => (r.superseded ? '訂正済み（数えない）' : ''),
        },
      ],
      rows: runs,
    },
    {
      name: '改善管理表',
      columns: [
        { key: 'createdAt', header: '登録日', value: (r) => formatJstDate(r.createdAt) },
        { key: 'kind', header: '種類', value: (r) => statusLabel('feedbackKind', r.kind) },
        {
          key: 'channel',
          header: '経路',
          value: (r) => FEEDBACK_CHANNEL_LABELS[r.channel as keyof typeof FEEDBACK_CHANNEL_LABELS],
        },
        { key: 'title', header: '件名', value: (r) => text(r.title) },
        { key: 'body', header: '内容', value: (r) => text(r.body) },
        { key: 'route', header: '画面', value: (r) => text(r.routePattern) },
        {
          key: 'severity',
          header: '重大度',
          value: (r) => (r.severity ? statusLabel('severity', r.severity) : ''),
        },
        {
          key: 'mandatory',
          header: '必須要件',
          value: (r) => (r.mandatoryRequirement ? '必須' : ''),
        },
        { key: 'status', header: '状態', value: (r) => statusLabel('feedbackStatus', r.status) },
        { key: 'policy', header: '対応方針', value: (r) => text(r.responsePolicy) },
        { key: 'owner', header: '担当', value: (r) => text(r.ownerLabel) },
        { key: 'due', header: '期限', value: (r) => (r.dueOn ? formatJstDate(r.dueOn) : '') },
        { key: 'cost', header: '費用区分', value: (r) => statusLabel('costClass', r.costClass) },
        {
          key: 'scopeKind',
          header: '別途協議の区分',
          value: (r) =>
            r.scopeKind
              ? SEPARATE_CONSULTATION_LABELS[
                  r.scopeKind as keyof typeof SEPARATE_CONSULTATION_LABELS
                ]
              : '',
        },
        { key: 'version', header: '反映した版', value: (r) => text(r.resolvedInVersion) },
        {
          key: 'verification',
          header: '再検証',
          value: (r) => verificationLabel(r.verificationResult),
        },
        { key: 'agreed', header: '合意', value: (r) => (r.agreed ? '合意済み' : '') },
        { key: 'env', header: '登録時の環境の版', value: (r) => text(r.environmentVersion) },
      ],
      rows: feedback.items,
    },
    {
      name: '作業時間',
      columns: [
        { key: 'measuredOn', header: '測定日', value: (r) => formatJstDate(r.measuredOn) },
        {
          key: 'task',
          header: '作業',
          value: (r) => TRIAL_TASK_LABELS[r.taskKey as keyof typeof TRIAL_TASK_LABELS],
        },
        {
          key: 'mode',
          header: '区分',
          value: (r) => TRIAL_TIMING_MODE_LABELS[r.mode as keyof typeof TRIAL_TIMING_MODE_LABELS],
        },
        { key: 'quantity', header: '数量', value: (r) => r.quantity, numeric: true },
        { key: 'unit', header: '単位', value: (r) => text(r.unitLabel) },
        { key: 'minutes', header: '所要分', value: (r) => r.minutes, numeric: true },
        {
          key: 'perUnit',
          header: '1 単位あたり分',
          value: (r) => round1(r.perUnitMinutes),
          numeric: true,
        },
        {
          key: 'method',
          header: '測り方',
          value: (r) =>
            TRIAL_TIMING_METHOD_LABELS[r.method as keyof typeof TRIAL_TIMING_METHOD_LABELS],
        },
        { key: 'department', header: '部署', value: (r) => text(r.department) },
        { key: 'note', header: 'メモ', value: (r) => text(r.note) },
        {
          key: 'superseded',
          header: '訂正',
          value: (r) => (r.superseded ? '訂正済み（数えない）' : ''),
        },
      ],
      rows: timings.records,
    },
    {
      name: '作業時間（作業ごと）',
      columns: [
        {
          key: 'task',
          header: '作業',
          value: (r) => TRIAL_TASK_LABELS[r.taskKey as keyof typeof TRIAL_TASK_LABELS],
        },
        ...reductionColumns('現行', 'baseline'),
        ...reductionColumns('T4D', 't4d'),
        { key: 'rate', header: '短縮率', value: (r) => r.label },
      ],
      rows: timings.tasks,
    },
    {
      name: '集計',
      columns: [
        { key: 'item', header: '項目', value: (r) => r.item },
        { key: 'value', header: '値', value: (r) => r.value },
        { key: 'note', header: '補足', value: (r) => r.note },
      ],
      rows: summaryRows,
    },
    {
      name: '注記',
      columns: [{ key: 'note', header: '注記', value: (r) => r.note }],
      rows: trialReportNotes(input).map((note) => ({ note })),
    },
  ];
}
