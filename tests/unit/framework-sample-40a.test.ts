import { describe, expect, it } from 'vitest';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DISCLOSURE_FIRST_IDS } from '@/lib/fixtures/disclosure-first';
import { ESRS_40A_SAMPLE_VERSION_ID } from '@/lib/fixtures/trial-ids';
import { MasterValidationError, parseMasterInput } from '../../scripts/import-framework-master';

/**
 * ESRS-40a 試行用サンプル（架空・条文ではない。トライアル対応 K5・NF-07。unit:framework-sample-40a）。
 *
 *  - 版は sample（legal_status・coverage_status とも）。全項目の題名が「（サンプル）」で始まり、説明に
 *    「公開草案の条文・要約ではありません」と書く
 *  - 草案らしい項番を使わない（40A-S01 の形だけ）
 *  - 公開草案の版は要求事項未収録のまま残る（条文・要約を推測で作らない）
 *  - 登録スクリプトの規則（サンプルの題名・項番）にも通る
 */

const db = createFixtureDb();
const version = db.frameworkVersions.find((v) => v.id === ESRS_40A_SAMPLE_VERSION_ID)!;
const items = db.disclosureItems.filter((i) => i.frameworkVersionId === ESRS_40A_SAMPLE_VERSION_ID);

describe('ESRS-40a 試行用サンプル', () => {
  it('版は sample で、架空であることを版の名前・収録の注記に書く', () => {
    expect(version.legalStatus).toBe('sample');
    expect(version.coverageStatus).toBe('sample');
    expect(version.isFixture).toBe(true);
    expect(version.label).toContain('架空・条文ではない');
    expect(version.coverageNote).toContain('公開草案の条文・要約ではありません');
  });

  it('8 項目すべての題名が「（サンプル）」で始まり、説明に条文ではないことを書く', () => {
    expect(items).toHaveLength(8);
    for (const item of items) {
      expect(item.questionText.startsWith('（サンプル）'), item.code).toBe(true);
      expect(item.guidance, item.code).toContain('公開草案の条文・要約ではありません');
    }
  });

  it('項番は 40A-S01 の形だけ（草案らしい項番を使わない）', () => {
    for (const item of items) expect(item.code).toMatch(/^40A-S\d{2}$/);
  });

  it('公開草案の版は要求事項未収録のまま', () => {
    const draft = db.frameworkVersions.find(
      (v) => v.id === DISCLOSURE_FIRST_IDS.esrs40aDraftVersion,
    )!;
    expect(draft.coverageStatus).toBe('not_loaded');
    expect(db.disclosureItems.filter((i) => i.frameworkVersionId === draft.id)).toHaveLength(0);
  });

  it('登録スクリプトのサンプルの規則に通る（同じ規則で作り直せる）', () => {
    const raw = {
      frameworkKey: 'esrs_40a',
      versionCode: version.versionCode,
      label: version.label,
      year: version.year,
      status: version.status,
      legalStatus: version.legalStatus,
      coverageStatus: version.coverageStatus,
      coverageNote: version.coverageNote,
      materialityBasis: version.materialityBasis,
      items: items.map((i) => ({
        code: i.code,
        section: i.section,
        title: i.questionText,
        answerType: i.answerType,
        previousItemCode: i.previousItemCode,
        source: '',
        verifiedOn: null,
      })),
    };
    expect(() => parseMasterInput(raw)).not.toThrow();
    const draftLike = {
      ...raw,
      items: [{ ...raw.items[0]!, code: '40a-1' }],
    };
    expect(() => parseMasterInput(draftLike)).toThrow(MasterValidationError);
  });
});
