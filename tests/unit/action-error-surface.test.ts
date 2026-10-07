import { describe, expect, it } from 'vitest';
import { actionSurfaces } from '../support/action-surface';

/**
 * 業務エラーが利用者に届く（plan §4 B3・§5.2）。
 *
 * 本番の Next.js は Server Action の例外の文を伏せ、error.tsx には識別子しか届かない。
 * 業務エラー（権限・入力の誤り・対象なし）を投げる Action は withUserFacingError で `?error=` に載せ、
 * 元の画面に理由を出す（FlashMessage か、AppShell の GlobalErrorNotice）。
 * useActionState 形・結果を返す形の Action は、結果の文を画面が出すので対象外。
 * 包んでいない Action は、理由付きの表（下の 2 つ）に載っているものだけ。
 */

/** 業務エラーを投げない Action（包む必要が無い） */
const NO_USER_FACING_ERROR: Record<string, string> = {
  'src/lib/auth/preferences.ts#selectPeriodAction':
    '報告期間の Cookie を書くだけ（業務エラーを投げない）',
  'src/lib/auth/actions.ts#logoutAction': 'ログアウト（業務エラーを投げない）',
};

/**
 * まだ包んでいない Action（担当の段が包む。包んだらここから外す。外し忘れると失敗する）。
 * Stage C で認証の 4 本（ログイン 2・ワークスペース選択・招待の受諾）を包み、空になった。
 * 新しく足すときは、包めない理由と担当を書く（空のまま保つのが目標）
 */
const PENDING: Record<string, { owner: 'B4' | 'B6' | 'C'; reason: string }> = {};

describe('業務エラーが利用者に届く（Server Action の包み直し）', () => {
  const surfaces = actionSurfaces();

  it('Action を見つけられている（検査そのものが空回りしていない）', () => {
    expect(surfaces.length).toBeGreaterThan(140);
    expect(surfaces.filter((s) => s.kind === 'wrapped').length).toBeGreaterThanOrEqual(93);
  });

  it('企業・監査法人の共通の Action（多くの画面が使う 2 ファイル）はすべて届く', () => {
    const shared = surfaces.filter(
      (s) =>
        s.file === 'src/app/enterprise/actions.ts' || s.file === 'src/app/assurance/actions.ts',
    );
    expect(shared.filter((s) => s.kind === 'unwrapped').map((s) => s.key)).toEqual([]);
  });

  it('包んでいない Action は理由付きの表のものだけ', () => {
    const unwrapped = surfaces
      .filter((s) => s.kind === 'unwrapped')
      .map((s) => s.key)
      .filter((key) => !(key in NO_USER_FACING_ERROR) && !(key in PENDING));
    expect(unwrapped).toEqual([]);
  });

  it('表は実在する未包装の Action だけを指す（包んだら表から外す）', () => {
    const byKey = new Map(surfaces.map((s) => [s.key, s]));
    for (const key of [...Object.keys(NO_USER_FACING_ERROR), ...Object.keys(PENDING)]) {
      expect(byKey.get(key)?.kind, key).toBe('unwrapped');
    }
  });
});
