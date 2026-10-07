import { Banknote, Globe, Info, Scale } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Collapsible } from '@/components/ui/collapsible';
import { MoreInfo } from '@/components/ui/more-info';
import { CSRD_DOUBLE_MATERIALITY_NOTE, SSBJ_VS_CSRD_MATERIALITY_NOTE } from '@/lib/domain/csrd';

/**
 * ダブル・マテリアリティの説明（docs/disclosure-first.md §9.2）。
 * CSRD はインパクト重要性と財務的重要性の 2 つの観点で判断し、どちらかで重要なら要求事項が適用になる。
 * SSBJ は財務的重要性だけ（シングル）。2 つを並べて違いが読み取れるようにする。
 *
 * 文字量を減らす（§10.4）: 違いは短い 1 行（または 2 つの見出し）で常に見せ、説明の全文は既定で閉じる。
 * 改正 ESRS が未発効であることは誠実さの注記なので、折りたたみの外か summary に置き、閉じていても見せる。
 *
 * 条文番号は本フェーズで再確認していないため書かない（正式らしい ID を作らない）。
 */

/** SSBJ との違いの 1 行（常に見せる。全文は SSBJ_VS_CSRD_MATERIALITY_NOTE） */
export const SSBJ_VS_CSRD_SHORT =
  'SSBJ は財務的重要性のみ（シングル）。CSRD はインパクトか財務のどちらかで重要なら適用（ダブル）';

/** 改正 ESRS が未発効であることの 1 行（閉じた説明に入れず、常に見せる。全文は CSRD_DOUBLE_MATERIALITY_NOTE） */
export const REVISED_ESRS_NOT_IN_FORCE = '改正 ESRS（2026-07-03 採択）は未発効・本サンプルに未反映';

/** 対応状況の DMA 要約に添える SSBJ との違い（1 行＋閉じた全文） */
export function SsbjDifferenceLine() {
  return (
    <div className="space-y-0.5">
      <p className="flex items-start gap-1.5 text-small text-ink">
        <Info className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        {SSBJ_VS_CSRD_SHORT}
      </p>
      <MoreInfo label="SSBJ との違い" className="pl-5">
        <p>{SSBJ_VS_CSRD_MATERIALITY_NOTE}</p>
      </MoreInfo>
    </div>
  );
}

export function DoubleMaterialityNote({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div
        role="note"
        className="space-y-0.5 rounded-t4d border border-line bg-surface px-3 py-1.5 text-small"
      >
        <p className="flex items-start gap-1.5 text-ink">
          <Info className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          <span>
            {SSBJ_VS_CSRD_SHORT}。{REVISED_ESRS_NOT_IN_FORCE}。
          </span>
        </p>
        <MoreInfo label="考え方の根拠と注記" className="pl-5">
          <p>{SSBJ_VS_CSRD_MATERIALITY_NOTE}</p>
          <p>{CSRD_DOUBLE_MATERIALITY_NOTE}</p>
        </MoreInfo>
      </div>
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-[1fr_1.4fr] divide-x divide-line">
        <section aria-labelledby="ssbj-single-title" className="space-y-1 p-3">
          <h2 id="ssbj-single-title" className="text-small font-semibold text-ink">
            SSBJ: シングル・マテリアリティ
          </h2>
          <p className="flex items-center gap-1 text-small text-ink">
            <Banknote className="size-3.5 text-ink-muted" aria-hidden="true" />
            財務的重要性のみ
          </p>
        </section>
        <section aria-labelledby="csrd-double-title" className="space-y-1 p-3">
          <h2
            id="csrd-double-title"
            className="flex items-center gap-1 text-small font-semibold text-ink"
          >
            <Scale className="size-3.5 text-brand-700" aria-hidden="true" />
            CSRD: ダブル・マテリアリティ
          </h2>
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-small text-ink">
            <span className="inline-flex items-center gap-1">
              <Globe className="size-3.5 text-ink-muted" aria-hidden="true" />
              インパクト重要性
            </span>
            <span className="text-ink-muted">または</span>
            <span className="inline-flex items-center gap-1">
              <Banknote className="size-3.5 text-ink-muted" aria-hidden="true" />
              財務的重要性
            </span>
            <span className="text-ink-muted">で重要なら適用（ESRS 2 は常に適用）</span>
          </p>
        </section>
      </div>
      <Collapsible
        variant="plain"
        summary={`考え方の詳細 ／ ${REVISED_ESRS_NOT_IN_FORCE}`}
        className="border-t border-line px-3 py-1"
        bodyClassName="space-y-1.5 leading-relaxed text-ink-muted"
      >
        <p>
          SSBJ: 投資家の意思決定に影響する情報か（企業への影響）だけで重要性を判断します。SSBJ
          の設定（マテリアリティ）は変わりません。
        </p>
        <ul className="space-y-0.5">
          <li>インパクト重要性 — 自社の事業が人・環境に与える影響（実在・潜在、負・正）</li>
          <li>財務的重要性 — サステナビリティ事項が自社に与えるリスク・機会</li>
        </ul>
        <p>
          CSRD: どちらかの観点で重要と判断した事項の要求事項が適用になります（ESRS 2
          は重要性に関わらず適用）。{CSRD_DOUBLE_MATERIALITY_NOTE}
        </p>
      </Collapsible>
    </Card>
  );
}
