import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeDemoEdits,
  encodeDemoEdits,
  type DemoEdit,
} from '../../src/lib/repositories/demo-edit-codec';

/**
 * Demo Mode の変更差分を Cookie へ収める符号化。
 *
 * 本番（Vercel）では取込結果がこの Cookie に載るかどうかで、
 * 画面が「プレビューが出る」か「保持できませんでした」かに分かれる。
 * 容量はここで担保する。
 */

/** Cookie に載せる実サイズの上限（demo-persistence.ts と同じ値） */
const MAX_BYTES = 3800;

function ingestionRow(job: JobIds, i: number): DemoEdit {
  // 実データに合わせる: 行 ID は edit.id と v.id で同じ値、
  // 指標・単位はごく少数の中から選ばれ、aiRunId はジョブで 1 つ。
  const rowId = randomUUID();
  const sites = ['Werk Nord', '東日本工場', 'Site de Lyon', 'Planta Norte', '华东工厂'];
  const metrics = ['Stromverbrauch', '電力使用量', "Consommation d'eau", 'Residuos', '用电量'];
  return {
    t: 'ingestionRows',
    id: rowId,
    v: {
      id: rowId,
      jobId: job.jobId,
      jobFileId: job.fileId,
      organizationId: job.orgId,
      rowIndex: i,
      raw: {
        拠点: sites[i % sites.length],
        項目: metrics[i % metrics.length],
        値: String(1000 + i * 37.5),
        単位: 'kWh',
        期間: 'FY2026',
      },
      metricId: job.metricIds[i % job.metricIds.length],
      unitId: job.unitIds[i % job.unitIds.length],
      reportingPeriodId: job.periodId,
      value: 1000 + i * 37.5,
      unitOfMeasure: 'kWh',
      confidence: 0.6 + (i % 4) / 10,
      warnings: i % 3 === 0 ? ['単位が推定です'] : [],
      status: 'mapped',
      sourceLocator: `row ${i + 2}`,
      duplicateOfDataPointId: null,
      aiRunId: job.aiRunId,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    },
  };
}

interface JobIds {
  jobId: string;
  fileId: string;
  orgId: string;
  periodId: string;
  aiRunId: string;
  metricIds: string[];
  unitIds: string[];
}

function ingestionJob(rows: number): DemoEdit[] {
  const job: JobIds = {
    jobId: randomUUID(),
    fileId: randomUUID(),
    orgId: randomUUID(),
    periodId: randomUUID(),
    aiRunId: randomUUID(),
    metricIds: Array.from({ length: 6 }, () => randomUUID()),
    unitIds: Array.from({ length: 4 }, () => randomUUID()),
  };
  return Array.from({ length: rows }, (_, i) => ingestionRow(job, i));
}

describe('Demo Mode の変更差分の符号化', () => {
  it('往復して同じ内容に戻る', () => {
    const edits = ingestionJob(3);
    expect(decodeDemoEdits(encodeDemoEdits(edits))).toEqual(edits);
  });

  it('入れ子・null・数値・配列・日本語をそのまま保つ', () => {
    const edits: DemoEdit[] = [
      {
        t: 'materialityTopics',
        id: 'topic-1',
        v: {
          materiality: 'high',
          rationale: '主要製品の製造工程がエネルギー多消費型であるため。',
          warnings: [],
          nested: { a: [1, 2, null], b: { c: '深い階層の日本語' } },
          ratio: 0.4235,
          flag: false,
          missing: null,
        },
      },
    ];
    expect(decodeDemoEdits(encodeDemoEdits(edits))).toEqual(edits);
  });

  it('辞書の目印と同じ制御文字が値に含まれていても壊れない', () => {
    const marker = String.fromCharCode(1);
    const edits: DemoEdit[] = [
      { t: 'comments', id: 'c1', v: { body: `${marker}0 これは参照ではなく本文です` } },
      { t: 'comments', id: 'c2', v: { body: `${marker}${marker}二重の目印` } },
    ];
    expect(decodeDemoEdits(encodeDemoEdits(edits))).toEqual(edits);
  });

  it('壊れた Cookie では例外を投げず空で返す', () => {
    expect(decodeDemoEdits('2これはbase64ではない')).toEqual([]);
    expect(decodeDemoEdits('')).toEqual([]);
    expect(decodeDemoEdits('W3sidCI6')).toEqual([]);
  });

  it('旧形式（無圧縮）の Cookie も読める', () => {
    const edits: DemoEdit[] = [{ t: 'comments', id: 'c1', v: { body: '旧形式' } }];
    const legacy = Buffer.from(JSON.stringify(edits), 'utf8').toString('base64url');
    // 旧形式は必ず 'W'（'[' の base64）で始まるため、新形式の目印 '2' と衝突しない
    expect(legacy.startsWith('W')).toBe(true);
    expect(decodeDemoEdits(legacy)).toEqual(edits);
  });

  it('取込 25 行が 1 つの Cookie に収まる（本番のプレビュー表示に必要な容量）', () => {
    // 共通する UUID を辞書へ移さないと 3800 B を超える。
    // 本番で「取込結果を保持できませんでした」が出たのはこれが原因だった。
    const encoded = encodeDemoEdits(ingestionJob(25));
    expect(encoded.length).toBeLessThan(MAX_BYTES);
  });

  it('辞書化しない場合より 3 倍以上小さい', () => {
    const edits = ingestionJob(25);
    const plain = Buffer.from(JSON.stringify(edits), 'utf8').toString('base64url').length;
    expect(plain / encodeDemoEdits(edits).length).toBeGreaterThan(3);
  });
});
