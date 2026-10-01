import { Badge } from '@/components/ui/badge';

export interface UnitOption {
  id: string;
  name: string;
  unitType: string;
  countryCode: string;
  consolidationMethod: string;
  ownershipPercent: number;
}

/**
 * 報告対象の組織・拠点を、資本関係 → 国内外 → サプライヤー の階層で選ぶ（SSBJ・CSRD の設定画面で共通）。
 *
 * 平らな一覧だと「どこまでが連結範囲か」が読めない。報告範囲の判断軸（資本関係・所在地・
 * バリューチェーン）に沿って束ね、束ごとに fieldset／legend で名前を付ける（読み上げで束が分かるように）。
 * サプライヤーの注記だけは画面ごとに違う（SSBJ は「バリューチェーンの扱い」の選択肢を指す）。
 */
export function UnitScopeSelector({
  units,
  includedUnitIds,
  disabled,
  supplierNote,
}: {
  units: UnitOption[];
  includedUnitIds: string[];
  disabled: boolean;
  supplierNote: string;
}) {
  const groups: Array<{ title: string; note?: string; members: UnitOption[] }> = [
    {
      title: '本社・直轄拠点',
      members: units.filter((u) => u.unitType === 'headquarters' || u.unitType === 'site'),
    },
    {
      title: '100% 子会社（連結）',
      members: units.filter(
        (u) =>
          u.unitType === 'subsidiary' &&
          (u.consolidationMethod === 'full' || u.consolidationMethod === 'proportionate'),
      ),
    },
    {
      title: '持分法適用会社',
      note: '連結範囲の外。含めるかどうかは自社の方針で決めます',
      members: units.filter((u) => u.consolidationMethod === 'equity'),
    },
    {
      title: 'サプライヤー',
      note: supplierNote,
      members: units.filter((u) => u.unitType === 'supplier'),
    },
  ];

  return (
    <div className="space-y-2">
      {groups
        .filter((group) => group.members.length > 0)
        .map((group) => (
          <fieldset key={group.title} className="rounded-t4d border border-line px-2.5 py-2">
            <legend className="flex items-center gap-2 px-1 text-[12px] font-medium text-ink">
              {group.title}
              {group.note && (
                <span className="text-[11px] font-normal text-ink-muted">（{group.note}）</span>
              )}
            </legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {/* 国内 → 海外の順に並べ、所在をバッジで併記する */}
              {[...group.members]
                .sort((a, b) => Number(a.countryCode !== 'JP') - Number(b.countryCode !== 'JP'))
                .map((unit) => (
                  <label key={unit.id} className="flex items-center gap-1.5 text-[12px] text-ink">
                    <input
                      type="checkbox"
                      name="includedUnitIds"
                      value={unit.id}
                      defaultChecked={includedUnitIds.includes(unit.id)}
                      disabled={disabled}
                      className="size-3.5 accent-[#0b57a4]"
                    />
                    {unit.name}
                    <Badge tone="neutral">{unit.countryCode === 'JP' ? '国内' : '海外'}</Badge>
                    {unit.consolidationMethod === 'equity' && (
                      <span className="text-[11px] text-ink-muted">
                        持分 {unit.ownershipPercent}%
                      </span>
                    )}
                  </label>
                ))}
            </div>
          </fieldset>
        ))}
    </div>
  );
}
