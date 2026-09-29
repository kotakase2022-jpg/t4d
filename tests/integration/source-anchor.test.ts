import { beforeEach, describe, expect, it } from 'vitest';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { disclosureFragmentId } from '@/lib/fixtures/disclosure-documents';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  addManualExcerpt,
  createAnchorFromFragment,
  listAnchorUsagesForFile,
  listDocumentsForCitation,
  loadDocumentFragments,
  registerEvidenceDocument,
  type RegisterDocumentInput,
} from '@/lib/services/source-anchor';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 定性情報の資料の登録と引用位置（指示書 §6.4 の 2 つ目の入口・§6.6）。
 *
 * 利用目的で「当年度の事実の根拠」を区別すること、抽出できないページを成功に見せず
 * 手動抜粋で補うこと、引用文が資料に実在すること、引用の利用先を逆引きできることを検査する。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  org: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: org,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);
const viewer = () => ctxFor('reviewer@demo.local', ['viewer']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const encoder = new TextEncoder();

function textInput(overrides: Partial<RegisterDocumentInput> = {}): RegisterDocumentInput {
  return {
    kind: 'qualitative',
    fileName: 'minutes.txt',
    mimeType: 'text/plain',
    bytes: encoder.encode(
      '第1章 開催概要\n\n取締役会は年4回、サステナビリティ委員会から報告を受ける。\n\n委員会は社外取締役を含む7名で構成する。',
    ),
    title: '2026年度 取締役会議事録（抜粋・架空）',
    reportingPeriodId: PERIOD_IDS.fy2026,
    editionLabel: '2026年7月 配布版',
    issuedOn: '2026-07-10',
    documentType: '議事録',
    confidentiality: 'internal',
    usagePurpose: 'current_fact',
    ...overrides,
  };
}

async function buildDocx(lines: string[]): Promise<Uint8Array> {
  const doc = new Document({
    sections: [{ children: lines.map((t) => new Paragraph({ children: [new TextRun(t)] })) }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

describe('資料の登録（資料名・年度・版・発行日・文書種別・機密区分・利用目的）', () => {
  it('定性情報の資料は利用目的が必須。選んだ機密区分・版・発行日を保存し、段落を抽出する', async () => {
    await expect(
      registerEvidenceDocument(db, manager(), textInput({ usagePurpose: '' })),
    ).rejects.toBeInstanceOf(ValidationError);

    const { file, extraction } = await registerEvidenceDocument(db, manager(), textInput());
    expect(file).toMatchObject({
      originalName: '2026年度 取締役会議事録（抜粋・架空）.txt',
      confidentiality: 'internal',
      usagePurpose: 'current_fact',
      editionLabel: '2026年7月 配布版',
      issuedOn: '2026-07-10',
      documentType: '議事録',
      reportingPeriodId: PERIOD_IDS.fy2026,
    });
    expect(extraction).toMatchObject({ status: 'extracted', fragmentCount: 3 });
    const loaded = await loadDocumentFragments(db, manager(), file.id);
    expect(loaded!.fragments.map((f) => f.locationLabel)).toEqual(['段落 1', '段落 2', '段落 3']);
    expect(loaded!.fragments.every((f) => !f.manual)).toBe(true);
  });

  it('証憑（利用目的なし）は従来どおり登録でき、機密区分の既定は「機密」', async () => {
    const { file } = await registerEvidenceDocument(
      db,
      manager(),
      textInput({ kind: 'evidence', usagePurpose: null, confidentiality: null, title: '' }),
    );
    expect(file.originalName).toBe('minutes.txt');
    expect(file.confidentiality).toBe('confidential');
    expect(file.usagePurpose).toBeNull();
  });

  it('Word は段落を抽出する。テキストを抽出できない PDF は成功に見せず手動抜粋へ誘導する', async () => {
    const docx = await registerEvidenceDocument(
      db,
      manager(),
      textInput({
        fileName: 'policy.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: await buildDocx(['気候変動方針', '当社は 2050 年のネットゼロを目指す（架空）。']),
        title: '',
      }),
    );
    expect(docx.extraction).toMatchObject({ status: 'extracted', fragmentCount: 2 });

    const pdf = await registerEvidenceDocument(
      db,
      manager(),
      textInput({
        fileName: 'scan.pdf',
        mimeType: 'application/pdf',
        bytes: encoder.encode('%PDF-1.4 画像だけの PDF を模したバイト列'),
        title: '',
      }),
    );
    expect(pdf.extraction.status).toBe('needs_manual');
    expect(pdf.extraction.fragmentCount).toBe(0);
    expect(pdf.extraction.message).toContain('手動抜粋');
    expect(fixture.fragments.filter((f) => f.fileVersionId === pdf.version.id)).toHaveLength(0);
  });

  it('許可しない拡張子・空のファイル・権限の無い利用者は登録できない', async () => {
    await expect(
      registerEvidenceDocument(db, manager(), textInput({ fileName: 'run.exe' })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      registerEvidenceDocument(db, manager(), textInput({ bytes: new Uint8Array() })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(registerEvidenceDocument(db, viewer(), textInput())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe('手動抜粋と引用位置', () => {
  it('手動抜粋は抽出結果として残り、そこからの引用は「手動の抜粋」として記録される', async () => {
    const { file } = await registerEvidenceDocument(
      db,
      manager(),
      textInput({
        fileName: 'scan.pdf',
        mimeType: 'application/pdf',
        bytes: encoder.encode('%PDF-x'),
        title: '',
      }),
    );
    await expect(
      addManualExcerpt(db, manager(), { fileId: file.id, page: 3, locator: '', text: ' ' }),
    ).rejects.toBeInstanceOf(ValidationError);

    const fragment = await addManualExcerpt(db, manager(), {
      fileId: file.id,
      page: 3,
      locator: '3ページ 表2の注記',
      text: '取締役会は年4回、委員会から報告を受ける。',
    });
    expect(fragment.locator).toBe('手動抜粋｜3ページ 表2の注記');

    const anchor = await createAnchorFromFragment(db, manager(), {
      fragmentId: fragment.id,
      quoteText: '年4回、委員会から報告を受ける',
    });
    expect(anchor).toMatchObject({
      anchorKind: 'manual_excerpt',
      acquiredBy: 'manual',
      fragmentId: fragment.id,
      page: 3,
    });
  });

  it('引用文は資料の該当箇所に実在する文言に限り、空の引用は登録しない。二重押下でも増えない', async () => {
    const fragmentId = disclosureFragmentId('fy2026-sustainability-committee-3', 'gov-2');
    await expect(
      createAnchorFromFragment(db, manager(), { fragmentId, quoteText: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createAnchorFromFragment(db, manager(), { fragmentId, quoteText: '年12回開催する' }),
    ).rejects.toBeInstanceOf(ValidationError);

    const first = await createAnchorFromFragment(db, manager(), {
      fragmentId,
      quoteText: '年4回開催する',
    });
    const again = await createAnchorFromFragment(db, manager(), {
      fragmentId,
      quoteText: '年4回開催する',
    });
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ anchorKind: 'heading_paragraph', acquiredBy: 'extracted' });
    expect(first.locator).toBe('第2章 2.1 第2段落');

    // 別テナントの利用者からは該当箇所が存在しないものとして扱う
    await expect(
      createAnchorFromFragment(db, otherTenant(), { fragmentId, quoteText: '年4回開催する' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // 引用位置の登録は開示の編集権限が必要
    await expect(
      createAnchorFromFragment(db, siteUser(), { fragmentId, quoteText: '年4回開催する' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('引用できる資料の一覧は利用目的を示し、引用の利用先（定性情報・原稿）を逆引きできる', async () => {
    const docs = await listDocumentsForCitation(db, manager());
    const committee = docs.find((d) => d.file.id === IDS.documents.committee.fileId)!;
    expect(committee.usagePurposeLabel).toBe('当年度の根拠');
    expect(committee.confidentialityLabel).toBe('機密');

    const usages = await listAnchorUsagesForFile(db, manager(), IDS.documents.committee.fileId);
    const gov1 = usages.find((u) => u.anchorId === IDS.anchors.committeeGovernance1)!;
    expect(gov1.narratives.map((n) => n.recordId)).toEqual([IDS.narratives.governance]);
    expect(gov1.blocks.map((b) => b.blockId).sort()).toEqual(
      [IDS.blocks.fy2026Governance.block, IDS.blocks.fy2026Esrs40aGovernance.block].sort(),
    );
    expect(
      await listAnchorUsagesForFile(db, otherTenant(), IDS.documents.committee.fileId),
    ).toEqual([]);
  });
});
