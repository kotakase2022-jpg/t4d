import type { QuantitativeImportDiffKind, QuantitativeImportStatus } from '@/types/domain';

/**
 * 数値の取込の履歴を、行の区分ごとに合計した内訳（「数値を登録」の画面の帯。docs/disclosure-first.md §10.4 B6）。
 *
 * 帯は重ならない区分だけで作り、区分の合計 = 合計に入れた取込の行数にする:
 *  - 合計に入れるのは確定した取込だけ。検証しただけ（未確定）の取込は台帳に書いていないため数えない
 *    （同じファイルを検証し直すたびに「新規」が増えて見えないように）
 *  - 確定した取込で除外した行（正常行のみ登録）は、エラーの行そのもの。「除外」を別の区分にすると
 *    同じ行を 2 回数えるため、エラーの区分の名前に書き、件数は内数として別に返す
 */

export interface ImportHistoryBatch {
  status: QuantitativeImportStatus;
  counts: Readonly<Record<QuantitativeImportDiffKind, number>>;
  excludedCount: number;
}

export interface ImportHistoryBreakdownItem {
  key: QuantitativeImportDiffKind;
  label: string;
  count: number;
}

export interface ImportHistoryBreakdown {
  /** 合計に入れた（確定した）取込の件数 */
  committedBatches: number;
  /** 合計に入れなかった取込（検証のみ・却下）の件数 */
  otherBatches: number;
  /** 確定した取込の行の区分（重ならない。合計 = totalRows） */
  items: ImportHistoryBreakdownItem[];
  /** 確定した取込の行数 */
  totalRows: number;
  /** 確定した取込で登録しなかった（除外した）行。エラーの区分の内数 */
  excludedRows: number;
}

const ITEM_LABEL: Record<QuantitativeImportDiffKind, string> = {
  new: '新規',
  changed: '変更',
  unchanged: '変更なし',
  error: 'エラー（除外・未登録）',
};

const ITEM_ORDER: readonly QuantitativeImportDiffKind[] = ['new', 'changed', 'unchanged', 'error'];

export function importHistoryBreakdown(
  history: readonly ImportHistoryBatch[],
): ImportHistoryBreakdown {
  const committed = history.filter((batch) => batch.status === 'committed');
  const items = ITEM_ORDER.map((key) => ({
    key,
    label: ITEM_LABEL[key],
    count: committed.reduce((sum, batch) => sum + batch.counts[key], 0),
  }));
  return {
    committedBatches: committed.length,
    otherBatches: history.length - committed.length,
    items,
    totalRows: items.reduce((sum, item) => sum + item.count, 0),
    excludedRows: committed.reduce((sum, batch) => sum + batch.excludedCount, 0),
  };
}
