import Link from 'next/link';
import { Check, CircleDot, Circle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * 開示対応の進め方を示すステップナビ（CDP / SSBJ 共通）。
 *
 * 一覧だけを見せると「何から手をつけるのか」が分からないため、
 * 前段の準備（版の選択・データの用意）から順に案内する。
 * 状態は色だけでなくアイコンとラベルでも示す。
 */

export interface DisclosureStep {
  /** 見出し */
  title: string;
  /** 何をする段階か */
  description: string;
  /** done: 完了 / current: いま行う / todo: これから */
  state: 'done' | 'current' | 'todo';
  /** 補足（取込済み件数など） */
  detail?: React.ReactNode;
  /** 主アクション */
  action?: { label: string; href: string };
}

const STATE_LABEL = {
  done: { label: '完了', tone: 'success' as const, Icon: Check },
  current: { label: '進行中', tone: 'brand' as const, Icon: CircleDot },
  todo: { label: '未着手', tone: 'neutral' as const, Icon: Circle },
};

export function DisclosureSteps({ steps }: { steps: DisclosureStep[] }) {
  return (
    <Card className="overflow-hidden">
      <ol className="grid grid-cols-3 divide-x divide-line">
        {steps.map((step, i) => {
          const s = STATE_LABEL[step.state];
          return (
            <li
              key={step.title}
              className={`space-y-1.5 p-3 ${step.state === 'current' ? 'bg-brand-50/60' : ''}`}
              aria-current={step.state === 'current' ? 'step' : undefined}
            >
              <div className="flex items-center gap-1.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-[11px] font-semibold text-ink-muted">
                  {i + 1}
                </span>
                <span className="text-[13px] font-semibold text-ink">{step.title}</span>
                <Badge tone={s.tone}>
                  <s.Icon className="size-3" aria-hidden="true" />
                  {s.label}
                </Badge>
              </div>
              <p className="text-[12px] leading-relaxed text-ink-muted">{step.description}</p>
              {step.detail && <div className="text-[12px] text-ink">{step.detail}</div>}
              {step.action && (
                <Button
                  size="xs"
                  variant={step.state === 'current' ? 'primary' : 'outline'}
                  asChild
                >
                  <Link href={step.action.href}>{step.action.label}</Link>
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
