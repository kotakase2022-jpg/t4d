import { FormSection } from '@/components/ui/form-section';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import type { OrganizationUnit } from '@/types/domain';

/**
 * 担当拠点の選択（トライアル対応 NF-25。招待の作成欄と、役割・担当拠点の変更欄で同じ形）。
 * 自社の拠点（本社・工場・子会社）は常に並べ、取引先（サプライヤー）の拠点は数が多いので
 * 任意の節に畳む（選んでいるときは開いて描く）。何も選ばなければ全社
 */
export function UnitScopeFields({
  units,
  selected = [],
}: {
  units: readonly OrganizationUnit[];
  selected?: readonly string[];
}) {
  const own = units.filter((unit) => unit.unitType !== 'supplier');
  const suppliers = units.filter((unit) => unit.unitType === 'supplier');
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-3">
        {own.map((unit) => (
          <NativeCheckbox
            key={unit.id}
            name="unitScopeIds"
            value={unit.id}
            defaultChecked={selected.includes(unit.id)}
            label={unit.name}
          />
        ))}
      </div>
      {suppliers.length > 0 && (
        <FormSection
          title={`取引先（サプライヤー）の拠点（${suppliers.length}）`}
          kind="optional"
          open={suppliers.some((unit) => selected.includes(unit.id))}
        >
          <div className="flex flex-wrap gap-3">
            {suppliers.map((unit) => (
              <NativeCheckbox
                key={unit.id}
                name="unitScopeIds"
                value={unit.id}
                defaultChecked={selected.includes(unit.id)}
                label={unit.name}
              />
            ))}
          </div>
        </FormSection>
      )}
    </div>
  );
}
