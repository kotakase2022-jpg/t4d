/**
 * テナントの終了（削除）の事前確認（トライアル対応 NF-30。運営だけが使う。画面は無い）。
 *
 *   pnpm exec tsx scripts/offboard-tenant.ts --org-code <組織コード> [--manifest-sha256 <返却 manifest の sha256>] \
 *     --confirm-project <Supabase のプロジェクト ref>
 *
 * このスクリプトは **何も削除しない**（dry-run だけ）。表ごとの件数と、保証側の記録（案件）が残っていないかを
 * 確かめ、DB の所有者のロールで実行する SQL（t4d.offboard_organization）を表示する。
 * 削除の関数は所有者だけが実行でき（0058。authenticated・service_role から EXECUTE を剥奪）、
 * 確認コード（組織コード）と保証側の案件が無いことを関数の中でも検査する。
 * 手順書: docs/operations/tenant-offboarding.md（返却の受け取りの確認・Storage の実体・Auth ユーザー・記録）
 */

import { pathToFileURL } from 'node:url';
import { assertSafeTarget, parseArgs, ProvisionSafetyError } from './provision-tenant';

/** 組織の行を持つ表（0058 の関数と同じく、アクセスの記録と削除の記録は残す） */
export const KEPT_TABLES = ['storage_access_events', 'tenant_lifecycle_records'] as const;

/** DB の所有者が実行する SQL（値は引用符を二重にして埋める。確認コードは組織コード） */
export function offboardSql(input: {
  organizationId: string;
  organizationCode: string;
  manifestSha256: string | null;
  executedByLabel: string;
}): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  if (input.manifestSha256 !== null && !/^[0-9a-f]{64}$/.test(input.manifestSha256)) {
    throw new Error('--manifest-sha256 は 64 桁の 16 進数にしてください。');
  }
  return [
    'begin;',
    `select t4d.offboard_organization(${quote(input.organizationId)}::uuid, ${quote(input.organizationCode)}, ${
      input.manifestSha256 ? quote(input.manifestSha256) : 'null'
    }, ${quote(input.executedByLabel)});`,
    '-- 結果（削除の記録の ID）と tenant_lifecycle_records の件数を確かめてから commit する',
    'commit;',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // 件数を読むため Service Role の接続が要る（--apply と同じ確認）。書き込みはしない
  const target = assertSafeTarget(process.env, {
    apply: true,
    confirmProject: args.confirmProject,
  });
  const code = args.values['org-code'];
  if (!code) throw new Error('--org-code が必要です。');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(target.supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: org } = await client
    .from('organizations')
    .select('id, code, type, deleted_at')
    .eq('code', code)
    .maybeSingle();
  if (!org || org.deleted_at)
    throw new Error('組織が見つかりません（既に終了済みの可能性があります）。');
  if (org.type !== 'enterprise') throw new ProvisionSafetyError('企業テナントだけを終了できます。');

  const { count: engagements } = await client
    .from('engagements')
    .select('id', { count: 'exact', head: true })
    .eq('client_organization_id', org.id);
  console.log(`■ 組織 ${code}（${org.id}）の終了の事前確認（何も削除していません）`);
  if ((engagements ?? 0) > 0) {
    console.log(
      `  ! 保証側の案件が ${engagements} 件残っています。保証人と合意した扱いに従ってから実行してください（関数も止めます）。`,
    );
  }

  const { SQL_TABLE_NAMES } = await import('../src/lib/repositories/table-names');
  let total = 0;
  for (const table of new Set(Object.values(SQL_TABLE_NAMES))) {
    if ((KEPT_TABLES as readonly string[]).includes(table)) continue;
    const { count, error } = await client
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', org.id);
    // organization_id を持たない表は数えない（関数も消さない）
    if (error) continue;
    if ((count ?? 0) > 0) {
      console.log(`  - ${table}: ${count} 行`);
      total += count ?? 0;
    }
  }
  console.log(
    `  合計 ${total} 行（アクセスの記録 storage_access_events は監査の記録として残します）`,
  );
  console.log('■ DB の所有者のロールで実行する SQL（Supabase の SQL エディタなど）:');
  console.log(
    offboardSql({
      organizationId: org.id,
      organizationCode: org.code,
      manifestSha256: args.values['manifest-sha256'] ?? null,
      executedByLabel: args.values['executed-by'] ?? 'operator',
    }),
  );
  console.log(
    '■ そのあと: Storage の実体・その組織だけに属する Auth ユーザーを手順書に従って削除する',
  );
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`offboard-tenant: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
