import { redirect } from 'next/navigation';

/** 「分析」の入口は現状診断（docs/disclosure-first.md §9.4） */
export default function AnalysisIndexPage(): never {
  redirect('/enterprise/analysis/diagnosis');
}
