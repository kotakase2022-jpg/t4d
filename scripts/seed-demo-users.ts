/**
 * Supabase Auth へ Demo ユーザーを作成する。
 *
 *   pnpm seed:demo-users
 *
 * profiles.id は auth.users(id) を参照するため、seed.sql を流す前に
 * 同じ UUID で auth ユーザーを作っておく必要がある。
 *
 * 安全装置:
 *  - 本番と思われる URL（*.supabase.co かつ ALLOW_REMOTE_SEED 未設定）には実行しない
 *  - 実ユーザーへの招待メールは送らない（email_confirm: true で確定させる）
 */

import { createClient } from '@supabase/supabase-js';
import { DEMO_USERS, userId } from '../src/lib/fixtures/dataset';

const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? 'T4D-demo-local-only!';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRole) {
    console.error(
      'NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です（.env.local を設定してください）。',
    );
    process.exit(1);
  }

  const isRemote = /\.supabase\.(co|in)/.test(url);
  if (isRemote && !process.env.ALLOW_REMOTE_SEED) {
    console.error(
      [
        'リモート Supabase プロジェクトへの Seed 実行はブロックされました。',
        '本番／共有環境へ架空ユーザーを作らないための安全装置です。',
        'ローカル（supabase start）で実行するか、意図的な場合のみ ALLOW_REMOTE_SEED=1 を設定してください。',
      ].join('\n'),
    );
    process.exit(1);
  }

  const admin = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let created = 0;
  let skipped = 0;

  for (const user of DEMO_USERS) {
    const id = userId(user.email);
    const { error } = await admin.auth.admin.createUser({
      // 決定論的 UUID を明示指定し、seed.sql の profiles と一致させる
      id,
      email: user.email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: user.displayName, demo: true },
    });

    if (error) {
      if (/already been registered|already exists/i.test(error.message)) {
        skipped += 1;
        continue;
      }
      console.error(`✗ ${user.email}: ${error.message}`);
      process.exitCode = 1;
      continue;
    }
    created += 1;
    console.log(`✓ ${user.email} (${user.displayName})`);
  }

  console.log(`\n作成 ${created} 件 / 既存 ${skipped} 件`);
  console.log(`パスワード: ${DEMO_PASSWORD}（ローカル検証専用。本番では使用しないこと）`);
}

main().catch((error) => {
  console.error('seed-demo-users に失敗しました:', error);
  process.exit(1);
});
