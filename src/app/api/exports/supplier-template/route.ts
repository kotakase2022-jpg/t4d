import { NextResponse } from 'next/server';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { can } from '@/lib/authorization/can';
import { getSession } from '@/lib/auth/session';
import { contentDisposition, toCsv } from '@/lib/exports';
import { getDb } from '@/lib/repositories';
import { loadScope3SupplierBreakdown } from '@/lib/services/scope3-suppliers';

/**
 * サプライヤーデータ取込テンプレート（CSV）のダウンロード。
 * 未提出のサプライヤーをあらかじめ行に並べ、記入してそのままドロップすれば取り込める形で出す。
 * CSV 生成は共有の toCsv を使う（サプライヤーコードは自由入力の文字列なので、
 * 他の Export と同じ数式インジェクション無害化・BOM 付与を通す）。
 */
export async function GET(request: Request) {
  const session = await getSession();
  const ctx = session?.context;
  if (!ctx || ctx.workspace.organizationType !== 'enterprise') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!can(ctx, 'enterprise.import.run')) {
    return accessDeniedResponse(await getDb(), ctx, {
      permission: 'enterprise.import.run',
      request,
    });
  }

  const db = await getDb();
  const periods = await db.select('periods', {
    where: { organizationId: ctx.workspace.organizationId },
  });
  const periodId = new URL(request.url).searchParams.get('period');
  const period =
    periods.find((p) => p.id === periodId) ??
    periods.find((p) => p.status === 'collecting') ??
    periods.sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0];
  if (!period) return NextResponse.json({ error: 'no_period' }, { status: 404 });

  const breakdown = await loadScope3SupplierBreakdown(db, ctx, period.id);
  const missing = breakdown.suppliers.filter((s) => !s.submitted);

  interface TemplateRow {
    code: string;
    item: string;
    dtype: string;
    amount: string;
    unit: string;
    factor: string;
  }
  const empty = (code: string): TemplateRow => ({
    code,
    item: '',
    dtype: '',
    amount: '',
    unit: '',
    factor: '',
  });
  const rows: TemplateRow[] = [
    // 未提出の社を先に並べる（記入するだけで取り込める）。提出済みの社の再提出も同じ形式でよい
    ...missing.map((s) => empty(s.code)),
    // 3 種類の素データの記入例（注記行として自動的に取込対象外になる）
    empty(
      '※ 記入例①排出量: SUP-16 / 報告排出量 / 排出量 / 8.4 / t-CO2e / （係数不要・この注記行は取り込まれません）',
    ),
    empty(
      '※ 記入例②物理量: SUP-27 / 購入電力 / 物理量 / 28400 / kWh / （係数コード空欄なら単位から自動解決）',
    ),
    empty('※ 記入例③金額: SUP-06 / 金属筐体 / 金額 / 12400 / 千円 / EF-PUR-METAL'),
  ];
  const csv = toCsv<TemplateRow>({
    name: 'サプライヤーデータ取込テンプレート',
    columns: [
      { key: 'code', header: 'サプライヤーコード', value: (r) => r.code },
      { key: 'item', header: '品目', value: (r) => r.item },
      { key: 'dtype', header: 'データ種別', value: (r) => r.dtype },
      { key: 'amount', header: '数値', value: (r) => r.amount },
      { key: 'unit', header: '単位', value: (r) => r.unit },
      { key: 'factor', header: '排出係数コード', value: (r) => r.factor },
    ],
    rows,
  });

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDisposition(
        `サプライヤーデータ取込テンプレート_${period.code}.csv`,
      ),
      'Cache-Control': 'private, no-store',
    },
  });
}
