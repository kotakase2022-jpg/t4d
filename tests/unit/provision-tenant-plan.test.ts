import { describe, expect, it } from 'vitest';
import { DEMO_USERS, ORG_IDS } from '@/lib/fixtures/dataset';
import { offboardSql } from '../../scripts/offboard-tenant';
import {
  assertSafeTarget,
  buildProvisionPlan,
  DEFAULT_ROUTE_STAGES,
  parseArgs,
  projectRefOf,
  ProvisionSafetyError,
  type ProvisionInput,
} from '../../scripts/provision-tenant';

/**
 * 空のテナントの払い出しの計画と安全装置（トライアル対応 NF-30・plan unit:provision-tenant-plan）。
 *
 *  - 計画に架空の Fixture（デモの組織・利用者・名前）が入らない
 *  - 本番の公開 URL を指す環境では止める。--apply は環境変数と、URL と一致する --confirm-project が必須
 *  - メールは送らない（招待はリンクを表示するだけ）
 */

function input(overrides: Partial<ProvisionInput> = {}): ProvisionInput {
  return {
    organizationName: 'トライアル企業（架空）',
    organizationCode: 'TRIAL-CO',
    adminEmail: 'admin@trial.invalid',
    fiscalYear: 2026,
    cdp: true,
    contractRef: '（架空）オプション契約',
    assurance: {
      firmName: 'トライアル監査法人（架空）',
      firmCode: 'TRIAL-FIRM',
      managerEmail: 'manager@firm.invalid',
      engagementCode: 'ENG-2026-001',
    },
    appUrl: 'http://localhost:3000/',
    now: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  };
}

let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`;

describe('払い出しの計画', () => {
  it('企業テナント・本社・報告年度・開示優先モード・3 段階の既定ルート・CDP・初期管理者の招待を作る', () => {
    const plan = buildProvisionPlan(input(), ids);
    const tables = plan.operations.map((op) => op.table);
    expect(tables).toContain('organizations');
    expect(tables).toContain('organization_units');
    expect(tables).toContain('reporting_periods');
    expect(
      plan.operations.find((op) => op.table === 'organization_feature_settings')?.row,
    ).toMatchObject({ disclosure_first: true });
    const route = plan.operations.find((op) => op.table === 'approval_routes')!;
    expect(route.row).toMatchObject({ is_default: true, purpose: 'default' });
    const stages = plan.operations.filter((op) => op.table === 'approval_route_stages');
    expect(stages.map((s) => s.row.name)).toEqual(DEFAULT_ROUTE_STAGES.map((s) => s.name));
    expect(stages.every((s) => s.row.route_id === route.row.id)).toBe(true);
    expect(plan.operations.find((op) => op.table === 'organization_options')?.row).toMatchObject({
      option_key: 'cdp',
      enabled: true,
    });
    const admin = plan.operations.find(
      (op) => op.table === 'invitations' && op.row.organization_id === plan.organizationId,
    )!;
    expect(admin.row).toMatchObject({ role_keys: ['enterprise_admin'], status: 'pending' });
    expect(plan.inviteLinks[0]!.url).toBe(`http://localhost:3000/invite/${admin.row.id}`);
  });

  it('保証側を再現するときは監査法人・関係・最初の案件・マネージャーの招待を作る（案件は自社の報告年度）', () => {
    const plan = buildProvisionPlan(input(), ids);
    const period = plan.operations.find((op) => op.table === 'reporting_periods')!;
    const engagement = plan.operations.find((op) => op.table === 'engagements')!;
    expect(engagement.row).toMatchObject({
      assurance_firm_id: plan.firmId,
      client_organization_id: plan.organizationId,
      client_reporting_period_id: period.row.id,
      status: 'planning',
    });
    expect(
      plan.operations.find((op) => op.table === 'organization_relationships')?.row,
    ).toMatchObject({
      client_organization_id: plan.organizationId,
      provider_organization_id: plan.firmId,
      status: 'active',
    });
    expect(plan.inviteLinks.map((l) => l.email)).toEqual([
      'admin@trial.invalid',
      'manager@firm.invalid',
    ]);
  });

  it('CDP・保証側を指定しなければ作らない', () => {
    const plan = buildProvisionPlan(input({ cdp: false, assurance: null }), ids);
    const tables = plan.operations.map((op) => op.table);
    expect(tables).not.toContain('organization_options');
    expect(tables).not.toContain('engagements');
    expect(plan.firmId).toBeNull();
  });

  it('架空の Fixture（デモの組織・利用者・名前）が計画に入らない', () => {
    const text = JSON.stringify(buildProvisionPlan(input(), ids));
    for (const id of Object.values(ORG_IDS)) expect(text).not.toContain(id);
    for (const user of DEMO_USERS) {
      expect(text).not.toContain(user.email);
      expect(text).not.toContain(user.displayName);
    }
    for (const fictional of ['青海', 'あおば', '蒼天', '@demo.local', '@fictional.invalid']) {
      expect(text).not.toContain(fictional);
    }
  });

  it('入力の誤りは計画を作らない', () => {
    expect(() => buildProvisionPlan(input({ organizationCode: 'x' }), ids)).toThrow();
    expect(() => buildProvisionPlan(input({ adminEmail: 'not-an-email' }), ids)).toThrow();
    expect(() =>
      buildProvisionPlan(
        input({
          assurance: {
            firmName: '法人',
            firmCode: 'TRIAL-CO',
            managerEmail: 'm@firm.invalid',
            engagementCode: 'ENG-1',
          },
        }),
        ids,
      ),
    ).toThrow(/別にしてください/);
  });
});

describe('安全装置', () => {
  const remote = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghij.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value',
  };

  it('本番の公開 URL・本番の Vercel では dry-run でも止める', () => {
    expect(() =>
      assertSafeTarget(
        { NEXT_PUBLIC_APP_URL: 'https://terrast-t4d.vercel.app' },
        { apply: false, confirmProject: null },
      ),
    ).toThrow(ProvisionSafetyError);
    expect(() =>
      assertSafeTarget({ VERCEL_ENV: 'production' }, { apply: false, confirmProject: null }),
    ).toThrow(ProvisionSafetyError);
    expect(() =>
      assertSafeTarget(
        { VERCEL_URL: 'terrast-t4d.vercel.app' },
        { apply: false, confirmProject: null },
      ),
    ).toThrow(ProvisionSafetyError);
  });

  it('--apply は環境変数と、URL のプロジェクトと一致する --confirm-project が必須', () => {
    expect(() => assertSafeTarget({}, { apply: true, confirmProject: 'abcdefghij' })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
    expect(() => assertSafeTarget(remote, { apply: true, confirmProject: null })).toThrow(
      /--confirm-project abcdefghij/,
    );
    expect(() => assertSafeTarget(remote, { apply: true, confirmProject: 'other' })).toThrow(
      ProvisionSafetyError,
    );
    expect(assertSafeTarget(remote, { apply: true, confirmProject: 'abcdefghij' })).toEqual({
      supabaseUrl: remote.NEXT_PUBLIC_SUPABASE_URL,
      projectRef: 'abcdefghij',
    });
  });

  it('既定は dry-run（--apply を付けたときだけ書く）', () => {
    expect(parseArgs(['--org-code', 'TRIAL-CO']).apply).toBe(false);
    expect(parseArgs(['--org-code', 'TRIAL-CO', '--apply']).apply).toBe(true);
    expect(projectRefOf('http://127.0.0.1:54321')).toBe('local');
  });
});

describe('終了（削除）の SQL', () => {
  it('所有者が実行する関数を、確認コード（組織コード）と返却 manifest の sha256 付きで組み立てる', () => {
    const sql = offboardSql({
      organizationId: '11111111-1111-4111-8111-111111111111',
      organizationCode: "TRIAL'CO",
      manifestSha256: 'a'.repeat(64),
      executedByLabel: '運営',
    });
    expect(sql).toContain('t4d.offboard_organization(');
    expect(sql).toContain("'TRIAL''CO'");
    expect(sql).toMatch(/^begin;/);
    expect(() =>
      offboardSql({
        organizationId: '11111111-1111-4111-8111-111111111111',
        organizationCode: 'X',
        manifestSha256: 'not-a-hash',
        executedByLabel: '運営',
      }),
    ).toThrow();
  });
});
