import { NextResponse } from 'next/server';
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
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
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
    amount: string;
    factor: string;
  }
  const rows: TemplateRow[] = [
    // 未提出の社を先に並べる（記入するだけで取り込める）。提出済みの社の再提出も同じ形式でよい
    ...missing.map((s) => ({ code: s.code, item: '', amount: '', factor: '' })),
    {
      code: '※ 記入例: SUP-06 / 金属筐体 / 12400 / EF-PUR-METAL（この注記行は取り込まれません）',
      item: '',
      amount: '',
      factor: '',
    },
  ];
  const csv = toCsv<TemplateRow>({
    name: 'サプライヤーデータ取込テンプレート',
    columns: [
      { key: 'code', header: 'サプライヤーコード', value: (r) => r.code },
      { key: 'item', header: '品目', value: (r) => r.item },
      { key: 'amount', header: '購買金額(千円)', value: (r) => r.amount },
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
