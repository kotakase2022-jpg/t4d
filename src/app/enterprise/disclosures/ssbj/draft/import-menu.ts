import { DRAFT_SOURCE_LABELS, type DraftImportOption } from '@/lib/services/draft-import';
import type { MenuActionSpec } from '@/lib/ui/actions';
import { importCsrdDraftToProjectAction } from '../../csrd/draft/actions';
import { importSsbjDraftToProjectAction } from './actions';

/**
 * ドラフト画面（SSBJ 開示ドラフト・CSRD 節ドラフト）の「その他 ▾ > 開示プロジェクトの原稿へ取り込む…」
 * （トライアル対応 NF-19）。取り込み先ごとに 1 項目。確認ダイアログ（一括・上書き）の範囲に、置き換わる節と版を出す。
 * 取り込めない（未確定・レビュー中）ものは押せない項目として残し、理由を出す
 */
export function draftImportMenuItems(
  options: readonly DraftImportOption[],
  canWrite: boolean,
): MenuActionSpec[] {
  const items: MenuActionSpec[] = [];
  for (const option of options) {
    const many = option.targets.length > 1;
    for (const target of option.targets) {
      const existing = target.existingBlock;
      const scope = existing
        ? `${option.label} → ${target.projectName}「${target.blockTitle}」（版 ${existing.versionNo ?? '—'}・${existing.statusLabel}）に新しい版（下書き）を追加します`
        : `${option.label} → ${target.projectName} に新しい節「${target.blockTitle}」を作り、版 1（下書き）として取り込みます`;
      items.push({
        kind: 'confirm',
        id: `import-draft-${option.draftId}-${target.projectId}`,
        label: `開示プロジェクトの原稿へ取り込む（${option.label}${many ? `・${target.projectName}` : ''}）…`,
        hidden: !canWrite,
        disabledReason: target.blockedReason ?? undefined,
        action:
          option.source === 'ssbj'
            ? importSsbjDraftToProjectAction
            : importCsrdDraftToProjectAction,
        fields: { draftId: option.draftId, projectId: target.projectId },
        group: 'advanced',
        confirm: {
          tier: 'bulk',
          title: `${DRAFT_SOURCE_LABELS[option.source]}の確定本文を原稿へ取り込みますか`,
          scope,
          consequences: [
            '取り込んだ版は下書きです。承認は引き継がず、原稿のレビュー・最終承認を通します。',
            existing && existing.status === 'approved'
              ? '承認済みの節は「承認後に修正」になり、承認済みの版は残したまま下書きに戻ります。'
              : '節の前の版は残ります（版の履歴から比べられます）。',
            'AI の草案に由来する段落は、段落の印と版の変更理由に残します。',
          ],
          confirmLabel: '取り込む',
          destructive: false,
        },
      });
    }
  }
  return items;
}
