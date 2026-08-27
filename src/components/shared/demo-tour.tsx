'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { PlayCircle, X, GripHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * デモモード（機能追加要望 ③）。
 *
 * 上場企業のサステナ担当・開示担当者が「自分の仕事がどう楽になるか」を
 * 順番に体験できるよう、実画面を巡回しながら見どころを案内する。
 *
 * **話の軸は SSBJ 対応**。「基準に対していま自社はどこまで対応できているのか」から始め、
 *   現在地 → 何が足りないか → 誰がいつまでに何をするか → そのデータをどう集めるか
 *   → 集めた数字の根拠と承認をどう残すか → 他の開示にも使い回せる
 * という順に見せる。機能を並べるのではなく、SSBJ 対応という 1 本の仕事を追う。
 *
 * Sidebar（enterprise レイアウト内で永続する Client Component）から描画されるため、
 * ツアーの進行状態は局所 state だけで画面遷移をまたいで保持できる。
 */

interface TourStep {
  href: string;
  title: string;
  /** この画面で何が解決するか（担当者の言葉で） */
  body: string;
  /** 具体的にどこを見るか */
  lookAt: string;
  /** SSBJ 対応の 8 段階のどこにあたるか（null = 全体を支える機能） */
  phase: string | null;
}

const TOUR_STEPS: TourStep[] = [
  {
    href: '/enterprise/dashboard',
    title: 'ホーム — SSBJ 対応の現在地から 1 日が始まる',
    body: 'SSBJ 対応度と未対応件数を先頭に置き、期限超過・検証エラー・監査法人からの依頼を 1 画面へ集約しています。朝ここを見れば、今日どの要求事項に手を付けるかが決まります。',
    lookAt:
      '「SSBJ 対応度」と「SSBJ 未対応」のカード。クリックすると該当の要求事項一覧へ直行します。',
    phase: null,
  },
  {
    href: '/enterprise/disclosures/ssbj',
    title: 'SSBJ 対応状況 — 単一の点数にまとめない',
    body: 'SSBJ 対応は「できた／できない」の二択では測れません。開示（資料に書いてあるか）・データ（社内で数値が取れているか）・業務プロセス（継続的かつ正確に集めて承認できる仕組みがあるか）を分けて出します。多くの企業は開示だけ先行し、データと仕組みが遅れます。',
    lookAt:
      '3 つの整備度の差。そして領域別（ガバナンス／戦略／リスク管理／指標及び目標）の対応率。',
    phase: '手順 1〜2: 分析条件の設定・資料の取り込み',
  },
  {
    href: '/enterprise/disclosures/ssbj/requirements',
    title: 'SSBJ 要求事項一覧 — 133 項目を 3 つの軸で仕分ける',
    body: '正式基準（転載許可取得済み）の全 133 要求事項を、適用区分（対象／対象外）・重要性（あり／なし）・対応状況の 3 軸で管理します。すべてを一律に評価するのではなく、自社に適用され重要性のあるものへ力を集中させます。',
    lookAt:
      '「人工知能による判定」と「最終判定」が別の列であること。絞り込みで「未対応のみ」「優先度：高」に切り替えてみてください。',
    phase: '手順 3: 対象判定・重要性判断',
  },
  {
    href: '/enterprise/disclosures/ssbj/requirements/top-priority',
    title: 'ギャップ分析 — 要求事項と現在の開示を突き合わせる',
    body: 'いま最も優先度の高い要求事項を開きました。左に基準の原文、右に既存資料から見つけた該当箇所（出典・ページ・該当文章）を並べます。人工知能は「一部対応」といった判定に加えて、何が不足しているのかを列挙し、次に取るべき対応を示します。',
    lookAt:
      '3 種類のギャップ（開示・データ・業務プロセス）と、「不足している情報」の具体的な列挙。',
    phase: '手順 4: 人工知能によるギャップ分析',
  },
  {
    href: '/enterprise/disclosures/ssbj/requirements/top-priority',
    title: '担当者による確認 — 人工知能は確定しない',
    body: '人工知能の判定はあくまで候補です。担当者が承認するか修正するかを選び、確認コメントを添えて初めて最終判定になります。誰がいつどの根拠で判断したかは履歴に残り、第三者保証で説明できます。人工知能を再実行すると確認はやり直しになります。',
    lookAt: '「担当者による確認」の承認／修正の選択と、右側の「優先順位の評価」6 項目の根拠。',
    phase: '手順 5〜6: 担当者による確認・優先順位付け',
  },
  {
    href: '/enterprise/disclosures/ssbj/plans',
    title: '対応計画 — 「あとで対応」を具体的な仕事に変える',
    body: 'ギャップを見つけただけでは何も進みません。対応区分（データ収集／開示内容追加／ガバナンス整備／内部統制整備など）・担当部署・担当者・期限・優先順位を決め、対応状況を追跡します。期限超過は赤で出ます。',
    lookAt: '関連する要求事項からの逆引きと、期限の残り日数表示。',
    phase: '手順 7: 対応計画の作成',
  },
  {
    href: '/enterprise/disclosures/ssbj/collection',
    title: 'データ収集 — ギャップから収集依頼までつながる',
    body: 'データギャップの対応計画から「データ収集項目を作成」すると、指標マスターへ登録され、拠点ごとに入力担当者と提出期限が設定されます。ギャップ分析 → 対応計画 → データ収集が途切れません。',
    lookAt: '集計対象範囲・入力担当者・提出期限と、収集状況（未入力／承認済み）。',
    phase: '手順 8: データ収集・開示・内部統制',
  },
  {
    href: '/enterprise/imports',
    title: '実際に集める — 事前加工なしの一括取込',
    body: '不足データを集める段になると、拠点や海外子会社からフォーマットも言語も違うファイルが届きます。事前加工なしでまとめてドロップすれば、人工知能が指標・拠点・単位を仕分けます。帳票に混ざる小計・合計行は検知して、二重計上を防ぎます。',
    lookAt: '複数ファイルの一括投入と、取込プレビューの警告（集計行・バウンダリ差異）。',
    phase: '手順 8: データ収集',
  },
  {
    href: '/enterprise/data',
    title: '非財務データ台帳 — 数字に承認の証跡を付ける',
    body: 'SSBJ の「業務プロセス・内部統制」ギャップを埋めるのがこの台帳です。単位不一致や前年比異常を自動検出し、提出 → レビュー → 承認の履歴を残します。「この数字は誰がいつ承認したか」に即答できる状態を作ります。',
    lookAt:
      '絞り込み「検証エラー」と、行の状態バッジ。組織・指標マスターで定義を揃えていることが前提です。',
    phase: '手順 8: 内部統制',
  },
  {
    href: '/enterprise/evidence',
    title: '根拠資料 — 第三者保証で聞かれる前に紐付ける',
    body: '請求書や検針記録を数値に紐付けておけば、監査法人からのサンプル要求に期末で慌てません。SSBJ 対応の最終目的地は「保証を受けられる開示」です。',
    lookAt: 'ファイルとデータの紐付け（どの数字の根拠か）。',
    phase: '手順 8: 内部統制・第三者保証への備え',
  },
  {
    href: '/enterprise/disclosures/cdp',
    title: '他の開示にも使い回す — CDP・CSRD',
    body: 'SSBJ のために整えたデータと根拠は、そのまま CDP や CSRD の回答に使えます。CDP では前年からの新規・変更だけを絞り込み、承認済みデータから回答ドラフトを作成できます。',
    lookAt: '「前年差分だけ回答」ビューと、整合チェック・適用判定。',
    phase: null,
  },
  {
    href: '/enterprise/workflows',
    title: '監査法人とのやりとり — ここまでが一巡',
    body: '社内の承認タスクと監査法人からの資料依頼（PBC）を同じ画面で管理します。SSBJ 対応で整えた根拠と承認履歴が、そのまま保証手続への回答になります。',
    lookAt: 'PBC の期限と状態。ここまでがデモの一巡です。',
    phase: null,
  },
];

export function DemoTour({ collapsed }: { collapsed: boolean }) {
  const router = useRouter();
  // null = ツアー未開始
  const [step, setStep] = React.useState<number | null>(null);

  /**
   * ポップアップの位置（右下からのオフセット px）。
   * 画面の右下に固定していると、案内したい要素がちょうどそこにある場合に隠れてしまう。
   * ヘッダーを掴んで動かせるようにし、キーボードでも動かせるようにする。
   */
  const [offset, setOffset] = React.useState({ right: 16, bottom: 16 });
  const dragState = React.useRef<{
    startX: number;
    startY: number;
    right: number;
    bottom: number;
  } | null>(null);

  /** 画面外へ出さないための丸め（ポップアップの想定サイズ分を残す） */
  const clamp = React.useCallback((next: { right: number; bottom: number }) => {
    if (typeof window === 'undefined') return next;
    const maxRight = Math.max(0, window.innerWidth - 200);
    const maxBottom = Math.max(0, window.innerHeight - 120);
    return {
      right: Math.min(Math.max(0, next.right), maxRight),
      bottom: Math.min(Math.max(0, next.bottom), maxBottom),
    };
  }, []);

  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    // 閉じるボタンなどの操作を邪魔しない
    if ((e.target as HTMLElement).closest('button')) return;
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      right: offset.right,
      bottom: offset.bottom,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragState.current;
    if (!start) return;
    // right / bottom 基準なので、カーソルの移動量は符号を反転して足す
    setOffset(
      clamp({
        right: start.right - (e.clientX - start.startX),
        bottom: start.bottom - (e.clientY - start.startY),
      }),
    );
  };

  const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    dragState.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  /** キーボード操作（ドラッグできない環境でも動かせるようにする） */
  const onHeaderKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const stepPx = e.shiftKey ? 64 : 16;
    const move: Record<string, { right: number; bottom: number }> = {
      ArrowLeft: { right: stepPx, bottom: 0 },
      ArrowRight: { right: -stepPx, bottom: 0 },
      ArrowUp: { right: 0, bottom: stepPx },
      ArrowDown: { right: 0, bottom: -stepPx },
    };
    const delta = move[e.key];
    if (!delta) return;
    e.preventDefault();
    setOffset((prev) =>
      clamp({ right: prev.right + delta.right, bottom: prev.bottom + delta.bottom }),
    );
  };
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const startRef = React.useRef<HTMLButtonElement>(null);

  const start = () => {
    setStep(0);
    router.push(TOUR_STEPS[0]!.href);
  };
  const stop = () => {
    setStep(null);
    // ツアーを閉じたらフォーカスを開始ボタンへ戻す（キーボード利用者が迷子にならない）
    startRef.current?.focus();
  };
  const go = (next: number) => {
    const target = TOUR_STEPS[next];
    if (!target) return;
    setStep(next);
    router.push(target.href);
  };

  // ツアー表示中は Escape で終了できる（フォーカスも閉じるボタンへ移す）
  React.useEffect(() => {
    if (step === null) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const current = step === null ? null : TOUR_STEPS[step];

  const button = (
    <button
      ref={startRef}
      type="button"
      onClick={start}
      aria-label={collapsed ? 'デモモードを開始' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-t4d px-2 py-1.5 text-[13px] font-medium text-brand-800 transition-colors hover:bg-brand-50',
        collapsed && 'justify-center px-0',
      )}
    >
      <PlayCircle className="size-4 shrink-0" aria-hidden="true" />
      {!collapsed && <span>デモモード</span>}
    </button>
  );

  return (
    <>
      {collapsed ? <Hint label="デモモード">{button}</Hint> : button}

      {current && step !== null && (
        <div
          role="dialog"
          aria-label={`デモモード ステップ ${step + 1}: ${current.title}`}
          className="t4d-no-print fixed z-50 w-[380px] rounded-t4d border border-brand-200 bg-surface shadow-lg"
          style={{ right: offset.right, bottom: offset.bottom }}
        >
          <div
            role="button"
            tabIndex={0}
            aria-label="デモモードの案内を移動（ドラッグ、または矢印キー。Shift で大きく移動）"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onKeyDown={onHeaderKeyDown}
            className="flex touch-none cursor-grab items-center justify-between gap-2 border-b border-line px-3 py-2 select-none active:cursor-grabbing"
          >
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-brand-800">
              <GripHorizontal className="size-3.5" aria-hidden="true" />
              デモモード（{step + 1} / {TOUR_STEPS.length}）
            </span>
            <button
              ref={closeRef}
              type="button"
              onClick={stop}
              aria-label="デモモードを終了"
              className="rounded-t4d p-0.5 text-ink-muted hover:bg-brand-50 hover:text-ink"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <div className="space-y-1.5 px-3 py-2.5">
            {/* SSBJ 対応の 8 段階のどこを見ているかを常に示す（機能の羅列にしない） */}
            {current.phase && (
              <p className="inline-flex rounded-t4d border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-900">
                {current.phase}
              </p>
            )}
            <h2 className="text-[13px] font-semibold text-ink">{current.title}</h2>
            <p className="text-[12px] leading-relaxed text-ink">{current.body}</p>
            <p className="rounded-t4d bg-surface-muted px-2 py-1.5 text-[12px] text-ink">
              👀 見どころ: {current.lookAt}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
            {/* 進捗（色だけに頼らず数値も併記） */}
            <div
              className="flex items-center gap-1"
              aria-label={`進捗 ${step + 1} / ${TOUR_STEPS.length}`}
            >
              {/* 同じ画面を 2 ステップに分けて案内することがあるため、href ではなく順番をキーにする */}
              {TOUR_STEPS.map((s, i) => (
                <span
                  key={`${i}-${s.href}`}
                  aria-hidden="true"
                  className={cn('h-1.5 w-3 rounded-full', i <= step ? 'bg-brand-600' : 'bg-line')}
                />
              ))}
            </div>
            <div className="flex gap-1.5">
              {step > 0 && (
                <Button size="xs" variant="outline" onClick={() => go(step - 1)}>
                  戻る
                </Button>
              )}
              {step < TOUR_STEPS.length - 1 ? (
                <Button size="xs" onClick={() => go(step + 1)}>
                  次へ
                </Button>
              ) : (
                <Button size="xs" onClick={stop}>
                  ツアーを終了
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
