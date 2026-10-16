/**
 * テナントの終了（削除）の事前確認（トライアル対応 NF-30・2026-10-16 の要望 ⑦。運営だけが使う。画面は無い）。
 *
 *   pnpm exec tsx scripts/offboard-tenant.ts --org-code <組織コード> [--manifest-sha256 <返却 manifest の sha256>] \
 *     [--backup-residual-days <日数>] [--executed-on <YYYY-MM-DD>] --confirm-project <Supabase のプロジェクト ref>
 *
 * このスクリプトは **何も削除しない**（dry-run だけ）。表ごとの件数と、保証側の記録（案件）が残っていないかを
 * 確かめ、DB の所有者のロールで実行する SQL（t4d.offboard_organization の 5 引数版）と、顧客へ渡す
 * 「削除完了の報告（案）」を表示する。
 *
 *  - バックアップの残存期間は、終了処理で消える前にデータ取扱条件の最新の版から読む。未合意なら
 *    --backup-residual-days が必須（推測で消去の見込み日を出さない）。合意値と違う日数を渡したら止める
 *  - 報告には組織の名称を入れない（組織コードと日付・件数だけ。終了処理は組織の行も匿名化する）
 *  - 資料へのアクセスの記録（storage_access_events）は削除の対象の表から外しているが、資料の版（file_versions）の
 *    削除に連鎖して消える（残らない。0060 の関数のコメント・tests/rls で確認）。削除の記録（tenant_lifecycle_records）は残す
 *
 * 削除の関数は所有者だけが実行でき（0058・0060。authenticated・service_role から EXECUTE を剥奪）、
 * 確認コード（組織コード）と保証側の案件が無いことを関数の中でも検査する。
 * 手順書: docs/operations/tenant-offboarding.md（返却の受け取りの確認・Storage の実体・Auth ユーザー・記録・報告）
 */

import { pathToFileURL } from 'node:url';
import {
  backupPurgeDueOn,
  backupResidualText,
  isBackupResidualDays,
  isCalendarDate,
} from '../src/lib/domain/data-disposal';
import { assertSafeTarget, parseArgs, ProvisionSafetyError } from './provision-tenant';

/** 終了処理の後も残す表（削除の記録。顧客の内容を持たない） */
export const KEPT_TABLES = ['tenant_lifecycle_records'] as const;

/** 削除の対象の表から外しているが、親（file_versions）の削除に連鎖して消える表 */
export const CASCADED_TABLES = ['storage_access_events'] as const;

/** DB の所有者が実行する SQL（値は引用符を二重にして埋める。確認コードは組織コード） */
export function offboardSql(input: {
  organizationId: string;
  organizationCode: string;
  manifestSha256: string | null;
  executedByLabel: string;
  /**
   * バックアップの残存期間（日）。渡すと 5 引数版（削除の記録に残存期間と消去の見込み日が入る）。
   * undefined は旧い 4 引数版（残存期間は未合意として記録される）
   */
  backupResidualDays?: number | null;
}): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  if (input.manifestSha256 !== null && !/^[0-9a-f]{64}$/.test(input.manifestSha256)) {
    throw new Error('--manifest-sha256 は 64 桁の 16 進数にしてください。');
  }
  const days = input.backupResidualDays;
  if (days !== undefined && days !== null && !isBackupResidualDays(days)) {
    throw new Error('--backup-residual-days は 0〜400 の整数にしてください。');
  }
  const args = [
    `${quote(input.organizationId)}::uuid`,
    quote(input.organizationCode),
    input.manifestSha256 ? quote(input.manifestSha256) : 'null',
    quote(input.executedByLabel),
    ...(days === undefined ? [] : [days === null ? 'null::integer' : String(days)]),
  ];
  return [
    'begin;',
    `select t4d.offboard_organization(${args.join(', ')});`,
    '-- 結果（削除の記録の ID）と tenant_lifecycle_records の件数・消去の見込み日を確かめてから commit する',
    'commit;',
  ].join('\n');
}

/**
 * バックアップの残存期間を決める。合意値（データ取扱条件の最新の版）があればそれを使い、引数で違う値を
 * 渡したら止める。未合意なら引数が必須（推測しない）
 */
export function resolveBackupResidualDays(input: {
  agreed: number | null;
  argument: string | undefined;
}): number {
  const raw = input.argument?.trim();
  const given = raw === undefined || raw === '' ? null : Number(raw);
  if (given !== null && !isBackupResidualDays(given)) {
    throw new Error('--backup-residual-days は 0〜400 の整数にしてください。');
  }
  if (input.agreed !== null) {
    if (given !== null && given !== input.agreed) {
      throw new Error(
        `--backup-residual-days（${given} 日）がデータ取扱条件の合意値（${input.agreed} 日）と違います。合意値に揃えるか、先に条件の版を記録し直してください。`,
      );
    }
    return input.agreed;
  }
  if (given === null) {
    throw new Error(
      'バックアップの残存期間が未合意です（データ取扱条件の最新の版に日数がありません）。--backup-residual-days で合意した日数を指定してください。',
    );
  }
  return given;
}

export interface OffboardReportInput {
  organizationCode: string;
  /** 削除の実施日（JST。SQL を実行する日） */
  executedOn: string;
  /** 表ごとの件数（事前確認の値。実施後は削除の記録の table_counts と照らす） */
  tableCounts: Readonly<Record<string, number>>;
  manifestSha256: string | null;
  backupResidualDays: number;
  /** 残存期間の出所（データ取扱条件の合意値か、運営が指定した値か） */
  residualSource: 'agreed' | 'argument';
}

/**
 * 顧客へ渡す「削除完了の報告（案）」。組織の名称は入れない（組織コードと日付・件数だけ）。
 * 消去の見込み日は削除日 + 残存期間（DB の削除の記録 backup_purge_due_on と同じ足し方）
 */
export function offboardReport(input: OffboardReportInput): string[] {
  if (!isCalendarDate(input.executedOn)) {
    throw new Error('--executed-on は YYYY-MM-DD の日付にしてください。');
  }
  if (!isBackupResidualDays(input.backupResidualDays)) {
    throw new Error('バックアップの残存期間は 0〜400 の整数にしてください。');
  }
  const purge = backupPurgeDueOn(input.executedOn, input.backupResidualDays)!;
  const tables = Object.entries(input.tableCounts).filter(([, n]) => n > 0);
  const total = tables.reduce((sum, [, n]) => sum + n, 0);
  return [
    '■ 削除完了の報告（案）— 実施後に、関数の結果（削除の記録）の件数・日付と照らしてから渡す',
    `- 組織コード: ${input.organizationCode}`,
    `- 削除の実施日: ${input.executedOn}（日本時間）`,
    `- 削除した行: 合計 ${total} 行（${tables.length} 表）`,
    `- 返却した書き出しの manifest の sha256: ${input.manifestSha256 ?? '（指定なし）'}`,
    `- バックアップの残存期間: ${input.backupResidualDays} 日（${
      input.residualSource === 'agreed' ? 'データ取扱条件の合意値' : '運営が指定した値'
    }）`,
    `- バックアップから消える見込み日: ${purge}`,
    `- それまでの扱い: ${backupResidualText(input.backupResidualDays)}`,
    '- 資料へのアクセスの記録は、資料の削除に連鎖して消えました。操作の記録（監査ログ）は合意した期間保存します。',
  ];
}

/** 今日の日付（JST） */
function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
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

  // バックアップの残存期間（終了処理で消える前に、データ取扱条件の最新の版から読む）
  const { data: terms } = await client
    .from('organization_data_terms')
    .select('version_no, backup_residual_days')
    .eq('organization_id', org.id)
    .order('version_no', { ascending: false })
    .limit(1)
    .maybeSingle();
  const agreed =
    typeof terms?.backup_residual_days === 'number' ? terms.backup_residual_days : null;
  const residualDays = resolveBackupResidualDays({
    agreed,
    argument: args.values['backup-residual-days'],
  });
  const executedOn = args.values['executed-on'] ?? todayJst();

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
  const counts: Record<string, number> = {};
  for (const table of new Set(Object.values(SQL_TABLE_NAMES))) {
    if ((KEPT_TABLES as readonly string[]).includes(table)) continue;
    const { count, error } = await client
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', org.id);
    // organization_id を持たない表は数えない（関数も消さない）
    if (error) continue;
    if ((count ?? 0) > 0) {
      const cascaded = (CASCADED_TABLES as readonly string[]).includes(table);
      console.log(
        `  - ${table}: ${count} 行${cascaded ? '（資料の版の削除に連鎖して消える）' : ''}`,
      );
      counts[table] = count ?? 0;
    }
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(
    `  合計 ${total} 行（資料へのアクセスの記録 storage_access_events も連鎖して消えます。削除の記録 tenant_lifecycle_records は残します）`,
  );
  console.log('■ DB の所有者のロールで実行する SQL（Supabase の SQL エディタなど）:');
  console.log(
    offboardSql({
      organizationId: org.id,
      organizationCode: org.code,
      manifestSha256: args.values['manifest-sha256'] ?? null,
      executedByLabel: args.values['executed-by'] ?? 'operator',
      backupResidualDays: residualDays,
    }),
  );
  console.log(
    offboardReport({
      organizationCode: org.code,
      executedOn,
      tableCounts: counts,
      manifestSha256: args.values['manifest-sha256'] ?? null,
      backupResidualDays: residualDays,
      residualSource: agreed !== null ? 'agreed' : 'argument',
    }).join('\n'),
  );
  console.log(
    '■ そのあと: Storage の実体・その組織だけに属する Auth ユーザーを手順書に従って削除し、報告（案）を実施後の値で確定して渡す',
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
