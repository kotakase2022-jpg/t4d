import { AlertTriangle } from 'lucide-react';
import type { DataSourceType } from '@/types/domain';
import { SemanticBadge } from '@/components/shared/status-badge';

/**
 * 非財務データの「要対応」の表示（一覧の列・詳細の見出し）。plan §1.17 の語（検証・根拠資料）で描く。
 *
 * 一覧では「対応が要るものだけ」を出す（検証 OK・根拠資料ありを全行に並べると、要対応の行が埋もれる）。
 * 色だけで示さない: SemanticBadge がアイコンとラベルを併記する。
 */
export interface AttentionCounts {
  errorCount: number;
  warningCount: number;
  evidenceCount: number;
  requiresEvidence: boolean;
}

/** 根拠資料が必須の指標で、まだ 1 件も紐付いていない */
export function isEvidenceMissing({ evidenceCount, requiresEvidence }: AttentionCounts): boolean {
  return requiresEvidence && evidenceCount === 0;
}

/** 一覧の「要対応」の列。対応が要るものが無ければ「なし」 */
export function AttentionCell(counts: AttentionCounts) {
  const badges = [
    counts.errorCount > 0 && (
      <SemanticBadge key="error" semantic="error" label={`検証エラー ${counts.errorCount}`} />
    ),
    counts.errorCount === 0 && counts.warningCount > 0 && (
      <SemanticBadge key="warning" semantic="blocked" label={`検証の警告 ${counts.warningCount}`} />
    ),
    isEvidenceMissing(counts) && (
      <SemanticBadge
        key="evidence"
        semantic="error"
        label="根拠資料の不足"
        detail="この指標は根拠資料が必須です。承認の前に紐付けてください。"
      />
    ),
  ].filter(Boolean);
  if (badges.length === 0) return <span className="text-caption text-ink-muted">なし</span>;
  return <span className="inline-flex flex-wrap gap-1">{badges}</span>;
}

/** 詳細の見出しに並べる検証と根拠資料の状態（OK も含めて必ず 2 つ出す） */
export function ValidationStatusBadge({
  errorCount,
  warningCount,
}: Pick<AttentionCounts, 'errorCount' | 'warningCount'>) {
  if (errorCount > 0) return <SemanticBadge semantic="error" label={`検証エラー ${errorCount}`} />;
  if (warningCount > 0)
    return <SemanticBadge semantic="blocked" label={`検証の警告 ${warningCount}`} />;
  return <SemanticBadge semantic="done" label="検証 OK" />;
}

export function EvidenceStatusBadge({
  evidenceCount,
  requiresEvidence,
}: Pick<AttentionCounts, 'evidenceCount' | 'requiresEvidence'>) {
  if (evidenceCount > 0)
    return <SemanticBadge semantic="done" label={`根拠資料 ${evidenceCount}`} />;
  return requiresEvidence ? (
    <SemanticBadge semantic="error" label="根拠資料の不足" />
  ) : (
    <SemanticBadge semantic="info" label="根拠資料なし" />
  );
}

/**
 * 単位の列。指標の単位と違う値は、色だけでなくアイコンと文で示す（以前は赤字だけだった。plan §1.12-6）
 */
export function UnitOfMeasureCell({
  unitOfMeasure,
  metricUnit,
}: {
  unitOfMeasure: string;
  metricUnit: string;
}) {
  if (unitOfMeasure === metricUnit) return <>{unitOfMeasure}</>;
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-1 font-medium text-warning-ink">
        <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
        {unitOfMeasure}
      </span>
      <span className="text-caption text-ink-muted">単位が指標（{metricUnit}）と異なります</span>
    </span>
  );
}

/** 値の出所（版の履歴の「出所」。資料名などの参照が無い版は区分の名前で示す。生の値を出さない） */
export const SOURCE_TYPE_LABEL: Record<DataSourceType, string> = {
  manual: '手入力',
  import: '取込',
  calculation: '算定',
  carry_forward: '前年度から複製',
};
