'use client';

import * as React from 'react';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { CONSOLIDATION_LABEL, UNIT_TYPE_LABEL } from './labels';

/**
 * 組織・拠点の入力欄（作成パネル・編集パネルで共通。plan §2 S10・§1.13）。
 * フォーム（PreservingForm）と送信ボタンはページが置く（Server Action はページが持つため）。
 *
 * - 必須の節に「コード・名称・種別・親組織・連結方法・持分」を置く（連結範囲はこの画面の主題）
 * - 除外理由は「連結対象外」を選んだときだけ出す（サービスも連結対象外のときだけ保存する）
 * - 国・通貨・タイムゾーンは親組織から引き継ぐ（D11）。人が書き換えた欄は親を変えても上書きしない。
 *   既定で閉じた任意の節に置く（親と違うときだけ直す）
 */

export interface UnitOption {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  timezone: string;
}

export interface UnitFormValues {
  unitId?: string;
  code: string;
  name: string;
  unitType: string;
  parentId: string;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  consolidationMethod: string;
  ownershipPercent: string;
  exclusionReason: string;
}

const LOCATION_FIELDS = ['countryCode', 'currencyCode', 'timezone'] as const;
type LocationField = (typeof LOCATION_FIELDS)[number];

export function UnitFormFields({
  idPrefix,
  values,
  parents,
  editing,
}: {
  /** 同じ画面に作成と編集が並んでも id が重ならないように */
  idPrefix: string;
  values: UnitFormValues;
  /** 親に選べる組織（編集では自分と子孫を除いて渡す） */
  parents: readonly UnitOption[];
  editing: boolean;
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const touched = React.useRef(new Set<LocationField>());
  const [method, setMethod] = React.useState(values.consolidationMethod);
  const id = (name: string) => `${idPrefix}-${name}`;

  // 入力エラーで戻ったとき、PreservingForm が送った値を戻す（DOM を直接書く）。戻した後の
  // 連結方法を読み直して、除外理由の欄の表示を合わせる
  React.useEffect(() => {
    const select = wrapperRef.current?.querySelector<HTMLSelectElement>(
      'select[name="consolidationMethod"]',
    );
    if (select) setMethod(select.value);
  }, []);

  const inheritFrom = (parentId: string) => {
    const parent = parents.find((p) => p.id === parentId);
    if (!parent || !wrapperRef.current) return;
    for (const field of LOCATION_FIELDS) {
      if (touched.current.has(field)) continue;
      const input = wrapperRef.current.querySelector<HTMLInputElement>(`input[name="${field}"]`);
      if (input) input.value = parent[field];
    }
  };

  const locationChanged =
    values.countryCode !== 'JP' ||
    values.currencyCode !== 'JPY' ||
    values.timezone !== 'Asia/Tokyo';

  return (
    <div ref={wrapperRef} className="space-y-3">
      {values.unitId && <input type="hidden" name="unitId" value={values.unitId} />}
      <FormSection title="基本" kind="required">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="組織コード"
            id={id('code')}
            required
            hint={editing ? 'コードは変えられません（データの紐付けに使うため）' : undefined}
          >
            {(p) => (
              <Input
                {...p}
                name="code"
                defaultValue={values.code}
                readOnly={editing}
                autoComplete="off"
              />
            )}
          </Field>
          <Field label="組織名" id={id('name')} required>
            {(p) => <Input {...p} name="name" defaultValue={values.name} />}
          </Field>
          <Field label="種別" id={id('unitType')} required>
            {(p) => (
              <NativeSelect {...p} name="unitType" defaultValue={values.unitType}>
                {Object.entries(UNIT_TYPE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label="親組織"
            id={id('parentId')}
            hint="国・通貨・タイムゾーンは親組織から引き継ぎます"
          >
            {(p) => (
              <NativeSelect
                {...p}
                name="parentId"
                defaultValue={values.parentId}
                onChange={(event) => inheritFrom(event.currentTarget.value)}
              >
                <option value="">（最上位）</option>
                {parents.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="連結方法" id={id('consolidationMethod')} required>
            {(p) => (
              <NativeSelect
                {...p}
                name="consolidationMethod"
                defaultValue={values.consolidationMethod}
                onChange={(event) => setMethod(event.currentTarget.value)}
              >
                {Object.entries(CONSOLIDATION_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="持分（%）" id={id('ownershipPercent')} required hint="0〜100">
            {(p) => (
              <Input
                {...p}
                name="ownershipPercent"
                inputMode="decimal"
                defaultValue={values.ownershipPercent}
              />
            )}
          </Field>
          <div hidden={method !== 'excluded'} className="sm:col-span-2 lg:col-span-3">
            <Field
              label="除外理由"
              id={id('exclusionReason')}
              hint="連結対象外にした理由（開示・監査で説明します）"
            >
              {(p) => <Input {...p} name="exclusionReason" defaultValue={values.exclusionReason} />}
            </Field>
          </div>
        </div>
      </FormSection>

      <FormSection
        title="所在地（親組織から引き継ぎ）"
        kind="optional"
        open={locationChanged || undefined}
        description="親組織と違う国・通貨・タイムゾーンのときだけ直します。"
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="国コード" id={id('countryCode')} hint="例: JP">
            {(p) => (
              <Input
                {...p}
                name="countryCode"
                defaultValue={values.countryCode}
                onInput={() => touched.current.add('countryCode')}
              />
            )}
          </Field>
          <Field label="通貨コード" id={id('currencyCode')} hint="例: JPY">
            {(p) => (
              <Input
                {...p}
                name="currencyCode"
                defaultValue={values.currencyCode}
                onInput={() => touched.current.add('currencyCode')}
              />
            )}
          </Field>
          <Field label="タイムゾーン" id={id('timezone')} hint="例: Asia/Tokyo">
            {(p) => (
              <Input
                {...p}
                name="timezone"
                defaultValue={values.timezone}
                onInput={() => touched.current.add('timezone')}
              />
            )}
          </Field>
        </div>
      </FormSection>
    </div>
  );
}
