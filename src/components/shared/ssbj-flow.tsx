import Link from 'next/link';
import { Check, Circle, CircleDot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

/**
 * SSBJ 対応の基本フロー（8 段階）。
 *
 * 「AI がギャップを見つけて終わり」ではなく、対象判定から対応計画・データ収集・
 * 開示作成までが 1 本の流れであることを、常に画面上で示すための帯。
 *
 * 4 列 × 2 段にしているのは、8 列を 1 段に並べると 1280px 幅で 1 マスが狭くなり
 * 説明文が読めなくなるため（横スクロールも出したくない）。題は省略せずに折り返す
 * （1366px の 4 列で長い題が途中から見えなくなっていた）。
 *
 * 「進行中」の工程は複数ありうるが、支援技術に伝える現在の工程（aria-current="step"）は、
 * 未完了の最初の 1 つ（進行中の最初の工程）だけにする。複数に付けると「現在のステップ」が
 * 何か所も読み上げられ、どこが今の工程か分からなくなる。
 */

/** 現在の工程（進行中の最初の工程）の位置。進行中が無ければ -1 */
export function currentStepIndex(steps: readonly Pick<SsbjFlowStep, 'state'>[]): number {
  return steps.findIndex((step) => step.state === 'current');
}

export interface SsbjFlowStep {
  title: string;
  description: string;
  state: 'done' | 'current' | 'todo';
  /** 件数などの補足 */
  detail?: string;
  href?: string;
}

const STATE = {
  done: { label: '完了', tone: 'success' as const, Icon: Check },
  current: { label: '進行中', tone: 'brand' as const, Icon: CircleDot },
  todo: { label: '未着手', tone: 'neutral' as const, Icon: Circle },
};

export function SsbjFlow({ steps }: { steps: SsbjFlowStep[] }) {
  const currentIndex = currentStepIndex(steps);
  return (
    <Card className="overflow-hidden">
      <ol className="grid grid-cols-4 divide-x divide-y divide-line">
        {steps.map((step, index) => {
          const s = STATE[step.state];
          const body = (
            <>
              <div className="flex items-center gap-1.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-[11px] font-semibold text-ink-muted">
                  {index + 1}
                </span>
                <span className="min-w-0 break-words text-[12px] font-semibold text-ink">
                  {step.title}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-ink-muted">{step.description}</p>
              <div className="flex items-center gap-1.5">
                <Badge tone={s.tone}>
                  <s.Icon className="size-3" aria-hidden="true" />
                  {s.label}
                </Badge>
                {step.detail && <span className="text-[11px] text-ink">{step.detail}</span>}
              </div>
            </>
          );
          return (
            <li
              key={step.title}
              className={`space-y-1 p-2.5 ${step.state === 'current' ? 'bg-brand-50/60' : ''}`}
              aria-current={index === currentIndex ? 'step' : undefined}
            >
              {/* Focus Ring は globals.css の :focus-visible が全体に効くので上書きしない */}
              {step.href ? (
                <Link href={step.href} className="block space-y-1 rounded-t4d">
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
