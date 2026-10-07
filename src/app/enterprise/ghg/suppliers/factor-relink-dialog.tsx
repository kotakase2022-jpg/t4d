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
  code: string;
  name: string;
  factorValue: number;
  factorUnit: string;
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
  currentCode,
  candidates,
}: {
  reportingPeriodId: string;
  supplierCode: string;
  supplierName: string;
  item: string;
  activityAmount: number;
  activityUnit: string;
  currentValue: number;
  currentCode: string;
  candidates: readonly RelinkCandidate[];
}) {
  const [selected, setSelected] = React.useState(currentCode || (candidates[0]?.code ?? ''));
  const current = candidates.find((c) => c.code === currentCode);
  const next = candidates.find((c) => c.code === selected);
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
              <option key={candidate.code} value={candidate.code}>
                {candidate.name}（{candidate.factorValue} {candidate.factorUnit}）
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
                {current ? `${current.name}（${current.code}）` : '不明（旧形式）'}
              </td>
              <td className="px-2 py-1">{next ? `${next.name}（${next.code}）` : '—'}</td>
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
