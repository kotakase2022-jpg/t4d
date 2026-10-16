import 'server-only';

import { GHG_FIXED_NOTICES } from '@/components/shared/ghg-notices';
import type { ExportSheet } from '@/lib/exports';
import { neutralizeFormula } from '@/lib/exports/disclosure-report';
import { itemSubjectLabel } from '@/lib/domain/ghg/attribution';
import { activityLabel, GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { formatJst } from '@/lib/format/datetime';
import type {
  LoadedReconciliation,
  ReconciliationItemView,
} from '@/lib/services/ghg/reconciliation';
import { statusLabel } from '@/lib/ui/status/registry';
import type { GhgScope } from '@/types/domain';

/**
 * 照合の結果の XLSX（plan E19・CR-15）。シート: 項目・原因別の寄与・確認の記録・条件・注記。
 *
 *  - 値は保存した値のまま（表示で丸め直さない）。単位はすべて t-CO2e（既存の値は t に揃えた値）
 *  - 判定の語は登録簿の語（許容差内・要確認・原因を確認済み・原因不明〔残差〕・片側のみ）。画面と同じ
 *  - 注記の文は画面の固定文と同じ関数・定数の文（N3・N4、Demo なら N9）を使う
 *  - 利用者が入力した文字列（名前・コメント・ファイル名）は数式として解釈されないよう無害化する
 */

type Cell = string | number | null;
type Row = Record<string, Cell>;

export const GHG_RECONCILIATION_SHEET_NAMES = [
  '項目',
  '原因別の寄与',
  '確認の記録',
  '条件',
  '注記',
] as const;

export interface GhgReconciliationExportInput {
  loaded: LoadedReconciliation & { items: ReconciliationItemView[] };
  /** 拠点 ID → コード・名前 */
  units: ReadonlyMap<string, { code: string; name: string }>;
  /** 利用者 ID → 表示名 */
  userNames: ReadonlyMap<string, string>;
  periodLabel: string;
  demo: boolean;
  /** 出力した環境の版 */
  build: string;
  generatedAt: string;
}

const text = (value: string | null | undefined): string => neutralizeFormula(value ?? '');

function sheet(
  name: (typeof GHG_RECONCILIATION_SHEET_NAMES)[number],
  columns: ReadonlyArray<readonly [key: string, header: string, numeric?: boolean]>,
  rows: Row[],
): ExportSheet<Row> {
  return {
    name,
    columns: columns.map(([key, header, numeric]) => ({
      key,
      header,
      value: (row: Row) => row[key] ?? null,
      numeric: numeric ?? false,
    })),
    rows,
  };
}

function scopeLabel(scope: GhgScope): string {
  return GHG_SCOPE_LABELS[scope];
}

/** 項目の主な原因（寄与が最も大きい原因。残差が最大なら「原因不明（残差）」） */
export function mainCauseLabel(
  item: Pick<ReconciliationItemView, 'mainCause' | 'residual'>,
): string {
  if (item.mainCause) return statusLabel('ghgCause', item.mainCause);
  return Math.abs(item.residual) > 0 ? statusLabel('ghgCause', 'residual') : '—';
}

/** 出力の注記（画面の固定文と同じ文） */
export function ghgReconciliationNotes(input: {
  demo: boolean;
  generatedAt: string;
  build: string;
}): string[] {
  const notes = [
    GHG_FIXED_NOTICES.N3,
    GHG_FIXED_NOTICES.N4,
    '判定は「許容差内」「要確認」「原因を確認済み」「原因不明（残差）」「片側のみ」のいずれかです。「原因を確認済み」は確認者が原因を記録した項目です（AI は関与していません）。',
    '差は「既存 − T4D」（t-CO2e）です。既存の値は t-CO2e に揃えた値です。',
    `出力日時: ${formatJst(input.generatedAt)}・環境の版: ${input.build}`,
  ];
  if (input.demo) notes.unshift(GHG_FIXED_NOTICES.N9);
  return notes;
}

export function buildGhgReconciliationSheets(
  input: GhgReconciliationExportInput,
): ExportSheet<Row>[] {
  const { loaded, units, userNames } = input;
  const { reconciliation, run, baseline, items } = loaded;
  const unitCode = (id: string | null) => (id ? (units.get(id)?.code ?? '') : '');
  const unitName = (id: string | null) => (id ? (units.get(id)?.name ?? '') : '');
  const activity = (i: Pick<ReconciliationItemView, 'activityKind' | 'activityCode'>) =>
    i.activityKind && i.activityCode
      ? activityLabel(i.activityKind, i.activityCode)
      : '（区分の合計）';
  const userName = (id: string) => text(userNames.get(id) ?? '（不明な利用者）');
  const itemByKey = new Map(items.map((i) => [i.key, i]));

  const itemRows: Row[] = items.map((i) => ({
    unitCode: text(unitCode(i.unitId)),
    unit: text(unitName(i.unitId)),
    scope: scopeLabel(i.scope),
    activity: activity(i),
    month: i.month ? i.month.slice(0, 7) : '',
    shipment: text(i.shipmentRef),
    t4d: i.t4d,
    baseline: i.baseline,
    diff: i.diff,
    diffPct: i.diffPct,
    verdict: statusLabel('ghgReconItem', i.verdict),
    mainCause: mainCauseLabel(i),
    residual: i.residual,
    oneSided:
      i.oneSided === 't4d_only' ? 'T4D のみ' : i.oneSided === 'baseline_only' ? '既存のみ' : '',
    note: i.latestNote ? statusLabel('ghgCause', i.latestNote.confirmedCause) : '',
  }));

  const stepRows: Row[] = items.flatMap((i) =>
    i.steps.map((s, index) => ({
      unitCode: text(unitCode(i.unitId)),
      scope: scopeLabel(i.scope),
      activity: activity(i),
      subject: itemSubjectLabel(i),
      order: index + 1,
      cause: statusLabel('ghgCause', s.cause),
      delta: s.delta,
      applicable: s.applicable ? '適用' : '適用できない（既存の側に情報が無い）',
      single: i.single.find((x) => x.cause === s.cause)?.delta ?? null,
      residual: index === i.steps.length - 1 ? i.residual : null,
    })),
  );

  const noteRows: Row[] = items
    .flatMap((i) => i.notes)
    .sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1 : 0))
    .map((n) => {
      const item = itemByKey.get(n.itemKey);
      return {
        decidedAt: formatJst(n.decidedAt),
        decidedBy: userName(n.decidedBy),
        unitCode: text(unitCode(item?.unitId ?? null)),
        scope: item ? scopeLabel(item.scope) : '',
        activity: item ? activity(item) : '',
        subject: item ? itemSubjectLabel(item) : '',
        cause: statusLabel('ghgCause', n.confirmedCause),
        comment: text(n.comment),
        supersedes: n.supersedesId ? '前の記録を差し替え' : '',
      };
    });

  const tolerance = Object.entries(reconciliation.tolerance).map(([scope, t]) => ({
    item: `許容差（${scopeLabel(scope as GhgScope)}）`,
    value: [
      t?.absoluteT !== null && t?.absoluteT !== undefined ? `絶対値 ${t.absoluteT} t` : null,
      t?.relativePct !== null && t?.relativePct !== undefined ? `相対 ${t.relativePct}%` : null,
    ]
      .filter(Boolean)
      .join(' または '),
  }));
  const conditionRows: Row[] = [
    { item: '期間', value: text(input.periodLabel) },
    { item: '照合の記録', value: reconciliation.id },
    { item: '照合の日時', value: formatJst(reconciliation.createdAt) },
    { item: '照合した人', value: userName(reconciliation.createdBy) },
    { item: '照合の規則の版', value: reconciliation.checkerVersion },
    {
      item: '原因を揃える順序',
      value: reconciliation.attributionOrder.map((c) => statusLabel('ghgCause', c)).join(' → '),
    },
    ...tolerance,
    { item: '算定の記録', value: run.id },
    { item: '算定の日時', value: formatJst(run.createdAt) },
    { item: '算定のエンジンの版', value: run.engineVersion },
    { item: '算定の入力ハッシュ', value: run.inputHash },
    { item: '既存の算定結果', value: text(baseline.label) },
    { item: '既存の算定結果のファイル', value: text(baseline.fileName) },
    { item: '既存の算定結果のファイルの sha256', value: baseline.fileSha256 },
    { item: '既存の算定結果の行数', value: String(baseline.rowCount) },
  ];

  return [
    sheet(
      '項目',
      [
        ['unitCode', '拠点コード'],
        ['unit', '拠点'],
        ['scope', '区分'],
        ['activity', '活動'],
        ['month', '月'],
        ['shipment', '出荷番号'],
        ['t4d', 'T4D（t-CO2e）', true],
        ['baseline', '既存（t-CO2e）', true],
        ['diff', '差（既存−T4D・t-CO2e）', true],
        ['diffPct', '差率（%）', true],
        ['verdict', '判定'],
        ['mainCause', '主な原因（寄与の最大）'],
        ['residual', '原因不明（残差）（t-CO2e）', true],
        ['oneSided', '片側のみ'],
        ['note', '確認者が記録した原因'],
      ],
      itemRows,
    ),
    sheet(
      '原因別の寄与',
      [
        ['unitCode', '拠点コード'],
        ['scope', '区分'],
        ['activity', '活動'],
        ['subject', '月・出荷'],
        ['order', '順'],
        ['cause', '原因'],
        ['delta', '寄与（t-CO2e）', true],
        ['applicable', '適用'],
        ['single', '単独差（t-CO2e）', true],
        ['residual', '原因不明（残差）（t-CO2e）', true],
      ],
      stepRows,
    ),
    sheet(
      '確認の記録',
      [
        ['decidedAt', '日時'],
        ['decidedBy', '確認者'],
        ['unitCode', '拠点コード'],
        ['scope', '区分'],
        ['activity', '活動'],
        ['subject', '月・出荷'],
        ['cause', '原因'],
        ['comment', 'コメント'],
        ['supersedes', '差し替え'],
      ],
      noteRows,
    ),
    sheet(
      '条件',
      [
        ['item', '項目'],
        ['value', '値'],
      ],
      conditionRows,
    ),
    sheet(
      '注記',
      [['note', '注記']],
      ghgReconciliationNotes(input).map((note) => ({ note })),
    ),
  ];
}
