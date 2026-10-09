import 'server-only';

import { can } from '@/lib/authorization/can';
import { frameworkLegalLabel } from '@/lib/domain/disclosure-status';
import { normalizePaletteText, type PaletteEntry } from '@/lib/ui/palette';
import { hasOption } from '@/lib/services/organization-options';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, FrameworkKey, Uuid } from '@/types/domain';

/**
 * Command Palette のデータの検索（plan §1.10・§4 B2）。読み取りだけ（書き込み・状態の作成をしない）。
 *
 * - 2 文字以上・種類ごとに 8 件まで（件数の多い組織で遅くしない）
 * - 権限で種類ごとに出し分ける（画面のゲートと同じ）: 指標・拠点はデータの閲覧、CSRD・プロジェクト・原稿・
 *   定性情報は開示の閲覧、資料は資料の閲覧、メンバーはメンバーの管理だけ
 * - 自分の組織（ワークスペース）の行だけを読む（他テナントを返さない）。監査法人は自分がアサインされた案件だけ
 * - 読み方は既存の画面・サービスと同じ（organizationId での絞り込み・論理削除の除外）。Supabase では RLS も通る
 * 評価の行を「その場で作る」サービス（loadSsbjRequirementViews など）は呼ばない（検索で書き込まないため）
 */

export const PALETTE_SEARCH_MIN_LENGTH = 2;
export const PALETTE_SEARCH_LIMIT_PER_KIND = 8;

export interface PaletteSearchResult {
  entries: PaletteEntry[];
}

function matches(query: string, ...texts: Array<string | null | undefined>): boolean {
  const q = normalizePaletteText(query);
  const haystack = normalizePaletteText(texts.filter(Boolean).join(' '));
  return q.split(' ').every((word) => haystack.includes(word));
}

function entry(kind: string, id: string, label: string, href: string): PaletteEntry {
  return { id: `data:${kind}:${id}`, group: 'data', label, href, hint: kind };
}

/**
 * 基準の現行版の要求事項と、種類の表示名。架空の縮小マスター（サンプル）は表示名に必ず
 * 「（サンプル・架空）」を添える。一覧・詳細の画面はマスターの位置付けを示しているが、検索の候補だけ
 * 種類しか出さず、架空の設問が正式な ESRS・CDP の要求事項に見えていた（指示書 §8.1・§14.3）
 */
async function frameworkItems(db: DbClient, key: FrameworkKey, kind: string) {
  const frameworks = await db.select('frameworks', { where: { key }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return { kind, items: [] };
  const versions = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id },
    orderBy: { column: 'year', dir: 'desc' },
  });
  const current = versions.find((v) => v.status === 'published') ?? versions[0];
  if (!current) return { kind, items: [] };
  const items = await db.select('disclosureItems', {
    where: { frameworkVersionId: current.id },
    orderBy: { column: 'sortOrder' },
  });
  const sample = frameworkLegalLabel(current) === SAMPLE_LEGAL_LABEL;
  return { kind: sample ? `${kind}（サンプル・架空）` : kind, items };
}

/** frameworkLegalLabel が架空の縮小マスターに返す表示 */
const SAMPLE_LEGAL_LABEL = frameworkLegalLabel({ legalStatus: 'sample' });

export async function searchPalette(
  db: DbClient,
  ctx: AuthorizationContext,
  rawQuery: string,
): Promise<PaletteSearchResult> {
  const query = rawQuery.trim();
  if (normalizePaletteText(query).length < PALETTE_SEARCH_MIN_LENGTH) return { entries: [] };
  const limit = PALETTE_SEARCH_LIMIT_PER_KIND;
  const organizationId = ctx.workspace.organizationId;
  const out: PaletteEntry[] = [];

  if (ctx.workspace.organizationType === 'assurance_firm') {
    if (!can(ctx, 'assurance.engagement.read') || ctx.engagementIds.length === 0) {
      return { entries: [] };
    }
    const engagements = await db.select('engagements', {
      where: { id: { in: ctx.engagementIds }, assuranceFirmId: organizationId },
    });
    for (const e of engagements.filter((e) => matches(query, e.code, e.name)).slice(0, limit)) {
      out.push(
        entry('案件', e.id, `${e.code} ${e.name}`, `/assurance/engagements/${e.id}/overview`),
      );
    }
    return { entries: out };
  }
  if (ctx.workspace.organizationType !== 'enterprise') return { entries: [] };

  const tasks: Array<Promise<void>> = [];

  if (can(ctx, 'enterprise.data.read')) {
    tasks.push(
      (async () => {
        const [metrics, units] = await Promise.all([
          db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
          db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
        ]);
        for (const m of metrics.filter((m) => matches(query, m.name, m.code)).slice(0, limit)) {
          out.push(
            entry('指標', m.id, `${m.name}（${m.code}）`, `/enterprise/data?metric=${m.id}`),
          );
        }
        for (const u of units.filter((u) => matches(query, u.name, u.code)).slice(0, limit)) {
          out.push(
            entry('組織・拠点', u.id, `${u.name}（${u.code}）`, `/enterprise/data?unit=${u.id}`),
          );
        }
      })(),
    );
    tasks.push(
      (async () => {
        const { kind, items } = await frameworkItems(db, 'ssbj', 'SSBJ 要求事項');
        for (const item of items
          .filter((i) => matches(query, i.code, i.questionText))
          .slice(0, limit)) {
          out.push(
            entry(
              kind,
              item.id,
              `${item.code} ${item.questionText}`,
              `/enterprise/disclosures/ssbj/requirements/${item.id}`,
            ),
          );
        }
      })(),
    );
    tasks.push(
      (async () => {
        // CDP 対応オプションの無い組織には CDP の質問を出さない（plan NF-38。画面も理由を出して止める）
        if (!(await hasOption(db, ctx, 'cdp'))) return;
        const { kind, items } = await frameworkItems(db, 'cdp', 'CDP 質問');
        for (const item of items
          .filter((i) => matches(query, i.code, i.questionText))
          .slice(0, limit)) {
          out.push(
            entry(
              kind,
              item.id,
              `${item.code} ${item.questionText}`,
              `/enterprise/disclosures/cdp/${item.id}`,
            ),
          );
        }
      })(),
    );
  }

  if (can(ctx, 'enterprise.disclosure.read')) {
    tasks.push(
      (async () => {
        const { kind, items } = await frameworkItems(db, 'csrd', 'CSRD 要求事項');
        for (const item of items
          .filter((i) => matches(query, i.code, i.questionText))
          .slice(0, limit)) {
          out.push(
            entry(
              kind,
              item.id,
              `${item.code} ${item.questionText}`,
              `/enterprise/disclosures/csrd/requirements/${item.id}`,
            ),
          );
        }
      })(),
    );
    tasks.push(
      (async () => {
        const [projects, blocks, narratives] = await Promise.all([
          db.select('disclosureProjects', {
            where: { organizationId, deletedAt: { isNull: true } },
          }),
          db.select('disclosureBlocks', {
            where: { organizationId, deletedAt: { isNull: true } },
          }),
          db.select('narrativeRecords', {
            where: { organizationId, deletedAt: { isNull: true } },
          }),
        ]);
        for (const p of projects.filter((p) => matches(query, p.name)).slice(0, limit)) {
          out.push(
            entry('開示プロジェクト', p.id, p.name, `/enterprise/disclosure-projects/${p.id}`),
          );
        }
        for (const b of blocks.filter((b) => matches(query, b.title)).slice(0, limit)) {
          out.push(
            entry(
              '原稿',
              b.id,
              b.title,
              `/enterprise/disclosure-projects/${b.projectId}/blocks/${b.id}`,
            ),
          );
        }
        for (const n of narratives
          .filter((n) => matches(query, n.title, n.ownerDepartment, ...(n.tags ?? [])))
          .slice(0, limit)) {
          out.push(entry('定性情報', n.id, n.title, `/enterprise/narratives/${n.id}`));
        }
      })(),
    );
  }

  if (can(ctx, 'enterprise.evidence.read')) {
    tasks.push(
      (async () => {
        const files = await db.select('files', {
          where: { organizationId, deletedAt: { isNull: true } },
          orderBy: { column: 'createdAt', dir: 'desc' },
        });
        for (const f of files
          .filter((f) => matches(query, f.originalName, f.documentType, f.editionLabel))
          .slice(0, limit)) {
          out.push(entry('資料', f.id, f.originalName, `/enterprise/evidence/${f.id}`));
        }
      })(),
    );
  }

  // 行き先の設定の画面は企業管理者だけが開ける（R1 は見送り）
  if (can(ctx, 'enterprise.member.manage') && can(ctx, 'enterprise.org.manage')) {
    tasks.push(
      (async () => {
        const memberships = await db.select('memberships', {
          where: { organizationId, status: 'active' },
        });
        if (memberships.length === 0) return;
        const profiles = await db.select('profiles', {
          where: { id: { in: memberships.map((m) => m.userId) as Uuid[] } },
        });
        for (const p of profiles
          .filter((p) => matches(query, p.displayName, p.email))
          .slice(0, limit)) {
          out.push(entry('メンバー', p.id, p.displayName, '/enterprise/settings?tab=members'));
        }
      })(),
    );
  }

  await Promise.all(tasks);
  // 種類の並びを一定にする（非同期の完了順に左右されない）
  const order = [
    '指標',
    '組織・拠点',
    'SSBJ 要求事項',
    'CSRD 要求事項',
    'CDP 質問',
    '開示プロジェクト',
    '原稿',
    '定性情報',
    '資料',
    'メンバー',
  ];
  return {
    entries: out.sort((a, b) => order.indexOf(a.hint ?? '') - order.indexOf(b.hint ?? '')),
  };
}
