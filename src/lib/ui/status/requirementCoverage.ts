import type { RequirementCoverageCategory } from '@/lib/domain/requirement-coverage';
import type { StatusEntry } from './types';

/**
 * 要求事項の 5 区分（トライアル対応 NF-03。スライド 5 の 4 区分＋未判定）。区分は保存せず
 * src/lib/domain/requirement-coverage.ts の classifyRequirement で毎回導く。所有: Stage A（表示は T1・T8・Stage C）
 */
export const requirementCoverage: Record<RequirementCoverageCategory, StatusEntry> = {
  confirmed: {
    label: '充足確認済み',
    semantic: 'done',
    description: '対応する節がすべて承認済みで、引用した数値・根拠・人の評価がそろっています。',
  },
  needs_check: {
    label: '追加確認が必要',
    semantic: 'question',
    description:
      'レビュー中・未承認の数値・要再確認・過年度の根拠だけなど、確認が残っています。公開草案・サンプルの基準はここが上限です。',
  },
  not_addressed: {
    label: '未対応',
    semantic: 'blocked',
    description: '原稿の節が無い、または下書きで必要な情報が足りません。',
  },
  undetermined: {
    label: '未判定',
    semantic: 'todo',
    description: '適用の判断が無い、または対象外の理由・承認がまだです（分母から外しません）。',
  },
  excluded: {
    label: '対象外',
    semantic: 'excluded',
    description: '理由付きの対象外・非重要で、別の人が承認しています。',
  },
};
