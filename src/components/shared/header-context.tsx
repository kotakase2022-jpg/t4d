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

  // 1366px 幅ではヘッダーに企業・期間・バッジ・役割切替が並び、flex の縮小で
  // プロジェクト名が幅 0 まで潰れていた（指示書 §4.2「重要なラベルを切り詰めて意味不明にしない」）。
  // 名前には最低幅を確保し、範囲はツールチップと本文見出しに任せて広い画面でだけ並べる。
  // 期間は選択中の報告期間と同じならヘッダー左の表示と重複するため、年度が違う時だけ出す。
  return (
    <div className="flex min-w-[9rem] items-center gap-1.5" data-testid="header-project-context">
      <Hint label={`対象範囲: ${project.scopeDetail}`}>
        <Link
          href={`/enterprise/disclosure-projects/${project.id}`}
          className="inline-flex min-w-[8.5rem] max-w-[420px] items-center gap-1.5 overflow-hidden rounded-t4d px-1.5 py-0.5 text-small text-ink hover:bg-brand-50"
        >
          <FolderKanban className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          <span className="sr-only">開示プロジェクト:</span>
          <span className="min-w-[7rem] truncate font-medium">{project.name}</span>
          <span className="hidden shrink-0 text-ink-muted xwide:inline" aria-hidden="true">
            ｜
          </span>
          <span className="hidden truncate text-ink-muted xwide:inline">
            範囲 {project.reportingEntity}
          </span>
          {otherPeriod && (
            <span className="hidden shrink-0 whitespace-nowrap text-caption text-ink-muted xwide:inline">
              （{project.periodText}）
            </span>
          )}
        </Link>
      </Hint>
      {otherPeriod && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-1.5 py-0.5 text-caption text-warning-ink"
          role="note"
        >
          <AlertTriangle className="size-3" aria-hidden="true" />
          {project.reportingPeriodCode ?? 'プロジェクトの年度'} を表示中
          {/* 狭い画面では理由の文を読み上げだけにする（年度の違いはアイコンと年度で分かる） */}
          <span className="max-[1599px]:sr-only">
            （選択中の報告期間は {currentPeriodCode ?? '—'}）
          </span>
        </span>
      )}
    </div>
  );
}
