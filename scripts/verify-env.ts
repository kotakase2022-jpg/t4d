/**
 * 環境変数の検証。
 *
 *   pnpm verify:env
 *
 * Demo Mode は環境変数ゼロで動くため、本スクリプトは
 * 「Supabase Mode を選んだのに設定が足りない」「Secret が NEXT_PUBLIC_ で露出している」
 * といった危険な組み合わせを検出することを目的とする。
 */

const SECRET_KEYS = ['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'SUPABASE_DB_URL'];

function nonEmpty(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t && t.length > 0 ? t : undefined;
}

function main() {
  const problems: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  const declaredMode = nonEmpty(process.env.NEXT_PUBLIC_APP_MODE);
  const url = nonEmpty(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const publishable = nonEmpty(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  const serviceRole = nonEmpty(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const openai = nonEmpty(process.env.OPENAI_API_KEY);

  const effectiveMode = declaredMode ?? (url && publishable ? 'supabase' : 'demo');
  info.push(`動作モード: ${effectiveMode}${declaredMode ? '（明示指定）' : '（自動判定）'}`);

  if (declaredMode && declaredMode !== 'demo' && declaredMode !== 'supabase') {
    problems.push(`NEXT_PUBLIC_APP_MODE の値が不正です: ${declaredMode}（demo | supabase）`);
  }

  if (effectiveMode === 'supabase') {
    if (!url) problems.push('NEXT_PUBLIC_SUPABASE_URL が未設定です。');
    if (!publishable) problems.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY が未設定です。');
    if (url && !/^https:\/\//.test(url)) {
      problems.push('NEXT_PUBLIC_SUPABASE_URL は https:// で始まる必要があります。');
    }
    if (!serviceRole) {
      warnings.push(
        'SUPABASE_SERVICE_ROLE_KEY が未設定です。監査ログの追記や非同期ジョブが動作しません。',
      );
    }
  } else {
    info.push(
      'Supabase 未接続。架空 Fixture で全画面が動作します（画面上部に「デモデータ」を表示）。',
    );
  }

  if (!openai) {
    info.push('OPENAI_API_KEY が未設定のため、決定論的 Mock AI Provider を使用します。');
  } else {
    info.push(`OpenAI Model: ${nonEmpty(process.env.OPENAI_MODEL) ?? 'gpt-4.1-mini'}`);
  }

  // Secret が NEXT_PUBLIC_ で露出していないか
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('NEXT_PUBLIC_')) continue;
    const suffix = key.replace('NEXT_PUBLIC_', '');
    if (SECRET_KEYS.includes(suffix) || /SERVICE_ROLE|SECRET|PRIVATE/i.test(key)) {
      problems.push(`${key} は Secret をブラウザへ露出させます。NEXT_PUBLIC_ を外してください。`);
    }
  }

  // publishable key に service_role が混入していないか（よくある事故）
  if (publishable && /service_role/i.test(publishable)) {
    problems.push(
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY に service_role キーが設定されている可能性があります。',
    );
  }

  for (const line of info) console.log(`  ${line}`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);

  if (problems.length > 0) {
    console.error('\n✗ 環境変数の検証に失敗しました:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\n✓ 環境変数の検証に合格しました。');
}

main();
