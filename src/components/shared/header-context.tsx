'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle, FolderKanban } from 'lucide-react';
import { Hint } from '@/components/ui/tooltip';

/** ヘッダーに出すプロジェクトの要約（日付はサーバー側で整形済みの文字列で受け取る） */
export interface HeaderProject {
  id: string;
  name: string;
  /** 報告主体（対象範囲の見出し） */
  reportingEntity: string;
  /** 対象範囲の説明（組織・連結・GHG 境界・バリューチェーン）。ツールチップに出す */
  scopeDetail: string;
  /** 例: 2026-04-01〜2027-03-31 */
  periodText: string;
  reportingPeriodId: string;
  reportingPeriodCode: string | null;
}

/** /enterprise/disclosure-projects/<id>/... から <id> を取り出す（一覧・新規作成は対象外） */
export function projectIdFromPath(pathname: string): string | null {
  const id = pathname.match(/^\/enterprise\/disclosure-projects\/([^/?#]+)/)?.[1] ?? null;
  return id && id !== 'new' ? id : null;
}

/**
 * プロジェクトの画面にいるとき、ヘッダーへプロジェクト名・対象範囲・期間を出す（指示書 §4.2）。
 *
 * Layout は子ページの URL パラメータを受け取れないため、パスから現在のプロジェクトを決める。
 * プロジェクト側のページに props を足さずに済み、どの画面から開いても同じ表示になる。
 * プロジェクトの年度がヘッダーで選択中の報告期間と違うときは、黙って混ぜずに明示する。
 */
export function HeaderProjectContext({
  projects,
  currentPeriodId,
  currentPeriodCode,
}: {
  projects: HeaderProject[];
  currentPeriodId: string | null;
  currentPeriodCode: string | null;
}) {
  const pathname = usePathname();
  const projectId = projectIdFromPath(pathname);
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
  if (!project) return null;

  const otherPeriod = currentPeriodId !== null && project.reportingPeriodId !== currentPeriodId;

  return (
    <div className="flex min-w-0 items-center gap-1.5" data-testid="header-project-context">
      <Hint label={`対象範囲: ${project.scopeDetail}`}>
        <Link
          href={`/enterprise/disclosure-projects/${project.id}`}
          className="inline-flex min-w-0 max-w-[420px] items-center gap-1.5 rounded-t4d px-1.5 py-0.5 text-[12px] text-ink hover:bg-brand-50"
        >
          <FolderKanban className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          <span className="sr-only">開示プロジェクト:</span>
          <span className="truncate font-medium">{project.name}</span>
          <span className="shrink-0 text-ink-muted" aria-hidden="true">
            ｜
          </span>
          <span className="truncate text-ink-muted">範囲 {project.reportingEntity}</span>
          <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-muted">
            （{project.periodText}）
          </span>
        </Link>
      </Hint>
      {otherPeriod && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-1.5 py-0.5 text-[11px] text-[#8a5d00]"
          role="note"
        >
          <AlertTriangle className="size-3" aria-hidden="true" />
          {project.reportingPeriodCode ?? 'プロジェクトの年度'} を表示中（選択中の報告期間は{' '}
          {currentPeriodCode ?? '—'}）
        </span>
      )}
    </div>
  );
}
