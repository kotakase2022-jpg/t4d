import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import {
  dataTermsItems,
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
    const view = await loadDataTerms(db, admin());
    expect(view.current?.versionNo).toBe(1);
    const state = Object.fromEntries(view.items.map((i) => [i.item, i.state]));
    expect(state.ndaStatus).toBe('agreed');
    expect(state.aiTrainingUse).toBe('agreed');
    expect(state.storageLocation).toBe('not_agreed');
    expect(state.aiProviderStorage).toBe('not_agreed');
    expect(state.subprocessors).toBe('not_agreed');
    expect(state.agreement).toBe('not_agreed');
    expect(view.notAgreedCount).toBe(view.items.filter((i) => i.state === 'not_agreed').length);
    // 未合意の値は推測で埋めず「—」
    expect(view.items.find((i) => i.item === 'storageLocation')?.value).toBe('—');
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
    expect(terms.versionNo).toBe(2);
    expect(terms.subprocessors).toEqual([
      { name: '（架空）クラウド事業者', role: '保管', location: '国内' },
      { name: '（架空）AI 提供元', role: '推論', location: '米国' },
    ]);
    expect(JSON.stringify(fixture.organizationDataTerms.find((t) => t.id === before.id))).toBe(
      snapshot,
    );

    const view = await loadDataTerms(db, admin());
    expect(view.versions.map((v) => v.versionNo)).toEqual([2, 1]);
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
