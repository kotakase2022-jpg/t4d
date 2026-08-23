import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import {
  contentDisposition,
  EXPORT_CONTENT_TYPES,
  toCsv,
  toDocx,
  toXlsx,
  type DocxSection,
  type ExportColumn,
  type ExportFormat,
} from '@/lib/exports';
import { getDb } from '@/lib/repositories';
import { loadDisclosureWorkspace, type DisclosureQuestionRow } from '@/lib/services/disclosure';
import { FRAMEWORK_KEYS, type FrameworkKey } from '@/types/domain';

const CHANGE_LABEL: Record<string, string> = {
  new: '新規',
  changed: '変更',
  carry_forward: '継続',
  retired: '廃止',
};

/**
 * 開示回答の CSV / XLSX / 簡易 DOCX Export（指示書 7.1-16 / DISC-P0-002）。
 *
 * 以前は CDP 固定で、SSBJ / CSRD の開示ドラフトを出す手段が無かった。
 * `?framework=` で切り替える（既定は互換のため cdp）。
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.export.run')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get('format') ?? 'csv') as ExportFormat;
  const frameworkParam = url.searchParams.get('framework') ?? 'cdp';
  if (!FRAMEWORK_KEYS.includes(frameworkParam as FrameworkKey)) {
    return NextResponse.json({ error: 'unknown_framework' }, { status: 400 });
  }
  const framework = frameworkParam as FrameworkKey;

  const db = await getDb();
  const organizationId = ctx.workspace.organizationId;

  const periods = await db.select('periods', { where: { organizationId } });
  const periodId = url.searchParams.get('period');
  const period =
    periods.find((p) => p.id === periodId) ??
    periods.find((p) => p.status === 'collecting') ??
    periods[0];
  if (!period) return NextResponse.json({ error: 'no_period' }, { status: 404 });

  const metrics = await db.select('metrics', {
    where: { organizationId, deletedAt: { isNull: true } },
  });
  const workspace = await loadDisclosureWorkspace(db, ctx, framework, period, periods, metrics);
  if (!workspace) return NextResponse.json({ error: 'no_framework' }, { status: 404 });

  const frameworkLabel = framework.toUpperCase();
  const baseName = `T4D_${frameworkLabel}回答_${ctx.workspace.organizationName}_${period.code}`;

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'disclosure_responses',
    afterSummary: `${frameworkLabel} ${workspace.rows.length} 問を ${format.toUpperCase()} で出力`,
    metadata: { period: period.code, format, framework },
  });

  if (format === 'docx') {
    const sections: DocxSection[] = workspace.sections.map((section) => ({
      heading: section,
      paragraphs: workspace.rows
        .filter((r) => r.item.section === section)
        .flatMap((r) => [
          `【${r.item.code}】${r.item.questionText}`,
          r.response?.answerText?.trim()
            ? r.response.answerText
            : '（未回答：承認済みデータと Evidence を確認のうえ記載してください）',
          '',
        ]),
    }));
    sections.unshift({
      heading: '概要',
      paragraphs: [
        `対象組織: ${ctx.workspace.organizationName}`,
        `対象期間: ${period.label}`,
        `質問書: ${workspace.versionLabel}${workspace.isFixture ? '（架空の縮小マスター）' : ''}`,
        `承認済み: ${workspace.summary.approved} / ${workspace.summary.total} 問`,
      ],
      table: {
        headers: ['区分', '件数'],
        rows: [
          ['新規', String(workspace.summary.newItems)],
          ['変更', String(workspace.summary.changedItems)],
          ['継続', String(workspace.summary.carryForward)],
        ],
      },
    });

    const buffer = await toDocx(`${frameworkLabel} 回答ドラフト ${period.code}`, sections);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': EXPORT_CONTENT_TYPES.docx,
        'Content-Disposition': contentDisposition(`${baseName}.docx`),
        'Cache-Control': 'no-store',
      },
    });
  }

  const columns: ExportColumn<DisclosureQuestionRow>[] = [
    { key: 'section', header: 'セクション', value: (r) => r.item.section },
    { key: 'code', header: '質問コード', value: (r) => r.item.code },
    { key: 'question', header: '質問文', value: (r) => r.item.questionText },
    { key: 'answerType', header: '回答型', value: (r) => r.item.answerType },
    { key: 'required', header: '必須', value: (r) => (r.item.required ? 'はい' : 'いいえ') },
    {
      key: 'changeType',
      header: '前年差分',
      value: (r) => CHANGE_LABEL[r.item.changeType] ?? r.item.changeType,
    },
    { key: 'status', header: '状態', value: (r) => r.response?.status ?? 'not_started' },
    { key: 'answerText', header: '回答本文', value: (r) => r.response?.answerText ?? '' },
    {
      key: 'answerNumeric',
      header: '回答数値',
      value: (r) => r.response?.answerNumeric ?? null,
      numeric: true,
    },
    {
      key: 'answerChoice',
      header: '選択',
      value: (r) => r.response?.answerChoice.join(' / ') ?? '',
    },
    {
      key: 'metrics',
      header: 'マッピング指標',
      value: (r) => r.mappedMetrics.map((m) => m.name).join(' / '),
    },
    { key: 'currentValue', header: '当年値', value: (r) => r.currentValue, numeric: true },
    { key: 'previousValue', header: '前年値', value: (r) => r.previousValue, numeric: true },
    {
      key: 'delta',
      header: '増減率(%)',
      value: (r) =>
        r.currentValue !== null && r.previousValue !== null && r.previousValue !== 0
          ? Math.round(((r.currentValue - r.previousValue) / r.previousValue) * 1000) / 10
          : null,
      numeric: true,
    },
    {
      key: 'previousAnswer',
      header: '前年回答',
      value: (r) => r.previousResponse?.answerText ?? '',
    },
  ];

  const sheet = { name: `${frameworkLabel}_${period.code}`, columns, rows: workspace.rows };

  if (format === 'xlsx') {
    const buffer = await toXlsx([sheet], baseName);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': EXPORT_CONTENT_TYPES.xlsx,
        'Content-Disposition': contentDisposition(`${baseName}.xlsx`),
        'Cache-Control': 'no-store',
      },
    });
  }

  return new NextResponse(toCsv(sheet), {
    headers: {
      'Content-Type': EXPORT_CONTENT_TYPES.csv,
      'Content-Disposition': contentDisposition(`${baseName}.csv`),
      'Cache-Control': 'no-store',
    },
  });
}

export const dynamic = 'force-dynamic';
