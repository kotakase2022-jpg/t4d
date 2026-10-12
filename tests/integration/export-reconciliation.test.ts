import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { RECONCILIATION_CHECKER_VERSION } from '@/lib/domain/export-reconciliation';
import { computeSnapshotContentHash } from '@/lib/domain/report-snapshot-content';
import { ValidationError } from '@/lib/errors/user-facing';
import { buildDisclosureDocx } from '@/lib/exports/disclosure-report';
import { buildZip } from '@/lib/exports/zip';
import { parseDocx } from '@/lib/imports/docx-text';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { DEMO_RECONCILIATION_MISMATCH_MAX } from '@/lib/repositories/demo-trial-checks';
import {
  buildExportContext,
  exportReportSnapshot,
  exportSnapshotReconciliation,
  reconcileUploadedFile,
  requirementStateChanges,
} from '@/lib/services/disclosure-export';
import { loadSsbjRequirementViews, saveSsbjScope } from '@/lib/services/ssbj-gap';
import {
  ExportReconciliationBlockedError,
  listReconciliations,
  loadReconciliation,
  readXlsxSheets,
} from '@/lib/services/export-reconciliation';
import {
  asSnapshotDetail,
  confirmReport,
  createReviewDraftSnapshot,
  frozenMaskedFileNames,
} from '@/lib/services/report-snapshot';
import type { AuthorizationContext, ReportSnapshot, RoleKey, Uuid } from '@/types/domain';

/**
 * 出力の自動突合（トライアル対応 NF-15。int:export-reconciliation）。
 *
 * 生成したファイルを渡す前に読み戻して承認版と照合し、正常なら不一致 0 件を出力の記録に入れる。
 * 不一致があればファイルを渡さず、記録だけを残す。外部で編集したファイルは保存せず、
 * ハッシュと照合の結果（位置付きの明細）だけを記録する。
 */

const state: { ctx: AuthorizationContext | null; db: DemoDbClient | null } = {
  ctx: null,
  db: null,
};
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => (state.ctx ? { context: state.ctx } : null),
}));
vi.mock('@/lib/repositories', () => ({ getDb: async () => state.db }));
const { GET } = await import('@/app/api/exports/disclosure-snapshots/[snapshotId]/route');

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: Uuid = ORG_IDS.aomi,
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
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.ctx = approver();
});

/** DOCX の本文の段落を 1 つ書き換えたファイル（Word で編集したのと同じく、別の本文で作り直す） */
async function editedDocx(snapshotId: Uuid, frameworkVersionId: Uuid): Promise<Uint8Array> {
  const row = fixture.reportSnapshots.find((s) => s.id === snapshotId)!;
  const detail = asSnapshotDetail(row);
  const target = detail.blocks.find(
    (b) =>
      b.frameworkVersionId === frameworkVersionId &&
      b.body.paragraphs.some(
        (p) => p.kind === 'paragraph' && p.children.some((c) => c.t === 'text'),
      ),
  )!;
  const paragraph = target.body.paragraphs.find(
    (p) => p.kind === 'paragraph' && p.children.some((c) => c.t === 'text'),
  )!;
  const edited = {
    ...detail,
    blocks: detail.blocks.map((b) =>
      b.blockId !== target.blockId
        ? b
        : {
            ...b,
            body: {
              paragraphs: b.body.paragraphs.map((p) =>
                p.id !== paragraph.id
                  ? p
                  : {
                      ...p,
                      children: p.children.map((c, i) =>
                        c.t === 'text' && i === p.children.findIndex((x) => x.t === 'text')
                          ? { ...c, text: `${c.text}（外部で追記）` }
                          : c,
                      ),
                    },
              ),
            },
          },
    ),
  };
  const context = await buildExportContext(db, approver(), detail, { requirements: false });
  return buildDisclosureDocx(
    edited,
    {
      audience: 'external',
      frameworkVersionId,
      nonPublicFileNames: frozenMaskedFileNames(detail) ?? [],
    },
    context,
  );
}

/** 節の最後の段落の後ろに主張を 1 段落足したファイル（Word で節の末尾に書き足したのと同じ） */
async function appendedClaimDocx(
  snapshotId: Uuid,
  frameworkVersionId: Uuid,
  claim: string,
): Promise<Uint8Array> {
  const row = fixture.reportSnapshots.find((s) => s.id === snapshotId)!;
  const detail = asSnapshotDetail(row);
  const target = detail.blocks.find(
    (b) => b.frameworkVersionId === frameworkVersionId && b.body.paragraphs.length > 0,
  )!;
  const edited = {
    ...detail,
    blocks: detail.blocks.map((b) =>
      b.blockId !== target.blockId
        ? b
        : {
            ...b,
            body: {
              paragraphs: [
                ...b.body.paragraphs,
                {
                  id: 'external-claim',
                  kind: 'paragraph' as const,
                  children: [{ t: 'text' as const, text: claim }],
                },
              ],
            },
          },
    ),
  };
  const context = await buildExportContext(db, approver(), detail, { requirements: false });
  return buildDisclosureDocx(
    edited,
    {
      audience: 'external',
      frameworkVersionId,
      nonPublicFileNames: frozenMaskedFileNames(detail) ?? [],
    },
    context,
  );
}

describe('生成した出力の突合', () => {
  it('DOCX（社内確認用・対外用）・XLSX・CSV の正常な出力は不一致 0 件で、照合の件数と規則の版を記録する', async () => {
    const snapshot = await confirmReport(db, approver(), IDS.projects.fy2025);
    const frameworkVersionId = snapshot.frameworkVersions[0]!.frameworkVersionId;
    const requests = [
      { format: 'docx', audience: 'internal', frameworkVersionId },
      { format: 'docx', audience: 'external', frameworkVersionId },
      { format: 'xlsx', audience: 'internal' },
      { format: 'csv', audience: 'internal' },
      { format: 'csv', audience: 'external' },
    ] as const;
    for (const request of requests) {
      const result = await exportReportSnapshot(db, approver(), {
        snapshotId: snapshot.id,
        ...request,
      });
      expect(result.artifact.mismatchCount, `${request.format} ${request.audience}`).toBe(0);
      expect(result.artifact.checkerVersion).toBe(RECONCILIATION_CHECKER_VERSION);
      const checked =
        (result.artifact.reconciledParagraphs ?? 0) +
        (result.artifact.reconciledNumbers ?? 0) +
        (result.artifact.reconciledRows ?? 0);
      expect(checked, `${request.format} ${request.audience}`).toBeGreaterThan(0);
    }
    // DOCX は本文の段落と付表の数値を照合する
    const docx = fixture.exportArtifacts.find(
      (a) => a.format === 'docx' && a.audience === 'internal',
    )!;
    expect(docx.reconciledParagraphs).toBeGreaterThan(0);
    expect(docx.reconciledNumbers).toBeGreaterThan(0);
    // 不一致が無いので、止めた出力の記録は作らない
    expect(fixture.exportReconciliations).toHaveLength(0);
  });

  it('草稿（未承認の箇所を含む）も描画どおりなら 0 件（承認の照合は承認済み版だけ）', async () => {
    const snapshot = await createReviewDraftSnapshot(db, author(), IDS.projects.fy2026);
    for (const framework of snapshot.frameworkVersions) {
      for (const audience of ['internal', 'external'] as const) {
        const result = await exportReportSnapshot(db, author(), {
          snapshotId: snapshot.id,
          format: 'docx',
          audience,
          frameworkVersionId: framework.frameworkVersionId,
        });
        expect(result.artifact.mismatchCount).toBe(0);
      }
    }
    const xlsx = await exportReportSnapshot(db, author(), {
      snapshotId: snapshot.id,
      format: 'xlsx',
      audience: 'internal',
    });
    expect(xlsx.artifact.mismatchCount).toBe(0);
    expect(xlsx.artifact.reconciledParagraphs).toBeGreaterThan(0);
  });

  it('承認済み版の写しに未承認の節があれば（承認の照合の不一致）、ファイルを渡さず記録だけを残す', async () => {
    const row = fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!;
    // 写しの承認の印だけを外し、内容ハッシュも合わせた行（追記専用の前提を外れた写しを想定）
    const blocks = (row.blocks as unknown as Array<Record<string, unknown>>).map((b, i) =>
      i === 0 ? { ...b, isApprovedVersion: false } : b,
    );
    const tampered = {
      ...row,
      id: '11111111-1111-4111-8111-111111111111',
      snapshotNo: 9,
      blocks,
    } as unknown as ReportSnapshot;
    tampered.contentHash = computeSnapshotContentHash(tampered);
    fixture.reportSnapshots.push(tampered);

    const error = await exportReportSnapshot(db, approver(), {
      snapshotId: tampered.id,
      format: 'csv',
      audience: 'internal',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExportReconciliationBlockedError);
    const blocked = error as ExportReconciliationBlockedError;
    expect(blocked.mismatchCount).toBeGreaterThan(0);
    expect(fixture.exportArtifacts.filter((a) => a.snapshotId === tampered.id)).toHaveLength(0);
    const record = await loadReconciliation(db, approver(), blocked.reconciliationId);
    expect(record.source).toBe('generated_blocked');
    expect(record.mismatches[0]).toMatchObject({ kind: 'approval' });
    expect(record.fileSha256).toMatch(/^[0-9a-f]{64}$/);

    // 画面の出力リンクからなら、出力タブへ戻して理由と記録を示す（ファイルは渡さない）
    const response = await GET(
      new Request(
        `http://localhost/api/exports/disclosure-snapshots/${tampered.id}?format=csv&audience=internal&project=${IDS.projects.fy2025}`,
      ),
      { params: Promise.resolve({ snapshotId: tampered.id }) },
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('Location')!);
    expect(location.searchParams.get('tab')).toBe('outputs');
    expect(location.searchParams.get('outputError')).toContain('不一致');
    expect(location.searchParams.get('reconciliation')).toMatch(/^[0-9a-f-]{36}$/);
    // API として呼べば 422（理由と記録の ID）
    const api = await GET(
      new Request(
        `http://localhost/api/exports/disclosure-snapshots/${tampered.id}?format=csv&audience=internal`,
      ),
      { params: Promise.resolve({ snapshotId: tampered.id }) },
    );
    expect(api.status).toBe(422);
    expect(await api.json()).toMatchObject({ error: 'reconciliation_mismatch' });
  });
});

describe('外部で編集したファイルの照合（ファイルは保存しない）', () => {
  it('DOCX の段落を変えたファイルは、位置（節・段落）付きで検出する。元のファイルは 0 件', async () => {
    const snapshotId = FY2025_APPROVED_SNAPSHOT_ID;
    const frameworkVersionId = asSnapshotDetail(
      fixture.reportSnapshots.find((s) => s.id === snapshotId)!,
    ).frameworkVersions[0]!.frameworkVersionId;
    const original = await exportReportSnapshot(db, approver(), {
      snapshotId,
      format: 'docx',
      audience: 'external',
      frameworkVersionId,
    });
    const clean = await reconcileUploadedFile(db, approver(), {
      snapshotId,
      fileName: '原稿.docx',
      bytes: original.bytes,
      audience: 'external',
      frameworkVersionId,
    });
    expect(clean.source).toBe('uploaded');
    expect(clean.mismatchCount).toBe(0);
    expect(clean.paragraphsChecked).toBeGreaterThan(0);

    const edited = await reconcileUploadedFile(db, approver(), {
      snapshotId,
      fileName: '原稿（Word で編集）.docx',
      bytes: await editedDocx(snapshotId, frameworkVersionId),
      audience: 'external',
      frameworkVersionId,
    });
    expect(edited.mismatchCount).toBe(1);
    expect(edited.mismatches[0]).toMatchObject({ kind: 'paragraph' });
    expect(edited.mismatches[0]!.location).toMatch(/段落 \d+/);
    expect(edited.mismatches[0]!.actual).toContain('外部で追記');
    // ファイルは保存せず、ハッシュと結果だけを記録する
    expect(edited.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(fixture.exportReconciliations)).not.toContain('UEsDB');
    expect(fixture.exportArtifacts).toHaveLength(1);
  });

  it('節の末尾に足した主張・期待値に無いシートは「一致」にしない（読み飛ばさない）', async () => {
    const snapshotId = FY2025_APPROVED_SNAPSHOT_ID;
    const frameworkVersionId = asSnapshotDetail(
      fixture.reportSnapshots.find((s) => s.id === snapshotId)!,
    ).frameworkVersions[0]!.frameworkVersionId;
    const claim = '当社は2030年にネットゼロを達成済みです。';
    const docx = await reconcileUploadedFile(db, approver(), {
      snapshotId,
      fileName: '原稿（節の末尾に追記）.docx',
      bytes: await appendedClaimDocx(snapshotId, frameworkVersionId, claim),
      audience: 'external',
      frameworkVersionId,
    });
    expect(docx.mismatchCount).toBeGreaterThan(0);
    expect(docx.mismatches.some((m) => m.kind === 'extra' && m.actual === claim)).toBe(true);

    const original = await exportReportSnapshot(db, approver(), {
      snapshotId,
      format: 'xlsx',
      audience: 'internal',
    });
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(original.bytes as unknown as ArrayBuffer);
    workbook.addWorksheet('Scope3 合計').addRow(['Scope3 合計', 99999]);
    const xlsx = await reconcileUploadedFile(db, approver(), {
      snapshotId,
      fileName: '対応表（シートを追加）.xlsx',
      bytes: new Uint8Array(await workbook.xlsx.writeBuffer()),
      audience: 'internal',
    });
    expect(xlsx.mismatches.map((m) => [m.kind, m.location])).toEqual([
      ['extra', 'シート「Scope3 合計」'],
    ]);
  });

  it('寸法だけ巨大な XLSX・展開すると巨大になる DOCX は、セルを総当たりせず・展開し切らずに断る', async () => {
    const snapshotId = FY2025_APPROVED_SNAPSHOT_ID;
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('対応表');
    sheet.getCell('A1').value = 'x';
    sheet.getCell('XFD1048576').value = 'y';
    const huge = new Uint8Array(await workbook.xlsx.writeBuffer());
    expect(huge.byteLength).toBeLessThan(64 * 1024);
    const started = Date.now();
    await expect(
      reconcileUploadedFile(db, approver(), {
        snapshotId,
        fileName: '巨大.xlsx',
        bytes: huge,
        audience: 'internal',
      }),
    ).rejects.toThrow(/照合できる範囲を超えています/);
    expect(Date.now() - started).toBeLessThan(10_000);

    // document.xml が展開すると 33 MB（上限 32 MB）になる .docx（圧縮後は数十 KB）
    const bomb = buildZip([
      { name: '[Content_Types].xml', bytes: new TextEncoder().encode('<Types/>') },
      { name: 'word/document.xml', bytes: new Uint8Array(33 * 1024 * 1024).fill(0x20) },
    ]);
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect((await parseDocx(bomb)).status).toBe('too_large');
    const frameworkVersionId = asSnapshotDetail(
      fixture.reportSnapshots.find((s) => s.id === snapshotId)!,
    ).frameworkVersions[0]!.frameworkVersionId;
    await expect(
      reconcileUploadedFile(db, approver(), {
        snapshotId,
        fileName: '爆弾.docx',
        bytes: bomb,
        audience: 'external',
        frameworkVersionId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.exportReconciliations).toHaveLength(0);
  });

  it('XLSX の数値を変えたファイルは、シートとセルの位置で検出する', async () => {
    const snapshotId = FY2025_APPROVED_SNAPSHOT_ID;
    const original = await exportReportSnapshot(db, approver(), {
      snapshotId,
      format: 'xlsx',
      audience: 'internal',
    });
    const sheets = await readXlsxSheets(original.bytes);
    expect([...sheets.keys()]).toEqual(['対応表', '数値', '根拠', 'トレース', 'スナップショット']);

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(original.bytes as unknown as ArrayBuffer);
    const cell = workbook.getWorksheet('数値')!.getRow(2).getCell(8);
    expect(typeof cell.value).toBe('number');
    cell.value = (cell.value as number) + 1;
    const edited = new Uint8Array(await workbook.xlsx.writeBuffer());

    const result = await reconcileUploadedFile(db, approver(), {
      snapshotId,
      fileName: '対応表.xlsx',
      bytes: edited,
      audience: 'internal',
    });
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatches[0]).toMatchObject({ kind: 'number', location: '数値!H2' });
  });

  it('Demo では明細を Cookie に載る件数までにし、件数は全件を残す', async () => {
    const snapshotId = FY2025_APPROVED_SNAPSHOT_ID;
    const original = await exportReportSnapshot(db, approver(), {
      snapshotId,
      format: 'xlsx',
      audience: 'internal',
    });
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(original.bytes as unknown as ArrayBuffer);
    // 対応表とトレースの全行を書き換える（明細の上限を超える件数にする）
    for (const name of ['対応表', 'トレース']) {
      const sheet = workbook.getWorksheet(name)!;
      for (let n = 2; n <= sheet.rowCount; n += 1) sheet.getRow(n).getCell(6).value = '書き換え';
    }
    const result = await reconcileUploadedFile(db, approver(), {
      snapshotId,
      fileName: '対応表.xlsx',
      bytes: new Uint8Array(await workbook.xlsx.writeBuffer()),
      audience: 'internal',
    });
    expect(result.mismatchCount).toBeGreaterThan(DEMO_RECONCILIATION_MISMATCH_MAX);
    expect(result.mismatches).toHaveLength(DEMO_RECONCILIATION_MISMATCH_MAX);
  });

  it('Word・Excel 以外のファイルは照合しない。権限は ID より先、他テナントは見つからない', async () => {
    await expect(
      reconcileUploadedFile(db, approver(), {
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
        fileName: 'memo.txt',
        bytes: new TextEncoder().encode('テキスト'),
        audience: 'internal',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      reconcileUploadedFile(db, reviewer(), {
        snapshotId: 'no-such-snapshot',
        fileName: 'a.docx',
        bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
        audience: 'internal',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      reconcileUploadedFile(db, otherTenant(), {
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
        fileName: 'a.docx',
        bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
        audience: 'internal',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fixture.exportReconciliations).toHaveLength(0);
    // 他テナントの記録は一覧にも出ない
    expect(await listReconciliations(db, otherTenant(), [FY2025_APPROVED_SNAPSHOT_ID])).toEqual([]);
  });
});

describe('突合結果の出力（XLSX）', () => {
  it('出力の記録・照合の記録・注記（第三者保証ではない・突合の位置付け）を載せる', async () => {
    const snapshotId = FY2025_APPROVED_SNAPSHOT_ID;
    await exportReportSnapshot(db, approver(), { snapshotId, format: 'csv', audience: 'internal' });
    const result = await exportSnapshotReconciliation(db, approver(), { snapshotId });
    const sheets = await readXlsxSheets(result.bytes);
    expect([...sheets.keys()]).toEqual([
      '出力の突合',
      '止めた出力・外部ファイル',
      '不一致の明細',
      '注記',
    ]);
    expect(sheets.get('出力の突合')).toHaveLength(2);
    const notes = sheets.get('注記')!.flat().join('\n');
    expect(notes).toContain('突合は T4D が生成したファイルと承認版の照合です');
    expect(notes).toContain('第三者保証ではありません');
    // 出力の記録には足さない（監査ログだけ）
    expect(fixture.exportArtifacts).toHaveLength(1);
    expect(
      fixture.auditEvents.filter(
        (e) => e.eventType === 'export_created' && e.metadata?.kind === 'reconciliation_xlsx',
      ),
    ).toHaveLength(1);
    await expect(
      exportSnapshotReconciliation(db, reviewer(), { snapshotId }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('承認版から出力する対応表（NF-04・NF-13）', () => {
  async function mappingRowsOf(snapshotId: Uuid) {
    const result = await exportReportSnapshot(db, approver(), {
      snapshotId,
      format: 'xlsx',
      audience: 'internal',
    });
    expect(result.artifact.mismatchCount).toBe(0);
    const sheet = (await readXlsxSheets(result.bytes)).get('対応表')!;
    const header = sheet[0]!.map(String);
    return {
      header,
      rows: sheet.slice(1).map((row) => row.map((c) => (c === null ? '' : String(c)))),
    };
  }

  it('節の無い要求事項も行に残し（全件）、判断の列と定性情報の題名・版を出す', async () => {
    const { header, rows } = await mappingRowsOf(FY2025_APPROVED_SNAPSHOT_ID);
    expect(header).toEqual(
      expect.arrayContaining([
        '要求事項ID',
        '原稿の節',
        '定性情報（題名・版）',
        '適用判断',
        '対象外の理由',
        '判断者',
        '判断の承認者',
        '固定後の変更',
      ]),
    );
    const code = header.indexOf('要求事項ID');
    const section = header.indexOf('原稿の節');
    // SSBJ の 133 項目はすべて 1 行以上（対象外・未判定・未対応を消さない）
    const items = fixture.disclosureItems.filter(
      (i) =>
        i.frameworkVersionId ===
        asSnapshotDetail(fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!)
          .frameworkVersions[0]!.frameworkVersionId,
    );
    expect(items).toHaveLength(133);
    const codes = new Set(rows.map((r) => r[code]));
    for (const item of items) expect(codes.has(item.code), item.code).toBe(true);
    expect(rows.some((r) => r[section] === '（原稿の節なし）')).toBe(true);
    // 固定した後に判断が変わっていない
    const changed = header.indexOf('固定後の変更');
    expect(new Set(rows.map((r) => r[changed]))).toEqual(new Set(['なし']));
  });

  it('SSBJ の評価（可変の行）が固定の後に変わると「確定後に変更あり」と示す', async () => {
    const snapshot = asSnapshotDetail(
      fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!,
    );
    const project = fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2025)!;
    const template = fixture.ssbjAssessments.find((a) => a.organizationId === ORG_IDS.aomi)!;
    const item = fixture.disclosureItems.find(
      (i) => i.frameworkVersionId === snapshot.frameworkVersions[0]!.frameworkVersionId,
    )!;
    fixture.ssbjAssessments.push({
      ...template,
      id: '22222222-2222-4222-8222-222222222222',
      reportingPeriodId: project.reportingPeriodId,
      itemId: item.id,
      applicability: 'applicable',
      applicabilityReason: 'テスト: 確定の後に評価を追加',
    });
    const { header, rows } = await mappingRowsOf(FY2025_APPROVED_SNAPSHOT_ID);
    const changed = header.indexOf('固定後の変更');
    expect(new Set(rows.map((r) => r[changed]))).toEqual(
      new Set(['確定後に変更あり（判断は現在の値）']),
    );
  });

  it('SSBJ の画面を開いて既定の評価行が作られただけでは「確定後に変更あり」にしない', async () => {
    const snapshot = asSnapshotDetail(
      fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!,
    );
    const project = fixture.disclosureProjects.find((p) => p.id === IDS.projects.fy2025)!;
    const period = fixture.periods.find((p) => p.id === project.reportingPeriodId)!;
    const ssbj = snapshot.frameworkVersions.find((f) => f.frameworkKey === 'ssbj')!;
    const rowsOfPeriod = () =>
      fixture.ssbjAssessments.filter(
        (a) => a.organizationId === ORG_IDS.aomi && a.reportingPeriodId === period.id,
      );
    expect(rowsOfPeriod()).toHaveLength(0);

    // 編集の権限を持つ人が SSBJ の画面を開く（既定の評価行が一括で作られる）
    await loadSsbjRequirementViews(db, author(), period);
    expect(rowsOfPeriod().length).toBeGreaterThan(0);
    expect(
      (await requirementStateChanges(db, approver(), snapshot)).get(ssbj.frameworkVersionId),
    ).toBe(false);
    const { header, rows } = await mappingRowsOf(FY2025_APPROVED_SNAPSHOT_ID);
    const changed = header.indexOf('固定後の変更');
    expect(rows.some((r) => r[changed] === '確定後に変更あり（判断は現在の値）')).toBe(false);

    // 人が判断を変えたときだけ「変更あり」
    const target = rowsOfPeriod()[0]!;
    await saveSsbjScope(db, author(), {
      assessmentId: target.id,
      applicability: 'applicable',
      applicabilityReason: '',
      materiality: 'material',
      materialityReason: 'テスト: 重要と判断',
      ownerDepartment: '',
    });
    expect(
      (await requirementStateChanges(db, approver(), snapshot)).get(ssbj.frameworkVersionId),
    ).toBe(true);
  });
});
