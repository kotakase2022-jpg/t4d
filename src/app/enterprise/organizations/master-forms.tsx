'use client';

import * as React from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import type { MetricDefinition, OrganizationUnit, ReportingPeriod } from '@/types/domain';
import {
  createCampaignAction,
  createMetricAction,
  createUnitAction,
  updateMetricAction,
  updateUnitAction,
} from '../actions';

/**
 * マスターデータ（指標・組織）の追加／編集フォーム。
 *
 * 30 件超の行それぞれにフォームを埋め込むと DOM が肥大化するため、
 * ダイアログを 1 つだけ持ち、追加・編集で使い回す。
 * 送信は Server Action（`createMetricAction` 等）へ直接。成功後は revalidate で再描画される。
 */

function Field({
  label,
  children,
  span = 1,
}: {
  label: string;
  children: React.ReactNode;
  span?: 1 | 2 | 3;
}) {
  const col = span === 3 ? 'col-span-3' : span === 2 ? 'col-span-2' : 'col-span-1';
  return (
    <label className={`${col} block text-[12px] text-ink-muted`}>
      {label}
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

const selectClass =
  'h-8 w-full rounded-t4d border border-line bg-surface px-2 text-[13px] text-ink';

// ----------------------------------------------------------------------
// 指標
// ----------------------------------------------------------------------

const METRIC_CATEGORY_OPTIONS: Array<[string, string]> = [
  ['ghg', 'GHG'],
  ['energy', 'エネルギー'],
  ['water', '水'],
  ['waste', '廃棄物'],
  ['human_capital', '人的資本'],
  ['governance', 'ガバナンス'],
];
const DATA_TYPE_OPTIONS: Array<[string, string]> = [
  ['number', '数値'],
  ['integer', '整数'],
  ['ratio', '比率'],
  ['text', 'テキスト'],
  ['boolean', '真偽'],
];
const AGG_OPTIONS: Array<[string, string]> = [
  ['sum', '合計'],
  ['average', '平均'],
  ['weighted_average', '加重平均'],
  ['ratio', '比率'],
  ['latest', '最新値'],
  ['none', 'なし'],
];

function MetricForm({ metric, onDone }: { metric?: MetricDefinition; onDone: () => void }) {
  return (
    <form action={metric ? updateMetricAction : createMetricAction} onSubmit={() => onDone()}>
      {metric && <input type="hidden" name="metricId" value={metric.id} />}
      <div className="grid grid-cols-3 gap-2 p-4">
        <Field label="指標コード">
          <Input
            name="code"
            required
            defaultValue={metric?.code}
            readOnly={Boolean(metric)}
            placeholder="例: GHG_SCOPE1"
          />
        </Field>
        <Field label="指標名" span={2}>
          <Input name="name" required defaultValue={metric?.name} />
        </Field>
        <Field label="定義" span={3}>
          <Textarea name="description" rows={2} defaultValue={metric?.description} />
        </Field>
        <Field label="カテゴリ">
          <select name="category" className={selectClass} defaultValue={metric?.category ?? 'ghg'}>
            {METRIC_CATEGORY_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="単位">
          <Input name="unit" required defaultValue={metric?.unit} placeholder="例: t-CO2e" />
        </Field>
        <Field label="基準単位（換算用）">
          <Input name="baseUnit" defaultValue={metric?.baseUnit} placeholder="単位と同じで可" />
        </Field>
        <Field label="データ型">
          <select
            name="dataType"
            className={selectClass}
            defaultValue={metric?.dataType ?? 'number'}
          >
            {DATA_TYPE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="集計方法">
          <select
            name="aggregationMethod"
            className={selectClass}
            defaultValue={metric?.aggregationMethod ?? 'sum'}
          >
            {AGG_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="重要度">
          <select
            name="materiality"
            className={selectClass}
            defaultValue={metric?.materiality ?? 'medium'}
          >
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </Field>
        <Field label="報告頻度">
          <select
            name="reportingFrequency"
            className={selectClass}
            defaultValue={metric?.reportingFrequency ?? 'annual'}
          >
            <option value="annual">年次</option>
            <option value="quarterly">四半期</option>
            <option value="monthly">月次</option>
          </select>
        </Field>
        <Field label="責任部署">
          <Input name="responsibleDepartment" defaultValue={metric?.responsibleDepartment ?? ''} />
        </Field>
        <Field label="前年変動許容（±%）">
          <Input
            name="yoyWarningPercent"
            inputMode="decimal"
            defaultValue={
              metric?.yoyWarningRatio == null
                ? ''
                : String(Math.round(metric.yoyWarningRatio * 100))
            }
            placeholder="空欄で判定なし"
          />
        </Field>
        <Field label="算定式" span={2}>
          <Input name="formula" defaultValue={metric?.formula ?? ''} placeholder="任意" />
        </Field>
        <Field label="Evidence 必須">
          <label className="mt-1.5 flex items-center gap-1.5 text-[13px] text-ink">
            <input
              type="checkbox"
              name="requiresEvidence"
              defaultChecked={metric?.requiresEvidence ?? false}
              className="size-3.5"
            />
            必須にする
          </label>
        </Field>
        <Field label="収集単位">
          <label className="mt-1.5 flex items-center gap-1.5 text-[13px] text-ink">
            <input
              type="checkbox"
              name="hqOnly"
              defaultChecked={metric?.hqOnly ?? false}
              className="size-3.5"
            />
            本社のみで収集する（拠点別に集めない）
          </label>
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-2">
        <Button type="submit" size="sm">
          {metric ? '更新する' : '追加する'}
        </Button>
      </div>
    </form>
  );
}

export function AddMetricButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        指標を追加
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl p-0">
          <DialogHeader className="border-b border-line px-4 py-2">
            <DialogTitle>指標マスターを追加</DialogTitle>
            <DialogDescription className="sr-only">
              新しい非財務指標を登録します。
            </DialogDescription>
          </DialogHeader>
          <MetricForm onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function EditMetricButton({ metric }: { metric: MetricDefinition }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={`${metric.name} を編集`}
      >
        <Pencil aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl p-0">
          <DialogHeader className="border-b border-line px-4 py-2">
            <DialogTitle>指標マスターを編集</DialogTitle>
            <DialogDescription className="sr-only">既存の指標定義を更新します。</DialogDescription>
          </DialogHeader>
          <MetricForm metric={metric} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ----------------------------------------------------------------------
// 組織・拠点
// ----------------------------------------------------------------------

const UNIT_TYPE_OPTIONS: Array<[string, string]> = [
  ['headquarters', '本社'],
  ['division', '事業部'],
  ['site', '事業所・工場'],
  ['subsidiary', 'グループ会社'],
  ['supplier', 'サプライヤー'],
];
const CONSOLIDATION_OPTIONS: Array<[string, string]> = [
  ['full', '全部連結'],
  ['proportionate', '比例連結'],
  ['equity', '持分法'],
  ['excluded', '連結対象外'],
];

function UnitForm({
  unit,
  units,
  onDone,
}: {
  unit?: OrganizationUnit;
  units: OrganizationUnit[];
  onDone: () => void;
}) {
  const parents = units.filter((u) => u.id !== unit?.id);
  return (
    <form action={unit ? updateUnitAction : createUnitAction} onSubmit={() => onDone()}>
      {unit && <input type="hidden" name="unitId" value={unit.id} />}
      <div className="grid grid-cols-2 gap-2 p-4">
        <Field label="組織コード">
          <Input name="code" required defaultValue={unit?.code} readOnly={Boolean(unit)} />
        </Field>
        <Field label="組織名">
          <Input name="name" required defaultValue={unit?.name} />
        </Field>
        <Field label="種別">
          <select name="unitType" className={selectClass} defaultValue={unit?.unitType ?? 'site'}>
            {UNIT_TYPE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="親組織">
          <select name="parentId" className={selectClass} defaultValue={unit?.parentId ?? ''}>
            <option value="">（最上位）</option>
            {parents.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="国コード">
          <Input name="countryCode" defaultValue={unit?.countryCode ?? 'JP'} />
        </Field>
        <Field label="通貨コード">
          <Input name="currencyCode" defaultValue={unit?.currencyCode ?? 'JPY'} />
        </Field>
        <Field label="タイムゾーン">
          <Input name="timezone" defaultValue={unit?.timezone ?? 'Asia/Tokyo'} />
        </Field>
        <Field label="連結方法">
          <select
            name="consolidationMethod"
            className={selectClass}
            defaultValue={unit?.consolidationMethod ?? 'full'}
          >
            {CONSOLIDATION_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="持分（%）">
          <Input
            name="ownershipPercent"
            inputMode="decimal"
            defaultValue={unit ? String(unit.ownershipPercent) : '100'}
          />
        </Field>
        <Field label="除外理由（連結対象外のとき）" span={2}>
          <Input name="exclusionReason" defaultValue={unit?.exclusionReason ?? ''} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-2">
        <Button type="submit" size="sm">
          {unit ? '更新する' : '追加する'}
        </Button>
      </div>
    </form>
  );
}

export function AddUnitButton({ units }: { units: OrganizationUnit[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        組織を追加
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl p-0">
          <DialogHeader className="border-b border-line px-4 py-2">
            <DialogTitle>組織・拠点を追加</DialogTitle>
            <DialogDescription className="sr-only">新しい組織階層を登録します。</DialogDescription>
          </DialogHeader>
          <UnitForm units={units} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function EditUnitButton({
  unit,
  units,
}: {
  unit: OrganizationUnit;
  units: OrganizationUnit[];
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={`${unit.name} を編集`}
      >
        <Pencil aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl p-0">
          <DialogHeader className="border-b border-line px-4 py-2">
            <DialogTitle>組織・拠点を編集</DialogTitle>
            <DialogDescription className="sr-only">既存の組織を更新します。</DialogDescription>
          </DialogHeader>
          <UnitForm unit={unit} units={units} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ----------------------------------------------------------------------
// 収集キャンペーン（ORG-P0-002）
// ----------------------------------------------------------------------

export function CreateCampaignButton({
  periods,
  units,
  metrics,
}: {
  periods: ReportingPeriod[];
  units: OrganizationUnit[];
  metrics: MetricDefinition[];
}) {
  const [open, setOpen] = React.useState(false);
  // サプライヤーは収集対象単位から外す（企業内の拠点・子会社が対象）
  const targetUnits = units.filter((u) => u.unitType !== 'supplier');

  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        キャンペーンを作成
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl p-0">
          <DialogHeader className="border-b border-line px-4 py-2">
            <DialogTitle>収集キャンペーンを作成</DialogTitle>
            <DialogDescription className="sr-only">
              対象期間・組織・指標・担当・期限をまとめて収集依頼を作成します。
            </DialogDescription>
          </DialogHeader>
          <form action={createCampaignAction} onSubmit={() => setOpen(false)}>
            <div className="grid grid-cols-2 gap-2 p-4">
              <Field label="キャンペーン名" span={2}>
                <Input name="name" required placeholder="例: FY2026 Q1 一次収集" />
              </Field>
              <Field label="対象期間">
                <select name="reportingPeriodId" className={selectClass} required>
                  {periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="提出期限">
                <Input name="dueDate" type="date" required />
              </Field>
              <Field label="説明" span={2}>
                <Textarea name="description" rows={2} />
              </Field>
              <fieldset className="col-span-1 rounded-t4d border border-line p-2">
                <legend className="px-1 text-[12px] text-ink-muted">対象組織</legend>
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {targetUnits.map((u) => (
                    <label key={u.id} className="flex items-center gap-1.5 text-[12px] text-ink">
                      <input type="checkbox" name="unitIds" value={u.id} className="size-3.5" />
                      {u.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="col-span-1 rounded-t4d border border-line p-2">
                <legend className="px-1 text-[12px] text-ink-muted">対象指標</legend>
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {metrics.map((m) => (
                    <label key={m.id} className="flex items-center gap-1.5 text-[12px] text-ink">
                      <input type="checkbox" name="metricIds" value={m.id} className="size-3.5" />
                      {m.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2">
              <span className="text-[11px] text-ink-muted">
                対象組織 × 対象指標 の各組み合わせを収集スコープとして展開します。
              </span>
              <Button type="submit" size="sm">
                作成する
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
