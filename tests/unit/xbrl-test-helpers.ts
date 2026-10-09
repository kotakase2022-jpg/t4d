import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { FY2025_APPROVED_SNAPSHOT_ID, TRIAL_XBRL_MAPPING_IDS } from '@/lib/fixtures/trial-case';
import { XBRL_SAMPLE_PACKAGE_ID, xbrlSampleConceptId } from '@/lib/fixtures/trial-ids';
import { asSnapshotDetail, type ReportSnapshotDetail } from '@/lib/domain/report-snapshot-content';
import { entityFor } from '@/lib/xbrl/context';
import type { FactBuildInput } from '@/lib/xbrl/facts';
import { buildTaxonomyPackage, type TaxonomyPackage } from '@/lib/xbrl/taxonomy';
import type { XbrlTagMapping } from '@/types/domain';

/**
 * XBRL の unit テストの材料（架空の Fixture から作る）。FY2025 の社内承認済みスナップショット・SAMPLE の
 * パッケージ・既定の対応付けを複製して渡す（テストごとに書き換えてよい）。
 */
export interface XbrlScenario {
  fixture: FixtureDb;
  snapshot: ReportSnapshotDetail;
  pkg: TaxonomyPackage;
  mappings: XbrlTagMapping[];
  input: FactBuildInput;
}

export function xbrlScenario(): XbrlScenario {
  const fixture = createFixtureDb();
  const row = fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!;
  const snapshot = structuredClone(asSnapshotDetail(row));
  const pkgRow = fixture.xbrlTaxonomyPackages.find((p) => p.id === XBRL_SAMPLE_PACKAGE_ID)!;
  const pkg = buildTaxonomyPackage(pkgRow, fixture.xbrlConcepts);
  const mappings = structuredClone(fixture.xbrlTagMappings);
  const identifiers = fixture.organizationFilingIdentifiers.filter(
    (i) => i.organizationId === row.organizationId,
  );
  const frameworkVersionId = snapshot.frameworkVersions[0]!.frameworkVersionId;
  return {
    fixture,
    snapshot,
    pkg,
    mappings,
    input: {
      snapshot,
      frameworkVersionId,
      pkg,
      mappings,
      entity: entityFor(pkg.profile, identifiers),
    },
  };
}

export function mappingOf(scenario: XbrlScenario, id: string): XbrlTagMapping {
  const found = scenario.mappings.find((m) => m.id === id);
  if (!found) throw new Error(`mapping ${id} not found`);
  return found;
}

export const scope1Of = (s: XbrlScenario) => mappingOf(s, TRIAL_XBRL_MAPPING_IDS.scope1);
export const governanceOf = (s: XbrlScenario) => mappingOf(s, TRIAL_XBRL_MAPPING_IDS.governance);
export const scope2Of = (s: XbrlScenario) => mappingOf(s, TRIAL_XBRL_MAPPING_IDS.scope2Candidate);
export const conceptId = xbrlSampleConceptId;
