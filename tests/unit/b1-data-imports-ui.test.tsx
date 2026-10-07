import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, dataPointId, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext, RoleKey } from '@/types/domain';
import { inferEvidenceAttributes, inferIssuedOn } from '@/app/enterprise/evidence/infer-attributes';
import { importJobTitle } from '@/app/enterprise/imports/job-title';
import { taskTargetHref } from '@/app/enterprise/workflows/task-target';
import { validationRuleLabel } from '@/app/enterprise/data/_components/validation-rule-labels';
import { AttentionCell, UnitOfMeasureCell } from '@/app/enterprise/data/_components/data-badges';

/**
 * Stage B1（データ・取込・資料・業務キュー・ホーム）の画面の約束（docs/ui-redesign/plan.md S16・S21・S23・S15）。
 * Server Component のページを Fixture の DB で描画する（Action は呼ばない）。
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));
// メニューから作るパンくず（NavBreadcrumbs）は描画中の URL を読む。App Router の外なので固定する
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/enterprise/workflows',
}));
vi.mock('@/app/enterprise/actions', () => ({
  carryForwardAction: vi.fn(),
  bulkTransitionAction: vi.fn(async () => null),
  respondPbcAction: vi.fn(),
  addCommentAction: vi.fn(),
  decideApprovalStepAction: vi.fn(),
  explainAnomaliesAction: vi.fn(),
  linkEvidenceAction: vi.fn(),
  suggestEvidenceAction: vi.fn(),
  transitionDataPointAction: vi.fn(),
  updateDataPointAction: vi.fn(),
}));
vi.mock('@/app/enterprise/evidence/actions', () => ({
  uploadEvidenceDocumentFormAction: vi.fn(),
  addManualExcerptFormAction: vi.fn(),
}));
// 一覧の絞り込み・列の切替は URL を書き換える Client Component（App Router が要る）
vi.mock('@/components/shared/filter-bar', () => ({
  FilterBar: ({ total }: { total: number }) => <p data-testid="filter-bar">{total} 件</p>,
}));
vi.mock('@/components/shared/table-controls', () => ({
  SortLink: ({ label }: { label: string }) => <span>{label}</span>,
}));
// 「その他」は Radix のメニュー（開くまで項目を描かない）。項目の定義（出す・出さない）を見るため差し替える
vi.mock('@/components/shared/page-actions', () => ({
  PageActions: ({
    primary,
    secondary,
    more,
  }: {
    primary?: { label: string; hidden?: boolean };
    secondary?: Array<{ label: string; hidden?: boolean }>;
    more?: Array<{ label: string; hidden?: boolean }>;
  }) => (
    <ul aria-label="見出しの操作">
      {[
        ...(primary ? [{ ...primary, slot: 'primary' }] : []),
        ...(secondary ?? []).map((a) => ({ ...a, slot: 'secondary' })),
        ...(more ?? []).map((a) => ({ ...a, slot: 'more' })),
      ]
        .filter((a) => !a.hidden)
        .map((a) => (
          <li key={`${a.slot}-${a.label}`} data-slot={a.slot}>
            {a.label}
          </li>
        ))}
    </ul>
  ),
}));

const { default: DataListPage } = await import('@/app/enterprise/data/page');
const { default: WorkflowsPage } = await import('@/app/enterprise/workflows/page');
const { default: DataPointDetailPage } = await import('@/app/enterprise/data/[dataPointId]/page');
const { default: EvidencePage } = await import('@/app/enterprise/evidence/page');

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  unitScopeIds: string[] = [],
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

const site = () => ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const approver = () => ctxFor('approver@demo.local', ['approver']);
const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

function setShell(ctx: AuthorizationContext): void {
  const organizationId = ctx.workspace.organizationId;
  shellState.shell = {
    db,
    session: null as never,
    ctx,
    periods: fixture.periods.filter((p) => p.organizationId === organizationId),
    currentPeriod: fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!,
    units: fixture.units
      .filter((u) => u.organizationId === organizationId && u.deletedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    metrics: fixture.metrics.filter((m) => m.organizationId === organizationId),
    unreadNotifications: 0,
  } satisfies EnterpriseShell;
}

const sp = (query: Record<string, string> = {}) => Promise.resolve(query);

function headerActions(): Array<{ slot: string; label: string }> {
  const list = screen.getByRole('list', { name: '見出しの操作' });
  return within(list)
    .queryAllByRole('listitem')
    .map((li) => ({ slot: li.getAttribute('data-slot') ?? '', label: li.textContent ?? '' }));
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('非財務データの一覧（S16・DataTable の基準実装）', () => {
  it('見出しに primary を置かず、取込は secondary、複製・出力は「その他」。出力は出力の権限のときだけ（R3）', async () => {
    setShell(manager());
    render(await DataListPage({ searchParams: sp() }));
    expect(headerActions()).toEqual([
      { slot: 'secondary', label: 'データを取り込む' },
      { slot: 'more', label: '前年度から複製' },
      { slot: 'more', label: 'CSV 出力' },
      { slot: 'more', label: 'XLSX 出力' },
    ]);

    setShell(reviewer());
    const { container } = render(await DataListPage({ searchParams: sp() }));
    const labels = within(container).getByRole('list', { name: '見出しの操作' }).textContent;
    expect(labels).not.toContain('CSV 出力');
    expect(labels).not.toContain('前年度から複製');
  });

  it('担当拠点を持つ利用者は担当拠点で絞った状態が既定。チップから全組織へ戻せる（D2）', async () => {
    setShell(site());
    render(await DataListPage({ searchParams: sp() }));
    const chip = screen.getByRole('link', { name: /担当: 東日本工場 の絞り込みを解除/ });
    expect(chip.getAttribute('href')).toBe('/enterprise/data?unit=');
    // 行はすべて担当拠点
    const rows = screen.getAllByRole('row').filter((r) => r.hasAttribute('data-t4d-record'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.textContent).toContain('東日本工場');

    // unit= （空）は全組織（既存の規則）。既定の絞り込みもチップも出さない
    render(await DataListPage({ searchParams: sp({ unit: '' }) }));
    expect(screen.getAllByRole('link', { name: /担当: 東日本工場/ })).toHaveLength(1);
  });

  it('担当拠点に入力中のデータがある（拠点担当の「データを入力する」の行き先が空にならない）', async () => {
    setShell(site());
    render(await DataListPage({ searchParams: sp({ status: 'draft' }) }));
    const rows = screen.getAllByRole('row').filter((r) => r.hasAttribute('data-t4d-record'));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('既定の列は primary・secondary だけ（期間・更新日時は「列」から出す）。行の名前のセルが詳細へのリンク', async () => {
    setShell(manager());
    render(await DataListPage({ searchParams: sp() }));
    const headers = screen
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('data-column-key'))
      .filter(Boolean);
    expect(headers).toEqual(['metric', 'unit', 'value', 'unitOfMeasure', 'status', 'attention']);
    // 同じ行き先へのリンクを 2 つ置かない（「詳細」のボタンは無い）
    expect(screen.queryAllByRole('link', { name: '詳細' })).toHaveLength(0);
  });

  it('一括操作は行を選んだときだけ。承認はデータの承認の権限のときだけ（R4）', async () => {
    setShell(reviewer());
    const { unmount } = render(await DataListPage({ searchParams: sp() }));
    expect(screen.queryByRole('region', { name: '一括操作' })).toBeNull();
    fireEvent.click(screen.getAllByRole('checkbox', { name: /を選択$/ })[0]!);
    const bar = await screen.findByRole('region', { name: '一括操作' });
    expect(within(bar).getByRole('button', { name: 'レビューへ' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '差戻し' })).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: '一括承認' })).toBeNull();
    expect(within(bar).queryByRole('button', { name: '一括提出' })).toBeNull();
    unmount();

    setShell(approver());
    render(await DataListPage({ searchParams: sp() }));
    fireEvent.click(screen.getAllByRole('checkbox', { name: /を選択$/ })[0]!);
    const approverBar = await screen.findByRole('region', { name: '一括操作' });
    expect(within(approverBar).getByRole('button', { name: '一括承認' })).toBeTruthy();
  });
});

describe('データの詳細（S3。状態 × 権限で primary は 1 つ）', () => {
  const open = async (ctx: AuthorizationContext, unit: string, metric: string) => {
    setShell(ctx);
    return render(
      await DataPointDetailPage({
        params: Promise.resolve({ dataPointId: dataPointId(unit, metric, 'FY2026') }),
        searchParams: sp(),
      }),
    );
  };

  it('差戻し中のデータは、拠点担当の primary が「提出」。値の編集の節は開いていて、保存は secondary', async () => {
    const { container } = await open(site(), 'EAST', 'water');
    expect(headerActions().filter((a) => a.slot === 'primary')).toEqual([
      { slot: 'primary', label: '提出' },
    ]);
    const edit = container.querySelector('#value-edit details');
    expect((edit as HTMLDetailsElement | null)?.open).toBe(true);
    const save = screen.getByRole('button', { name: '保存' });
    expect(save.getAttribute('data-variant')).toBe('secondary');
    // コメントの入力欄は最初から見える。送信ボタンは secondary（状態の主操作と primary を並べない。plan §1.6）
    expect(container.querySelector('textarea[name="body"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'コメントする' }).getAttribute('data-variant')).toBe(
      'secondary',
    );
  });

  it('承認の道筋の現段階を決められる人には、段階の承認が primary。見出しの操作は secondary へ下げる', async () => {
    const { container } = await open(reviewer(), 'WEST', 'waste');
    const actions = headerActions();
    expect(actions.filter((a) => a.slot === 'primary')).toEqual([]);
    expect(actions.filter((a) => a.slot === 'secondary').map((a) => a.label)).toEqual([
      'レビュー開始',
      '差戻し…',
    ]);
    const primaries = [...container.querySelectorAll('[data-variant="primary"]')];
    expect(primaries.map((b) => b.textContent)).toEqual(['「拠点責任者の確認」を承認']);
    // 段階の差戻しは理由必須の確認ダイアログを開くボタン（その場で送らない）
    expect(screen.getByRole('button', { name: '差し戻す…' }).getAttribute('type')).not.toBe(
      'submit',
    );
  });

  it('現段階の承認者でない承認者には、一発承認を出さず承認フローへ案内する', async () => {
    await open(approver(), 'EU', 'scope1');
    const labels = headerActions().map((a) => a.label);
    expect(labels).not.toContain('承認');
    expect(labels.some((label) => /^承認フローへ（\d+\/5 段階）$/.test(label))).toBe(true);
    expect(screen.getByText(/あなたはこの段階の承認者ではありません/)).toBeTruthy();
  });
});

describe('資料・証跡（S23）', () => {
  it('登録は作成パネル（?new=1）。一覧の上にフォームを常設しない', async () => {
    setShell(manager());
    const { container, unmount } = render(await EvidencePage({ searchParams: sp() }));
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(headerActions()).toContainEqual({ slot: 'primary', label: '資料を登録' });
    // 行の操作は「画面内で開く」1 つ（名前のセルはリンクにしない＝同じ行き先を 2 つ置かない）
    expect(screen.getAllByRole('link', { name: '画面内で開く' }).length).toBeGreaterThan(0);
    unmount();

    render(await EvidencePage({ searchParams: sp({ new: '1' }) }));
    expect(screen.getByRole('region', { name: 'Evidence を登録' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '登録' })).toBeTruthy();
    // パネルを開いている間は、見出しの primary を重ねない
    expect(headerActions().filter((a) => a.slot === 'primary')).toEqual([]);
  });

  it('登録だけの権限（資料の閲覧なし）には、権限なしの表示を先頭に出さず登録欄を出す（R5）', async () => {
    // デモ利用者に取引先の入力担当はいない（plan Q5）ので、役割だけを合成する
    setShell(ctxFor('site-user@demo.local', ['supplier_contributor']));
    render(await EvidencePage({ searchParams: sp() }));
    expect(screen.queryByText('アクセス権限がありません')).toBeNull();
    expect(screen.getByRole('button', { name: '登録' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('ワークフロー（S21）', () => {
  it('動詞の節に並べ、資料依頼の回答欄は「回答を書く」を開いた中（primary を行ごとに並べない）', async () => {
    setShell(manager());
    const { container } = render(await WorkflowsPage({ searchParams: sp() }));
    for (const name of [
      /^直す・入力する/,
      /^確認する・承認する/,
      /^監査法人からの資料依頼/,
      /^タスク/,
    ]) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    }
    // 回答の欄は閉じた折りたたみの中。送信ボタンは secondary（画面に primary を置かない）
    const forms = [...container.querySelectorAll('form')].filter((f) =>
      f.querySelector('textarea[name="body"]'),
    );
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form.closest('details')?.open).toBe(false);
      expect(form.querySelector('[data-variant="primary"]')).toBeNull();
    }
    expect(container.querySelectorAll('[data-variant="primary"]')).toHaveLength(0);
    // タスクの行は対象へのリンク（行き止まりにしない）
    const tasks = screen.getByRole('table', { name: 'タスク' });
    for (const row of within(tasks).getAllByRole('row').slice(1)) {
      expect(within(row).getAllByRole('link').length).toBeGreaterThan(0);
    }
  });
});

describe('画面の小さな部品・規則', () => {
  it('資料の属性をファイル名から推定する（推定できないものは空）', () => {
    expect(inferEvidenceAttributes('電力請求書_2026-06-30.pdf')).toEqual({
      title: '電力請求書_2026-06-30',
      documentType: '請求書',
      issuedOn: '2026-06-30',
    });
    expect(inferIssuedOn('議事録20260415')).toBe('2026-04-15');
    expect(inferIssuedOn('2026年2月30日 報告')).toBe('');
    expect(inferEvidenceAttributes('photo.png').documentType).toBe('');
  });

  it('タスクの対象から開く先を決める（不明な種類はワークフローのタスクの節）', () => {
    expect(taskTargetHref('data_point', 'dp-1')).toBe('/enterprise/data/dp-1');
    expect(taskTargetHref('pbc_request', 'x')).toBe('/enterprise/workflows#pbc');
    expect(taskTargetHref('ingestion_job', 'j-1')).toBe('/enterprise/imports/j-1');
    expect(taskTargetHref('unknown', null)).toBe('/enterprise/workflows#tasks');
  });

  it('取込の名前はファイル名（内部 ID を出さない）', () => {
    expect(importJobTitle(['a.csv'])).toBe('a.csv');
    expect(importJobTitle(['a.csv', 'b.csv', 'c.csv'])).toBe('a.csv ほか 2 ファイル');
    expect(importJobTitle([])).toBe('（ファイルなし）');
  });

  it('検証ルールのキーを画面に出さない', () => {
    expect(validationRuleLabel('missing_evidence')).toBe('根拠資料の不足');
    expect(validationRuleLabel('__unknown__')).toBe('その他の検証');
  });

  it('要対応の列は対応が要るものだけ。単位の違いは色だけでなく文で示す', () => {
    const { container, rerender } = render(
      <AttentionCell errorCount={0} warningCount={0} evidenceCount={2} requiresEvidence />,
    );
    expect(container.textContent).toBe('なし');
    rerender(<AttentionCell errorCount={2} warningCount={1} evidenceCount={0} requiresEvidence />);
    expect(container.textContent).toContain('検証エラー 2');
    expect(container.textContent).toContain('根拠資料の不足');
    rerender(<UnitOfMeasureCell unitOfMeasure="kWh" metricUnit="MWh" />);
    expect(container.textContent).toContain('単位が指標（MWh）と異なります');
  });
});
