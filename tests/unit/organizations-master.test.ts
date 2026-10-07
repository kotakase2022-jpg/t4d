import { describe, expect, it } from 'vitest';
import {
  formFailureFromRedirect,
  userFacingRedirectMessage,
} from '@/app/enterprise/organizations/_lib/form-adapter';
import { nextPeriodDefaults } from '@/app/enterprise/organizations/_lib/period-defaults';
import {
  campaignDefaults,
  filterMetrics,
  filterUnits,
  orderedUnits,
  sortMetrics,
} from '@/app/enterprise/organizations/_lib/master-tables';
import { orgTabHref, parseOrgTab } from '@/app/enterprise/organizations/_lib/tabs';
import type { MetricDefinition, OrganizationUnit, ReportingPeriod } from '@/types/domain';

/**
 * 組織・拠点（plan §2 S10）の画面の純関数。
 *  - 業務エラーの ?error= リダイレクトから理由を取り出し、入力を残したまま返す（既存の Action をそのまま呼ぶ）
 *  - 報告年度の既定値は最新の期間＋1 年（D12）
 *  - キャンペーンの既定値: 期間＝ヘッダー、期限＝提出期限、拠点＝連結対象、指標＝前回キャンペーン（S10）
 *  - 一覧の検索・絞り込み・並べ替え（DataTable はサーバー側で行う）
 */

function redirectError(url: string): Error & { digest: string } {
  return Object.assign(new Error('NEXT_REDIRECT'), {
    digest: `NEXT_REDIRECT;replace;${url};307;`,
  });
}

describe('業務エラーのリダイレクトから理由を取り出す', () => {
  it('?error= の付いたリダイレクトなら、その理由（復号した文）を返す', () => {
    const error = redirectError(
      `/enterprise/organizations?error=${encodeURIComponent('下限は上限以下にしてください。')}`,
    );
    expect(userFacingRedirectMessage(error)).toBe('下限は上限以下にしてください。');
  });

  it('理由の無いリダイレクト（ログインへの移動など）・通常の例外は扱わない', () => {
    expect(userFacingRedirectMessage(redirectError('/login'))).toBeNull();
    expect(userFacingRedirectMessage(new Error('boom'))).toBeNull();
    expect(userFacingRedirectMessage(null)).toBeNull();
  });

  it('理由と送った値を持った失敗の状態にする（入力を失わない）', () => {
    const form = new FormData();
    form.set('code', 'qa_metric');
    form.set('name', '検証用');
    const state = formFailureFromRedirect(
      redirectError(`/enterprise/organizations?error=${encodeURIComponent('重複しています')}`),
      form,
    );
    expect(state).toEqual({
      status: 'error',
      message: '重複しています',
      values: [
        ['code', 'qa_metric'],
        ['name', '検証用'],
      ],
    });
    expect(formFailureFromRedirect(new Error('boom'), form)).toBeNull();
  });
});

function period(code: string, label: string, start: string, end: string, due: string | null) {
  return {
    id: code,
    organizationId: 'org',
    code,
    label,
    startDate: start,
    endDate: end,
    status: 'closed',
    submissionDueDate: due,
    createdAt: '',
    updatedAt: '',
    createdBy: null,
    updatedBy: null,
  } as unknown as ReportingPeriod;
}

describe('報告年度の既定値（D12: 最新の期間＋1 年）', () => {
  it('コード・名称・開始・終了・提出期限を 1 年進める', () => {
    const periods = [
      period(
        'FY2025',
        '2025年度（2025-04-01〜2026-03-31）',
        '2025-04-01',
        '2026-03-31',
        '2026-06-30',
      ),
      period(
        'FY2026',
        '2026年度（2026-04-01〜2027-03-31）',
        '2026-04-01',
        '2027-03-31',
        '2027-06-30',
      ),
    ];
    expect(nextPeriodDefaults(periods)).toEqual({
      code: 'FY2027',
      label: '2027年度（2027-04-01〜2028-03-31）',
      startDate: '2027-04-01',
      endDate: '2028-03-31',
      submissionDueDate: '2028-06-30',
    });
  });

  it('うるう年の 2 月 29 日は 2 月 28 日に寄せる（存在しない日付を作らない）', () => {
    const periods = [period('FY2023', '2023年度', '2023-03-01', '2024-02-29', null)];
    expect(nextPeriodDefaults(periods)).toMatchObject({
      startDate: '2024-03-01',
      endDate: '2025-02-28',
      submissionDueDate: '',
    });
  });

  it('期間が 1 つも無ければ空（推測しない）', () => {
    expect(nextPeriodDefaults([])).toEqual({
      code: '',
      label: '',
      startDate: '',
      endDate: '',
      submissionDueDate: '',
    });
  });
});

function unit(
  id: string,
  parentId: string | null,
  extra: Partial<OrganizationUnit> = {},
): OrganizationUnit {
  return {
    id,
    organizationId: 'org',
    parentId,
    code: id.toUpperCase(),
    name: `${id} 拠点`,
    unitType: 'site',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'full',
    ownershipPercent: 100,
    exclusionReason: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ...extra,
  } as OrganizationUnit;
}

describe('組織・拠点の一覧', () => {
  const units = [
    unit('hq', null, { unitType: 'headquarters' }),
    unit('east', 'hq'),
    unit('sub', 'hq', { unitType: 'subsidiary', consolidationMethod: 'equity' }),
    unit('east-line', 'east'),
    unit('supplier', null, { unitType: 'supplier', consolidationMethod: 'excluded' }),
  ];

  it('階層の順（親の直後に子）に並べ、深さを持つ', () => {
    expect(orderedUnits(units).map((u) => [u.unit.id, u.depth])).toEqual([
      ['hq', 0],
      ['east', 1],
      ['east-line', 2],
      ['sub', 1],
      ['supplier', 0],
    ]);
  });

  it('名称・コードの検索と、種別・連結方法の絞り込み（階層の順は保つ）', () => {
    const rows = orderedUnits(units);
    expect(filterUnits(rows, { q: 'EAST' }).map((r) => r.unit.id)).toEqual(['east', 'east-line']);
    expect(filterUnits(rows, { type: ['subsidiary', 'supplier'] }).map((r) => r.unit.id)).toEqual([
      'sub',
      'supplier',
    ]);
    expect(filterUnits(rows, { consolidation: ['equity'] }).map((r) => r.unit.id)).toEqual(['sub']);
  });
});

function metric(code: string, extra: Partial<MetricDefinition> = {}): MetricDefinition {
  return {
    id: `m-${code}`,
    organizationId: 'org',
    code,
    name: `${code} の指標`,
    description: '',
    category: 'ghg',
    unit: 't-CO2e',
    baseUnit: 't-CO2e',
    dataType: 'number',
    aggregationMethod: 'sum',
    numeratorMetricCode: null,
    denominatorMetricCode: null,
    formula: null,
    requiresEvidence: false,
    hqOnly: false,
    frameworks: [],
    materiality: 'medium',
    reportingFrequency: 'annual',
    responsibleDepartment: null,
    yoyWarningRatio: null,
    minValue: null,
    maxValue: null,
    createdAt: '',
    updatedAt: '',
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ...extra,
  } as MetricDefinition;
}

describe('指標マスターの一覧', () => {
  const metrics = [
    metric('scope1', {
      frameworks: ['ssbj', 'cdp'],
      responsibleDepartment: 'サステナビリティ推進部',
    }),
    metric('water_use', {
      category: 'water',
      name: '取水量',
      responsibleDepartment: 'エネルギー管理部',
    }),
    metric('own_kpi', { category: 'governance', name: '独自の指標' }),
  ];

  it('コード・指標名で検索し、分類と基準（自社独自を含む）で絞り込む', () => {
    expect(filterMetrics(metrics, { q: '取水' }).map((m) => m.code)).toEqual(['water_use']);
    expect(filterMetrics(metrics, { q: 'SCOPE' }).map((m) => m.code)).toEqual(['scope1']);
    expect(
      filterMetrics(metrics, { category: ['water', 'governance'] }).map((m) => m.code),
    ).toEqual(['water_use', 'own_kpi']);
    expect(filterMetrics(metrics, { framework: ['own'] }).map((m) => m.code)).toEqual([
      'water_use',
      'own_kpi',
    ]);
    expect(filterMetrics(metrics, { framework: ['cdp'] }).map((m) => m.code)).toEqual(['scope1']);
  });

  it('並べ替えは列と向きを受け、知らない列は元の順のまま', () => {
    expect(sortMetrics(metrics, 'code', 'asc').map((m) => m.code)).toEqual([
      'own_kpi',
      'scope1',
      'water_use',
    ]);
    expect(sortMetrics(metrics, 'code', 'desc').map((m) => m.code)).toEqual([
      'water_use',
      'scope1',
      'own_kpi',
    ]);
    // 責任部署の無い指標は最後（空を先頭に並べない）
    expect(sortMetrics(metrics, 'department', 'asc').map((m) => m.code)).toEqual([
      'water_use',
      'scope1',
      'own_kpi',
    ]);
    expect(sortMetrics(metrics, 'unknown', 'asc').map((m) => m.code)).toEqual([
      'scope1',
      'water_use',
      'own_kpi',
    ]);
  });
});

describe('収集キャンペーンの既定値', () => {
  const units = [
    unit('hq', null, { unitType: 'headquarters' }),
    unit('east', 'hq'),
    unit('jv', 'hq', { consolidationMethod: 'excluded' }),
    unit('supplier', null, { unitType: 'supplier' }),
  ];
  const metrics = [metric('scope1'), metric('scope2'), metric('water')];
  const current = period('FY2026', '2026年度', '2026-04-01', '2027-03-31', '2027-06-30');

  it('期間＝ヘッダー、期限＝提出期限、拠点＝連結対象、指標＝前回のキャンペーン', () => {
    const defaults = campaignDefaults({
      currentPeriod: current,
      units,
      metrics,
      lastCampaignMetricIds: ['m-scope2', 'm-water', 'm-deleted'],
    });
    expect(defaults).toEqual({
      name: 'FY2026 収集キャンペーン',
      reportingPeriodId: 'FY2026',
      dueDate: '2027-06-30',
      unitIds: ['hq', 'east'],
      metricIds: ['m-scope2', 'm-water'],
    });
  });

  it('前回のキャンペーンが無ければ指標は選ばない（人が選ぶ）', () => {
    const defaults = campaignDefaults({
      currentPeriod: { ...current, submissionDueDate: null },
      units,
      metrics,
      lastCampaignMetricIds: [],
    });
    expect(defaults.metricIds).toEqual([]);
    expect(defaults.dueDate).toBe('');
  });
});

describe('タブ（?tab=）', () => {
  it('知らない値は組織・拠点、行き先はタブだけを持つ', () => {
    expect(parseOrgTab(undefined)).toBe('units');
    expect(parseOrgTab('metrics')).toBe('metrics');
    expect(parseOrgTab('nope')).toBe('units');
    expect(parseOrgTab(['periods'])).toBe('periods');
    expect(orgTabHref('units')).toBe('/enterprise/organizations?tab=units');
    expect(orgTabHref('metrics', { q: 'scope1' })).toBe(
      '/enterprise/organizations?tab=metrics&q=scope1',
    );
  });
});
