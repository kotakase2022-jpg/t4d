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
}

const TOUR_STEPS: TourStep[] = [
  {
    href: '/enterprise/dashboard',
    title: 'ホーム — 今日やるべきことが一目で分かる',
    body: '収集の進捗・提出期限・検証エラー・監査法人からの依頼を 1 画面に集約。朝ここを見れば、メールを掘り返さずに今日の優先順位が決まります。',
    lookAt: 'KPI カードと「要対応」の件数。クリックでそのまま作業画面へ飛べます。',
  },
  {
    href: '/enterprise/organizations',
    title: '組織・指標マスター — 集計範囲のズレを元から断つ',
    body: '組織階層・連結方法・持分、指標の定義・単位・集計方法をここで一元管理。「拠点ごとに定義がバラバラ」問題を入口で防ぎます。',
    lookAt: '連結方法・持分の列と、収集キャンペーン（対象組織×指標の収集依頼）。',
  },
  {
    href: '/enterprise/imports',
    title: 'データ収集 — 事前加工なしの一括取込',
    body: '拠点・部門ごとにフォーマットや言語が違うファイルを、事前加工なしでまとめてドロップ。AI が指標・拠点・単位を自動仕分けし、過去の確定実績から学習して精度が上がります。',
    lookAt: '複数ファイルの一括アップロードと、取込プレビューの AI 推定列。',
  },
  {
    href: '/enterprise/data',
    title: '非財務データ — 検証と承認の証跡が残る台帳',
    body: '単位不一致・前年比異常は自動検出。提出 → レビュー → 承認の流れが記録され、「この数字は誰がいつ承認したか」に即答できます。',
    lookAt: 'フィルター「検証エラー」と、行の状態バッジ（承認済み／レビュー中）。',
  },
  {
    href: '/enterprise/evidence',
    title: 'Evidence — 監査で聞かれる前に根拠を紐付ける',
    body: '請求書や検針記録をデータに紐付けておけば、監査法人からのサンプル要求に期末で慌てません。',
    lookAt: 'ファイルとデータの紐付け（どの数字の根拠か）。',
  },
  {
    href: '/enterprise/disclosures/cdp',
    title: 'CDP — 前年差分だけ回答すればいい',
    body: '今年の質問書で「新規・変更」だけを絞り込み、承認済みデータから AI が回答ドラフトを作成。整合チェックが古い記述や矛盾を洗い出します。',
    lookAt: '「前年差分だけ回答」ビューと、整合チェック・適用判定ボタン。',
  },
  {
    href: '/enterprise/disclosures/csrd',
    title: 'CSRD — 初年度対応のギャップが見える',
    body: 'ESRS の各項目に対して「データがあるか・回答があるか」を一覧化。何から着手すべきかが会議資料なしで共有できます。',
    lookAt: '「データあり／承認済みデータなし」のギャップ表示。',
  },
  {
    href: '/enterprise/ai',
    title: 'AI Copilot — 気づいていない論点を先回り',
    body: '拠点別トレンドの逆行・締切と未完了の衝突・Evidence 不足などを横断分析し、根拠と推奨アクション付きで提示。AI は提案のみで、確定は必ず人が行います。',
    lookAt: '「インサイトを発見」ボタンと、洞察カードの根拠・含意・推奨アクション。',
  },
  {
    href: '/enterprise/workflows',
    title: 'ワークフロー — 監査法人とのやりとりも 1 か所で',
    body: '社内の承認タスクと監査法人からの資料依頼（PBC）を同じ画面で管理。対応漏れと期末の駆け込みを防ぎます。',
    lookAt: 'PBC の期限と状態。ここまでがデモの一巡です。',
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
            <h2 className="text-[13px] font-semibold text-ink">{current.title}</h2>
            <p className="text-[12px] leading-relaxed text-ink">{current.body}</p>
            <p className="rounded-t4d bg-brand-50 px-2 py-1.5 text-[12px] text-brand-900">
              👀 見どころ: {current.lookAt}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
            {/* 進捗（色だけに頼らず数値も併記） */}
            <div
              className="flex items-center gap-1"
              aria-label={`進捗 ${step + 1} / ${TOUR_STEPS.length}`}
            >
              {TOUR_STEPS.map((s, i) => (
                <span
                  key={s.href}
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
