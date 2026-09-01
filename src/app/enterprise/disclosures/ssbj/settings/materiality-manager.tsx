'use client';

import * as React from 'react';
import { Pencil, Plus, Target, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  suggestMaterialityCategory,
  type CategorySuggestion,
} from '@/lib/domain/materiality-suggest';
import type { MaterialityCategory, MaterialityLevel } from '@/types/domain';
import {
  addMaterialityTopicAction,
  assessMaterialityTopicAction,
  deleteMaterialityTopicAction,
  updateMaterialityTopicAction,
  type MaterialityActionState,
} from '../../../actions';

/**
 * マテリアリティ評価の管理（追加・編集・削除・評価）。
 *
 * 課題は固定の一覧から選ぶのではなく、
 *   ① 自由記述でマテリアリティ名を入力
 *   ② 当てはまりそうな区分（環境・社会・ガバナンス）の提示を受けて選ぶ
 *   ③ 区分に応じた項目（対象指標）が付く
 * の順で登録する。マテリアリティ名 → 区分 → 項目 という階層になる。
 *
 * 入力の誤り（理由未入力など）は画面トップではなく、
 * **操作したフォームのすぐそば**に出す。
 */

export interface TopicRowData {
  id: string;
  title: string;
  category: MaterialityCategory;
  materiality: MaterialityLevel;
  rationale: string;
  metricNames: string[];
}

const CATEGORY_LABEL: Record<MaterialityCategory, string> = {
  environment: '環境',
  social: '社会',
  governance: 'ガバナンス',
};

const LEVEL_LABEL: Record<MaterialityLevel, string> = {
  high: '重要度：高',
  medium: '重要度：中',
  low: '重要度：低',
  not_material: '重要ではない',
  not_assessed: '未評価',
};

const LEVEL_TONE: Record<MaterialityLevel, 'brand' | 'warning' | 'neutral'> = {
  high: 'brand',
  medium: 'warning',
  low: 'neutral',
  not_material: 'neutral',
  not_assessed: 'warning',
};

/** フォームのそばに出す誤りの指摘 */
function InlineError({ state }: { state: MaterialityActionState }) {
  if (!state || state.ok) return null;
  return (
    <p
      role="alert"
      className="mt-1 rounded-t4d border border-danger/40 bg-danger-soft px-2 py-1 text-[11px] text-ink"
    >
      {state.message}
    </p>
  );
}

const PRESET_TITLES = [
  '気候変動（GHG 排出）',
  '水資源の利用',
  '資源循環・廃棄物',
  '人的資本（人材の育成・多様性）',
  '労働安全衛生',
  'サプライチェーン管理',
  'コーポレートガバナンス',
];

// ----------------------------------------------------------------------
// 追加フォーム（自由記述 → 区分の提示 → 選択）
// ----------------------------------------------------------------------

function AddTopicForm({ reportingPeriodId }: { reportingPeriodId: string }) {
  const [state, formAction] = React.useActionState(addMaterialityTopicAction, null);
  const [title, setTitle] = React.useState('');
  /** 利用者が明示的に選んだ区分。null のあいだは最有力候補に追随する */
  const [chosen, setChosen] = React.useState<MaterialityCategory | null>(null);

  const suggestion = React.useMemo(() => suggestMaterialityCategory(title), [title]);
  const selectedCategory = chosen ?? suggestion.top;
  const selected: CategorySuggestion | null =
    suggestion.candidates.find((c) => c.category === selectedCategory) ?? null;

  // 追加できたら入力を空へ戻し、次の課題を続けて入れられるようにする
  React.useEffect(() => {
    if (state?.ok) {
      setTitle('');
      setChosen(null);
    }
  }, [state]);

  return (
    <form action={formAction} className="space-y-2 border-b border-line p-3">
      <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />

      <div>
        <label className="block text-[12px] font-medium text-ink" htmlFor="materiality-title">
          マテリアリティ名（自由記述）
        </label>
        <input
          id="materiality-title"
          type="text"
          name="title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            // 名前を書き直したら、提示も選び直しからやり直す
            setChosen(null);
          }}
          placeholder="例: 気候変動に伴う炭素価格の上昇、熟練技術者の確保"
          className="mt-0.5 h-8 w-full rounded-t4d border border-line px-2 text-[13px]"
        />
        <p className="mt-0.5 text-[11px] text-ink-muted">
          自社の言葉で入力してください。入力すると、当てはまりそうな区分を提示します。
        </p>
        <span className="mt-1 flex flex-wrap gap-1">
          {PRESET_TITLES.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                setTitle(preset);
                setChosen(null);
              }}
              className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-muted hover:border-brand-300 hover:text-ink"
            >
              {preset}
            </button>
          ))}
        </span>
      </div>

      {title.trim() !== '' && (
        <fieldset>
          <legend className="text-[12px] font-medium text-ink">
            区分を選ぶ
            {suggestion.top ? (
              <span className="ml-1 font-normal text-ink-muted">
                （入力内容から候補を提示しています。選ぶのはあなたです）
              </span>
            ) : (
              <span className="ml-1 font-normal text-ink-muted">
                （入力内容からは判断できませんでした。区分を選んでください）
              </span>
            )}
          </legend>
          <div className="mt-1 grid grid-cols-3 gap-1.5">
            {suggestion.candidates.map((candidate) => {
              const isSelected = selectedCategory === candidate.category;
              return (
                <label
                  key={candidate.category}
                  className={`cursor-pointer rounded-t4d border px-2 py-1.5 text-[12px] ${
                    isSelected
                      ? 'border-brand-400 bg-brand-50 text-ink'
                      : 'border-line bg-surface text-ink-muted hover:border-brand-300'
                  }`}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <input
                      type="radio"
                      name="category"
                      value={candidate.category}
                      checked={isSelected}
                      onChange={() => setChosen(candidate.category)}
                      aria-label={`区分: ${candidate.label}`}
                      className="size-3 accent-[#0b57a4]"
                    />
                    {candidate.label}
                  </span>
                  {candidate.matched.length > 0 ? (
                    <span className="mt-0.5 block text-[11px] text-brand-700">
                      一致した語: {candidate.matched.join('・')}
                    </span>
                  ) : (
                    <span className="mt-0.5 block text-[11px]">一致する語はありません</span>
                  )}
                </label>
              );
            })}
          </div>
          {selected && (
            <p className="mt-1 text-[11px] text-ink-muted">
              {selected.ssbjHint}
              {selected.metricCodes.length > 0 &&
                ` 項目（対象指標）として ${selected.metricCodes.length} 件を紐付けます。`}
            </p>
          )}
          {/* 選んだ区分の項目（対象指標）を一緒に送る */}
          {selected?.metricCodes.map((code) => (
            <input key={code} type="hidden" name="metricCodes" value={code} />
          ))}
        </fieldset>
      )}

      <div className="flex items-center gap-2">
        <SubmitButton
          size="sm"
          icon={<Plus aria-hidden="true" />}
          pendingLabel="追加中…"
          disabled={title.trim() === '' || !selectedCategory}
        >
          マテリアリティを追加
        </SubmitButton>
        {title.trim() !== '' && !selectedCategory && (
          <span className="text-[11px] text-ink-muted">区分を選ぶと追加できます。</span>
        )}
      </div>
      <InlineError state={state} />
    </form>
  );
}

// ----------------------------------------------------------------------
// 課題の行（評価・編集・削除）
// ----------------------------------------------------------------------

function TopicRow({ topic }: { topic: TopicRowData }) {
  const [assessState, assessAction] = React.useActionState(assessMaterialityTopicAction, null);
  const [editState, editAction] = React.useActionState(updateMaterialityTopicAction, null);
  const [deleteState, deleteAction] = React.useActionState(deleteMaterialityTopicAction, null);
  const [editing, setEditing] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  React.useEffect(() => {
    if (editState?.ok) setEditing(false);
  }, [editState]);

  return (
    <li className="space-y-1.5 px-3 py-2.5">
      {/* マテリアリティ名 → 区分 → 項目 の階層で見せる */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <Target className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
            {topic.title}
            <Badge tone="neutral">{CATEGORY_LABEL[topic.category]}</Badge>
            <Badge tone={LEVEL_TONE[topic.materiality]}>{LEVEL_LABEL[topic.materiality]}</Badge>
          </p>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            項目: {topic.metricNames.length > 0 ? topic.metricNames.join('・') : '対象指標は未設定'}
          </p>
          {topic.rationale && <p className="mt-0.5 text-[11px] text-ink">{topic.rationale}</p>}
        </div>

        <span className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-label={`${topic.title} を編集`}
          >
            <Pencil aria-hidden="true" />
            編集
          </Button>
          {confirmingDelete ? (
            <span className="flex items-center gap-1">
              <span className="text-[11px] text-ink">削除しますか？</span>
              <form action={deleteAction} className="inline">
                <input type="hidden" name="topicId" value={topic.id} />
                <SubmitButton size="xs" variant="outline" pendingLabel="削除中…">
                  削除する
                </SubmitButton>
              </form>
              <Button
                size="xs"
                variant="outline"
                type="button"
                onClick={() => setConfirmingDelete(false)}
              >
                やめる
              </Button>
            </span>
          ) : (
            <Button
              size="xs"
              variant="outline"
              type="button"
              onClick={() => setConfirmingDelete(true)}
              aria-label={`${topic.title} を削除`}
            >
              <Trash2 aria-hidden="true" />
              削除
            </Button>
          )}
        </span>
      </div>
      <InlineError state={deleteState} />

      {editing && (
        <form
          action={editAction}
          className="flex flex-wrap items-end gap-2 rounded-t4d border border-line bg-surface-muted px-2 py-1.5"
        >
          <input type="hidden" name="topicId" value={topic.id} />
          <label className="text-[11px] text-ink-muted">
            マテリアリティ名
            <input
              type="text"
              name="title"
              defaultValue={topic.title}
              className="mt-0.5 block h-7 w-64 rounded-t4d border border-line px-2 text-[12px]"
            />
          </label>
          <label className="text-[11px] text-ink-muted">
            区分
            <select
              name="category"
              defaultValue={topic.category}
              className="mt-0.5 block h-7 rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
            >
              <option value="environment">環境</option>
              <option value="social">社会</option>
              <option value="governance">ガバナンス</option>
            </select>
          </label>
          <SubmitButton size="xs" pendingLabel="保存中…">
            変更を保存
          </SubmitButton>
          <Button size="xs" variant="outline" type="button" onClick={() => setEditing(false)}>
            <X aria-hidden="true" />
            取消
          </Button>
          <span className="w-full">
            <InlineError state={editState} />
          </span>
        </form>
      )}

      {/* 評価。理由は必須（重要とした根拠も、重要でないとした根拠も監査で問われる） */}
      <form action={assessAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="topicId" value={topic.id} />
        <label className="text-[11px] text-ink-muted">
          評価
          <select
            name="materiality"
            defaultValue={topic.materiality}
            aria-label={`${topic.title} の重要度`}
            className="mt-0.5 block h-7 rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
          >
            <option value="high">重要度：高</option>
            <option value="medium">重要度：中</option>
            <option value="low">重要度：低</option>
            <option value="not_material">重要ではない</option>
            <option value="not_assessed">未評価</option>
          </select>
        </label>
        <span className="min-w-0 flex-1">
          <label className="block text-[11px] text-ink-muted">
            評価理由 <span className="font-medium text-danger">（必須）</span>
            <input
              type="text"
              name="rationale"
              defaultValue={topic.rationale}
              placeholder="なぜその評価なのかを記入"
              aria-label={`${topic.title} の評価理由`}
              className="mt-0.5 block h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
            />
          </label>
          {/* 誤りの指摘は入力欄の直下に出す（画面トップに飛ばさない） */}
          <InlineError state={assessState} />
        </span>
        <SubmitButton size="xs" variant="outline" pendingLabel="保存中…">
          評価を保存
        </SubmitButton>
      </form>
    </li>
  );
}

// ----------------------------------------------------------------------
// 全体
// ----------------------------------------------------------------------

export function MaterialityManager({
  reportingPeriodId,
  topics,
  canEdit,
}: {
  reportingPeriodId: string;
  topics: TopicRowData[];
  canEdit: boolean;
}) {
  return (
    <div>
      {canEdit && <AddTopicForm reportingPeriodId={reportingPeriodId} />}

      {topics.length === 0 ? (
        <p className="px-3 py-4 text-[12px] text-ink-muted">
          まだマテリアリティが登録されていません。
          {canEdit
            ? '上の入力欄に自社の重要課題を自由記述で入力してください。'
            : '編集権限のある担当者が登録すると、ここに表示されます。'}
        </p>
      ) : canEdit ? (
        <ul className="divide-y divide-line">
          {topics.map((topic) => (
            <TopicRow key={topic.id} topic={topic} />
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-line">
          {topics.map((topic) => (
            <li key={topic.id} className="px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                <Target className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                {topic.title}
                <Badge tone="neutral">{CATEGORY_LABEL[topic.category]}</Badge>
                <Badge tone={LEVEL_TONE[topic.materiality]}>{LEVEL_LABEL[topic.materiality]}</Badge>
              </p>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                項目:{' '}
                {topic.metricNames.length > 0 ? topic.metricNames.join('・') : '対象指標は未設定'}
              </p>
              {topic.rationale && <p className="mt-0.5 text-[11px] text-ink">{topic.rationale}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
