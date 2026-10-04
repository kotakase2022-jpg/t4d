import { EyeOff } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { can } from '@/lib/authorization/can';
import { formatJstDate } from '@/lib/format/datetime';
import { loadDiagnosis } from '@/lib/services/analysis/diagnosis';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DiagnosisAreaSection } from '../_components/diagnosis-area';

export const metadata = { title: '現状診断' };

/**
 * 現状診断（docs/disclosure-first.md §9.6）。閲覧専用。
 * 年度はヘッダーの報告期間（データの一覧・ホームと同じ）で切り替える。リンク先の一覧と件数をそろえるため。
 * 見方（点数を出さない・分母・基準日）は「この画面について」に閉じる（§10.4）。
 * 権限が無く出さなかった領域の注記は閉じない
 */
export default async function DiagnosisPage() {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const canRead = can(ctx, 'enterprise.data.read');
  const diagnosis = canRead
    ? await loadDiagnosis(db, ctx, {
        period: shell.currentPeriod,
        periods: shell.periods,
        units: shell.units,
        metrics: shell.metrics,
      })
    : null;

  const header = (
    <PageHeader
      title="現状診断"
      description={`${shell.currentPeriod.label} ／ 開示に向けた準備の状況を領域ごとに示します`}
      help={
        <>
          <p>
            単一の総合点や割合は出しません。領域ごとに「不足あり／確認待ちあり／不足なし／算定対象外」で示し、件数には分母を添えます。
          </p>
          <p>未入力・未収録は 0 として扱いません。</p>
          {diagnosis && (
            <p>期限は基準日 {formatJstDate(diagnosis.referenceDate)} で判定しています。</p>
          )}
          <p>年度は画面上部のヘッダーで切り替えます。</p>
        </>
      }
      breadcrumbs={[{ label: '企業ワークスペース' }, { label: '分析' }, { label: '現状診断' }]}
    />
  );
  if (!diagnosis) {
    return (
      <>
        {header}
        <div className="p-4">
          <PermissionDeniedState description="現状診断は、データの閲覧権限を持つ利用者のみ閲覧できます。" />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="space-y-3 p-4">
        {diagnosis.hiddenNote && (
          <p
            role="note"
            className="flex items-center gap-1.5 rounded-t4d border border-line bg-surface-muted px-3 py-1.5 text-[12px] text-ink-muted"
          >
            <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
            {diagnosis.hiddenNote}（{diagnosis.hiddenAreas.join('・')}）
          </p>
        )}
        {diagnosis.areas.map((area) => (
          <DiagnosisAreaSection key={area.key} area={area} />
        ))}
      </div>
    </>
  );
}
