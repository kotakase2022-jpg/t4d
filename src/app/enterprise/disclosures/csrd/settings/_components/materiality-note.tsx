import { Banknote, Globe, Info, Scale } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { CSRD_DOUBLE_MATERIALITY_NOTE } from '@/lib/domain/csrd';

/**
 * ダブル・マテリアリティの説明（docs/disclosure-first.md §9.2）。
 * CSRD はインパクト重要性と財務的重要性の 2 つの観点で判断し、どちらかで重要なら要求事項が適用になる。
 * SSBJ は財務的重要性だけ（シングル）。2 つを並べて違いが読み取れるようにする。
 *
 * 条文番号は本フェーズで再確認していないため書かない（正式らしい ID を作らない）。
 */
export function DoubleMaterialityNote({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p
        role="note"
        className="flex items-start gap-1.5 rounded-t4d border border-line bg-surface px-3 py-2 text-[11px] leading-relaxed text-ink-muted"
      >
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          CSRD
          はダブル・マテリアリティ（インパクト重要性・財務的重要性のどちらかで重要なら適用）で、
          SSBJ（財務的重要性のみ・シングル）とは考え方が異なります。{CSRD_DOUBLE_MATERIALITY_NOTE}
        </span>
      </p>
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-[1fr_1.4fr] divide-x divide-line">
        <section aria-labelledby="ssbj-single-title" className="space-y-1 p-3">
          <h2 id="ssbj-single-title" className="text-[12px] font-semibold text-ink">
            SSBJ: シングル・マテリアリティ
          </h2>
          <p className="flex items-center gap-1 text-[12px] text-ink">
            <Banknote className="size-3.5 text-ink-muted" aria-hidden="true" />
            財務的重要性のみ
          </p>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            投資家の意思決定に影響する情報か（企業への影響）だけで重要性を判断します。SSBJ
            の設定（マテリアリティ）は変わりません。
          </p>
        </section>
        <section aria-labelledby="csrd-double-title" className="space-y-1 p-3">
          <h2
            id="csrd-double-title"
            className="flex items-center gap-1 text-[12px] font-semibold text-ink"
          >
            <Scale className="size-3.5 text-brand-700" aria-hidden="true" />
            CSRD: ダブル・マテリアリティ
          </h2>
          <ul className="space-y-0.5 text-[12px] text-ink">
            <li className="flex items-center gap-1">
              <Globe className="size-3.5 text-ink-muted" aria-hidden="true" />
              インパクト重要性 — 自社の事業が人・環境に与える影響（実在・潜在、負・正）
            </li>
            <li className="flex items-center gap-1">
              <Banknote className="size-3.5 text-ink-muted" aria-hidden="true" />
              財務的重要性 — サステナビリティ事項が自社に与えるリスク・機会
            </li>
          </ul>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            どちらかの観点で重要と判断した事項の要求事項が適用になります（ESRS 2
            は重要性に関わらず適用）。
            {CSRD_DOUBLE_MATERIALITY_NOTE}
          </p>
        </section>
      </div>
    </Card>
  );
}
