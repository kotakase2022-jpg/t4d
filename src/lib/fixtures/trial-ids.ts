import { fid } from './ids';
import type { Uuid } from '@/types/domain';

/**
 * トライアル対応（2026-10）の架空 Fixture の ID のうち、ほかの Fixture（disclosure-first.ts）からも参照するもの。
 * trial-case.ts と disclosure-first.ts が互いを読み込まないよう、ID だけをここに置く。
 */

/**
 * ESRS-40a 試行用サンプル（架空・条文ではない）の版。FY2026 のプロジェクトの ESRS-40a はこの版に固定する
 * （公開草案の版は要求事項が未収録で、判断・対応表・横断対応の実演ができないため）。
 * 公開草案の条文・要約は作らない（docs/disclosure-first.md の規則）
 */
export const ESRS_40A_SAMPLE_VERSION_ID: Uuid = fid('framework_version', 'esrs_40a/trial-sample');

/** ESRS-40a 試行用サンプルの要求事項（コード 40A-S01〜40A-S08） */
export function esrs40aSampleItemId(code: string): Uuid {
  return fid('disclosure_item', `esrs_40a/trial-sample/${code}`);
}

/**
 * 架空のメンバー（担当拠点・役割の変更の実演用。ログインの選択肢には出さない）のメールの末尾。
 * Demo Mode で Cookie から戻すメンバーシップの変更は、この末尾の利用者に限る（demo-trial-checks.ts）
 */
export const FICTIONAL_MEMBER_EMAIL_SUFFIX = '@fictional.invalid';

/** XBRL の SAMPLE（架空）タクソノミのパッケージ */
export const XBRL_SAMPLE_PACKAGE_ID: Uuid = fid('xbrl_taxonomy_package', 'sample-ssbj-2026');

/** SAMPLE の概念（local_name で引く） */
export function xbrlSampleConceptId(localName: string): Uuid {
  return fid('xbrl_concept', `sample-ssbj-2026/t4ds/${localName}`);
}
