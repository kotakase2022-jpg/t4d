import type { ActivityImportPreview } from '@/lib/services/ghg/activity-import';

/**
 * 活動量の取込の Server Action の結果（画面が入力を保ったまま結果を出し分けられるよう、例外でなく型で返す）。
 * 'use server' のモジュールには …Action の関数だけを置くため、型はここに分ける
 */
export type ActivityPreviewActionResult =
  { ok: true; preview: ActivityImportPreview } | { ok: false; message: string };

export type ActivityImportActionResult =
  { ok: true; href: string } | { ok: false; message: string };
