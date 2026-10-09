import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  FY2025_APPROVED_SNAPSHOT_ID,
  TRIAL_XBRL_MAPPING_IDS,
  XBRL_SAMPLE_NAMESPACE,
  XBRL_SAMPLE_PREFIX,
} from '@/lib/fixtures/trial-case';
import { XBRL_SAMPLE_PACKAGE_ID } from '@/lib/fixtures/trial-ids';
import { renderBlockParagraphs } from '@/lib/exports/disclosure-report';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { asSnapshotDetail, createReviewDraftSnapshot } from '@/lib/services/report-snapshot';
import { XbrlExportError, exportXbrl, previewXbrl } from '@/lib/services/xbrl-export';
import {
  confirmMappings,
  deleteMapping,
  excludeMapping,
  loadXbrlTab,
  restoreMapping,
  saveFilingIdentifier,
  saveMapping,
  setFrameworkTaxonomy,
  suggestMappings,
} from '@/lib/services/xbrl-tagging';
import { textBlockValue } from '@/lib/xbrl/facts';
import { SAMPLE_TAXONOMY_NAMESPACE, SAMPLE_TAXONOMY_PREFIX } from '@/lib/xbrl/sample-taxonomy';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * XBRL Stage 1（トライアル対応 NF-42。plan §3.6 int:xbrl-export）。
 *
 * FY2025 の社内承認済みスナップショット（架空）と SAMPLE（架空）のタクソノミ・既定の対応付けから、
 * 書き込みなしで事実と検証を作り、社内確認用の出力（xBRL-JSON・iXBRL・照合表）を確かめる。
 */

// Route Handler の検査（セッションと DB は差し替える。サービスの検査は差し替えない）
const routeState: { ctx: AuthorizationContext | null; db: DemoDbClient | null } = {
  ctx: null,
  db: null,
};
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => (routeState.ctx ? { context: routeState.ctx } : null),
}));
vi.mock('@/lib/repositories', () => ({
  getDb: async () => routeState.db,
}));
const { GET } = await import('@/app/api/exports/xbrl/[snapshotId]/route');

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  routeState.db = db;
  routeState.ctx = null;
});

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const approver = () => ctxFor('approver@demo.local', ['approver']);
// 閲覧だけの役割（Demo の利用者に閲覧者がいないため、レビュー担当の利用者に閲覧の役割だけを持たせる）
const viewer = () => ctxFor('reviewer@demo.local', ['viewer']);
const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const otherTenant = () =>
  ctxFor(
    'other-enterprise-admin@demo.local',
    ['enterprise_admin', 'sustainability_manager'],
    ORG_IDS.soten,
  );

const exportJson = (ctx = author()) =>
  exportXbrl(db, ctx, {
    snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    format: 'xbrl_json',
    audience: 'internal',
  });

describe('SAMPLE のタクソノミ（Fixture と名前空間の一致）', () => {
  it('名前空間・接頭辞は Fixture と同じで、パッケージは提出用ではない', () => {
    expect(SAMPLE_TAXONOMY_NAMESPACE).toBe(XBRL_SAMPLE_NAMESPACE);
    expect(SAMPLE_TAXONOMY_PREFIX).toBe(XBRL_SAMPLE_PREFIX);
    const pkg = fixture.xbrlTaxonomyPackages.find((p) => p.id === XBRL_SAMPLE_PACKAGE_ID)!;
    expect(pkg.filingReady).toBe(false);
    expect(pkg.profile).toBe('sample');
  });
});

describe('FY2025 の承認済みスナップショットからの事実（書き込みなし）', () => {
  it('全事実が版・要求事項へ遡れ（追跡率 100%）、承認値・本文の表示と一致する', async () => {
    const guard = new WriteDetectingDbClient(db);
    const { evaluation, integrityOk } = await previewXbrl(guard, author(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    });
    expect(guard.writes).toEqual([]);
    expect(integrityOk).toBe(true);
    expect(evaluation).not.toBeNull();
    const { built, trace, validation } = evaluation!;
    // 確定済みの既定の対応付け 3 件（Scope1・ガバナンス・指標及び目標）。候補（Scope2）は事実にしない
    expect(built.facts.map((f) => f.mappingId).sort()).toEqual(
      [
        TRIAL_XBRL_MAPPING_IDS.scope1,
        TRIAL_XBRL_MAPPING_IDS.governance,
        TRIAL_XBRL_MAPPING_IDS.metricsTargets,
      ].sort(),
    );
    expect(built.facts.some((f) => f.mappingId === TRIAL_XBRL_MAPPING_IDS.scope2Candidate)).toBe(
      false,
    );
    expect(trace).toEqual({ traceable: 3, total: 3 });

    const snapshot = asSnapshotDetail(
      fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!,
    );
    for (const fact of built.facts) {
      expect(fact.requirements.length).toBeGreaterThan(0);
      if (fact.source.kind === 'metric') {
        const src = fact.source;
        const mv = snapshot.metricValues.find(
          (m) => m.dataPointVersionId === src.dataPointVersionId,
        )!;
        // 承認値と一致（t-CO2e → utr:tCO2e は 10^0）
        expect(mv.versionApproved).toBe(true);
        expect(Number(fact.value)).toBe(mv.value);
        expect(fact.unit?.measure).toBe('utr:tCO2e');
        expect(fact.contextId).toBe('CurrentYearDuration_SampleFinancialControlMember');
      } else {
        const src = fact.source;
        const block = snapshot.blocks.find((b) => b.blockId === src.blockId)!;
        expect(block.isApprovedVersion).toBe(true);
        // 本文の表示（出力と同じ文字列）と一致
        expect(fact.value).toBe(textBlockValue(renderBlockParagraphs(block, snapshot, 'internal')));
      }
    }
    // 検証: エラーなし。SAMPLE と架空の識別子は注記
    expect(validation.counts.error).toBe(0);
    expect(validation.blocking).toBe(false);
    expect(validation.byRule.V16).toBe('note');
    expect(validation.byRule.V11).toBe('note');
    expect(validation.byRule.V01).toBe('passed');
    expect(validation.byRule.V07).toBe('passed');
  });

  it('同じ入力なら内容ハッシュ・ファイルが一致する（別の評価でも）', async () => {
    const a = await previewXbrl(db, author(), { snapshotId: FY2025_APPROVED_SNAPSHOT_ID });
    const b = await previewXbrl(db, approver(), { snapshotId: FY2025_APPROVED_SNAPSHOT_ID });
    expect(a.evaluation!.contentHash).toBe(b.evaluation!.contentHash);
    const first = await exportJson();
    const second = await exportJson(approver());
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.artifact!.fileSha256).toBe(second.artifact!.fileSha256);
  });
});

describe('社内確認用の出力', () => {
  it('xBRL-JSON は提出用ではない注記・SAMPLE の名前空間を持ち、出力の記録にパッケージ・集合のハッシュ・検証の要約を残す', async () => {
    const before = fixture.exportArtifacts.length;
    const result = await exportJson();
    const doc = JSON.parse(new TextDecoder().decode(result.bytes)) as {
      documentInfo: Record<string, unknown> & { namespaces: Record<string, string> };
      facts: Record<string, { value: string; dimensions: Record<string, string> }>;
    };
    expect(doc.documentInfo.documentType).toBe('https://xbrl.org/2021/xbrl-json');
    expect(String(doc.documentInfo['t4d:notice'])).toContain('提出用ではありません');
    expect(doc.documentInfo['t4d:sampleTaxonomy']).toBe(true);
    expect(doc.documentInfo.namespaces[SAMPLE_TAXONOMY_PREFIX]).toBe(SAMPLE_TAXONOMY_NAMESPACE);
    const facts = Object.values(doc.facts);
    expect(facts).toHaveLength(3);
    const scope1 = facts.find((f) => f.dimensions.concept === 't4ds:SampleScope1GhgEmissions')!;
    expect(scope1.dimensions.period).toBe('2025-04-01T00:00:00/2026-04-01T00:00:00');
    expect(scope1.dimensions.unit).toBe('utr:tCO2e');
    expect(scope1.dimensions['t4ds:SampleGhgBoundaryAxis']).toBe(
      't4ds:SampleFinancialControlMember',
    );
    expect(result.fileName).toContain('社内確認用_提出用ではない');

    expect(fixture.exportArtifacts.length).toBe(before + 1);
    const artifact = fixture.exportArtifacts.at(-1)!;
    expect(artifact.format).toBe('xbrl_json');
    expect(artifact.audience).toBe('internal');
    expect(artifact.taxonomyPackageId).toBe(XBRL_SAMPLE_PACKAGE_ID);
    expect(artifact.mappingSetHash).toBe(result.mappingSetHash);
    expect(artifact.validationSummary).toMatchObject({ e: 0, facts: 3, traced: 3 });
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'export_created' && e.resourceId === FY2025_APPROVED_SNAPSHOT_ID,
      ),
    ).toBe(true);
  });

  it('iXBRL のプレビューは先頭に「提出用ではありません」の帯を置き、出力の記録を作らない（監査ログだけ）', async () => {
    const before = fixture.exportArtifacts.length;
    const result = await exportXbrl(db, author(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      format: 'ixbrl_html',
      audience: 'internal',
    });
    const html = new TextDecoder().decode(result.bytes);
    expect(result.inline).toBe(true);
    expect(result.artifact).toBeNull();
    expect(fixture.exportArtifacts.length).toBe(before);
    const banner = html.indexOf('data-t4d-not-filing-ready');
    expect(banner).toBeGreaterThan(0);
    expect(banner).toBeLessThan(html.indexOf('<ix:header>'));
    expect(html).toContain('提出用ではありません');
    expect(html).toMatch(/<ix:nonFraction[^>]*name="t4ds:SampleScope1GhgEmissions"[^>]*>1,240\.5</);
    expect(html).toMatch(
      /<ix:nonNumeric[^>]*name="t4ds:SampleGovernanceTextBlock"[^>]*escape="true"/,
    );
    expect(html).not.toMatch(/<script/i);

    // 保存用（download）は出力の記録を残す
    await exportXbrl(db, author(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      format: 'ixbrl_html',
      audience: 'internal',
      download: true,
    });
    expect(fixture.exportArtifacts.at(-1)!.format).toBe('ixbrl_html');
  });

  it('照合表（CSV）は事実 ID ⇄ 版 ID ⇄ 要求事項を並べ、出力の記録は作らない', async () => {
    const before = fixture.exportArtifacts.length;
    const result = await exportXbrl(db, author(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      format: 'trace_csv',
      audience: 'internal',
    });
    const csv = new TextDecoder().decode(result.bytes);
    expect(csv.split('\r\n')[0]).toContain('事実 ID');
    expect(csv).toContain('気候-47(1)');
    expect(csv).toContain('遡れる');
    expect(fixture.exportArtifacts.length).toBe(before);
  });

  it('対外用は断る・権限なしは 403 相当（ID より先）・他テナントは見つからない', async () => {
    await expect(
      exportXbrl(db, author(), {
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
        format: 'xbrl_json',
        audience: 'external',
      }),
    ).rejects.toBeInstanceOf(XbrlExportError);
    // 閲覧だけの人は出力できない（存在しない ID でも同じ応答）
    await expect(exportJson(viewer())).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      exportXbrl(db, viewer(), {
        snapshotId: '00000000-0000-4000-8000-000000000000',
        format: 'xbrl_json',
        audience: 'internal',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(exportJson(otherTenant())).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      previewXbrl(db, otherTenant(), { snapshotId: FY2025_APPROVED_SNAPSHOT_ID }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('検証のエラー（decimals なし）があれば出力を止め、直せば出せる', async () => {
    // 作成者が Scope1 の対応付けを変える（decimals を外す）→ 候補に戻る
    const mapping = fixture.xbrlTagMappings.find((m) => m.id === TRIAL_XBRL_MAPPING_IDS.scope1)!;
    const targetKey = `metric|${mapping.metricId}|${mapping.unitId}|${encodeURIComponent(mapping.boundary ?? '')}`;
    await saveMapping(db, author(), {
      projectId: IDS.projects.fy2025,
      mappingId: mapping.id,
      packageId: XBRL_SAMPLE_PACKAGE_ID,
      conceptId: mapping.conceptId,
      targetKey,
      disclosureItemId: mapping.disclosureItemId,
      periodRole: 'current',
      decimals: null,
      dimensions: mapping.dimensions,
    });
    const edited = fixture.xbrlTagMappings.find((m) => m.id === mapping.id)!;
    expect(edited.status).toBe('candidate');
    expect(edited.confirmedBy).toBeNull();
    // decimals が無い候補は確定できない（承認者でも）
    await expect(confirmMappings(db, approver(), { mappingIds: [mapping.id] })).rejects.toThrow(
      /decimals/,
    );
    // 承認権限と編集権限を持つ同一人物でも、最後に内容を変えた人は確定できない
    const both = ctxFor('sustainability@demo.local', ['sustainability_manager', 'approver']);
    await saveMapping(db, admin(), {
      projectId: IDS.projects.fy2025,
      mappingId: mapping.id,
      packageId: XBRL_SAMPLE_PACKAGE_ID,
      conceptId: mapping.conceptId,
      targetKey,
      disclosureItemId: mapping.disclosureItemId,
      periodRole: 'current',
      decimals: 1,
      dimensions: mapping.dimensions,
    });
    await expect(confirmMappings(db, admin(), { mappingIds: [mapping.id] })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(confirmMappings(db, both, { mappingIds: [mapping.id] })).rejects.toThrow(
      /作った人|変えた人/,
    );
    const confirmed = await confirmMappings(db, approver(), { mappingIds: [mapping.id] });
    expect(confirmed.confirmed).toHaveLength(1);
    expect(fixture.xbrlTagMappings.find((m) => m.id === mapping.id)!.confirmedBy).toBe(
      userId('approver@demo.local'),
    );
    const result = await exportJson();
    expect(result.validation.counts.error).toBe(0);
    // decimals を 1 にしたので精度の警告（V05）は消える
    expect(result.validation.byRule.V05).toBe('passed');
  });

  it('確定した Scope1 から decimals を外した状態の出力は止まる（確定済みの行を直接変えた場合）', async () => {
    const row = fixture.xbrlTagMappings.find((m) => m.id === TRIAL_XBRL_MAPPING_IDS.scope1)!;
    row.decimals = null;
    await expect(exportJson()).rejects.toMatchObject({ code: 'blocked' });
    const preview = await previewXbrl(db, author(), { snapshotId: FY2025_APPROVED_SNAPSHOT_ID });
    expect(preview.evaluation!.validation.byRule.V05).toBe('error');
  });
});

describe('対応付けの操作', () => {
  it('候補を承認者が確定すると事実の対象になる（本文に無い数値は V02 で事実にしない）', async () => {
    const result = await confirmMappings(db, approver(), {
      mappingIds: [TRIAL_XBRL_MAPPING_IDS.scope2Candidate],
    });
    expect(result.confirmed).toHaveLength(1);
    const { evaluation } = await previewXbrl(db, author(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    });
    // FY2025 の本文は Scope2 を引用していない → 事実を出さず V02（警告）
    expect(
      evaluation!.validation.findings.some(
        (f) => f.rule === 'V02' && f.mappingId === TRIAL_XBRL_MAPPING_IDS.scope2Candidate,
      ),
    ).toBe(true);
    expect(evaluation!.built.facts).toHaveLength(3);
    expect(fixture.auditEvents.some((e) => e.eventType === 'xbrl_mapping_confirmed')).toBe(true);
    expect(
      fixture.xbrlTagMappingEvents.some(
        (e) => e.mappingId === TRIAL_XBRL_MAPPING_IDS.scope2Candidate && e.event === 'confirmed',
      ),
    ).toBe(true);
  });

  it('対象外は理由必須。取り消すと候補に戻り、削除すると一覧から消える', async () => {
    const id = TRIAL_XBRL_MAPPING_IDS.scope2Candidate;
    await expect(excludeMapping(db, author(), { mappingId: id, reason: '  ' })).rejects.toThrow(
      /理由/,
    );
    await expect(
      excludeMapping(db, approver(), { mappingId: id, reason: '前年は開示しない' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await excludeMapping(db, author(), { mappingId: id, reason: '本文で引用しないため' });
    expect(fixture.xbrlTagMappings.find((m) => m.id === id)!.status).toBe('excluded');
    await restoreMapping(db, author(), { mappingId: id });
    expect(fixture.xbrlTagMappings.find((m) => m.id === id)!.status).toBe('candidate');
    await deleteMapping(db, author(), { mappingId: id });
    const tab = await loadXbrlTab(db, author(), { projectId: IDS.projects.fy2025 });
    expect(tab.rows.some((r) => r.mapping?.id === id)).toBe(false);
    // 他テナントからは見つからない
    await expect(
      excludeMapping(db, otherTenant(), {
        mappingId: TRIAL_XBRL_MAPPING_IDS.scope1,
        reason: '他社',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('保存の検査: 重複・型の合わない概念・パッケージに無い軸を断り、新しい対応付けは候補で入る', async () => {
    const governance = fixture.xbrlTagMappings.find(
      (m) => m.id === TRIAL_XBRL_MAPPING_IDS.governance,
    )!;
    const blockKey = `block|${governance.frameworkVersionId}|${encodeURIComponent('governance')}`;
    const base = {
      projectId: IDS.projects.fy2025,
      packageId: XBRL_SAMPLE_PACKAGE_ID,
      targetKey: blockKey,
      disclosureItemId: null,
      periodRole: 'current' as const,
      decimals: null,
      dimensions: {},
    };
    // 同じ節・同じ概念は重ねない
    await expect(
      saveMapping(db, author(), { ...base, conceptId: governance.conceptId }),
    ).rejects.toThrow(/既にあります/);
    // 節を数値の概念に
    await expect(
      saveMapping(db, author(), {
        ...base,
        conceptId: fixture.xbrlConcepts.find((c) => c.localName === 'SampleScope1GhgEmissions')!.id,
      }),
    ).rejects.toThrow(/文章の概念/);
    // パッケージに無い軸
    await expect(
      saveMapping(db, author(), {
        ...base,
        conceptId: fixture.xbrlConcepts.find((c) => c.localName === 'SampleStrategyTextBlock')!.id,
        dimensions: { NoSuchAxis: 'SampleConsolidatedMember' },
      }),
    ).rejects.toThrow(/軸/);
    // 閲覧だけの人は書けない
    await expect(
      saveMapping(db, viewer(), {
        ...base,
        conceptId: fixture.xbrlConcepts.find((c) => c.localName === 'SampleStrategyTextBlock')!.id,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const created = await saveMapping(db, author(), {
      ...base,
      conceptId: fixture.xbrlConcepts.find((c) => c.localName === 'SampleStrategyTextBlock')!.id,
    });
    expect(created).toMatchObject({ status: 'candidate', origin: 'human', confirmedBy: null });
    expect(
      fixture.xbrlTagMappingEvents.some((e) => e.mappingId === created.id && e.event === 'created'),
    ).toBe(true);
    expect(fixture.auditEvents.some((e) => e.eventType === 'xbrl_mapping_changed')).toBe(true);
  });

  it('タブの表示は書き込みをせず、件数と未対応付けの対象を出す', async () => {
    const guard = new WriteDetectingDbClient(db);
    const tab = await loadXbrlTab(guard, author(), { projectId: IDS.projects.fy2025 });
    expect(guard.writes).toEqual([]);
    expect(tab.pkg?.isSample).toBe(true);
    expect(tab.counts).toMatchObject({ confirmed: 3, candidate: 1, excluded: 0, mappings: 4 });
    // 対象＝節 2＋本文の数値 1。すべて対応付け済み
    expect(tab.counts.targets).toBe(3);
    expect(tab.counts.unmapped).toBe(0);
    expect(tab.entity?.isSample).toBe(true);
  });

  it('AI の候補は候補の行として入り、自動では確定しない（事実にならない）', async () => {
    // FY2026 のレビュー用草稿を作り、未対応付けの節に候補を出させる
    await createReviewDraftSnapshot(db, author(), IDS.projects.fy2026);
    const result = await suggestMappings(db, author(), { projectId: IDS.projects.fy2026 });
    expect(result.provider).toBe('mock');
    // Mock は語句の重なりで決定論的に候補を出す（節「ガバナンス」→（サンプル）ガバナンス［テキストブロック］など）
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => /サンプル|架空/.test(w))).toBe(true);
    for (const row of result.created) {
      expect(row.status).toBe('candidate');
      expect(row.origin).toBe('ai_adopted');
      expect(row.aiRunId).toBe(result.runId);
      expect(row.confirmedBy).toBeNull();
    }
    const tab = await loadXbrlTab(db, author(), { projectId: IDS.projects.fy2026 });
    const factMappingIds = new Set(tab.evaluation?.built.facts.map((f) => f.mappingId) ?? []);
    for (const row of result.created) expect(factMappingIds.has(row.id)).toBe(false);
    // 候補を出させた人は確定できない（承認権限を兼ねていても）
    const both = ctxFor('sustainability@demo.local', ['sustainability_manager', 'approver']);
    await expect(
      confirmMappings(db, both, { mappingIds: result.created.map((r) => r.id) }),
    ).rejects.toThrow(/作った人/);
  });

  it('基準のタクソノミを外すと出力できない（設定し直すと戻る）', async () => {
    await setFrameworkTaxonomy(db, author(), {
      projectId: IDS.projects.fy2025,
      projectFrameworkId: IDS.projectFrameworks.fy2025Ssbj,
      packageId: null,
    });
    await expect(exportJson()).rejects.toMatchObject({ code: 'no_package' });
    await setFrameworkTaxonomy(db, author(), {
      projectId: IDS.projects.fy2025,
      projectFrameworkId: IDS.projectFrameworks.fy2025Ssbj,
      packageId: XBRL_SAMPLE_PACKAGE_ID,
    });
    await expect(exportJson()).resolves.toBeTruthy();
    // 基準に合わないパッケージ（ESRS-40a に SSBJ 用の SAMPLE）は断る
    await expect(
      setFrameworkTaxonomy(db, author(), {
        projectId: IDS.projects.fy2026,
        projectFrameworkId: IDS.projectFrameworks.fy2026Esrs40a,
        packageId: XBRL_SAMPLE_PACKAGE_ID,
      }),
    ).rejects.toThrow(/タクソノミ/);
  });

  it('提出者の識別子: デモは架空（sample）だけ・管理者だけ', async () => {
    await expect(
      saveFilingIdentifier(db, admin(), { scheme: 'edinet_code', value: 'E12345' }),
    ).rejects.toThrow(/サンプル/);
    await expect(
      saveFilingIdentifier(db, author(), { scheme: 'sample', value: 'SAMPLE-AOMI-0002' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      saveFilingIdentifier(db, admin(), { scheme: 'sample', value: 'not-sample' }),
    ).rejects.toThrow(/形式/);
    const saved = await saveFilingIdentifier(db, admin(), {
      scheme: 'sample',
      value: 'SAMPLE-AOMI-0002',
    });
    expect(saved.value).toBe('SAMPLE-AOMI-0002');
    const { evaluation } = await previewXbrl(db, author(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    });
    expect(evaluation!.built.entity.value).toBe('SAMPLE-AOMI-0002');
  });
});

describe('XBRL 出力の Route Handler', () => {
  const project = IDS.projects.fy2025;

  async function call(snapshotId: string, query: string) {
    return GET(new Request(`http://localhost/api/exports/xbrl/${snapshotId}?${query}`), {
      params: Promise.resolve({ snapshotId }),
    });
  }

  it('xBRL-JSON はファイル、iXBRL のプレビューはスクリプトを禁止した inline で返す', async () => {
    routeState.ctx = author();
    const json = await call(FY2025_APPROVED_SNAPSHOT_ID, 'format=xbrl_json');
    expect(json.status).toBe(200);
    expect(json.headers.get('Content-Type')).toContain('application/json');
    expect(json.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(json.headers.get('X-T4D-Content-Hash')).toMatch(/^[0-9a-f]{64}$/);

    const preview = await call(FY2025_APPROVED_SNAPSHOT_ID, 'format=ixbrl_html');
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Content-Disposition')).toMatch(/^inline;/);
    expect(preview.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(preview.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await preview.text()).toContain('提出用ではありません');
  });

  it('他テナント・存在しない ID は同じ 404、権限なしは 403、未ログインは 401、未対応の形式・対外用は 400', async () => {
    routeState.ctx = otherTenant();
    const other = await call(FY2025_APPROVED_SNAPSHOT_ID, 'format=xbrl_json');
    routeState.ctx = author();
    const missing = await call('00000000-0000-4000-8000-000000000000', 'format=xbrl_json');
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());

    routeState.ctx = viewer();
    expect((await call(FY2025_APPROVED_SNAPSHOT_ID, 'format=xbrl_json')).status).toBe(403);
    expect(fixture.auditEvents.some((e) => e.eventType === 'access_denied')).toBe(true);
    routeState.ctx = null;
    expect((await call(FY2025_APPROVED_SNAPSHOT_ID, 'format=xbrl_json')).status).toBe(401);
    routeState.ctx = author();
    expect((await call(FY2025_APPROVED_SNAPSHOT_ID, 'format=pdf')).status).toBe(400);
    expect(
      (await call(FY2025_APPROVED_SNAPSHOT_ID, 'format=xbrl_json&audience=external')).status,
    ).toBe(400);
  });

  it('画面のリンク（project 付き）で止まったら、XBRL タブへ理由の符号で戻す（検証のエラー・見つからない）', async () => {
    routeState.ctx = author();
    fixture.xbrlTagMappings.find((m) => m.id === TRIAL_XBRL_MAPPING_IDS.scope1)!.decimals = null;
    const blocked = await call(FY2025_APPROVED_SNAPSHOT_ID, `format=xbrl_json&project=${project}`);
    expect(blocked.status).toBe(303);
    const location = new URL(blocked.headers.get('Location') ?? '');
    expect(location.pathname).toBe(`/enterprise/disclosure-projects/${project}`);
    expect(location.searchParams.get('tab')).toBe('xbrl');
    expect(location.searchParams.get('xbrlError')).toBe('blocked');
    // project が無ければ JSON（検証のエラーは 422）
    expect((await call(FY2025_APPROVED_SNAPSHOT_ID, 'format=xbrl_json')).status).toBe(422);
    // project が UUID でなければ戻り先に使わない
    const forged = await call(
      '00000000-0000-4000-8000-000000000000',
      'format=xbrl_json&project=https://evil.example',
    );
    expect(forged.status).toBe(404);
  });
});
