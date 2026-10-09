import { describe, expect, it } from 'vitest';
import { createFixtureDb } from '@/lib/fixtures/store';
import { ESRS_40A_SAMPLE_VERSION_ID } from '@/lib/fixtures/trial-ids';
import { fid } from '@/lib/fixtures/ids';
import {
  MASTER_SCHEMA,
  MasterValidationError,
  TITLE_MAX,
  buildFrameworkMasterFile,
  csvToItems,
  masterFileName,
  parseCsv,
  parseMasterInput,
  renderDiffReport,
  renderRegistry,
  serializeMasterFile,
} from '../../scripts/import-framework-master';

/**
 * 基準マスターの登録スクリプト（トライアル対応 NF-07・NF-08。int:framework-master-import）。
 *
 *  - 不正な入力を拒否する（条文・本文の欄、出典・確認日の無い公開草案、長い題名、重複、サンプルの規則、
 *    前の版に無い前の項番）
 *  - 生成物は決定的（同じ入力から同じ ID・同じバイト列）
 *  - 差分レポートは改番を削除＋追加にしない
 * 入力はすべて架空（公開草案の条文・要約ではない）。
 */

/** 架空の公開草案の構造（項番・節・要約題名・出典・確認日だけ。条文ではない） */
function draftInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    frameworkKey: 'esrs_40a',
    versionCode: 'esrs-40a-test-final',
    label: 'ESRS-40a テスト版（架空）',
    year: 2027,
    status: 'published',
    legalStatus: 'draft',
    coverageStatus: 'partial',
    coverageNote: '試行範囲の項目だけ（架空）',
    materialityBasis: 'impact',
    issuedAt: null,
    effectiveAt: null,
    jurisdiction: null,
    sourceUrl: 'https://example.invalid/esrs-40a-test',
    verifiedAt: '2026-10-01',
    verifiedBy: '運営側の確認者（架空）',
    previousVersionCode: 'esrs-40a-trial-sample',
    items: [
      {
        code: 'T-01',
        section: 'ガバナンス（テスト）',
        title: 'ガバナンスの体制（テストの要約題名）',
        answerType: 'text',
        previousItemCode: '40A-S01',
        source: 'テスト資料 1 節',
        verifiedOn: '2026-10-01',
      },
      {
        code: 'T-02',
        section: '環境（テスト）',
        title: '（サンプル）温室効果ガス排出量（総量）',
        answerType: 'numeric',
        previousItemCode: '40A-S05',
        source: 'テスト資料 2 節',
        verifiedOn: '2026-10-01',
      },
      {
        code: 'T-03',
        section: '環境（テスト）',
        title: '新しいテスト項目',
        answerType: 'text',
        previousItemCode: null,
        source: 'テスト資料 3 節',
        verifiedOn: '2026-10-01',
      },
    ],
    ...overrides,
  };
}

function problemsOf(raw: unknown, previous?: ReadonlySet<string>): string[] {
  try {
    parseMasterInput(raw, { previousItemCodes: previous ?? null });
    return [];
  } catch (error) {
    if (error instanceof MasterValidationError) return error.problems;
    throw error;
  }
}

const sampleFixture = () => {
  const db = createFixtureDb();
  const version = db.frameworkVersions.find((v) => v.id === ESRS_40A_SAMPLE_VERSION_ID)!;
  return {
    label: version.label,
    items: db.disclosureItems.filter((i) => i.frameworkVersionId === version.id),
  };
};

describe('入力の検査（不正な入力を拒否する）', () => {
  it('正しい入力は通る', () => {
    expect(problemsOf(draftInput())).toEqual([]);
  });

  it('条文・本文の欄は受け付けない', () => {
    const items = (draftInput().items as Array<Record<string, unknown>>).map((i) => ({ ...i }));
    items[0]!.text = '条文の写し（テスト）';
    expect(problemsOf(draftInput({ items }))).toEqual([
      'items[1]: 知らない欄「text」があります（条文・本文は収録しません）。',
    ]);
    expect(problemsOf(draftInput({ body: 'x' }))).toEqual([
      '版に知らない欄「body」があります（条文・本文は収録しません）。',
    ]);
  });

  it('公開草案は出典 URL・確認日・確認者が必須。題名は要約（120 字・改行なし）', () => {
    const problems = problemsOf(draftInput({ sourceUrl: null, verifiedAt: null, verifiedBy: '' }));
    expect(problems).toContain('sourceUrl（一次資料の https の URL）が必要です。');
    expect(problems).toContain('verifiedAt（一次資料で確認した日）が必要です。');
    expect(problems).toContain('verifiedBy（確認した人・組織）が必要です。');
    const items = (draftInput().items as Array<Record<string, unknown>>).map((i) => ({ ...i }));
    items[0]!.title = 'あ'.repeat(TITLE_MAX + 1);
    items[1]!.code = 'T-01';
    items[2]!.verifiedOn = '2026-02-30';
    const more = problemsOf(draftInput({ items }));
    expect(more.some((p) => p.startsWith('items[1]: title'))).toBe(true);
    expect(more).toContain('items[2]: code「T-01」が重複しています。');
    expect(more).toContain('items[3]: verifiedOn は YYYY-MM-DD の日付にしてください。');
  });

  it('試行用サンプルは「（サンプル）」の題名と -S01 の項番だけ。前の版に無い前の項番は拒否', () => {
    const sample = draftInput({
      legalStatus: 'sample',
      coverageStatus: 'sample',
      items: [
        {
          code: '40a-12',
          section: 'テスト',
          title: '草案らしい題名',
          answerType: 'text',
          previousItemCode: null,
          source: '',
          verifiedOn: null,
        },
      ],
    });
    const problems = problemsOf(sample);
    expect(problems).toContain(
      'items[1]: 試行用サンプルの題名は「（サンプル）」で始めてください。',
    );
    expect(problems).toContain(
      'items[1]: 試行用サンプルの項番は「-S01」の形にしてください（公開草案らしい項番を作らない）。',
    );
    const previous = new Set(sampleFixture().items.map((i) => i.code));
    const items = (draftInput().items as Array<Record<string, unknown>>).map((i) => ({ ...i }));
    items[2]!.previousItemCode = '40A-S99';
    expect(problemsOf(draftInput({ items }), previous)).toEqual([
      'items[3]: previousItemCode「40A-S99」は前の版にありません。',
    ]);
  });

  it('要求事項の無い版は not_loaded だけ', () => {
    expect(problemsOf(draftInput({ items: [] }))).toContain(
      '要求事項が 0 件の版は coverageStatus を not_loaded にしてください。',
    );
    expect(problemsOf(draftInput({ items: [], coverageStatus: 'not_loaded' }))).toEqual([]);
  });
});

describe('生成物（決定的）と差分レポート', () => {
  it('同じ入力から同じ ID・同じバイト列（実行日時を書かない）', () => {
    const previous = sampleFixture();
    const a = buildFrameworkMasterFile(parseMasterInput(draftInput()), previous.items);
    const b = buildFrameworkMasterFile(parseMasterInput(draftInput()), previous.items);
    expect(serializeMasterFile(a)).toBe(serializeMasterFile(b));
    expect(a.schema).toBe(MASTER_SCHEMA);
    expect(a.version.id).toBe(fid('framework_version', 'esrs_40a/esrs-40a-test-final'));
    expect(a.version.frameworkId).toBe(fid('framework', 'esrs_40a'));
    expect(a.items.map((i) => i.id)).toEqual(
      ['T-01', 'T-02', 'T-03'].map((c) =>
        fid('disclosure_item', `esrs_40a/esrs-40a-test-final/${c}`),
      ),
    );
    // 公開草案は Fixture（架空）ではない。題名は要約、本文の代わりに出典だけ
    expect(a.version.isFixture).toBe(false);
    expect(a.items[0]?.guidance).toBe('出典: テスト資料 1 節');
    // 前の版との区分: 題名が変われば changed、同じなら carry_forward、新しい項目は new
    expect(a.items.map((i) => i.changeType)).toEqual(['changed', 'carry_forward', 'new']);
    expect(masterFileName(a)).toBe('esrs_40a-esrs-40a-test-final.json');
  });

  it('差分レポートは改番を削除＋追加にしない', () => {
    const previous = sampleFixture();
    const file = buildFrameworkMasterFile(parseMasterInput(draftInput()), previous.items);
    const report = renderDiffReport(previous, file);
    expect(report).toContain('| 改番 | 2 |');
    expect(report).toContain('| 追加 | 1 |');
    // 前の版のうち対応の無い 6 件は削除
    expect(report).toContain('| 削除 | 6 |');
    expect(report).toMatch(/\| 改番（文言も変更） \| 40A-S01 \| T-01 \|/);
    expect(report).toContain('顧客の画面には出しません');
  });

  it('CSV（BOM・引用符・改行入り）を読み、登録簿の本文は名前順で決定的', () => {
    const rows = parseCsv('﻿code,title\n"A-1","題名, その1"\n"A-2","改行\nあり"\n');
    expect(rows).toEqual([
      ['code', 'title'],
      ['A-1', '題名, その1'],
      ['A-2', '改行\nあり'],
    ]);
    const items = csvToItems(
      'code,section,title,answer_type,previous_item_code,source,verified_on,required\nT-01,節,題名,text,,出典,2026-10-01,true\n',
    );
    expect(items[0]).toEqual({
      code: 'T-01',
      section: '節',
      title: '題名',
      answerType: 'text',
      previousItemCode: null,
      source: '出典',
      verifiedOn: '2026-10-01',
      required: true,
    });
    const registry = renderRegistry(['b.json', 'a.json', 'index.ts']);
    expect(registry).toBe(renderRegistry(['a.json', 'b.json']));
    expect(registry.indexOf("from './a.json'")).toBeLessThan(registry.indexOf("from './b.json'"));
    expect(renderRegistry([])).toContain(
      'export const IMPORTED_FRAMEWORK_MASTERS: readonly ImportedFrameworkMaster[] = [];',
    );
  });
});
