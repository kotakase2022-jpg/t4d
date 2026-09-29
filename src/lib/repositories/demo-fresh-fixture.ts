import 'server-only';

import { headers } from 'next/headers';
import { createFixtureDb, getDemoDb, type FixtureDb } from '@/lib/fixtures/store';

/**
 * 試験用の切替: **リクエストごとに新しい Fixture** を作る（Demo Mode のみ・既定は無効）。
 *
 * 本番（Vercel の Demo Mode）はリクエストごとに別のインスタンスへ振り分けられることがあり、
 * インスタンスのメモリにだけある行は次のリクエストで見えない（docs/known-limitations.md D-3）。
 * ローカルでは 1 プロセスがメモリを持ち続けるため、この失敗を再現できなかった
 * （本番で標準 CSV の確定が「検証結果の有効期限が切れました」になった。2026-09-30）。
 *
 * この切替を有効にすると、getDb() はリクエストごとに Fixture を作り直し、Cookie の操作だけを
 * 適用する。つまり**すべてのリクエストが起動直後の別インスタンスに届いた**のと同じ状態になり、
 * Cookie かブラウザが持ち回した状態だけが残る（最悪の場合の再現）。
 *
 * - `playwright.stateless.config.ts`（`pnpm test:e2e:stateless`）だけが設定する。Vercel には設定しない
 *   （本番は環境変数を一切持たない。CLAUDE.md §0-7）。
 * - 未設定のときは従来どおりプロセス共有の Fixture（getDemoDb）を使い、この関数群は何もしない。
 */
export const FRESH_FIXTURE_ENV = 'T4D_DEMO_FRESH_FIXTURE_PER_REQUEST';

export function isFreshFixturePerRequest(): boolean {
  return process.env.T4D_DEMO_FRESH_FIXTURE_PER_REQUEST === '1';
}

/**
 * リクエストごとの Fixture。キーは Next.js のリクエストのヘッダー（リクエストの間は同じ物）。
 * Server Action の後の描画も同じリクエストなので、同じ Fixture を見る（書いた行が見える）。
 * リダイレクト先の描画は Next.js が別のリクエストとして取り直すため、新しい Fixture になる
 * （本番で別インスタンスへ届く場合と同じ）
 */
const perRequest = new WeakMap<object, FixtureDb>();

export interface RequestFixture {
  db: FixtureDb;
  /** このリクエストで初めて作った（Cookie の操作をまだ適用していない） */
  created: boolean;
}

/**
 * 切替が有効なら、このリクエストの Fixture（無ければ作る）。リクエストの外（テスト・スクリプト）や
 * 切替が無効なときは、プロセス共有の Fixture を返す
 */
export async function demoFixtureForRequest(): Promise<RequestFixture> {
  if (!isFreshFixturePerRequest()) return { db: getDemoDb(), created: false };
  let key: object;
  try {
    key = await headers();
  } catch {
    return { db: getDemoDb(), created: false };
  }
  const existing = perRequest.get(key);
  if (existing) return { db: existing, created: false };
  const db = createFixtureDb();
  perRequest.set(key, db);
  return { db, created: true };
}
