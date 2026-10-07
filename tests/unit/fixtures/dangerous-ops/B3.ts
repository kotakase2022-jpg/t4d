import type { DangerousOp } from './types';

/** Stage B3（CSRD） */
export const B3_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F051',
    label: 'DMA の確定',
    tier: 'irreversible',
    action: 'src/app/enterprise/disclosures/csrd/settings/actions.ts#confirmCsrdDmaAction',
    origins: ['src/app/enterprise/disclosures/csrd/settings/page.tsx'],
    status: 'done',
    note: '設定の手順③の「DMA を確定する」→ ConfirmDialog（範囲 1 行・結果の箇条。確定は人）',
  },
  {
    id: 'F053',
    label: 'IRO の削除（論理削除。DMA の確定を取り消す）',
    tier: 'irreversible',
    action: 'src/app/enterprise/disclosures/csrd/settings/actions.ts#deleteCsrdDmaIroAction',
    origins: ['src/app/enterprise/disclosures/csrd/settings/matters/[topic]/page.tsx'],
    status: 'done',
    note: '行の「操作 ▾ → 削除…」（kind: confirm）。本文に「論理削除」「DMA の確定を取り消す」',
  },
  {
    id: 'F063',
    label: 'AI 草案を本文に採用（本文が置き換わる）',
    tier: 'bulk',
    action: 'src/app/enterprise/disclosures/csrd/draft/actions.ts#adoptCsrdDraftAction',
    origins: ['src/app/enterprise/disclosures/csrd/draft/_components/draft-section-card.tsx'],
    status: 'done',
    note: '本文がある節は ConfirmDialog（置き換わる本文の字数を範囲に）。本文が空なら置き換わるものが無いので確認しない',
  },
];
