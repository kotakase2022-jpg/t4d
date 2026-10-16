'use client';

import * as React from 'react';
import { Link2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { NativeSelect } from '@/components/ui/native-select';
import { formatNumber } from '@/lib/format/datetime';
import { relinkSupplierFactorAction } from '../../actions';

/**
 * 確定済みの素データ行の排出量原単位を紐づけ直す（plan §1.16 区分 2・§2 S5: 上書きの前に前後を見せる）。
 *
 * 行に置いていた「選択＋更新」を、行の「原単位を変更…」から開く小さなダイアログにした。
 * 変更前・変更後の原単位と、この行の排出量の前後を並べてから確定する（新しい算定版を追記し、
 * 過去の版は残る。サーバーが原単位をマスターと再照合し、排出量を計算し直す）。
 * 画面の排出量はサーバーと同じ丸め（小数 1 桁）で示す見込み値。
 */

export interface RelinkCandidate {
  /** 選択の値（係数コード。同じコードに年度が 2 つ以上あれば「コード@年度」。年度を明示して選ぶ） */
  ref: string;
  code: string;
  name: string;
  factorValue: number;
  factorUnit: string;
  factorYear: number;
}

function roundEmissions(value: number): number {
  return Math.round(value * 10) / 10;
}

export function FactorRelinkDialog({
  reportingPeriodId,
  supplierCode,
  supplierName,
  item,
  activityAmount,
  activityUnit,
  currentValue,
  currentRef,
  candidates,
}: {
  reportingPeriodId: string;
  supplierCode: string;
  supplierName: string;
  item: string;
  activityAmount: number;
  activityUnit: string;
  currentValue: number;
  /** いまの係数の参照（不明なら空） */
  currentRef: string;
  candidates: readonly RelinkCandidate[];
}) {
  const [selected, setSelected] = React.useState(currentRef || (candidates[0]?.ref ?? ''));
  const current = candidates.find((c) => c.ref === currentRef);
  const next = candidates.find((c) => c.ref === selected);
  const nextValue = next ? roundEmissions(activityAmount * next.factorValue) : null;
  const selectId = React.useId();

  return (
    <ConfirmDialog
      tier="bulk"
      title="排出量原単位を変更しますか"
      scope={`${supplierName}（${supplierCode}）／ ${item} ／ 活動量 ${formatNumber(activityAmount)} ${activityUnit}`}
      consequences={[
        '新しい算定版を追記します（過去の版は残ります）。',
        'Data Point の確定値は変わりません（値の変更は承認フローで行います）。',
      ]}
      extraFields={
        <div className="space-y-1">
          <label htmlFor={selectId} className="font-medium">
            変更後の原単位
          </label>
          <NativeSelect
            id={selectId}
            name="factorCode"
            value={selected}
            onChange={(event) => setSelected(event.currentTarget.value)}
            aria-label={`${supplierName} ${item} の排出量原単位`}
          >
            {candidates.map((candidate) => (
              <option key={candidate.ref} value={candidate.ref}>
                {candidate.name}（{candidate.factorValue} {candidate.factorUnit}・
                {candidate.factorYear}年度）
              </option>
            ))}
          </NativeSelect>
        </div>
      }
      preview={
        <table className="w-full rounded-t4d border border-line text-small">
          <caption className="sr-only">変更前と変更後</caption>
          <thead className="bg-surface-muted text-caption text-ink-muted">
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-medium">
                <span className="sr-only">項目</span>
              </th>
              <th scope="col" className="px-2 py-1 text-left font-medium">
                変更前
              </th>
              <th scope="col" className="px-2 py-1 text-left font-medium">
                変更後
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line">
              <th
                scope="row"
                className="px-2 py-1 text-left text-caption font-normal text-ink-muted"
              >
                原単位
              </th>
              <td className="px-2 py-1">
                {current
                  ? `${current.name}（${current.code}）・${current.factorYear}年度`
                  : '不明（旧形式）'}
              </td>
              <td className="px-2 py-1">
                {next ? `${next.name}（${next.code}）・${next.factorYear}年度` : '—'}
              </td>
            </tr>
            <tr className="border-t border-line">
              <th
                scope="row"
                className="px-2 py-1 text-left text-caption font-normal text-ink-muted"
              >
                排出量（t-CO2e）
              </th>
              <td className="tnum px-2 py-1">{formatNumber(currentValue)}</td>
              <td className="tnum px-2 py-1">{formatNumber(nextValue)}（見込み）</td>
            </tr>
          </tbody>
        </table>
      }
      confirmLabel="更新"
      action={relinkSupplierFactorAction}
      fields={{ reportingPeriodId, supplierCode, item }}
      trigger={{
        label: '原単位を変更',
        size: 'xs',
        icon: <Link2 aria-hidden="true" />,
        actionId: `relink-${supplierCode}-${item}`,
      }}
    />
  );
}
