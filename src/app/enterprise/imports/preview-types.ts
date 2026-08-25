/**
 * 取込プレビューを「そのリクエストだけで完結させる」ための最小表現。
 *
 * Demo Mode の状態はプロセスのメモリにしか無い（docs/known-limitations.md D-3）。
 * 取込結果を別リクエスト（プレビュー画面の GET）で読み直す作りだと、
 * Vercel のように複数インスタンスへ振り分けられる環境では
 * 「50 ファイル投入したのにプレビューが出ない」が起きる。
 *
 * そこで、プレビューに必要なぶんだけをこの形にして**クライアントが持ち回す**。
 * 確定時にはこの内容がそのままサーバーへ戻るので、
 * 取込ジョブが別インスタンスのメモリにしか無くても確定できる。
 */
export interface ImportPreviewRow {
  id: string;
  rowIndex: number;
  /** 元ファイルの該当行（表示用） */
  raw: Record<string, string>;
  /** 元資料の位置（"ファイル名 / row 3" 等）。確定時の出典に残す */
  sourceLocator: string | null;
  metricId: string | null;
  unitId: string | null;
  value: number | null;
  unitOfMeasure: string | null;
  confidence: number;
  warnings: string[];
  status: string;
}

export interface ImportPreviewPayload {
  jobId: string;
  reportingPeriodId: string;
  fileNames: string[];
  rows: ImportPreviewRow[];
  /** 解析に失敗したファイル（あれば画面に出す） */
  failedFiles: { name: string; message: string }[];
}

/** sessionStorage のキー。ジョブごとに 1 件 */
export function previewStorageKey(jobId: string): string {
  return `t4d.import-preview.${jobId}`;
}

/** 一度に投入できるファイル数。要求仕様（事前加工なしで 50 ファイル一括）に合わせる */
export const MAX_FILES_PER_IMPORT = 50;
