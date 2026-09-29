import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { buildReportExportCards, toDocx } from '@/lib/exports';
import { parseDocx } from '@/lib/imports/parsers';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { buildSsbjDocxSections } from '@/lib/services/disclosure';
import { confirmSsbjDraft, generateSsbjDraft, saveSsbjDraftBody } from '@/lib/services/ssbj-draft';
import {
  loadSsbjRequirementViews,
  runSsbjGapAnalysis,
  saveSsbjReview,
} from '@/lib/services/ssbj-gap';
import type {
  AuthorizationContext,
  MetricDefinition,
  ReportingPeriod,
  RoleKey,
} from '@/types/domain';

/**
 * SSBJ の「Word で書き出す」とレポート画面の出力カード（W0 棚卸し §2.2 の訂正事項）。
 *
 * - 以前の SSBJ の DOCX は要求事項ごとの回答（SSBJ には無い）を出しており、133 件すべてが
 *   「（未回答…）」の空欄だった。開示ドラフト画面の節別の本文を、確定／未確定を明記して出す。
 * - レポート画面の CDP カードが SSBJ カードの links に入れ子になって表示されず、
 *   CSRD の DOCX は経路があるのにリンクが無かった。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let period: ReportingPeriod;
let periods: ReportingPeriod[];
let metrics: MetricDefinition[];

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
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

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

/** 節の草案を書けるよう、その節の要求事項を確認済み・対応済みにする */
async function reviewArea(area: 'governance' | 'strategy', limit = 2): Promise<void> {
  const master = await loadSsbjRequirementViews(db, manager(), period);
  const targets = master!.views
    .filter((v) => v.area === area && v.assessment.applicability === 'applicable')
    .slice(0, limit);
  for (const view of targets) {
    await runSsbjGapAnalysis(db, manager(), view.assessment.id);
    await saveSsbjReview(db, manager(), {
      assessmentId: view.assessment.id,
      decision: 'modify',
      disclosureStatus: 'covered',
      dataStatus: 'covered',
      processStatus: 'covered',
      comment: '統合報告書の記載を確認しました（架空）。',
    });
  }
}

async function docxParagraphs(): Promise<string[]> {
  const built = await buildSsbjDocxSections(db, manager(), period, periods, metrics);
  expect(built).not.toBeNull();
  const bytes = await toDocx(built!.title, built!.sections);
  const parsed = await parseDocx(bytes);
  expect(parsed.status).toBe('parsed');
  return parsed.paragraphs;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
  period = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
  metrics = fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
});

describe('SSBJ の Word 出力: 節別ドラフトの本文を確定／未確定つきで出す', () => {
  it('草案が無いうちは節ごとに「未作成」と書き、要求事項 133 件の空欄を並べない', async () => {
    const paragraphs = await docxParagraphs();
    const text = paragraphs.join('\n');
    expect(text).toContain('ガバナンス（未作成）');
    expect(text).toContain('節の確定状況: 確定 0 / 5 節');
    expect(text).not.toContain('未回答');
    // 以前の出力（要求事項ごとの見出し【気候-47(1)】…）は出さない
    expect(text).not.toMatch(/【一般-7】/);
    // 企業内の確定を保証と誤認させない
    expect(text).toContain('第三者による保証ではありません');
  });

  it('確定した節は本文と「確定」、未確定の節は「未確定」、AI 草案のままなら Mock を明記', async () => {
    await reviewArea('governance');
    await reviewArea('strategy');
    const governance = await generateSsbjDraft(db, manager(), period, 'governance');
    const body = '取締役会はサステナビリティ委員会の報告を四半期ごとに受けています（架空）。';
    await saveSsbjDraftBody(db, manager(), governance.id, `${body}\n\n監督の頻度は年 4 回です。`);
    await confirmSsbjDraft(db, manager(), governance.id);
    const strategy = await generateSsbjDraft(db, manager(), period, 'strategy');

    const paragraphs = await docxParagraphs();
    const text = paragraphs.join('\n');

    // 確定した節: 人が直した本文がそのまま載り、確定者が分かる
    expect(paragraphs).toContain('ガバナンス（確定）');
    expect(paragraphs).toContain(body);
    expect(paragraphs).toContain('監督の頻度は年 4 回です。');
    const confirmer = fixture.profiles.find(
      (p) => p.id === userId('sustainability@demo.local'),
    )!.displayName;
    expect(text).toContain(`・確定者 ${confirmer}）`);
    expect(text).toMatch(/状態: 確定（\d{4}-\d{2}-\d{2} \d{2}:\d{2}・確定者 /);
    expect(text).toContain('節の確定状況: 確定 1 / 5 節');

    // 未確定の節: 下書きであることと、AI 草案のまま（Mock）であることを書く
    expect(paragraphs).toContain('戦略（未確定）');
    expect(text).toContain('状態: 未確定（下書き）');
    expect(text).toContain('デモ生成（Mock）');
    const firstStrategyLine = strategy.body
      .split(/\r?\n/)
      .find((l) => l.trim() !== '')!
      .trim();
    expect(paragraphs).toContain(firstStrategyLine);
  });

  it('定量指標は指標ごとの承認済みの値を並べ、値の無い指標は「値なし」と書く（0 と書かない）', async () => {
    const paragraphs = await docxParagraphs();
    const text = paragraphs.join('\n');
    expect(paragraphs).toContain('定量指標（承認済みの値）');
    // Scope3 絶対総量（気候-47(3)）は Scope3 合計に対応し、Cat.1 の値を載せない
    const idx = paragraphs.indexOf('気候-47(3)');
    expect(idx).toBeGreaterThan(-1);
    expect(paragraphs[idx + 1]).toBe('Scope3 排出量（合計）');
    expect(paragraphs[idx + 2]).toBe('値なし（承認済みの値がありません）');
    expect(text).toContain('異なる指標（Scope2 の 2 方式を含む）は足し合わせていません');
  });
});

describe('レポート画面の出力カード', () => {
  it('CDP は独立したカードで、どのカードの links にもカードが入れ子にならない', () => {
    const cards = buildReportExportCards('period-1');
    expect(cards.map((c) => c.title)).toEqual([
      '非財務データ台帳',
      'SSBJ 開示ドラフト',
      'CDP 回答一覧',
      'CSRD 開示ドラフト',
    ]);
    for (const card of cards) {
      for (const link of card.links) {
        expect(Object.keys(link).sort()).toEqual(['href', 'label']);
        expect(link.href).toMatch(/^\/api\/exports\//);
      }
    }
    const cdp = cards.find((c) => c.title === 'CDP 回答一覧')!;
    expect(cdp.links.map((l) => l.href)).toContain('/api/exports/cdp?period=period-1&format=docx');
  });

  it('CSRD の DOCX へのリンクがある', () => {
    const csrd = buildReportExportCards('period-1').find((c) => c.title === 'CSRD 開示ドラフト')!;
    expect(csrd.links.map((l) => l.href)).toContain(
      '/api/exports/cdp?framework=csrd&period=period-1&format=docx',
    );
  });
});
