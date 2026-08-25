import { describe, expect, it } from 'vitest';
import { createFixtureDb } from '@/lib/fixtures/store';
import { SSBJ_FRAMEWORK_INFO, SSBJ_MASTER_ITEMS } from '@/lib/frameworks/ssbj-2026';

/**
 * SSBJ 正式基準マスターの整合性。
 * 架空縮小版と違い、ここは公表基準の条文（転載許可取得済み）なので、
 * 「原文が欠けていない・改変されていない・出所が明示されている」ことを機械で守る。
 */
describe('SSBJ 2026 正式基準マスター', () => {
  it('項目数と構成が公表基準と一致する（一般33・気候96・実務4）', () => {
    const byPrefix = (p: string) => SSBJ_MASTER_ITEMS.filter((i) => i.code.startsWith(p));
    expect(byPrefix('一般-')).toHaveLength(33);
    expect(byPrefix('気候-')).toHaveLength(96);
    expect(byPrefix('実務-')).toHaveLength(4);
    expect(SSBJ_MASTER_ITEMS).toHaveLength(133);
  });

  it('コードが重複せず、原文が項番号から始まる', () => {
    const codes = SSBJ_MASTER_ITEMS.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const item of SSBJ_MASTER_ITEMS) {
      // 「気候-47(1)」→ 47、「気候-56-2」→ 56-2
      const para = item.code.replace(/^[^-]+-/, '').replace(/\(\d\)$/, '');
      expect(item.text, item.code).toMatch(new RegExp(`^${para}\\.`));
      expect(item.text.length, item.code).toBeGreaterThan(20);
      expect(item.title.length, item.code).toBeGreaterThan(5);
    }
  });

  it('PDF 抽出のノイズ（ページ番号・目次点線）が残っていない', () => {
    for (const item of SSBJ_MASTER_ITEMS) {
      expect(item.text, item.code).not.toMatch(/・・・|−\d+−| - \d+ - /);
    }
  });

  it('GHG 排出量の 3 項目だけが数値回答で、指標へ紐づく', () => {
    const numeric = SSBJ_MASTER_ITEMS.filter((i) => i.answerType === 'numeric');
    expect(numeric.map((i) => [i.code, i.metricCode])).toEqual([
      ['気候-47(1)', 'scope1'],
      ['気候-47(2)', 'scope2'],
      ['気候-47(3)', 'scope3_cat1'],
    ]);
  });

  it('2026年3月13日改正で挿入された枝番の項だけが new になる', () => {
    const added = SSBJ_MASTER_ITEMS.filter((i) => i.changeType === 'new').map((i) => i.code);
    expect(added).toEqual(['気候-56-2', '気候-56-3', '気候-56-4']);
    expect(SSBJ_MASTER_ITEMS.every((i) => i.changeType !== 'changed')).toBe(true);
  });

  it('目的規定・条件付き規定は必須にしない（例）', () => {
    const byCode = new Map(SSBJ_MASTER_ITEMS.map((i) => [i.code, i]));
    expect(byCode.get('一般-9')?.required).toBe(true);
    expect(byCode.get('一般-20')?.required).toBe(false); // 定量的情報の免除要件
    expect(byCode.get('気候-9')?.required).toBe(false); // 目的規定
    expect(byCode.get('気候-47(1)')?.required).toBe(true);
    expect(byCode.get('実務-7')?.required).toBe(false); // SHK 制度選択時のみ
  });

  it('出所と転載許可が明示されている', () => {
    expect(SSBJ_FRAMEWORK_INFO.description).toContain('転載許可');
    expect(SSBJ_FRAMEWORK_INFO.attribution).toContain('サステナビリティ基準委員会');
    expect(SSBJ_FRAMEWORK_INFO.versionLabel).toContain('2026年3月13日改正');
  });

  it('Fixture ストアへ正式版として組み込まれる（架空フラグが立たない）', () => {
    const db = createFixtureDb();
    const framework = db.frameworks.find((f) => f.key === 'ssbj');
    expect(framework?.name).toBe(SSBJ_FRAMEWORK_INFO.name);
    const version = db.frameworkVersions.find((v) => v.frameworkId === framework?.id);
    expect(version?.isFixture).toBe(false);
    expect(version?.label).toBe(SSBJ_FRAMEWORK_INFO.versionLabel);
    const items = db.disclosureItems.filter((i) => i.frameworkVersionId === version?.id);
    expect(items).toHaveLength(133);
    // GHG 3 項目のマッピングが引き継がれる
    const itemIds = new Set(items.filter((i) => i.code.startsWith('気候-47(')).map((i) => i.id));
    const mappings = db.disclosureMappings.filter((m) => itemIds.has(m.itemId));
    expect(mappings).toHaveLength(3);
  });
});
