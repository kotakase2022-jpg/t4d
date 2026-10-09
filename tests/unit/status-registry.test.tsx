import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Loader2 } from 'lucide-react';
import {
  CDP_OPTION_STATES,
  CLIENT_NOTE_STATES,
  CSRD_DRAFT_STATES,
  DATA_TERMS_STATES,
  RECONCILIATION_STATES,
  SHARED_REPORT_STATES,
  TRIAL_JUDGEMENT_STATES,
  XBRL_MAPPING_STATES,
  XBRL_VALIDATION_STATES,
  SEMANTIC_STYLE,
  STATUS,
  STATUS_SEMANTICS,
  statusEntry,
  statusLabel,
  statusOptions,
  type StatusDomain,
} from '@/lib/ui/status/registry';
import {
  SemanticBadge,
  STATUS_ICON_COMPONENTS,
  StatusBadge,
} from '@/components/shared/status-badge';
import { DataPointStatusBadge, TaskStatusBadge } from '@/components/shared/badges';
import { SCAN_STATUS_LABELS } from '@/lib/domain/evidence-limits';
import {
  EXCLUSION_STATES,
  REQUIREMENT_COVERAGE_CATEGORIES,
} from '@/lib/domain/requirement-coverage';
import {
  AI_RUN_STATUSES,
  APPLICABILITY_STATUSES,
  APPROVAL_STEP_STATUSES,
  BLOCK_STATUSES,
  COST_CLASSES,
  CROSSWALK_RELATIONS,
  CSRD_APPLICABILITY_KINDS,
  DATA_POINT_STATUSES,
  DMA_OUTCOMES,
  ENGAGEMENT_STATUSES,
  FEEDBACK_KINDS,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  ISSUE_STATUSES,
  JOB_STATUSES,
  MEMBERSHIP_STATUSES,
  NARRATIVE_STATUSES,
  PBC_STATUSES,
  PERIOD_STATUSES,
  QUANTITATIVE_IMPORT_STATUSES,
  RESPONSE_STATUSES,
  REVIEW_NOTE_STATUSES,
  REVIEW_REQUEST_STATUSES,
  SAMPLING_METHODS,
  SIGNOFF_STAGES,
  SSBJ_ACTION_STATUSES,
  SSBJ_COVERAGE_STATUSES,
  TASK_STATUSES,
  TEST_STATUSES,
  TRIAL_COMPLETIONS,
} from '@/types/domain';

/**
 * 状態登録簿（plan §3.2・§3.5 status-registry）。
 *  - domain.ts の全 enum 値が登録済み（足し忘れ・消し忘れの両方を検出）
 *  - ラベルが空でなく、ASCII だけでない（生の enum・英語のシステム語を出さない）
 *  - 同じ意味（semantic）は同じ色とアイコン、Loader2 を使わない
 */

const ENUMS: Record<StatusDomain, readonly string[]> = {
  dataPoint: DATA_POINT_STATUSES,
  response: RESPONSE_STATUSES,
  block: BLOCK_STATUSES,
  review: REVIEW_REQUEST_STATUSES,
  job: JOB_STATUSES,
  task: TASK_STATUSES,
  pbc: PBC_STATUSES,
  test: TEST_STATUSES,
  issue: ISSUE_STATUSES,
  reviewNote: REVIEW_NOTE_STATUSES,
  engagement: ENGAGEMENT_STATUSES,
  membership: MEMBERSHIP_STATUSES,
  period: PERIOD_STATUSES,
  aiRun: AI_RUN_STATUSES,
  ssbjCoverage: SSBJ_COVERAGE_STATUSES,
  ssbjAction: SSBJ_ACTION_STATUSES,
  applicabilityProject: APPLICABILITY_STATUSES,
  applicabilityCsrd: CSRD_APPLICABILITY_KINDS,
  narrative: NARRATIVE_STATUSES,
  quantitativeImport: QUANTITATIVE_IMPORT_STATUSES,
  csrdDraft: CSRD_DRAFT_STATES,
  csrdPlan: SSBJ_ACTION_STATUSES,
  dmaOutcome: DMA_OUTCOMES,
  signoff: SIGNOFF_STAGES,
  scan: Object.keys(SCAN_STATUS_LABELS),
  approvalStep: APPROVAL_STEP_STATUSES,
  samplingMethod: SAMPLING_METHODS,
  // トライアル対応（2026-10。付録 C）
  requirementCoverage: REQUIREMENT_COVERAGE_CATEGORIES,
  exclusionApproval: EXCLUSION_STATES,
  crosswalkRelation: CROSSWALK_RELATIONS,
  sharedReport: SHARED_REPORT_STATES,
  clientNote: CLIENT_NOTE_STATES,
  reconciliation: RECONCILIATION_STATES,
  xbrlMapping: XBRL_MAPPING_STATES,
  xbrlValidation: XBRL_VALIDATION_STATES,
  trialJudgement: TRIAL_JUDGEMENT_STATES,
  trialCompletion: TRIAL_COMPLETIONS,
  feedbackKind: FEEDBACK_KINDS,
  feedbackStatus: FEEDBACK_STATUSES,
  severity: FEEDBACK_SEVERITIES,
  costClass: COST_CLASSES,
  dataTerms: DATA_TERMS_STATES,
  cdpOption: CDP_OPTION_STATES,
};

const domains = Object.keys(STATUS) as StatusDomain[];

describe('状態登録簿', () => {
  it('登録簿のドメインと検査の対応表が一致する（ドメインを足したらここにも足す）', () => {
    expect([...domains].sort()).toEqual(Object.keys(ENUMS).sort());
  });

  it.each(domains)('%s: domain.ts の enum の値をすべて、過不足なく登録している', (domain) => {
    expect(Object.keys(STATUS[domain]).sort()).toEqual([...ENUMS[domain]].sort());
  });

  it.each(domains)('%s: ラベルが空でなく、ASCII だけの語（生の enum）ではない', (domain) => {
    for (const [value, entry] of Object.entries(STATUS[domain])) {
      expect(entry.label.trim(), `${domain}.${value}`).not.toBe('');
      expect(/^[\x20-\x7e]+$/.test(entry.label), `${domain}.${value}: ${entry.label}`).toBe(false);
      expect(entry.label, `${domain}.${value}`).not.toBe(value);
      expect(STATUS_SEMANTICS).toContain(entry.semantic);
    }
  });

  it('意味ごとの色とアイコンは 1 通り（意味の数だけ定義がある）', () => {
    expect(Object.keys(SEMANTIC_STYLE).sort()).toEqual([...STATUS_SEMANTICS].sort());
  });

  it('Loader2（回転の印）を状態のアイコンに使わない', () => {
    expect(Object.values(STATUS_ICON_COMPONENTS)).not.toContain(Loader2);
    for (const file of [
      'src/components/shared/status-badge.tsx',
      'src/components/shared/badges.tsx',
    ]) {
      // コメント（使わない理由の説明）は除き、コードでの使用だけを見る
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\bLoader2\b/);
    }
  });

  it('知らない値は「状態不明」（生の値を出さず、画面を落とさない）', () => {
    expect(statusEntry('dataPoint', 'zzz').label).toBe('状態不明');
    expect(statusLabel('job', 'needs_review')).toBe('要確認');
    // Object.prototype の名前を値として渡しても登録簿の外の値として扱う
    expect(statusLabel('task', 'toString')).toBe('状態不明');
  });

  it('選択肢は登録順で、値とラベルの組になる', () => {
    expect(statusOptions('dataPoint').map((o) => o.value)).toEqual([...DATA_POINT_STATUSES]);
    expect(statusOptions('dataPoint')[1]).toEqual({ value: 'draft', label: '入力中' });
  });
});

describe('StatusBadge', () => {
  function iconClassOf(container: HTMLElement): string {
    return container.querySelector('svg')?.getAttribute('class') ?? '';
  }

  it('同じ意味の状態は、ドメインが違っても同じ色とアイコン', () => {
    const a = render(<StatusBadge domain="dataPoint" value="approved" />);
    const b = render(<StatusBadge domain="pbc" value="accepted" />);
    const badgeA = a.container.firstElementChild as HTMLElement;
    const badgeB = b.container.firstElementChild as HTMLElement;
    expect(badgeA.getAttribute('data-semantic')).toBe('done');
    expect(badgeB.getAttribute('data-semantic')).toBe('done');
    expect(badgeA.className).toBe(badgeB.className);
    expect(iconClassOf(a.container)).toBe(iconClassOf(b.container));
  });

  it('ラベルとアイコンを併記し、色だけで状態を示さない', () => {
    const { container, getByText } = render(<StatusBadge domain="job" value="needs_review" />);
    expect(getByText('要確認')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.firstElementChild).toHaveAttribute('data-status-domain', 'job');
    expect(container.firstElementChild).toHaveAttribute('data-status-value', 'needs_review');
  });

  it('補足は title= ではなく読み上げ用の文で添える', () => {
    const { container } = render(
      <SemanticBadge semantic="blocked" label="要再確認" detail="証跡を確認してください" />,
    );
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.querySelector('.sr-only')?.textContent).toContain('証跡を確認してください');
  });

  it('既存のバッジ（badges.tsx）は登録簿を通る薄いラッパー', () => {
    const { container, getByText } = render(<TaskStatusBadge status="blocked" />);
    expect(getByText('保留（阻害あり）')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-semantic', 'blocked');

    const recheck = render(<DataPointStatusBadge status="approved" needsRecheck />);
    expect(recheck.getByText('承認済み・要再確認')).toBeInTheDocument();
    expect(recheck.container.querySelector('[title]')).toBeNull();
  });
});
