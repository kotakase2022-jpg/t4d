/**
 * 空のテナントの払い出し（トライアル対応 NF-30。運営だけが使う。画面は無い）。
 *
 *   pnpm exec tsx scripts/provision-tenant.ts --org-name "<企業名>" --org-code <コード> --admin-email <メール> \
 *     [--fiscal-year 2026] [--cdp --contract-ref "<契約の参照>"] \
 *     [--firm-name "<監査法人名>" --firm-code <コード> --firm-manager-email <メール> --engagement-code <コード>] \
 *     [--apply --confirm-project <Supabase のプロジェクト ref>]
 *
 *   # 監査法人のメンバーが招待を受諾したあと、最初の案件のチームに加える
 *   pnpm exec tsx scripts/provision-tenant.ts --assign-members --firm-code <コード> --engagement-code <コード> \
 *     --member-email <メール> [--apply --confirm-project <ref>]
 *
 * 既定は dry-run（何も書かずに計画を表示する）。--apply は Supabase の環境変数（URL・Service Role Key）と、
 * URL のプロジェクトと一致する --confirm-project が必須。本番の Vercel の URL を指す環境では止める。
 *
 * 入れるもの: 企業テナント（組織・本社・報告年度）・開示優先モード ON・3 段階の既定の承認ルート・
 * （指定時）CDP オプション・初期管理者の招待（リンクを表示するだけ。メールは送らない）。
 * 保証側を再現するときは監査法人テナント・組織間の関係・最初の案件・監査法人のマネージャーの招待。
 * **架空の Fixture は入れない**（マスター〔基準・要求事項・役割・権限〕はマイグレーションとマスターの投入で入っている前提）。
 * 手順書: docs/operations/tenant-provisioning.md
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** 本番の Vercel の URL（Demo Mode 限定で公開。実データ・本番 Supabase を載せない: CLAUDE.md §0-7） */
export const PRODUCTION_HOSTS = ['terrast-t4d.vercel.app'] as const;

export class ProvisionSafetyError extends Error {}

export interface ProvisionInput {
  organizationName: string;
  organizationCode: string;
  adminEmail: string;
  /** 報告年度（4 月始まり）。既定は今年度 */
  fiscalYear: number;
  cdp: boolean;
  contractRef: string;
  assurance: {
    firmName: string;
    firmCode: string;
    managerEmail: string;
    engagementCode: string;
  } | null;
  /** 招待リンクの前に付ける URL（メールは送らない。運営が本人へ手渡す） */
  appUrl: string;
  now: Date;
}

export interface ProvisionOperation {
  table: string;
  /** 計画の表示（何を作るか） */
  description: string;
  row: Record<string, unknown>;
}

export interface ProvisionPlan {
  operations: ProvisionOperation[];
  /** 招待リンク（本人へ手渡す。メールは送らない） */
  inviteLinks: Array<{ email: string; role: string; url: string }>;
  organizationId: string;
  firmId: string | null;
  engagementId: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const INVITATION_TTL_DAYS = 14;

/** 3 段階の既定の承認ルート（設定の「3 段階のひな形」と同じ） */
export const DEFAULT_ROUTE_STAGES = [
  { name: '拠点・部署の確認', role: 'reviewer' },
  { name: '本社サステナビリティ担当の確認', role: 'sustainability_manager' },
  { name: '最終承認', role: 'approver' },
] as const;

function validate(input: ProvisionInput): void {
  if (input.organizationName.trim() === '') throw new Error('--org-name が必要です。');
  if (!CODE.test(input.organizationCode)) {
    throw new Error('--org-code は英大文字・数字・-・_ の 2〜32 文字にしてください。');
  }
  if (!EMAIL.test(input.adminEmail)) throw new Error('--admin-email の形式が正しくありません。');
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 2000 || input.fiscalYear > 2100) {
    throw new Error('--fiscal-year は西暦の年にしてください。');
  }
  if (input.assurance) {
    if (input.assurance.firmName.trim() === '') throw new Error('--firm-name が必要です。');
    if (!CODE.test(input.assurance.firmCode))
      throw new Error('--firm-code の形式が正しくありません。');
    if (input.assurance.firmCode === input.organizationCode) {
      throw new Error('企業と監査法人のコードは別にしてください。');
    }
    if (!EMAIL.test(input.assurance.managerEmail)) {
      throw new Error('--firm-manager-email の形式が正しくありません。');
    }
    if (!CODE.test(input.assurance.engagementCode)) {
      throw new Error('--engagement-code の形式が正しくありません。');
    }
  }
}

/** 払い出しの計画（純関数。DB に触れない。dry-run とテストが使う） */
export function buildProvisionPlan(
  input: ProvisionInput,
  newId: () => string = randomUUID,
): ProvisionPlan {
  validate(input);
  const now = input.now.toISOString();
  const expiresAt = new Date(
    input.now.getTime() + INVITATION_TTL_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const audit = { created_at: now, updated_at: now, created_by: null, updated_by: null };
  const operations: ProvisionOperation[] = [];
  const inviteLinks: ProvisionPlan['inviteLinks'] = [];
  const base = input.appUrl.replace(/\/+$/, '');

  const organizationId = newId();
  operations.push({
    table: 'organizations',
    description: `企業テナント「${input.organizationName}」（${input.organizationCode}）`,
    row: {
      id: organizationId,
      type: 'enterprise',
      name: input.organizationName.trim(),
      legal_name: null,
      code: input.organizationCode,
      country_code: 'JP',
      deleted_at: null,
      ...audit,
    },
  });
  const unitId = newId();
  operations.push({
    table: 'organization_units',
    description: '本社（担当拠点は運用開始後に設定の「組織・拠点」で足す）',
    row: {
      id: unitId,
      organization_id: organizationId,
      parent_id: null,
      code: 'HQ',
      name: '本社',
      unit_type: 'headquarters',
      sort_order: 0,
      deleted_at: null,
      ...audit,
    },
  });
  const periodId = newId();
  const fy = input.fiscalYear;
  operations.push({
    table: 'reporting_periods',
    description: `報告年度 FY${fy}（${fy}-04-01〜${fy + 1}-03-31）`,
    row: {
      id: periodId,
      organization_id: organizationId,
      code: `FY${fy}`,
      label: `FY${fy}（${fy}年度）`,
      start_date: `${fy}-04-01`,
      end_date: `${fy + 1}-03-31`,
      status: 'collecting',
      submission_due_date: null,
      ...audit,
    },
  });
  operations.push({
    table: 'organization_feature_settings',
    description: '開示優先モードを有効にする',
    row: { id: newId(), organization_id: organizationId, disclosure_first: true, ...audit },
  });
  const routeId = newId();
  operations.push({
    table: 'approval_routes',
    description: '既定の承認ルート（3 段階）',
    row: {
      id: routeId,
      organization_id: organizationId,
      name: '3 段階の承認（標準）',
      description: '拠点・部署の確認 → 本社の確認 → 最終承認 の 3 段階（払い出しの初期値）',
      is_default: true,
      purpose: 'default',
      ...audit,
    },
  });
  DEFAULT_ROUTE_STAGES.forEach((stage, index) => {
    operations.push({
      table: 'approval_route_stages',
      description: `承認ルートの ${index + 1} 段目「${stage.name}」`,
      row: {
        id: newId(),
        organization_id: organizationId,
        route_id: routeId,
        stage_no: index + 1,
        name: stage.name,
        approver_role: stage.role,
        approver_user_id: null,
        department: '',
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
    });
  });
  if (input.cdp) {
    operations.push({
      table: 'organization_options',
      description: 'CDP 対応オプションを有効にする（契約に基づく）',
      row: {
        id: newId(),
        organization_id: organizationId,
        option_key: 'cdp',
        enabled: true,
        contract_ref: input.contractRef.trim(),
        valid_from: now.slice(0, 10),
        valid_to: null,
        note: '',
        set_at: now,
        set_by_label: '運営（払い出し）',
      },
    });
  }
  const adminInvitationId = newId();
  operations.push({
    table: 'invitations',
    description: `初期管理者の招待（${input.adminEmail}・企業管理者。メールは送らない）`,
    row: {
      id: adminInvitationId,
      organization_id: organizationId,
      email: input.adminEmail.trim().toLowerCase(),
      role_keys: ['enterprise_admin'],
      status: 'pending',
      unit_scope_ids: [],
      expires_at: expiresAt,
      ...audit,
    },
  });
  inviteLinks.push({
    email: input.adminEmail.trim().toLowerCase(),
    role: '企業管理者',
    url: `${base}/invite/${adminInvitationId}`,
  });

  let firmId: string | null = null;
  let engagementId: string | null = null;
  if (input.assurance) {
    firmId = newId();
    operations.push({
      table: 'organizations',
      description: `監査法人テナント「${input.assurance.firmName}」（${input.assurance.firmCode}）`,
      row: {
        id: firmId,
        type: 'assurance_firm',
        name: input.assurance.firmName.trim(),
        legal_name: null,
        code: input.assurance.firmCode,
        country_code: 'JP',
        deleted_at: null,
        ...audit,
      },
    });
    operations.push({
      table: 'organization_relationships',
      description: '企業と監査法人の関係（保証）',
      row: {
        id: newId(),
        client_organization_id: organizationId,
        provider_organization_id: firmId,
        relationship_type: 'assurance',
        status: 'active',
        started_at: now.slice(0, 10),
        ended_at: null,
        ...audit,
      },
    });
    engagementId = newId();
    operations.push({
      table: 'engagements',
      description: `最初の案件 ${input.assurance.engagementCode}（FY${fy}・SSBJ・限定的保証）`,
      row: {
        id: engagementId,
        assurance_firm_id: firmId,
        client_organization_id: organizationId,
        client_reporting_period_id: periodId,
        code: input.assurance.engagementCode,
        name: `FY${fy} サステナビリティ情報の保証`,
        assurance_level: 'limited',
        framework_key: 'ssbj',
        status: 'planning',
        planned_start_date: now.slice(0, 10),
        deadline_date: `${fy + 1}-06-30`,
        partner_user_id: null,
        manager_user_id: null,
        materiality_basis: null,
        materiality_value: null,
        materiality_unit: null,
        ...audit,
      },
    });
    const firmInvitationId = newId();
    operations.push({
      table: 'invitations',
      description: `監査法人のマネージャーの招待（${input.assurance.managerEmail}。メールは送らない）`,
      row: {
        id: firmInvitationId,
        organization_id: firmId,
        email: input.assurance.managerEmail.trim().toLowerCase(),
        role_keys: ['assurance_manager'],
        status: 'pending',
        unit_scope_ids: [],
        expires_at: expiresAt,
        ...audit,
      },
    });
    inviteLinks.push({
      email: input.assurance.managerEmail.trim().toLowerCase(),
      role: '監査法人のマネージャー',
      url: `${base}/invite/${firmInvitationId}`,
    });
  }

  return { operations, inviteLinks, organizationId, firmId, engagementId };
}

/** Supabase の URL からプロジェクトの ref（ローカルは local） */
export function projectRefOf(supabaseUrl: string): string {
  const url = new URL(supabaseUrl);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return 'local';
  const match = url.hostname.match(/^([a-z0-9]+)\.supabase\.(co|in)$/);
  return match?.[1] ?? url.hostname;
}

/**
 * 書き込みの前の安全装置（dry-run のときも本番の URL では止める）。
 *  - 本番の Vercel（PRODUCTION_HOSTS・VERCEL_ENV=production）を指す環境では動かさない
 *  - --apply は Supabase の URL・Service Role Key と、URL と一致する --confirm-project が必須
 */
export function assertSafeTarget(
  env: Record<string, string | undefined>,
  options: { apply: boolean; confirmProject: string | null },
): { supabaseUrl: string | null; projectRef: string | null } {
  if (env.VERCEL_ENV === 'production') {
    throw new ProvisionSafetyError(
      '本番の Vercel の環境では実行しません（VERCEL_ENV=production）。',
    );
  }
  for (const key of ['NEXT_PUBLIC_APP_URL', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
    const value = env[key];
    if (!value) continue;
    const host = (() => {
      try {
        return new URL(value.includes('://') ? value : `https://${value}`).hostname;
      } catch {
        return value;
      }
    })();
    if ((PRODUCTION_HOSTS as readonly string[]).includes(host)) {
      throw new ProvisionSafetyError(
        `本番の公開 URL（${host}）を指す環境では実行しません。実データ・本番の Supabase を Demo の公開環境に載せない規則です。`,
      );
    }
  }
  if (!options.apply)
    return { supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? null, projectRef: null };
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRole) {
    throw new ProvisionSafetyError(
      '--apply には NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です。',
    );
  }
  const projectRef = projectRefOf(supabaseUrl);
  if (!options.confirmProject || options.confirmProject !== projectRef) {
    throw new ProvisionSafetyError(
      `--apply には --confirm-project ${projectRef} を付けてください（書き込み先のプロジェクトを人が確かめるため）。`,
    );
  }
  return { supabaseUrl, projectRef };
}

export interface ParsedArgs {
  apply: boolean;
  confirmProject: string | null;
  assignMembers: boolean;
  values: Record<string, string>;
  flags: Set<string>;
  memberEmails: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const memberEmails: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      if (key === 'member-email') memberEmails.push(next);
      else values[key] = next;
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return {
    apply: flags.has('apply'),
    confirmProject: values['confirm-project'] ?? null,
    assignMembers: flags.has('assign-members'),
    values,
    flags,
    memberEmails,
  };
}

export function inputFromArgs(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  now = new Date(),
): ProvisionInput {
  const v = args.values;
  const month = now.getUTCMonth() + 1;
  const currentFy = month >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const firm = v['firm-name']
    ? {
        firmName: v['firm-name'],
        firmCode: v['firm-code'] ?? '',
        managerEmail: v['firm-manager-email'] ?? '',
        engagementCode: v['engagement-code'] ?? '',
      }
    : null;
  return {
    organizationName: v['org-name'] ?? '',
    organizationCode: v['org-code'] ?? '',
    adminEmail: v['admin-email'] ?? '',
    fiscalYear: v['fiscal-year'] ? Number(v['fiscal-year']) : currentFy,
    cdp: args.flags.has('cdp'),
    contractRef: v['contract-ref'] ?? '',
    assurance: firm,
    appUrl: env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
    now,
  };
}

function printPlan(plan: ProvisionPlan, apply: boolean): void {
  console.log(apply ? '■ 払い出しを実行します' : '■ 払い出しの計画（dry-run。何も書いていません）');
  for (const op of plan.operations) console.log(`  - [${op.table}] ${op.description}`);
  console.log('■ 招待リンク（メールは送りません。本人へ手渡してください。有効 14 日）');
  for (const link of plan.inviteLinks) console.log(`  - ${link.role} ${link.email}: ${link.url}`);
  if (plan.engagementId) {
    console.log(
      '■ 監査法人のマネージャーが受諾したら、--assign-members で最初の案件のチームに加えてください。',
    );
  }
}

async function serviceClient(supabaseUrl: string, env: Record<string, string | undefined>) {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function provision(args: ParsedArgs, env: Record<string, string | undefined>): Promise<void> {
  const target = assertSafeTarget(env, { apply: args.apply, confirmProject: args.confirmProject });
  const plan = buildProvisionPlan(inputFromArgs(args, env));
  printPlan(plan, args.apply);
  if (!args.apply || !target.supabaseUrl) return;

  const client = await serviceClient(target.supabaseUrl, env);
  // マスター（役割・基準）がある環境だけ（架空の Fixture は入れないので、マスターの投入を先に済ませる）
  const { data: roles } = await client.from('roles').select('key').eq('key', 'enterprise_admin');
  const { data: frameworks } = await client
    .from('disclosure_frameworks')
    .select('key')
    .eq('key', 'ssbj');
  if (!roles?.length || !frameworks?.length) {
    throw new ProvisionSafetyError(
      'マスター（役割・SSBJ の基準）が見つかりません。マイグレーションとマスターの投入を先に行ってください。',
    );
  }
  for (const op of plan.operations) {
    const { error } = await client.from(op.table).insert(op.row);
    if (error) throw new Error(`${op.table}: ${error.message}（${op.description}）`);
  }
  console.log(`■ 完了: 組織 ${plan.organizationId}`);
}

async function assignMembers(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): Promise<void> {
  const target = assertSafeTarget(env, { apply: args.apply, confirmProject: args.confirmProject });
  const firmCode = args.values['firm-code'];
  const engagementCode = args.values['engagement-code'];
  if (!firmCode || !engagementCode || args.memberEmails.length === 0) {
    throw new Error('--firm-code・--engagement-code・--member-email（1 つ以上）が必要です。');
  }
  console.log(
    `■ 案件 ${engagementCode} のチームに加える: ${args.memberEmails.join('、')}${args.apply ? '' : '（dry-run）'}`,
  );
  if (!args.apply || !target.supabaseUrl) return;
  const client = await serviceClient(target.supabaseUrl, env);
  const { data: firm } = await client
    .from('organizations')
    .select('id')
    .eq('code', firmCode)
    .eq('type', 'assurance_firm')
    .maybeSingle();
  if (!firm) throw new Error('監査法人が見つかりません。');
  const { data: engagement } = await client
    .from('engagements')
    .select('id')
    .eq('assurance_firm_id', firm.id)
    .eq('code', engagementCode)
    .maybeSingle();
  if (!engagement) throw new Error('案件が見つかりません。');
  for (const email of args.memberEmails) {
    const { data: profile } = await client
      .from('profiles')
      .select('id')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();
    if (!profile) throw new Error(`${email} はまだ招待を受諾していません。`);
    const { data: membership } = await client
      .from('organization_memberships')
      .select('id')
      .eq('organization_id', firm.id)
      .eq('user_id', profile.id)
      .eq('status', 'active')
      .maybeSingle();
    if (!membership) throw new Error(`${email} は監査法人の有効なメンバーではありません。`);
    const { error } = await client.from('engagement_members').insert({
      id: randomUUID(),
      engagement_id: engagement.id,
      assurance_firm_id: firm.id,
      user_id: profile.id,
      role_key: 'assurance_manager',
      assigned_at: new Date().toISOString(),
      assigned_by: null,
      removed_at: null,
    });
    if (error) throw new Error(`${email}: ${error.message}`);
    console.log(`  - ${email} を加えました`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.assignMembers) await assignMembers(args, process.env);
  else await provision(args, process.env);
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`provision-tenant: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
