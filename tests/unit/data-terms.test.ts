import { describe, expect, it } from 'vitest';
import {
  dataTermsItems,
  DATA_TERMS_ITEM_LABELS,
  DEMO_SUBPROCESSORS_JSON_MAX,
  environmentProcessors,
  normalizeSubprocessor,
  parseSubprocessors,
  processorMismatches,
  subprocessorRows,
} from '@/lib/services/data-terms';
import { ValidationError } from '@/lib/errors/user-facing';
import type { OrganizationDataTerms } from '@/types/domain';

/**
 * データ取扱条件の処理を委ねる先（plan CR-25・unit:data-terms）。純関数だけ（DB を使わない）。
 *  - 区分ごとに読む。以前の版（区分なしの 3 項目）は「その他」・根拠なしに読み替える
 *  - AI サービス提供者の行だけ、AI の再学習の合意の語を出す
 *  - 秘密保持の根拠が空の行は未合意（推測で埋めない）
 *  - この環境の外部の処理先（ホスティング・DB・AI）と合意した区分を突き合わせる。値は読まない
 *  - 残存期間は日数（未合意は未合意）
 */

function terms(overrides: Partial<OrganizationDataTerms> = {}): OrganizationDataTerms {
  return {
    id: 't',
    organizationId: 'o',
    versionNo: 1,
    ndaStatus: 'signed',
    processingTermsRef: '',
    storageLocation: '',
    retentionPolicy: '',
    aiTrainingUse: 'not_allowed',
    aiProviderStorage: 'none',
    subprocessors: [],
    returnMethod: '',
    deletionMethod: '',
    agreedOn: null,
    agreedByLabel: '',
    note: '',
    createdBy: 'u',
    createdAt: '2026-10-01T00:00:00Z',
    backupResidualDays: null,
    ...overrides,
  };
}

describe('処理を委ねる先の読み取り', () => {
  it('項目名は「処理を委ねる先（業務委託先・クラウド・AI）」（「再委託先」ではない）', () => {
    expect(DATA_TERMS_ITEM_LABELS.subprocessors).toBe('処理を委ねる先（業務委託先・クラウド・AI）');
  });

  it('以前の版（区分なしの 3 項目）は「その他」・根拠なし（未合意）に読み替える', () => {
    const old = terms({
      subprocessors: [{ name: '（架空）保管の事業者', role: '保管', location: '国内' }],
    });
    expect(normalizeSubprocessor(old.subprocessors[0]!)).toEqual({
      name: '（架空）保管の事業者',
      role: '保管',
      location: '国内',
      category: 'other',
      confidentialityBasis: '',
    });
    const [row] = subprocessorRows(old);
    expect(row).toMatchObject({ category: 'other', basisState: 'not_agreed', aiTraining: null });
    // 版そのものは書き換えない
    expect(old.subprocessors[0]).not.toHaveProperty('category');
  });

  it('区分の順（業務委託先・クラウド・AI・その他）に並べ、AI の行だけ再学習の合意の語を出す', () => {
    const rows = subprocessorRows(
      terms({
        aiTrainingUse: 'not_allowed',
        subprocessors: [
          { category: 'ai', name: 'A', role: '', location: '', confidentialityBasis: '約款' },
          { category: 'other', name: 'O', role: '', location: '', confidentialityBasis: '' },
          { category: 'cloud', name: 'C', role: '', location: '', confidentialityBasis: '条件' },
          {
            category: 'contractor',
            name: 'K',
            role: '',
            location: '',
            confidentialityBasis: 'NDA',
          },
        ],
      }),
    );
    expect(rows.map((r) => r.name)).toEqual(['K', 'C', 'A', 'O']);
    expect(rows.find((r) => r.name === 'A')!.aiTraining).toBe('再学習に使わない');
    expect(rows.filter((r) => r.aiTraining !== null)).toHaveLength(1);
    expect(rows.find((r) => r.name === 'O')!.basisState).toBe('not_agreed');
    expect(rows.find((r) => r.name === 'K')!.basisState).toBe('agreed');
  });

  it('合意した条件の表の値は区分ごとの社数と、根拠が未合意の社数', () => {
    const item = dataTermsItems(
      terms({
        subprocessors: [
          { category: 'cloud', name: 'C', role: '', location: '', confidentialityBasis: '条件' },
          { category: 'ai', name: 'A', role: '', location: '', confidentialityBasis: '' },
        ],
      }),
    ).find((i) => i.item === 'subprocessors')!;
    expect(item.value).toBe(
      'クラウドサービス提供者 1・AI サービス提供者 1（2 社。秘密保持の根拠が未合意 1 社）',
    );
    expect(item.state).toBe('agreed');
  });

  it('バックアップの残存期間は日数。未合意（null）は未合意', () => {
    const agreed = dataTermsItems(terms({ backupResidualDays: 35 })).find(
      (i) => i.item === 'backupResidualDays',
    )!;
    expect(agreed).toMatchObject({ value: '35 日', state: 'agreed' });
    const none = dataTermsItems(terms()).find((i) => i.item === 'backupResidualDays')!;
    expect(none).toMatchObject({ value: '—', state: 'not_agreed' });
  });
});

describe('入力の読み取り', () => {
  it('区分ごとの欄を「名称／役割／所在地／秘密保持の根拠」で読む。4 つ目以降の「／」は根拠に含める', () => {
    const list = parseSubprocessors(
      {
        subprocessorsByCategory: {
          cloud: '（架空）クラウド事業者／保管／国内／（架空）データ処理条件',
          ai: '（架空）AI 提供元／候補の生成／米国／約款／学習に使わない設定',
        },
      },
      60,
    );
    expect(list).toEqual([
      {
        category: 'cloud',
        name: '（架空）クラウド事業者',
        role: '保管',
        location: '国内',
        confidentialityBasis: '（架空）データ処理条件',
      },
      {
        category: 'ai',
        name: '（架空）AI 提供元',
        role: '候補の生成',
        location: '米国',
        confidentialityBasis: '約款／学習に使わない設定',
      },
    ]);
  });

  it('半角の「/」は区切らない（URL・「米国/EU」・「NDA/DPA」を所在地・根拠へずらさない。自己監査 UX-06）', () => {
    const list = parseSubprocessors(
      {
        subprocessorsByCategory: {
          cloud: 'Example Cloud／ホスティング／東京/大阪／DPA https://example.com/dpa',
          contractor: 'A社／保管／米国/EU／NDA/DPA',
        },
      },
      60,
    );
    expect(list.map((s) => [s.name, s.role, s.location, s.confidentialityBasis])).toEqual([
      ['A社', '保管', '米国/EU', 'NDA/DPA'],
      ['Example Cloud', 'ホスティング', '東京/大阪', 'DPA https://example.com/dpa'],
    ]);
  });

  it('区分の合計で 10 社まで。各項目の上限・名称の空は断る', () => {
    const many = Array.from({ length: 6 }, (_, i) => `社${i}／役割／所在`).join('\n');
    expect(() =>
      parseSubprocessors({ subprocessorsByCategory: { cloud: many, contractor: many } }, 60),
    ).toThrow('10 社まで');
    expect(() =>
      parseSubprocessors({ subprocessorsByCategory: { ai: `${'あ'.repeat(61)}／役割` } }, 60),
    ).toThrow('60 文字以内');
    expect(() => parseSubprocessors({ subprocessorsByCategory: { cloud: '／保管' } }, 60)).toThrow(
      ValidationError,
    );
  });

  it('Demo Mode では JSON の合計を Cookie の検査と同じ上限で断る（戻らない行を作らない）', () => {
    const long = (i: number) =>
      [`${'名'.repeat(55)}${i}`, '役'.repeat(60), '所'.repeat(60), '根'.repeat(60)].join('／');
    const text = Array.from({ length: 10 }, (_, i) => long(i)).join('\n');
    expect(() =>
      parseSubprocessors({ subprocessorsByCategory: { contractor: text } }, 60, { demo: true }),
    ).toThrow(`${DEMO_SUBPROCESSORS_JSON_MAX.toLocaleString('ja-JP')} 文字まで`);
    // 本番（Supabase Mode）は合計を Cookie の都合で縛らない
    expect(
      parseSubprocessors({ subprocessorsByCategory: { contractor: text } }, 60, { demo: false }),
    ).toHaveLength(10);
  });
});

describe('この環境の外部の処理先と合意の突き合わせ', () => {
  it('Vercel 上・Supabase Mode・AI の API キーありから区分を決める（値は読まない）', () => {
    const processors = environmentProcessors(
      { VERCEL: '1' },
      { mode: 'supabase', aiConnected: true },
    );
    expect(processors.map((p) => `${p.category}:${p.name}`)).toEqual([
      'cloud:Vercel',
      'cloud:Supabase',
      'ai:OpenAI',
    ]);
    expect(environmentProcessors({}, { mode: 'demo', aiConnected: false })).toEqual([]);
  });

  it('本番のデモ（Vercel・環境変数なし）はホスティングだけ。合意にクラウドがあれば食い違いなし', () => {
    const env = environmentProcessors({ VERCEL: '1' }, { mode: 'demo', aiConnected: false });
    expect(env.map((p) => p.name)).toEqual(['Vercel']);
    const agreed = terms({
      subprocessors: [
        { category: 'cloud', name: 'C', role: '', location: '', confidentialityBasis: '条件' },
      ],
    });
    expect(processorMismatches(env, agreed)).toEqual([]);
  });

  it('環境が AI を使い、合意に AI サービス提供者が無ければ区分ごとに知らせる', () => {
    const env = environmentProcessors({ VERCEL: '1' }, { mode: 'supabase', aiConnected: true });
    const agreed = terms({
      subprocessors: [{ name: '（架空）保管', role: '保管', location: '国内' }],
    });
    expect(processorMismatches(env, agreed)).toEqual([
      'この環境は「クラウドサービス提供者」（Vercel・Supabase）を使っていますが、合意した処理先に「クラウドサービス提供者」がありません。',
      'この環境は「AI サービス提供者」（OpenAI）を使っていますが、合意した処理先に「AI サービス提供者」がありません。',
    ]);
    // 合意の版が無ければ、使っている区分はすべて合意に無い
    expect(processorMismatches(env, null)).toHaveLength(2);
    // 環境が外部の処理先を使っていなければ知らせない
    expect(processorMismatches([], null)).toEqual([]);
  });
});
