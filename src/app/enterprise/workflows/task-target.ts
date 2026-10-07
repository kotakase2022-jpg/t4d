/**
 * タスクの対象から開く先を決める（ワークフロー・アラートで共通）。行き止まりの行を作らない（plan S21）。
 * 対象の画面が無い種類は、ワークフローのタスクの節へ戻す。
 */
export function taskTargetHref(targetType: string | null, targetId: string | null): string {
  switch (targetType) {
    case 'data_point':
      return targetId ? `/enterprise/data/${targetId}` : '/enterprise/data';
    case 'evidence':
      return targetId ? `/enterprise/evidence/${targetId}` : '/enterprise/evidence';
    case 'ingestion_job':
      return targetId ? `/enterprise/imports/${targetId}` : '/enterprise/imports';
    case 'pbc_request':
      return '/enterprise/workflows#pbc';
    case 'disclosure_response':
      return '/enterprise/disclosures/cdp';
    case 'disclosure_block':
      return '/enterprise/disclosure-projects';
    case 'collection_campaign':
      return '/enterprise/organizations?tab=campaigns';
    default:
      return '/enterprise/workflows#tasks';
  }
}
