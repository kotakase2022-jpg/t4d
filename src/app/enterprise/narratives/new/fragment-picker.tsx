'use client';

import * as React from 'react';

export interface PickerFragment {
  id: string;
  locationLabel: string;
  manual: boolean;
  text: string;
}

/** 選べる抜粋の数（サーバーの createNarrativeCandidateFromFragments と同じ） */
export const MIN_FRAGMENTS = 1;
export const MAX_FRAGMENTS = 12;

/**
 * 資料から候補を作るときの抜粋の選択。選んだ数が 1〜12 件の範囲外なら、送信の前にブラウザの
 * 入力検査で止める（送信してから断られると、題名・種別・選択がすべて消えていた）。
 */
export function FragmentPicker({ fragments }: { fragments: PickerFragment[] }) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const firstRef = React.useRef<HTMLInputElement>(null);
  const count = selected.size;
  const message =
    count < MIN_FRAGMENTS
      ? `抜粋を ${MIN_FRAGMENTS} 件以上選んでください。`
      : count > MAX_FRAGMENTS
        ? `抜粋は ${MAX_FRAGMENTS} 件までにしてください（いま ${count} 件）。`
        : '';

  React.useEffect(() => {
    // 最初の選択肢に検査の結果を載せる（送信すると、ここに理由を出してフォーカスを移す）
    firstRef.current?.setCustomValidity(message);
  }, [message]);

  return (
    <fieldset aria-describedby="fragment-count">
      <legend className="text-[12px] font-medium text-ink">
        使う抜粋（{MIN_FRAGMENTS}〜{MAX_FRAGMENTS} 件）
      </legend>
      <p
        id="fragment-count"
        role="status"
        className={`mt-0.5 text-[11px] ${message && count > 0 ? 'text-danger' : 'text-ink-muted'}`}
      >
        選択中 {count} 件{count > MAX_FRAGMENTS ? `（${MAX_FRAGMENTS} 件まで）` : ''}
      </p>
      <ul className="mt-1 max-h-[50vh] space-y-1 overflow-y-auto">
        {fragments.map((f, index) => (
          <li key={f.id} className="rounded-t4d border border-line px-2 py-1">
            <label className="flex gap-2 text-[12px]">
              <input
                ref={index === 0 ? firstRef : undefined}
                type="checkbox"
                name="fragmentIds"
                value={f.id}
                checked={selected.has(f.id)}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(f.id);
                    else next.delete(f.id);
                    return next;
                  })
                }
                className="mt-0.5"
              />
              <span>
                <span className="block text-[11px] font-medium text-ink-muted">
                  {f.locationLabel}
                  {f.manual ? '（手動の抜粋）' : ''}
                </span>
                {f.text}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
