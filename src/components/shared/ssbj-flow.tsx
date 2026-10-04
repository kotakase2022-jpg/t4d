import Link from 'next/link';
import { Check, Circle, CircleDot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Collapsible } from '@/components/ui/collapsible';

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
 *
 * 工程の説明文は帯に書かず、帯の下の「各工程の説明」1 つ（既定で閉じる）に番号順でまとめる
 * （docs/disclosure-first.md §10.4。帯は題・状態・件数だけで読める）。説明側に題を重ねて書かないのは、
 * 同じ題が画面に 2 回出て「どこが工程の題か」が 1 か所に定まらなくなるため。
 */

/** 現在の工程（進行中の最初の工程）の位置。進行中が無ければ -1 */
export function currentStepIndex(steps: readonly Pick<SsbjFlowStep, 'state'>[]): number {
  return steps.findIndex((step) => step.state === 'current');
}

export interface SsbjFlowStep {
  title: string;
  /** 工程で何をするか。帯の下の「各工程の説明」（既定で閉じる）に出す */
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

function StepNumber({ index }: { index: number }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-[11px] font-semibold text-ink-muted">
      {index + 1}
    </span>
  );
}

export function SsbjFlow({ steps }: { steps: SsbjFlowStep[] }) {
  const currentIndex = currentStepIndex(steps);
  const described = steps
    .map((step, index) => ({ index, description: step.description.trim() }))
    .filter((step) => step.description !== '');
  return (
    <Card className="overflow-hidden">
      <ol className="grid grid-cols-4 divide-x divide-y divide-line">
        {steps.map((step, index) => {
          const s = STATE[step.state];
          const body = (
            <>
              <div className="flex items-center gap-1.5">
                <StepNumber index={index} />
                <span className="min-w-0 break-words text-[12px] font-semibold text-ink">
                  {step.title}
                </span>
              </div>
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
      {described.length > 0 && (
        // 下の余白は、閉じたときに Card（overflow-hidden）の下端に接する summary のフォーカスリングを切らないため
        <Collapsible
          variant="plain"
          summary="各工程の説明"
          className="border-t border-line px-2.5 pb-1"
        >
          <ol className="space-y-1">
            {described.map(({ index, description }) => (
              <li key={index} className="flex items-start gap-1.5">
                <StepNumber index={index} />
                <span className="pt-0.5 leading-relaxed text-ink-muted">{description}</span>
              </li>
            ))}
          </ol>
        </Collapsible>
      )}
    </Card>
  );
}
