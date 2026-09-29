import type { DiffSegment } from '@/lib/domain/disclosure-block';

/**
 * 定性情報の画面（Server Component → Client Component）でやり取りする値。
 * DB の行をそのまま渡さず、表示に要るものだけを渡す。
 */

export interface AnchorPayload {
  id: string;
  fileId: string | null;
  fileName: string;
  locationLabel: string;
  quoteText: string;
  usagePurposeLabel: string;
  /** 当年度の事実の根拠として登録された資料か */
  isCurrentFact: boolean;
  /** 手動抜粋から取った引用か */
  manual: boolean;
  missing: boolean;
}

export interface FragmentPayload {
  id: string;
  locationLabel: string;
  text: string;
  manual: boolean;
}

export interface DocumentPayload {
  fileId: string;
  name: string;
  usagePurposeLabel: string;
  confidentialityLabel: string;
  fragmentCount: number;
  periodCode: string | null;
}

export interface UsagePayload {
  blockId: string;
  blockTitle: string;
  blockStatusLabel: string;
  projectId: string;
  projectName: string;
  citedVersionNo: number | null;
  citesCurrent: boolean;
}

export interface FieldDef {
  key: string;
  label: string;
}

export interface ConflictPayload {
  latestVersionId: string | null;
  latestVersionNo: number | null;
  latestCreatedByName: string | null;
  latestCreatedAt: string | null;
  latestBody: string;
  fieldDiffs: Array<{ key: string; label: string; mine: string | null; latest: string | null }>;
  bodyDiff: DiffSegment[];
}
