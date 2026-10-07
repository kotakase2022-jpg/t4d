import 'server-only';

import { getSession } from '@/lib/auth/session';
import { getDb } from '@/lib/repositories';
import { isDisclosureFirstEnabled } from '@/lib/services/feature-settings';

/**
 * 資料の画面のタブの題名。開示優先モードが OFF の組織は、メニュー・見出しと同じ従来の名前（A39）。
 * 題名の決定で画面を落とさない（ログイン前・権限外は既定の名前）
 */
export async function evidenceTitles(): Promise<{ list: string; viewer: string }> {
  // 資料の画面は「資料の詳細」（plan §1.17。Evidence Viewer・資料・証跡の表示を業務の言葉に揃える）
  const fallback = { list: '資料・証跡', viewer: '資料の詳細' };
  try {
    const session = await getSession();
    if (!session?.context || session.context.workspace.organizationType !== 'enterprise') {
      return fallback;
    }
    const enabled = await isDisclosureFirstEnabled(await getDb(), session.context);
    return enabled ? fallback : { list: 'Evidence', viewer: '資料の詳細' };
  } catch {
    return fallback;
  }
}
