import 'server-only';

import {
  checkTranscription,
  type TranscriptionCheck,
  type TranscriptionNarrativeInput,
} from '@/lib/domain/transcription';
import type { DbClient } from '@/lib/repositories/types';
import { getProject } from '@/lib/services/disclosure-project';
import type { AuthorizationContext, Uuid } from '@/types/domain';

/**
 * 転記・再利用の点検（トライアル対応 NF-18）。プロジェクトの原稿の現在の版を数えるだけ（書き込まない）。
 * 規則は src/lib/domain/transcription.ts。権限は開示プロジェクトの閲覧（getProject が確かめる）。
 */
export async function loadTranscriptionCheck(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid },
): Promise<TranscriptionCheck> {
  const detail = await getProject(db, ctx, input.projectId);
  const organizationId = detail.project.organizationId;
  const versionIds = detail.blocks
    .map((b) => b.currentVersionId)
    .filter((id): id is Uuid => id !== null);
  const versions =
    versionIds.length > 0
      ? await db.select('disclosureBlockVersions', {
          where: { organizationId, id: { in: versionIds } },
        })
      : [];
  const byId = new Map(versions.map((v) => [v.id, v]));

  const narrativeVersionIds = [
    ...new Set(
      versions.flatMap((v) =>
        v.body.paragraphs.flatMap((p) =>
          p.children.flatMap((i) => (i.t === 'narrative' ? [i.narrativeVersionId] : [])),
        ),
      ),
    ),
  ];
  const narrativeVersions =
    narrativeVersionIds.length > 0
      ? await db.select('narrativeVersions', {
          where: { organizationId, id: { in: narrativeVersionIds } },
        })
      : [];
  const records =
    narrativeVersions.length > 0
      ? await db.select('narrativeRecords', {
          where: {
            organizationId,
            id: { in: [...new Set(narrativeVersions.map((v) => v.narrativeRecordId))] },
          },
        })
      : [];
  const narratives: TranscriptionNarrativeInput[] = narrativeVersions.map((v) => ({
    versionId: v.id,
    title: `${records.find((r) => r.id === v.narrativeRecordId)?.title ?? '（定性情報）'}（版 ${v.versionNo}）`,
  }));

  return checkTranscription(
    detail.blocks.map((block) => ({
      blockId: block.id,
      title: block.title,
      frameworkVersionId: block.frameworkVersionId,
      body: block.currentVersionId ? (byId.get(block.currentVersionId)?.body ?? null) : null,
      translation: block.translationOfBlockId !== null,
    })),
    narratives,
  );
}
