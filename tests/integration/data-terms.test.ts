import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import {
  dataTermsItems,
  DATA_TERMS_ITEM_LABELS,
  loadDataTerms,
  recordDataTermsVersion,
  systemFacts,
  type RecordDataTermsInput,
} from '@/lib/services/data-terms';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * データ取扱条件（トライアル対応 NF-28・plan int:data-terms）。
 *
 *  - 未合意の項目は「未合意」（空・未定・NDA 未締結）。推測で埋めない
 *  - 版は追記（前の版は残る）。記録は組織の管理（enterprise.org.manage）だけ
 *  - システムの実態は設定から読み、Secret の値を出さない
 */

let fixture: FixtureDb;
let db: DemoDbClient;

function enterprise(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () => enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
const manager = () => enterprise('sustainability@demo.local', ['sustainability_manager']);

function input(overrides: Partial<RecordDataTermsInput> = {}): RecordDataTermsInput {
  return {
    ndaStatus: 'signed',
    processingTermsRef: '（架空）データ処理条件 v1.0',
    storageLocation: '国内リージョン（架空）',
    retentionPolicy: '',
    aiTrainingUse: 'not_allowed',
    aiProviderStorage: 'none',
    subprocessorsText: '（架空）クラウド事業者／保管／国内\n（架空）AI 提供元／推論／米国',
    returnMethod: 'CSV と manifest',
    deletionMethod: '',
    agreedOn: '2026-10-01',
    agreedByLabel: '（架空）情報システム部長',
    note: '',
    ...overrides,
  };
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('未合意の表示', () => {
  it('Fixture の第 1 版は、空・未定の項目を「未合意」にし、合意済みの項目と分ける', async () => {
    // 現在の版は第 2 版（処理を委ねる先を区分ごとに記載した架空の版。合意の手続きは確認中）。
    // 第 1 版は追記専用の記録として残る
    const view = await loadDataTerms(db, admin());
    expect(view.current?.versionNo).toBe(2);
    const currentState = Object.fromEntries(view.items.map((i) => [i.item, i.state]));
    expect(currentState.subprocessors).toBe('agreed');
    expect(currentState.agreement).toBe('not_agreed');
    expect(view.notAgreedCount).toBeGreaterThan(0);
    const first = fixture.organizationDataTerms.find(
      (t) => t.organizationId === ORG_IDS.aomi && t.versionNo === 1,
    )!;
    const firstItems = dataTermsItems(first);
    const state = Object.fromEntries(firstItems.map((i) => [i.item, i.state]));
    expect(state.ndaStatus).toBe('agreed');
    expect(state.aiTrainingUse).toBe('agreed');
    expect(state.storageLocation).toBe('not_agreed');
    expect(state.aiProviderStorage).toBe('not_agreed');
    expect(state.subprocessors).toBe('not_agreed');
    expect(state.agreement).toBe('not_agreed');
    expect(view.notAgreedCount).toBe(view.items.filter((i) => i.state === 'not_agreed').length);
    // 未合意の値は推測で埋めず「—」
    expect(firstItems.find((i) => i.item === 'storageLocation')?.value).toBe('—');
  });

  it('記録が 1 件も無い組織は全項目が未合意', () => {
    const items = dataTermsItems(null);
    expect(items.every((i) => i.state === 'not_agreed')).toBe(true);
  });

  it('システムの実態は設定から読み、API キーの値を出さない', () => {
    const facts = systemFacts();
    expect(facts.map((f) => f.label)).toContain('AI の提供元での保存の指定');
    const text = facts.map((f) => f.value).join('\n');
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    // 保管場所は推測で出さない
    expect(facts.find((f) => f.label === 'データの保管場所')?.value).toContain('表示しません');
  });
});

describe('版の記録', () => {
  it('新しい版を追記し、前の版は残る。監査ログに残す', async () => {
    const before = fixture.organizationDataTerms.find((t) => t.organizationId === ORG_IDS.aomi)!;
    const snapshot = JSON.stringify(before);
    const terms = await recordDataTermsVersion(db, admin(), input());
    // Fixture は第 1 版・第 2 版を持つ。新しい版は第 3 版
    expect(terms.versionNo).toBe(3);
    // 区分の無い以前の 1 欄の入力は「その他」・秘密保持の根拠なし（未合意）として記録する（推測で区分を決めない）
    expect(terms.subprocessors).toEqual([
      {
        category: 'other',
        name: '（架空）クラウド事業者',
        role: '保管',
        location: '国内',
        confidentialityBasis: '',
      },
      {
        category: 'other',
        name: '（架空）AI 提供元',
        role: '推論',
        location: '米国',
        confidentialityBasis: '',
      },
    ]);
    expect(JSON.stringify(fixture.organizationDataTerms.find((t) => t.id === before.id))).toBe(
      snapshot,
    );

    const view = await loadDataTerms(db, admin());
    expect(view.versions.map((v) => v.versionNo)).toEqual([3, 2, 1]);
    const state = Object.fromEntries(view.items.map((i) => [i.item, i.state]));
    expect(state.retentionPolicy).toBe('not_agreed');
    expect(state.deletionMethod).toBe('not_agreed');
    expect(state.agreement).toBe('agreed');
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'settings_changed' && e.resourceType === 'organization_data_terms',
      ),
    ).toBe(true);
  });

  it('組織の管理の権限が無い人は読めない・記録できない', async () => {
    await expect(loadDataTerms(db, manager())).rejects.toBeInstanceOf(AuthorizationError);
    await expect(recordDataTermsVersion(db, manager(), input())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('選択肢に無い値・形の誤った合意日・Demo の上限を超える本文・11 社以上の再委託先は記録しない', async () => {
    const count = fixture.organizationDataTerms.length;
    await expect(
      recordDataTermsVersion(db, admin(), input({ aiTrainingUse: 'sometimes' })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordDataTermsVersion(db, admin(), input({ agreedOn: '2026/10/01' })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordDataTermsVersion(
        db,
        admin(),
        input({ retentionPolicy: 'あ'.repeat(DEMO_TEXT_LIMITS.trialText + 1) }),
      ),
    ).rejects.toThrow(`${DEMO_TEXT_LIMITS.trialText} 文字以内`);
    await expect(
      recordDataTermsVersion(
        db,
        admin(),
        input({
          subprocessorsText: Array.from({ length: 11 }, (_, i) => `社${i}／役割／所在`).join('\n'),
        }),
      ),
    ).rejects.toThrow('10 社まで');
    expect(fixture.organizationDataTerms.length).toBe(count);
  });
});

describe('処理を委ねる先の区分・秘密保持の根拠（2026-10-16 の要望 ⑥）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('区分ごとの欄を区分と根拠つきで記録し、表は区分の順・AI の行だけ再学習の語', async () => {
    await recordDataTermsVersion(
      db,
      admin(),
      input({
        subprocessorsText: '',
        subprocessorsByCategory: {
          ai: '（架空）AI 提供元／候補の生成／（架空）提供元の地域／（架空）約款',
          cloud: '（架空）クラウド事業者／保管／（架空）国内／（架空）データ処理条件',
          contractor: '（架空）運用の委託先／運用の一部／（架空）国内',
        },
      }),
    );
    const view = await loadDataTerms(db, admin());
    expect(view.processors.map((r) => [r.category, r.name, r.basisState, r.aiTraining])).toEqual([
      ['contractor', '（架空）運用の委託先', 'not_agreed', null],
      ['cloud', '（架空）クラウド事業者', 'agreed', null],
      ['ai', '（架空）AI 提供元', 'agreed', '再学習に使わない'],
    ]);
    expect(view.items.find((i) => i.item === 'subprocessors')!.label).toBe(
      DATA_TERMS_ITEM_LABELS.subprocessors,
    );
  });

  it('Fixture の第 2 版は区分ごとに 1 社ずつ。第 1 版（区分なし）は表に出さず、読むときは「その他」に読み替える', async () => {
    const view = await loadDataTerms(db, admin());
    expect(view.current?.versionNo).toBe(2);
    expect(view.processors.map((r) => r.category)).toEqual(['contractor', 'cloud', 'ai']);
    expect(view.processors.every((r) => r.basisState === 'agreed')).toBe(true);
  });

  it('環境の外部の処理先: 本番のデモ（Vercel・環境変数なし）はホスティングだけで、合意のクラウドと食い違わない', async () => {
    const view = await loadDataTerms(db, admin(), { VERCEL: '1' });
    expect(view.environment.map((p) => p.name)).toEqual(['Vercel']);
    expect(view.mismatches).toEqual([]);
    const facts = systemFacts({ VERCEL: '1' });
    expect(facts.find((f) => f.label === 'この環境が使う外部の処理先')?.value).toContain('Vercel');
  });

  it('環境に AI の API キーがあり、合意に AI サービス提供者が無ければ知らせる（キーの値は出さない）', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-placeholder-not-a-key');
    await recordDataTermsVersion(
      db,
      admin(),
      input({
        subprocessorsText: '',
        subprocessorsByCategory: { cloud: '（架空）クラウド事業者／保管／国内／（架空）条件' },
      }),
    );
    const view = await loadDataTerms(db, admin(), {});
    expect(view.environment.map((p) => p.category)).toEqual(['ai']);
    expect(view.mismatches).toEqual([
      'この環境は「AI サービス提供者」（OpenAI）を使っていますが、合意した処理先に「AI サービス提供者」がありません。',
    ]);
    const text = systemFacts({})
      .map((f) => f.value)
      .join('\n');
    expect(text).not.toContain('test-placeholder-not-a-key');
  });

  it('処理を委ねる先は合計 10 社まで（区分をまたいで数える）。Demo の各項目は 60 字まで', async () => {
    const count = fixture.organizationDataTerms.length;
    const six = Array.from({ length: 6 }, (_, i) => `社${i}／役割／所在`).join('\n');
    await expect(
      recordDataTermsVersion(
        db,
        admin(),
        input({ subprocessorsText: '', subprocessorsByCategory: { cloud: six, ai: six } }),
      ),
    ).rejects.toThrow('10 社まで');
    await expect(
      recordDataTermsVersion(
        db,
        admin(),
        input({
          subprocessorsText: '',
          subprocessorsByCategory: { cloud: `${'あ'.repeat(61)}／保管` },
        }),
      ),
    ).rejects.toThrow('60 文字以内');
    expect(fixture.organizationDataTerms.length).toBe(count);
  });
});

describe('バックアップの残存期間（2026-10-16 の要望 ⑦。0060）', () => {
  it('0〜400 の整数を記録する。空は未合意。入力が無い呼び出しは前の版の合意値を引き継ぐ', async () => {
    const zero = await recordDataTermsVersion(db, admin(), input({ backupResidualDays: '0' }));
    expect(zero.backupResidualDays).toBe(0);
    const max = await recordDataTermsVersion(db, admin(), input({ backupResidualDays: 400 }));
    expect(max.backupResidualDays).toBe(400);
    const carried = await recordDataTermsVersion(db, admin(), input());
    expect(carried.backupResidualDays).toBe(400);
    const cleared = await recordDataTermsVersion(db, admin(), input({ backupResidualDays: '' }));
    expect(cleared.backupResidualDays).toBeNull();
    const view = await loadDataTerms(db, admin());
    expect(view.items.find((i) => i.item === 'backupResidualDays')!.state).toBe('not_agreed');
    expect(view.residualText).toContain('残存期間は未合意です');
  });

  it('範囲外・整数でない値は記録しない', async () => {
    const count = fixture.organizationDataTerms.length;
    for (const value of ['401', '-1', '1.5', '三十']) {
      await expect(
        recordDataTermsVersion(db, admin(), input({ backupResidualDays: value })),
      ).rejects.toThrow('0〜400 の整数');
    }
    expect(fixture.organizationDataTerms.length).toBe(count);
  });

  it('Fixture の第 2 版の合意値（架空の 35 日）を表と固定の文に出す', async () => {
    const view = await loadDataTerms(db, admin());
    expect(view.items.find((i) => i.item === 'backupResidualDays')).toMatchObject({
      value: '35 日',
      state: 'agreed',
    });
    expect(view.residualText).toContain('合意: 35 日');
    expect(view.residualText).toContain('それまで秘密情報として管理します');
  });
});
