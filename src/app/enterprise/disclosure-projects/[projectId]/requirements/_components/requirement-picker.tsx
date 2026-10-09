'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';

export interface RequirementPickerOption {
  id: string;
  code: string;
  section: string;
  title: string;
}

/**
 * 要求事項の検索つき複数選択（トライアル対応 NF-05。節の追加フォーム・原稿エディタの対応付けで使う）。
 *
 * - 選択は素のチェックボックス（name で送る。defaultChecked で描くため、PreservingForm が断られた後の値を戻せる）
 * - 検索は表示を絞るだけ（隠れた選択も送る。絞り込みで選択を失わない）
 * - コードと題名の両方を出す（コードだけ・アイコンだけにしない）
 */
export function RequirementPicker({
  options,
  defaultSelected,
  name = 'requirementItemIds',
  idPrefix,
  legend,
}: {
  options: readonly RequirementPickerOption[];
  defaultSelected: readonly string[];
  name?: string;
  idPrefix: string;
  legend: string;
}) {
  const [query, setQuery] = React.useState('');
  const [count, setCount] = React.useState(
    () => options.filter((o) => defaultSelected.includes(o.id)).length,
  );
  const listRef = React.useRef<HTMLUListElement>(null);
  const recount = React.useCallback(
    () => setCount(listRef.current?.querySelectorAll('input[type="checkbox"]:checked').length ?? 0),
    [],
  );
  // 断られた後に PreservingForm が選択を戻したとき（親の layout effect の後）にも数え直す
  React.useEffect(() => {
    recount();
  }, [recount]);
  const normalized = query.trim().toLowerCase();
  const matches = (option: RequirementPickerOption) =>
    normalized === '' ||
    `${option.code} ${option.section} ${option.title}`.toLowerCase().includes(normalized);
  const visible = options.filter(matches).length;

  return (
    <fieldset className="space-y-1.5" data-requirement-picker="">
      <legend className="text-small font-medium text-ink">{legend}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex-1" htmlFor={`${idPrefix}-search`}>
          <span className="sr-only">要求事項を検索</span>
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted"
            aria-hidden="true"
          />
          <Input
            id={`${idPrefix}-search`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // 絞り込みの欄で Enter を押してもフォームを送らない（選び終わる前に保存しない）
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
            placeholder="コード・題名で絞り込む"
            className="h-7 pl-7 text-small"
          />
        </label>
        <span className="text-caption text-ink-muted" aria-live="polite">
          {count} 件を選択中／{options.length} 件中 {visible} 件を表示
        </span>
      </div>
      {options.length === 0 ? (
        <p className="text-small text-ink-muted">
          この基準の版には要求事項が収録されていません（未収録の版では選べません）。
        </p>
      ) : (
        <ul
          ref={listRef}
          className="max-h-56 space-y-0.5 overflow-y-auto rounded-t4d border border-line p-1.5"
          onChange={recount}
        >
          {options.map((option) => (
            <li key={option.id} hidden={!matches(option)}>
              <label
                htmlFor={`${idPrefix}-${option.id}`}
                className="flex items-start gap-1.5 rounded-t4d px-1 py-0.5 text-small hover:bg-surface-muted"
              >
                <NativeCheckbox
                  id={`${idPrefix}-${option.id}`}
                  name={name}
                  value={option.id}
                  defaultChecked={defaultSelected.includes(option.id)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-mono text-caption text-ink-muted">{option.code}</span>{' '}
                  <span className="text-ink">{option.title}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
