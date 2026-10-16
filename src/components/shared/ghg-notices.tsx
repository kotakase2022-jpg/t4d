import * as React from 'react';
import { Notice, type NoticeTone } from '@/components/shared/notice';
import { formatJstDate } from '@/lib/format/datetime';
import type { IsoDate, IsoDateTime } from '@/types/domain';

/**
 * Scope1・2 の算定と照合の固定文（plan §2.5 の N1〜N10）。
 *
 * 区分方針の当否・照合の限界・改良トンキロ法の適用範囲は、画面ごとに言い回しが変わると
 * 「一致を保証する」「標準の区分である」と読める余地が生まれる。文はここで固定し、
 * スライス（画面・出力）は文言を変えずに呼ぶだけにする（CSV・XLSX の出力も同じ関数の文を使う）。
 * 折りたたみの中に置かない（誠実さの注記は常に見える場所に置く）。
 */

export const GHG_NOTICE_IDS = [
  'N1',
  'N2',
  'N3',
  'N4',
  'N5',
  'N6',
  'N7',
  'N8',
  'N9',
  'N10',
] as const;
export type GhgNoticeId = (typeof GHG_NOTICE_IDS)[number];

/** 差し込みの無い固定文 */
export const GHG_FIXED_NOTICES = {
  N3: 'この照合は、設定した排出係数・算定ルールで算定した結果と既存の算定結果の整合性を確認し、差異の原因を示すものです。結果の一致を保証するものではありません。許容差は利用者が入力した値です。',
  N4: '原因別の寄与は、上の順に前提を既存の算定に揃えて再計算した差です。順序を変えると配分が変わることがあります。単独差（その原因だけを揃えた差）の合計は総差と等しくならないことがあります。説明できない差は「原因不明（残差）」として表示します。',
  N5: '改良トンキロ法は国内のトラック輸送の算定方法です（ロジスティクス分野の共同ガイドライン）。海外拠点の輸送への適用は組織の判断で、国内分と分けて表示します。',
  N6: '温対法・省エネ法の「荷主としての排出量」は事業所の排出とは別の枠で、この画面の Scope 区分とは対応しません。',
  N8: '仮説の再計算は保存しません（試算）。差が閉じても原因の確定にはなりません。原因は確認者が記録します。',
  N9: 'デモの係数セット（出所「架空」）・活動量・既存の算定結果は架空です（実係数・実データではありません）。公的参照（告示・算定省令）として示す値と、それを取り込んだ係数セットは架空ではありません。',
  N10: '告示（平成18年経済産業省告示第66号。令和4年改正までを反映した版）と算定省令の値を収録したものです（確認日 2026-10-16）。令和5年以降の改正の有無は一部未確認です。組織が採用を決めたときだけ係数セットへ取り込みます。',
} as const satisfies Partial<Record<GhgNoticeId, string>>;
export type GhgFixedNoticeId = keyof typeof GHG_FIXED_NOTICES;

export interface CompanyRuleNoticeParams {
  ruleName: string;
  /** 承認の日時（UTC で保存。表示は JST の日付） */
  approvedAt: IsoDateTime | IsoDate;
  approverName: string;
}

/** N1: 承認済みの区分規則で報告区分を決めたとき（P90・P96・E18・GHG サマリー） */
export function companyRuleNoticeText(params: CompanyRuleNoticeParams): string {
  return `報告区分は、組織が承認した算定ルール「${params.ruleName}」（${formatJstDate(params.approvedAt)}・承認者 ${params.approverName}）によるものです。GHG プロトコル（Scope 3 Standard 表 5.7）の標準区分では、自社が所有・支配していない車両による輸送サービスの購入は Scope 3 カテゴリ 4 です。同じ排出を両方に計上しないよう報告区分を 1 つに固定し、既定区分の値を参考として並べています。開示の際に区分方針の注記が必要かをご確認ください。`;
}

/** N2: 区分規則が承認待ちのとき（P90） */
export function pendingRuleNoticeText(params: { ruleName: string }): string {
  return `区分規則「${params.ruleName}」は承認待ちです。承認されるまで、委託物流は既定区分（Scope 3 カテゴリ 4）で算定します。`;
}

export interface LoadFactorNoticeParams {
  /** 積載率が無く、見なし積載率の原単位表で算定した行の数 */
  defaultRows: number;
  /** 積載率の下限（%） */
  minLoadPct: number;
  /** 下限未満のため下限で算定した行の数 */
  flooredRows: number;
}

/** N7: 見なし積載率・下限の適用（P94・P95・P96） */
export function loadFactorNoticeText(params: LoadFactorNoticeParams): string {
  return `積載率が無い行は係数セットの見なし積載率の原単位表で算定しました（${params.defaultRows} 行）。積載率が ${params.minLoadPct}% 未満の行は ${params.minLoadPct}% として算定しました（${params.flooredRows} 行）。`;
}

/** 注記の枠の色。警告色は「読まずに先へ進むと誤解する」もの（区分の違い・承認待ち・架空）に限る */
const TONE: Record<GhgNoticeId, NoticeTone> = {
  N1: 'warning',
  N2: 'warning',
  N3: 'info',
  N4: 'info',
  N5: 'info',
  N6: 'info',
  N7: 'info',
  N8: 'info',
  N9: 'warning',
  N10: 'info',
};

/** 見出し（色だけで種類を示さないため、枠の種類が分かる語を付ける） */
const TITLE: Record<GhgNoticeId, string> = {
  N1: '報告区分は組織の算定ルールによるものです',
  N2: '区分規則は承認待ちです',
  // 「一致」は K8 の固定の否定文（「一致を保証するものではありません」）の形でだけ使う
  N3: '整合性の確認です（結果の一致を保証するものではありません）',
  N4: '原因別の寄与の読み方',
  N5: '海外拠点の輸送',
  N6: '荷主としての排出量との関係',
  N7: '積載率の扱い',
  N8: '試算です（保存しません）',
  N9: '架空のデータです',
  N10: '公的参照の収録範囲',
};

function NoticeFrame({
  id,
  className,
  children,
}: {
  id: GhgNoticeId;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-ghg-notice={id}>
      <Notice tone={TONE[id]} title={TITLE[id]} className={className}>
        <p>{children}</p>
      </Notice>
    </div>
  );
}

/** 差し込みの無い固定文（N3・N4・N5・N6・N8・N9・N10） */
export function GhgNotice({ id, className }: { id: GhgFixedNoticeId; className?: string }) {
  return (
    <NoticeFrame id={id} className={className}>
      {GHG_FIXED_NOTICES[id]}
    </NoticeFrame>
  );
}

/** N1 */
export function CompanyRuleNotice({
  className,
  ...params
}: CompanyRuleNoticeParams & { className?: string }) {
  return (
    <NoticeFrame id="N1" className={className}>
      {companyRuleNoticeText(params)}
    </NoticeFrame>
  );
}

/** N2 */
export function PendingRuleNotice({
  ruleName,
  className,
}: {
  ruleName: string;
  className?: string;
}) {
  return (
    <NoticeFrame id="N2" className={className}>
      {pendingRuleNoticeText({ ruleName })}
    </NoticeFrame>
  );
}

/** N7。見なし・下限のどちらも使っていなければ出さない（該当が無いのに注記を出すと読み手が探してしまう） */
export function LoadFactorNotice({
  className,
  ...params
}: LoadFactorNoticeParams & { className?: string }) {
  if (params.defaultRows <= 0 && params.flooredRows <= 0) return null;
  return (
    <NoticeFrame id="N7" className={className}>
      {loadFactorNoticeText(params)}
    </NoticeFrame>
  );
}
