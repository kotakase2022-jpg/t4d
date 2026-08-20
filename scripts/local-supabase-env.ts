import { execFileSync } from 'node:child_process';

/**
 * ローカル Supabase スタックの接続情報を `supabase status` から読む。
 *
 * 以前はテスト側にキーを直書きしていた。Supabase CLI がどの環境でも同じ値を配る
 * ローカル開発用キーではあるが、**キーの形をした文字列をリポジトリへ置かない**方が
 * 取り違えを防げる（CLAUDE.md §0.5）。実際 GitHub の Secret Scanning にも弾かれる。
 *
 * 環境変数が設定されていればそちらを優先する（CI や別ポートのスタック用）。
 */

interface LocalSupabaseEnv {
  url: string;
  publishableKey: string;
  serviceRoleKey: string;
}

let cached: LocalSupabaseEnv | null = null;

function readStatus(): Record<string, string> {
  try {
    const raw = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Windows では pnpm がシェル経由でないと解決できない
      shell: process.platform === 'win32',
    });
    const start = raw.indexOf('{');
    return start >= 0 ? (JSON.parse(raw.slice(start)) as Record<string, string>) : {};
  } catch {
    // スタックが起動していない場合は空で返し、呼び出し側で理由を出す
    return {};
  }
}

export function localSupabaseEnv(): LocalSupabaseEnv {
  if (cached) return cached;

  const envUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const envPublishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const envServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (envUrl && envPublishable && envServiceRole) {
    cached = { url: envUrl, publishableKey: envPublishable, serviceRoleKey: envServiceRole };
    return cached;
  }

  const status = readStatus();
  const url = envUrl ?? status.API_URL ?? '';
  const publishableKey = envPublishable ?? status.PUBLISHABLE_KEY ?? status.ANON_KEY ?? '';
  const serviceRoleKey = envServiceRole ?? status.SECRET_KEY ?? status.SERVICE_ROLE_KEY ?? '';

  if (!url || !publishableKey || !serviceRoleKey) {
    throw new Error(
      [
        'ローカル Supabase の接続情報を取得できませんでした。',
        '  pnpm exec supabase start',
        'を実行してから、もう一度お試しください。',
        '（別のスタックへ向ける場合は NEXT_PUBLIC_SUPABASE_URL /',
        '  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY を設定してください）',
      ].join('\n'),
    );
  }

  cached = { url, publishableKey, serviceRoleKey };
  return cached;
}
