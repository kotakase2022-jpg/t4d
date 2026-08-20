import { MfaChallengeForm } from './mfa-form';

/**
 * 静的化させず毎リクエスト描画する。静的 HTML だと middleware の CSP nonce と
 * 一致せずスクリプトが全てブロックされ、hydration しない（フォームが動かない）。
 */
export const dynamic = 'force-dynamic';

export default function MfaChallengePage() {
  return <MfaChallengeForm />;
}
