/**
 * 最小の ZIP 書き出し。本体は src/lib/exports/zip.ts へ移した（全データの返却の書き出し〔NF-29〕が
 * アプリから使うため）。データセットの生成スクリプトはこれまでどおりここから読む。
 */
export { buildZip, type ZipEntry } from '../src/lib/exports/zip';
