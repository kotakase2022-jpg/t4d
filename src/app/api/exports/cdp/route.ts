import { NextResponse } from 'next/server';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
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
import { formatJst } from '@/lib/format/datetime';
import { SSBJ_FRAMEWORK_INFO } from '@/lib/frameworks/ssbj-2026';
import { getDb } from '@/lib/repositories';
import {
  buildSsbjDocxSections,
  isFrameworkAvailable,
  loadDisclosureWorkspace,
  type DisclosureQuestionRow,
} from '@/lib/services/disclosure';
import { OPTION_NOT_CONTRACTED_MESSAGES } from '@/lib/services/organization-options';
import { FRAMEWORK_KEYS, type FrameworkKey, type Uuid } from '@/types/domain';

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
 *
 * トライアル対応（NF-38・NF-39 C-08）:
 *  - CDP は組織ごとに契約するオプション。契約が無い組織には 403（JSON。権限の拒否ではないので
 *    access_denied は記録しない）
 *  - `?approvedOnly=1` で承認済みの回答だけを出す。列に作成担当・レビュー担当・承認者・承認日時・版
 *  - `?version=` で画面と同じ版の質問構成で出す（省略時は期間に対応する版）
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.export.run')) {
    return accessDeniedResponse(await getDb(), ctx, {
      permission: 'enterprise.export.run',
      request,
    });
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

  if (!(await isFrameworkAvailable(db, ctx, framework))) {
    return NextResponse.json(
      { error: 'option_not_contracted', message: OPTION_NOT_CONTRACTED_MESSAGES.cdp },
      { status: 403 },
    );
  }
  const approvedOnly = url.searchParams.get('approvedOnly') === '1';

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
  const workspace = await loadDisclosureWorkspace(db, ctx, framework, period, periods, metrics, {
    versionId: url.searchParams.get('version'),
  });
  if (!workspace) return NextResponse.json({ error: 'no_framework' }, { status: 404 });
  const rows = approvedOnly
    ? workspace.rows.filter((r) => r.response?.status === 'approved')
    : workspace.rows;

  const frameworkLabel = framework.toUpperCase();
  const baseName = `T4D_${frameworkLabel}回答_${ctx.workspace.organizationName}_${period.code}${
    approvedOnly ? '_承認済み' : ''
  }`;

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'disclosure_responses',
    afterSummary:
      framework === 'ssbj' && format === 'docx'
        ? 'SSBJ 開示ドラフト（節別本文・定量指標）を DOCX で出力'
        : `${frameworkLabel} ${rows.length} 問を ${format.toUpperCase()} で出力${
            approvedOnly ? '（承認済みだけ）' : ''
          }`,
    metadata: { period: period.code, format, framework, approvedOnly },
  });

  // 担当・承認者の名前と、回答の現在の版の番号（C-08）
  const userIds = [
    ...new Set(
      rows.flatMap((r) =>
        [r.response?.ownerUserId, r.response?.reviewerUserId, r.response?.approvedBy].filter(
          (id): id is Uuid => Boolean(id),
        ),
      ),
    ),
  ];
  const profiles =
    userIds.length > 0 ? await db.select('profiles', { where: { id: { in: userIds } } }) : [];
  const nameById = new Map(profiles.map((p) => [p.id, p.displayName]));
  const nameOf = (id: Uuid | null | undefined) => (id ? (nameById.get(id) ?? '—') : '');
  const versionIds = rows.flatMap((r) =>
    r.response?.currentVersionId ? [r.response.currentVersionId] : [],
  );
  const versions =
    versionIds.length > 0
      ? await db.select('disclosureResponseVersions', {
          where: { organizationId, id: { in: versionIds } },
        })
      : [];
  const versionNoById = new Map(versions.map((v) => [v.id, v.versionNo]));

  if (format === 'docx' && framework === 'ssbj') {
    // SSBJ は要求事項ごとの回答を持たない。開示ドラフト画面の節別の本文を
    // 確定／未確定を明記して出す（以前は 133 件の空欄だけが出ていた。W0 棚卸し）
    const built = await buildSsbjDocxSections(db, ctx, period, periods, metrics);
    if (!built) return NextResponse.json({ error: 'no_framework' }, { status: 404 });
    const buffer = await toDocx(built.title, built.sections);
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': EXPORT_CONTENT_TYPES.docx,
        'Content-Disposition': contentDisposition(
          `T4D_SSBJ開示ドラフト_${ctx.workspace.organizationName}_${period.code}.docx`,
        ),
        'Cache-Control': 'no-store',
      },
    });
  }

  if (format === 'docx') {
    const sections: DocxSection[] = workspace.sections
      .map((section) => ({
        heading: section,
        paragraphs: rows
          .filter((r) => r.item.section === section)
          .flatMap((r) => [
            `【${r.item.code}】${r.item.questionText}`,
            r.response?.answerText?.trim()
              ? r.response.answerText
              : '（未回答：承認済みデータと Evidence を確認のうえ記載してください）',
            '',
          ]),
      }))
      .filter((section) => section.paragraphs.length > 0);
    sections.unshift({
      heading: '概要',
      paragraphs: [
        `対象組織: ${ctx.workspace.organizationName}`,
        `対象期間: ${period.label}`,
        `質問書: ${workspace.versionLabel}${workspace.isFixture ? '（架空の縮小マスター）' : ''}`,
        `承認済み: ${workspace.summary.approved} / ${workspace.summary.total} 問`,
        ...(approvedOnly ? ['承認済みの回答だけを出力しています。'] : []),
        // CDP ポータルへの送信・API 連携は含まない（回答は出力して転記する。plan 付録 E）
        ...(framework === 'cdp'
          ? ['CDP ポータルへの送信・API 連携は行いません。回答は内容を確認のうえ転記してください。']
          : []),
        // 正式基準（SSBJ）は転載許可に基づく収録のため、Export にも出所を残す
        ...(framework === 'ssbj' && !workspace.isFixture ? [SSBJ_FRAMEWORK_INFO.attribution] : []),
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
    { key: 'owner', header: '作成担当', value: (r) => nameOf(r.response?.ownerUserId) },
    { key: 'reviewer', header: 'レビュー担当', value: (r) => nameOf(r.response?.reviewerUserId) },
    { key: 'approvedBy', header: '承認者', value: (r) => nameOf(r.response?.approvedBy) },
    {
      key: 'approvedAt',
      header: '承認日時',
      value: (r) => (r.response?.approvedAt ? formatJst(r.response.approvedAt) : ''),
    },
    {
      key: 'versionNo',
      header: '版',
      value: (r) =>
        r.response?.currentVersionId
          ? (versionNoById.get(r.response.currentVersionId) ?? null)
          : null,
      numeric: true,
    },
  ];

  const sheet = { name: `${frameworkLabel}_${period.code}`, columns, rows };

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
