import * as React from 'react';
import { CollapsibleSection } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/**
 * 本文の節（plan §1.19・§3.1 Section）。見出し（h2/h3）と罫線だけで区切り、枠・影を付けない
 * （装飾の Card を減らす。指示書 §15・§16: 余白を増やさず情報の階層を整理する）。
 *
 * - collapsible: 中身だけを既定で閉じる（見出しと操作は閉じていても見える）。既存の CollapsibleSection を使う
 * - summary は閉じたときの 1 行（要点の数値を含める）
 * - 誠実さの注記・エラー・権限なしの説明は collapsible の中に入れない
 */
type SectionProps = {
  title: React.ReactNode;
  level?: 2 | 3;
  /** 見出しの右に添える要点（件数など）。collapsible では閉じたときの 1 行 */
  summary?: React.ReactNode;
  /** 見出しの右の操作（PageActions と同じ規則で、primary は画面に 1 つ） */
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  /** 開いて描く（URL の絞り込み・フラッシュ・入力エラーが中身を指すとき） */
  open?: boolean;
  divider?: 'top' | 'none';
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
} & (
  | {
      collapsible: true;
      /** 折りたたむ節は id が必須（ページ内リンクと見出しの関連付け） */ id: string;
    }
  | { collapsible?: false; id?: string }
);

export function Section({
  id,
  title,
  level = 2,
  summary,
  actions,
  collapsible = false,
  defaultOpen = false,
  open,
  divider = 'top',
  className,
  bodyClassName,
  children,
}: SectionProps) {
  if (collapsible && id) {
    return (
      <CollapsibleSection
        id={id}
        title={title}
        summary={summary ?? '詳細'}
        actions={actions}
        defaultOpen={defaultOpen}
        open={open}
        className={cn('rounded-none border-x-0 border-b-0 bg-transparent', className)}
        bodyClassName={bodyClassName}
      >
        {children}
      </CollapsibleSection>
    );
  }
  const Heading = level === 2 ? 'h2' : 'h3';
  const titleId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      // id が無いときは見出しの文字で領域に名前を付ける（getByRole('region', { name })）
      aria-label={titleId ? undefined : typeof title === 'string' ? title : undefined}
      data-section=""
      className={cn(divider === 'top' && 'border-t border-line', 'pt-2', className)}
    >
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <Heading
            id={titleId}
            className={cn('font-semibold text-ink', level === 2 ? 'text-body' : 'text-small')}
          >
            {title}
          </Heading>
          {summary && <span className="truncate text-small text-ink-muted">{summary}</span>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
