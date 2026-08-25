'use client';

import { previewStorageKey, type ImportPreviewPayload } from './preview-types';

/**
 * 取込プレビューをブラウザ側に置いておく。
 *
 * Demo Mode の取込結果はサーバーのメモリにしか無く、
 * Vercel のように複数インスタンスがある環境では次のリクエストで見つからない。
 * Cookie は 4KB しか無いので、50 ファイル（数百行）は載らない。
 *
 * ブラウザの sessionStorage なら数 MB 使えるうえ、
 * 「今このタブで取り込んだ内容」という寿命がちょうど合う。
 * 保存するのは自分がアップロードしたファイルの内容だけで、他人のデータは入らない。
 */

/** 1 タブぶんの上限。これを超えるとブラウザが例外を投げるので、超える前にやめる */
const MAX_BYTES = 4 * 1024 * 1024;

export function savePreview(payload: ImportPreviewPayload): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const json = JSON.stringify(payload);
    if (json.length > MAX_BYTES) return false;
    // 古い取込は消しておく（同じタブで何度も取り込むと溜まるため）
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith('t4d.import-preview.')) window.sessionStorage.removeItem(key);
    }
    window.sessionStorage.setItem(previewStorageKey(payload.jobId), json);
    return true;
  } catch {
    // 容量超過・プライベートモードなど。持ち回れないだけなので黙って諦める
    return false;
  }
}

export function loadPreview(jobId: string): ImportPreviewPayload | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(previewStorageKey(jobId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImportPreviewPayload;
    return parsed.jobId === jobId && Array.isArray(parsed.rows) ? parsed : null;
  } catch {
    return null;
  }
}
