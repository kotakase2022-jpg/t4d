import { describe, expect, it } from 'vitest';
import { buildEvidenceDocument } from '@/lib/fixtures/evidence-documents';
import { createFixtureDb } from '@/lib/fixtures/store';

/**
 * 労働災害記録（safety-record）の紙面。
 *
 * W0 O3 で労働災害度数率（証跡必須）に証跡ファイルを足したが、紙面の組み立てが無く
 * Evidence Viewer に汎用の「添付資料」しか出ていなかった。証跡として説明できるよう、
 * 紙面の拠点別の度数率が Fixture の Data Point と一致することを確かめる。
 */
describe('労働災害記録の紙面', () => {
  it('汎用の既定紙面ではなく、件数・労働時間・度数率を持つ', () => {
    const lines = buildEvidenceDocument('safety-record', 'FY2025', 1);
    expect(lines[0]?.text).toContain('労働災害');
    expect(lines.some((l) => l.text.includes('延べ労働時間'))).toBe(true);
    expect(lines.some((l) => l.text.includes('架空'))).toBe(true);
  });

  it('拠点ごとの度数率が Fixture の LTIFR（FY2025・FY2026）と一致する', () => {
    const db = createFixtureDb();
    const metric = db.metrics.find((m) => m.code === 'ltifr')!;
    const points = db.dataPoints.filter((d) => d.metricId === metric.id);
    expect(points.length).toBeGreaterThan(0);

    for (const point of points) {
      const period = db.periods.find((p) => p.id === point.reportingPeriodId)!;
      const unit = db.units.find((u) => u.id === point.unitId)!;
      const lines = buildEvidenceDocument('safety-record', period.code, 1);
      const row = lines.find((l) => l.kind === 'row' && l.text.startsWith(unit.name));
      expect(row, `${period.code} ${unit.name} の行が無い`).toBeDefined();
      expect(row!.text.trimEnd(), `${period.code} ${unit.name}`).toMatch(
        new RegExp(`${point.value!.toFixed(1).replace('.', '\\.')}$`),
      );
    }
  });
});
