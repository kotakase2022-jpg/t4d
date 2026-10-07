import type { IsoDate } from '@/types/domain';
import type { HomeProfile } from './home-profile';
import type { StatusSemantic } from './status/registry';

/**
 * 「自分の作業」の型と並び（plan §1.3・§1.14）。React 非依存・サーバー非依存（サービスと部品が共有）。
 *
 * Attention（放置すると問題になる事実。0 件は出さない）→ Action（次にやること。動詞・対象・期限・理由）。
 * 並びは役割（HomeProfile）で変える: 拠点担当は「直す → 入力する → 回答する → 取込を確認する」、
 * 作成担当は「差戻し原稿を直す → 再確認する → 原稿を書く → 確認する → 取込」…
 */

export const MY_WORK_KINDS = [
  'admin-prepare',
  'data-returned',
  'data-enter',
  'pbc-respond',
  'import-check',
  'manuscript-returned',
  'manuscript-recheck',
  'manuscript-write',
  'data-review',
  'manuscript-review',
  'manuscript-final',
  'data-approve',
] as const;
export type MyWorkKind = (typeof MY_WORK_KINDS)[number];

export interface MyWorkItem {
  key: string;
  kind: MyWorkKind;
  /** 動詞（直す・入力する・確認する・承認する・回答する…） */
  verb: string;
  /** 対象（項目名、または件数のまとめ） */
  target: string;
  /** 補足（基準・担当など） */
  context?: string | null;
  dueDate: IsoDate | null;
  daysUntilDue: number | null;
  /** 阻害理由・差戻し理由など */
  reason: string | null;
  /** 開く先と、ボタンの文言（開示ホームの CTA と同じ文言を保つ） */
  cta: { label: string; href: string };
}

export interface MyWorkAttention {
  key: string;
  label: string;
  count: number;
  href: string;
  semantic: StatusSemantic;
}

export interface MyWorkModel {
  profile: HomeProfile;
  attention: MyWorkAttention[];
  /** 並べ替え済みの全件（表示は先頭 MY_WORK_VISIBLE 件） */
  items: MyWorkItem[];
}

/** 表に出す件数（残りは「すべて見る」） */
export const MY_WORK_VISIBLE = 7;

const PREPARER_ORDER: readonly MyWorkKind[] = [
  'manuscript-returned',
  'manuscript-recheck',
  'manuscript-write',
  'data-review',
  'import-check',
  'data-returned',
  'data-enter',
  'pbc-respond',
  'manuscript-review',
  'manuscript-final',
  'data-approve',
];

/** 役割ごとの Action の並び（plan §1.3 の表）。表に無い種類は末尾 */
export const MY_WORK_ORDER: Record<HomeProfile, readonly MyWorkKind[]> = {
  contributor: ['data-returned', 'data-enter', 'pbc-respond', 'import-check'],
  preparer: PREPARER_ORDER,
  reviewer: ['manuscript-review', 'data-review', 'manuscript-returned', 'manuscript-write'],
  approver: [
    'manuscript-final',
    'data-approve',
    'manuscript-review',
    'data-review',
    'manuscript-returned',
  ],
  admin: ['admin-prepare', ...PREPARER_ORDER],
  // 閲覧者には自分が行う作業が無い（Insight を先頭に出す）
  viewer: [],
};

/** 役割の並びで並べる。同じ種類の中は期限の早い順（期限なしは後ろ）、次に元の順 */
export function orderMyWork(profile: HomeProfile, items: readonly MyWorkItem[]): MyWorkItem[] {
  if (profile === 'viewer') return [];
  const order = MY_WORK_ORDER[profile];
  const rank = (kind: MyWorkKind) => {
    const index = order.indexOf(kind);
    return index === -1 ? order.length + MY_WORK_KINDS.indexOf(kind) : index;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        rank(a.item.kind) - rank(b.item.kind) ||
        (a.item.dueDate ?? '9999-12-31').localeCompare(b.item.dueDate ?? '9999-12-31') ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}
