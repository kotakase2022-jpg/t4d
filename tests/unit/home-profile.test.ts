import { describe, expect, it } from 'vitest';
import { defaultCollapsedGroups } from '@/components/shared/nav-config';
import { permissionsFor } from '@/lib/authorization/can';
import {
  assuranceHomeProfileFor,
  defaultHomeTab,
  homeProfileFor,
  resolveHomeTab,
  type Can,
} from '@/lib/ui/home-profile';
import { MY_WORK_ORDER, orderMyWork, type MyWorkItem } from '@/lib/ui/my-work';
import { buildPaletteEntries } from '@/lib/ui/palette';
import { availableTaskVerbs } from '@/lib/ui/task-verbs';
import type { RoleKey } from '@/types/domain';

/**
 * 役割ごとの初期表示（plan §1.3・§3.5 home-profile）。
 * デモ利用者の無い役割（サプライヤー担当・閲覧者・外部支援者・専門家・監査法人の閲覧者）も、
 * 合成した権限で固定する（デモ利用者・fixture は増やさない。plan §7 Q5）。
 */

function canOf(...roles: RoleKey[]): Can {
  const set = permissionsFor(roles);
  return (permission) => set.has(permission);
}

describe('HomeProfile（権限で決める。兼務は上を優先）', () => {
  it.each([
    [['approver', 'reviewer'], 'approver'],
    [['approver'], 'approver'],
    [['sustainability_manager'], 'preparer'],
    [['enterprise_admin'], 'admin'],
    [['reviewer'], 'reviewer'],
    [['site_contributor'], 'contributor'],
    [['supplier_contributor'], 'contributor'],
    [['external_advisor'], 'viewer'],
    [['viewer'], 'viewer'],
  ] as Array<[RoleKey[], string]>)('%j → %s', (roles, profile) => {
    expect(homeProfileFor(canOf(...roles))).toBe(profile);
  });

  it.each([
    [['engagement_partner'], 'partner'],
    [['assurance_manager'], 'manager'],
    [['assurance_staff'], 'staff'],
    [['specialist'], 'specialist'],
    [['assurance_admin'], 'firm_admin'],
    [['assurance_viewer'], 'viewer'],
  ] as Array<[RoleKey[], string]>)('監査法人 %j → %s', (roles, profile) => {
    expect(assuranceHomeProfileFor(canOf(...roles))).toBe(profile);
  });
});

describe('開示優先ホームの既定タブ', () => {
  it('開示の閲覧権限が無い役割（拠点担当・サプライヤー担当）は ESG経営（権限なしを先頭に出さない）', () => {
    expect(defaultHomeTab(canOf('site_contributor'))).toBe('esg');
    expect(defaultHomeTab(canOf('supplier_contributor'))).toBe('esg');
    for (const role of [
      'sustainability_manager',
      'reviewer',
      'approver',
      'enterprise_admin',
      'viewer',
      'external_advisor',
    ] as RoleKey[]) {
      expect(defaultHomeTab(canOf(role)), role).toBe('disclosure');
    }
  });

  it('URL の ?tab= が役割の既定より優先する', () => {
    expect(resolveHomeTab('disclosure', canOf('site_contributor'))).toBe('disclosure');
    expect(resolveHomeTab('esg', canOf('sustainability_manager'))).toBe('esg');
    expect(resolveHomeTab('zzz', canOf('site_contributor'))).toBe('esg');
    expect(resolveHomeTab(undefined, canOf('sustainability_manager'))).toBe('disclosure');
  });
});

describe('サイドバーの既定で閉じるグループ', () => {
  it('開示の閲覧権限が無い役割は 開示対応（従来）・開示プロジェクト（開示優先）を閉じる。分析は閉じない', () => {
    const site = canOf('site_contributor');
    expect(defaultCollapsedGroups('enterprise', site)).toEqual(['開示対応']);
    expect(defaultCollapsedGroups('enterprise-disclosure', site)).toEqual(['開示プロジェクト']);
    expect(defaultCollapsedGroups('enterprise', canOf('supplier_contributor'))).toEqual([
      '開示対応',
    ]);
    for (const role of ['sustainability_manager', 'viewer', 'external_advisor'] as RoleKey[]) {
      expect(defaultCollapsedGroups('enterprise', canOf(role)), role).toEqual([]);
    }
    expect(defaultCollapsedGroups('assurance', canOf('assurance_staff'))).toEqual([]);
  });
});

describe('自分の作業の並び（役割ごと）', () => {
  const item = (kind: MyWorkItem['kind'], dueDate: string | null = null): MyWorkItem => ({
    key: `${kind}-${dueDate}`,
    kind,
    verb: '',
    target: kind,
    dueDate,
    daysUntilDue: null,
    reason: null,
    cta: { label: 'x', href: '/x' },
  });

  it('拠点担当: 直す → 入力する → 回答する → 取込を確認する', () => {
    const ordered = orderMyWork('contributor', [
      item('import-check'),
      item('pbc-respond'),
      item('data-enter'),
      item('data-returned'),
    ]);
    expect(ordered.map((i) => i.kind)).toEqual(MY_WORK_ORDER.contributor);
  });

  it('最終承認者: 最終承認 → データの承認 → レビュー', () => {
    const ordered = orderMyWork('approver', [
      item('manuscript-review'),
      item('data-approve'),
      item('manuscript-final'),
    ]);
    expect(ordered.map((i) => i.kind)).toEqual([
      'manuscript-final',
      'data-approve',
      'manuscript-review',
    ]);
  });

  it('同じ種類の中は期限の早い順（期限なしは後ろ）', () => {
    const ordered = orderMyWork('contributor', [
      item('pbc-respond', null),
      item('pbc-respond', '2026-12-01'),
      item('pbc-respond', '2026-11-01'),
    ]);
    expect(ordered.map((i) => i.dueDate)).toEqual(['2026-11-01', '2026-12-01', null]);
  });

  it('閲覧者には自分の作業を出さない', () => {
    expect(orderMyWork('viewer', [item('data-enter')])).toEqual([]);
  });
});

describe('タスク動詞とパレットのおすすめ（権限で絞る）', () => {
  const ctx = { unitScopeIds: [] as string[], demo: true, disclosureFirst: true };

  it('拠点担当には入力・差戻し・資料・取込の動詞（承認・レポートは出さない）', () => {
    const verbs = availableTaskVerbs(canOf('site_contributor'), {
      unitScopeIds: ['unit-east'],
    }).map((v) => v.id);
    expect(verbs).toEqual(
      expect.arrayContaining([
        'enter-data',
        'fix-returned-data',
        'register-evidence',
        'start-import',
      ]),
    );
    expect(verbs).not.toContain('approve-data');
    expect(verbs).not.toContain('make-report');
    const enter = availableTaskVerbs(canOf('site_contributor'), {
      unitScopeIds: ['unit-east'],
    }).find((v) => v.id === 'enter-data');
    expect(enter?.href).toBe('/enterprise/data?status=not_started&status=draft&unit=unit-east');
  });

  it('報告年度の追加は組織の管理のときだけ（期間の管理だけでは出さない。R2）', () => {
    expect(availableTaskVerbs(canOf('sustainability_manager'), ctx).map((v) => v.id)).not.toContain(
      'add-period',
    );
    expect(availableTaskVerbs(canOf('enterprise_admin'), ctx).map((v) => v.id)).toContain(
      'add-period',
    );
  });

  it('デモのリセットは Demo Mode・開示優先のときだけ（実行はせずホームの確認ダイアログへ）', () => {
    const can = canOf('sustainability_manager');
    expect(
      availableTaskVerbs(can, { unitScopeIds: [], demo: false, disclosureFirst: true }).map(
        (v) => v.id,
      ),
    ).not.toContain('reset-demo');
    expect(
      availableTaskVerbs(can, { unitScopeIds: [], demo: true, disclosureFirst: false }).map(
        (v) => v.id,
      ),
    ).not.toContain('reset-demo');
    const reset = availableTaskVerbs(can, ctx).find((v) => v.id === 'reset-demo');
    expect(reset?.href).toBe('/enterprise/dashboard?confirm=reset-demo');
  });

  it.each([
    [
      'site_contributor',
      ['データを入力する', '差戻しを直す（データ）', '資料を登録する', '取込を始める'],
    ],
    ['sustainability_manager', ['原稿を書く', '取込を始める', 'SSBJ 要求事項', '開示プロジェクト']],
    ['reviewer', ['原稿をレビューする', 'データを確認する']],
    ['enterprise_admin', ['組織・拠点', '設定', 'メンバーを招待する', '監査法人へのアクセス許諾']],
    ['viewer', ['現状診断', '自社経年比較', 'ESG経営']],
  ] as Array<[RoleKey, string[]]>)('%s のおすすめ', (role, labels) => {
    const can = canOf(role);
    const built = buildPaletteEntries({
      workspace: 'enterprise',
      can,
      profile: homeProfileFor(can),
      verbContext: ctx,
      navPaths: [],
    });
    expect(built.recommended.map((r) => r.label)).toEqual(labels);
  });

  it('監査法人のパレットには企業の操作を出さず、案件の画面は案件を選んでいるときだけ', () => {
    const can = canOf('assurance_manager');
    const none = buildPaletteEntries({
      workspace: 'assurance',
      can,
      verbContext: ctx,
      navPaths: [],
      engagementId: null,
    });
    // 企業の操作（タスク動詞）は出さない。監査法人の操作は案件の外では起票だけ（案件の中の作成は案件を選んでから）
    expect(none.actions.map((a) => [a.label, a.href])).toEqual([
      ['保証契約を起票する', '/assurance/engagements?new=1'],
    ]);
    expect(none.screens.filter((s) => s.href.startsWith('/assurance/engagements/'))).toEqual([]);
    expect(none.screens.map((s) => s.href)).toContain('/assurance/engagements');
    const selected = buildPaletteEntries({
      workspace: 'assurance',
      can,
      verbContext: ctx,
      navPaths: [],
      engagementId: 'eng-1',
    });
    expect(selected.screens.map((s) => s.href)).toContain('/assurance/engagements/eng-1/sampling');
    // 案件を選んでいるときは、その案件の作成欄を開いた画面へ移る操作（権限のあるものだけ）
    expect(selected.actions.map((a) => [a.label, a.href])).toEqual([
      ['保証契約を起票する', '/assurance/engagements?new=1'],
      ['資料依頼を作成する', '/assurance/engagements/eng-1/requests?new=1'],
      ['指摘を起票する', '/assurance/engagements/eng-1/issues?new=1'],
      ['レビューNote を追加する', '/assurance/engagements/eng-1/review-notes?new=1'],
      ['サンプルを抽出する', '/assurance/engagements/eng-1/sampling?new=1'],
      ['案件チームを変更する', '/assurance/engagements/eng-1/overview?team=1'],
    ]);
    // 法人管理者（案件の閲覧なし）には案件の画面を出さない
    const firmAdmin = buildPaletteEntries({
      workspace: 'assurance',
      can: canOf('assurance_admin'),
      verbContext: ctx,
      navPaths: [],
      engagementId: 'eng-1',
    });
    expect(firmAdmin.screens.map((s) => s.href)).not.toContain(
      '/assurance/engagements/eng-1/sampling',
    );
    expect(firmAdmin.screens.map((s) => s.href)).toContain('/assurance/settings');
    // 法人管理者は案件の起票・作成の権限を持たないので、操作は出さない
    expect(firmAdmin.actions).toEqual([]);
  });
});
