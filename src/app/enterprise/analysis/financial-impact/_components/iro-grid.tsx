import Link from 'next/link';
import { ArrowRight, CircleMinus, Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type {
  IroView,
  NarrativeImpactView,
  QualitativeImpactView,
} from '@/lib/services/analysis/financial-impact';

/**
 * 定性情報・IRO（docs/disclosure-first.md §10.3）。**円に換算しない**:
 * IRO は 1〜5 の点数（発生可能性 × 財務影響の大きさ）と期間のまま 5×5 の格子に置き、
 * 定性情報は題・状態と、記録された理由（財務的影響の額を示さない理由など）をそのまま示す。
 * 格子は表（行 = 大きさ、列 = 可能性）。位置は色ではなく行・列の見出しと文字で読む。
 */

const SCORES = [1, 2, 3, 4, 5] as const;

function PathwayChips({ pathways }: { pathways: readonly string[] }) {
  if (pathways.length === 0) {
    return (
      <Badge tone="neutral">
        <CircleMinus className="size-3" aria-hidden="true" />
        円にしない
      </Badge>
    );
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {pathways.map((id) => (
        <Badge key={id} tone="outline">
          <Link2 className="size-3" aria-hidden="true" />
          {id}
        </Badge>
      ))}
    </span>
  );
}

function IroMatrix({ iros }: { iros: readonly IroView[] }) {
  const at = (likelihood: number, magnitude: number) =>
    iros.filter((i) => i.likelihood === likelihood && i.magnitude === magnitude);
  const unplaced = iros.filter((i) => i.likelihood === null || i.magnitude === null);
  return (
    <div className="t4d-scroll-x">
      <table className="w-full border-collapse text-[11px]">
        <caption className="pb-1 text-left text-[12px] font-semibold text-ink">
          IRO（リスク・機会）の位置: 発生可能性 × 財務影響の大きさ（1〜5。円にしない）
        </caption>
        <thead>
          <tr>
            <th scope="col" className="border border-line px-1.5 py-1 text-left text-ink-muted">
              大きさ ＼ 可能性
            </th>
            {SCORES.map((l) => (
              <th key={l} scope="col" className="border border-line px-1.5 py-1 text-ink-muted">
                可能性 {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...SCORES].reverse().map((m) => (
            <tr key={m}>
              <th scope="row" className="border border-line px-1.5 py-1 text-left text-ink-muted">
                大きさ {m}
              </th>
              {SCORES.map((l) => {
                const cell = at(l, m);
                return (
                  <td key={l} className="h-10 min-w-[88px] border border-line px-1 py-1 align-top">
                    {cell.length > 0 && (
                      <ul className="space-y-0.5">
                        {cell.map((iro) => (
                          <li key={iro.id} className="text-ink">
                            <span className="font-semibold">{iro.topic}</span> {iro.typeLabel}
                            {iro.horizonLabel && (
                              <span className="text-ink-muted">・{iro.horizonLabel}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {unplaced.length > 0 && (
        <p className="mt-1 text-[11px] text-ink-muted">
          点数が未入力で格子に置けない IRO: {unplaced.map((i) => i.topic).join('・')}
        </p>
      )}
    </div>
  );
}

function IroList({ iros }: { iros: readonly IroView[] }) {
  return (
    <ul aria-label="IRO（リスク・機会）と経路" className="divide-y divide-line">
      {iros.map((iro) => (
        <li key={iro.id} className="space-y-0.5 py-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] font-semibold text-ink">
              {iro.topic} {iro.topicLabel}・{iro.typeLabel}
            </span>
            <span className="text-[12px] text-ink">{iro.description}</span>
            <PathwayChips pathways={iro.pathways} />
          </div>
          <p className="text-[11px] text-ink-muted">
            可能性 {iro.likelihood ?? '—'} × 大きさ {iro.magnitude ?? '—'}・期間{' '}
            {iro.horizonLabel ?? '未設定'}・事項の結果（人の判断）: {iro.outcomeLabel}
          </p>
          <p className="text-[11px] text-ink-muted">{iro.note}</p>
          <Link
            href={iro.href}
            className="inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline"
          >
            {iro.topic} の IRO と判断（CSRD 設定）
            <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function NarrativeList({ narratives }: { narratives: readonly NarrativeImpactView[] }) {
  // 経路に関連するものと、財務的影響の定性情報（記録された理由を示す）だけを並べる
  const shown = narratives.filter((n) => n.pathways.length > 0 || n.amountNote !== null);
  const others = narratives.length - shown.length;
  if (shown.length === 0) {
    return (
      <p className="text-[12px] text-ink-muted">
        経路に関連する定性情報はありません（登録 {narratives.length} 件）。
      </p>
    );
  }
  return (
    <>
      <ul aria-label="定性情報と経路" className="divide-y divide-line">
        {shown.map((n) => (
          <li key={n.id} className="space-y-0.5 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Link
                href={n.href}
                className="text-[12px] font-semibold text-brand-700 hover:underline"
              >
                {n.title}
              </Link>
              <span className="text-[11px] text-ink-muted">
                {n.themeLabel}・{n.statusLabel}
              </span>
              {n.pathways.length > 0 && <PathwayChips pathways={n.pathways} />}
            </div>
            {n.amountNote && <p className="text-[11px] text-ink">{n.amountNote}</p>}
          </li>
        ))}
      </ul>
      {others > 0 && (
        <p className="text-[11px] text-ink-muted">
          経路に関連しない定性情報 {others} 件は省略しています。
        </p>
      )}
    </>
  );
}

export function QualitativeSection({ view }: { view: QualitativeImpactView }) {
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-muted">
        定性情報・IRO は経路との関連を示すだけで、円に換算しません（試算の合計にも足しません）。IRO
        は CSRD のダブル・マテリアリティ評価（{view.csrdPeriod.code}）のリスク・機会です。
      </p>
      {view.iros.length > 0 ? (
        <>
          <IroMatrix iros={view.iros} />
          <IroList iros={view.iros} />
        </>
      ) : (
        <p className="text-[12px] text-ink-muted">
          {view.csrdPeriod.code} の CSRD の IRO（リスク・機会）は登録されていません。
        </p>
      )}

      <div className="space-y-1">
        <h3 className="text-[12px] font-semibold text-ink">定性情報</h3>
        <NarrativeList narratives={view.narratives} />
      </div>

      <div className="space-y-1">
        <h3 className="text-[12px] font-semibold text-ink">
          SSBJ マテリアリティ（{view.ssbjPeriod ? `${view.ssbjPeriod.code} の評価` : '評価なし'}）
        </h3>
        {view.ssbjTopics.length === 0 ? (
          <p className="text-[12px] text-ink-muted">評価済みのマテリアリティはありません。</p>
        ) : (
          <ul aria-label="SSBJ マテリアリティと経路" className="divide-y divide-line">
            {view.ssbjTopics.map((t) => (
              <li key={t.id} className="space-y-0.5 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12px] font-semibold text-ink">{t.title}</span>
                  <span className="text-[11px] text-ink-muted">{t.materialityLabel}</span>
                  {t.pathways.length > 0 && <PathwayChips pathways={t.pathways} />}
                </div>
                {t.rationale && <p className="text-[11px] text-ink-muted">根拠: {t.rationale}</p>}
              </li>
            ))}
          </ul>
        )}
        <Link
          href="/enterprise/disclosures/ssbj/settings"
          className="inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline"
        >
          SSBJ の設定（マテリアリティ。年度はヘッダーで切り替え）
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
