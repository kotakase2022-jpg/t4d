import 'server-only';

import { ghgVerificationUnitIds, resolveGhgPeriod } from '@/lib/services/ghg/inputs';
import { loadGhgVerificationStatus, type GhgVerificationStatus } from '@/lib/services/ghg/status';
import { loadEnterpriseShell, type EnterpriseShell } from '@/lib/services/shell';
import { loadTrialProgram } from '@/lib/services/trial-program';
import type { ReportingPeriod, TrialProgram, Uuid } from '@/types/domain';

/**
 * Scope1・2 の算定の画面（P90〜P98）が共通に読むもの。期間（`?period=` → トライアルの検証期間 →
 * 画面共通の現在の期間）・検証の拠点・拠点別の状態（NavTabs の件数と Attention）を 1 回で揃える。
 * 閲覧は enterprise.data.read（全企業ロールが持つ。書きの権限は各画面の操作で確かめる）
 */
export interface CalcContext {
  shell: EnterpriseShell;
  trialProgram: TrialProgram | null;
  period: ReportingPeriod;
  /** 検証の拠点（トライアルの設定 → 計画の対象拠点。どちらも無ければ空） */
  unitIds: Uuid[];
  status: GhgVerificationStatus;
}

export async function loadCalcContext(
  searchParams: Record<string, string | string[] | undefined>,
): Promise<CalcContext> {
  const shell = await loadEnterpriseShell();
  const trialProgram = await loadTrialProgram(shell.db, shell.ctx);
  const period = resolveGhgPeriod(shell, trialProgram, searchParams);
  const unitIds = ghgVerificationUnitIds(trialProgram);
  const status = await loadGhgVerificationStatus(shell.db, shell.ctx, {
    periodId: period.id,
    unitIds,
  });
  return { shell, trialProgram, period, unitIds, status };
}
