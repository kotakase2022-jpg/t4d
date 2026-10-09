import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  cdpOptionState,
  hasOption,
  isOptionActive,
  OPTION_NOT_CONTRACTED_MESSAGES,
} from '@/lib/services/organization-options';
import type { AuthorizationContext } from '@/types/domain';

/**
 * 契約で開く有償オプション（トライアル対応 NF-38 の中核）。
 * 画面・API・Action の停止は各スライスが int:cdp-option で確かめる。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function enterprise(email: string, organizationId: string): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys: ['enterprise_admin'],
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const aomi = () => enterprise('enterprise-admin@demo.local', ORG_IDS.aomi);
const soten = () => enterprise('other-enterprise-admin@demo.local', ORG_IDS.soten);

describe('hasOption', () => {
  it('Fixture: 実演の組織は CDP が有効、越権テスト用の組織は無効', async () => {
    expect(await hasOption(db, aomi(), 'cdp')).toBe(true);
    expect(await hasOption(db, soten(), 'cdp')).toBe(false);
    expect((await cdpOptionState(db, aomi())).state).toBe('contracted');
    expect((await cdpOptionState(db, soten())).state).toBe('not_contracted');
    expect(OPTION_NOT_CONTRACTED_MESSAGES.cdp).toContain('契約されていません');
  });

  it('行が無い・無効・期間外は契約なし（期間は日本時間の日付）', () => {
    expect(isOptionActive(null, '2026-10-09')).toBe(false);
    expect(isOptionActive({ enabled: false, validFrom: null, validTo: null }, '2026-10-09')).toBe(
      false,
    );
    const window = { enabled: true, validFrom: '2026-10-01', validTo: '2026-10-31' };
    expect(isOptionActive(window, '2026-09-30')).toBe(false);
    expect(isOptionActive(window, '2026-10-01')).toBe(true);
    expect(isOptionActive(window, '2026-10-31')).toBe(true);
    expect(isOptionActive(window, '2026-11-01')).toBe(false);
  });

  it('監査法人のワークスペースでは常に false', async () => {
    const base = aomi();
    const firm: AuthorizationContext = {
      ...base,
      workspace: {
        ...base.workspace,
        organizationId: ORG_IDS.aoba,
        organizationType: 'assurance_firm',
      },
    };
    expect(await hasOption(db, firm, 'cdp')).toBe(false);
  });

  it('組織の行が無ければ契約なし', async () => {
    fixture.organizationOptions = fixture.organizationOptions.filter(
      (o) => o.organizationId !== ORG_IDS.aomi,
    );
    expect(await hasOption(db, aomi(), 'cdp')).toBe(false);
  });
});
