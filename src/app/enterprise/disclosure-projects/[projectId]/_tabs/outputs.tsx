import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  History,
  Info,
  Lock,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import {
  APPLICABILITY_STATUS_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
  EXPORT_ARTIFACT_FORMAT_LABELS,
} from '@/lib/domain/disclosure-status';
import { AUDIENCE_DISPLAY } from '@/lib/exports/disclosure-report';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { listExportArtifacts } from '@/lib/services/disclosure-export';
import {
  SNAPSHOT_KIND_DISPLAY,
  evaluateReportReadiness,
  listProjectSnapshots,
  type SnapshotListEntry,
} from '@/lib/services/report-snapshot';
import type { ExportArtifactFormat, ExportAudience, ReportSnapshotKind } from '@/types/domain';
import { confirmReportAction, createReviewDraftSnapshotAction } from '../outputs/actions';

/**
 * 開示プロジェクトの「出力」タブ（指示書 §6.10、docs/disclosure-first.md §5「レポート確定」「出力」）。
 *
 * - 出力する版を「レビュー用草稿」「社内承認済み版」から選ぶ。どちらもスナップショットを作ってから、
 *   そのスナップショットだけを元に DOCX / XLSX / CSV を生成する（ライブの値から組み立てない）。
 * - 確定ボタンは阻害条件があれば無効にし、理由を並べる。無効化は表示だけで、
 *   確定の操作でもサーバー（confirmReport）が同じ判定をやり直す。
 * - ファイルの作成は提出ではない。社内承認は第三者保証ではない（どちらも画面に明記する）。
 * - スナップショット作成後に上流が変わった場合は注意として示すだけで、スナップショットは変えない（§10.3）。
 */

type SearchParams = Record<string, string | string[] | undefined>;

function param(searchParams: SearchParams, key: string): string | null {
  const value = searchParams[key];
  return typeof value === 'string' ? value : null;
}

function exportHref(
  snapshot: { id: string; projectId: string },
  format: ExportArtifactFormat,
  audience: ExportAudience,
  frameworkVersionId?: string,
): string {
  // project は、出力できなかったとき（デモで別のサーバーに当たったなど）に出力タブへ戻して理由を示すため
  const query = new URLSearchParams({ format, audience, project: snapshot.projectId });
  if (frameworkVersionId) query.set('framework', frameworkVersionId);
  return `/api/exports/disclosure-snapshots/${encodeURIComponent(snapshot.id)}?${query.toString()}`;
}

function SnapshotKindBadge({ kind }: { kind: ReportSnapshotKind }) {
  return kind === 'approved' ? (
    <Badge tone="success">
      <BadgeCheck className="size-3" aria-hidden="true" />
      {SNAPSHOT_KIND_DISPLAY.approved}
    </Badge>
  ) : (
    <Badge tone="outline">
      <FileText className="size-3" aria-hidden="true" />
      {SNAPSHOT_KIND_DISPLAY.review_draft}
    </Badge>
  );
}

function DownloadLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="outline" size="xs">
      {/* download 属性は付けない（失敗時の出力タブへの戻りをファイルとして保存させない）。
          成功時は Content-Disposition: attachment でダウンロードになる */}
      <a href={href}>
        <Download aria-hidden="true" />
        {children}
      </a>
    </Button>
  );
}

function SnapshotDownloads({ entry, canExport }: { entry: SnapshotListEntry; canExport: boolean }) {
  const { snapshot } = entry;
  if (!canExport) {
    return (
      <p className="flex items-center gap-1 text-[11px] text-ink-muted">
        <Lock className="size-3" aria-hidden="true" />
        出力の権限がありません
      </p>
    );
  }
  if (!entry.integrityOk) {
    return (
      <Badge tone="danger">
        <AlertTriangle className="size-3" aria-hidden="true" />
        内容ハッシュ不一致のため出力できません
      </Badge>
    );
  }
  return (
    <div className="space-y-1">
      {snapshot.frameworkVersions.map((framework) => (
        <div key={framework.frameworkVersionId} className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] text-ink-muted">DOCX 原稿（{framework.label}）</span>
          <DownloadLink
            href={exportHref(snapshot, 'docx', 'internal', framework.frameworkVersionId)}
          >
            社内確認用
          </DownloadLink>
          <DownloadLink
            href={exportHref(snapshot, 'docx', 'external', framework.frameworkVersionId)}
          >
            対外用
          </DownloadLink>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[11px] text-ink-muted">対応表・数値</span>
        <DownloadLink href={exportHref(snapshot, 'xlsx', 'internal')}>
          XLSX 対応表（社内確認用）
        </DownloadLink>
        <DownloadLink href={exportHref(snapshot, 'csv', 'internal')}>
          CSV 数値（社内確認用）
        </DownloadLink>
        <DownloadLink href={exportHref(snapshot, 'csv', 'external')}>
          CSV 数値（対外用）
        </DownloadLink>
      </div>
    </div>
  );
}

export async function OutputsTab({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: SearchParams;
}) {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  if (!can(ctx, 'enterprise.disclosure.read')) {
    return (
      <p className="flex items-center gap-1.5 p-4 text-[12px] text-ink-muted">
        <Lock className="size-3.5" aria-hidden="true" />
        出力の確認には開示の閲覧権限が必要です。
      </p>
    );
  }

  const [readiness, snapshots] = await Promise.all([
    evaluateReportReadiness(db, ctx, projectId),
    listProjectSnapshots(db, ctx, projectId),
  ]);
  const artifacts = await listExportArtifacts(
    db,
    ctx,
    snapshots.map((s) => s.snapshot.id),
  );
  const snapshotNoById = new Map(
    snapshots.map((s) => [
      s.snapshot.id,
      `${SNAPSHOT_KIND_DISPLAY[s.snapshot.snapshotKind]} No.${s.snapshot.snapshotNo}`,
    ]),
  );

  const canDraft = can(ctx, 'enterprise.disclosure.write') || can(ctx, 'enterprise.export.run');
  const canExport = can(ctx, 'enterprise.export.run');
  // 番号以外が載った URL（手で作られたもの）で「作成しました」と見せない
  const createdParam = param(searchParams, 'snapshotCreated');
  const created = createdParam && /^\d{1,6}$/.test(createdParam) ? createdParam : null;
  const createdKind = param(searchParams, 'kind') === 'approved' ? 'approved' : 'review_draft';
  // 作成したスナップショットが、この一覧（このサーバーのメモリ）にあるか。デモでは作成したサーバーと
  // 一覧を描くサーバーが違うことがあり、無いのに「下の一覧から出力できます」と言わない
  const createdListed =
    created !== null &&
    snapshots.some(
      (s) => s.snapshot.snapshotKind === createdKind && String(s.snapshot.snapshotNo) === created,
    );
  const outputError = param(searchParams, 'outputError');
  const blockerListId = `report-blockers-${projectId}`;
  const MAX_BLOCKERS = 8;

  return (
    <div className="space-y-3">
      {outputError && (
        <p
          role="alert"
          className="flex items-center gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {outputError}
        </p>
      )}
      {created && createdListed && (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 rounded-t4d border border-success/40 bg-success-soft px-3 py-1.5 text-[12px] text-ink"
        >
          <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden="true" />
          {SNAPSHOT_KIND_DISPLAY[createdKind]}
          のスナップショット No.{created} を作成しました。下の一覧から出力できます。
        </p>
      )}
      {created && !createdListed && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-[12px] text-ink"
          data-testid="snapshot-created-elsewhere"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#8a5d00]" aria-hidden="true" />
          <span>
            {SNAPSHOT_KIND_DISPLAY[createdKind]}のスナップショット No.{created}
            は作成しましたが、この画面を表示したサーバーの一覧にはありません
            {db.mode === 'demo'
              ? '（デモ環境ではスナップショットをこのブラウザの Cookie で持ち回すため、別のブラウザで作成した・古い操作が押し出された・固定した元の行が変わった可能性があります）'
              : ''}
            。一覧に無い場合は、作成し直してから出力してください。
          </span>
        </p>
      )}

      <div
        role="note"
        className="space-y-0.5 rounded-t4d border border-brand-200 bg-brand-50 px-3 py-2 text-[12px] text-brand-900"
      >
        <p className="flex items-start gap-1.5">
          <Info className="mt-0.5 size-3.5 shrink-0 text-brand-600" aria-hidden="true" />
          <span>
            ファイル作成は提出ではありません（開示先へ提出・公表したことにはなりません）。
            {SNAPSHOT_KIND_DISPLAY.approved}
            は社内の承認であり、第三者による保証ではありません。
          </span>
        </p>
        {db.mode === 'demo' && (
          <p className="pl-5 text-[11px]">
            デモではスナップショットの目録をこのブラウザの Cookie
            で持ち回します。別のブラウザや、Cookie
            の容量不足で古い操作が押し出された後は一覧から消えることがあります（本番は追記専用の表に保存します）。
          </p>
        )}
      </div>

      {/* 出力する版を選ぶ */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <FileText className="size-4 text-brand-600" aria-hidden="true" />
              {SNAPSHOT_KIND_DISPLAY.review_draft}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <CardDescription>
              保存済みの版をそのまま固定します（自動保存中の本文は含めません）。未承認の節・不足情報は出力に「草稿・未承認箇所あり」として明示します。
            </CardDescription>
            {canDraft ? (
              <form action={createReviewDraftSnapshotAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton
                  size="sm"
                  variant="outline"
                  pendingLabel="作成中…"
                  icon={<FileText aria-hidden="true" />}
                >
                  {SNAPSHOT_KIND_DISPLAY.review_draft}を作成
                </SubmitButton>
              </form>
            ) : (
              <p className="flex items-center gap-1 text-[11px] text-ink-muted">
                <Lock className="size-3" aria-hidden="true" />
                草稿の作成には開示の編集または出力の権限が必要です。
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <BadgeCheck className="size-4 text-brand-600" aria-hidden="true" />
              {SNAPSHOT_KIND_DISPLAY.approved}（レポートの確定）
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <CardDescription>
              適用する基準の全節が承認済みで阻害条件が無いときだけ確定できます。確定の操作でも、サーバーで同じ条件を確かめ直します。
            </CardDescription>
            {readiness.draftStandardPrep && (
              <p className="flex items-start gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1 text-[11px] text-ink">
                <AlertTriangle
                  className="mt-0.5 size-3 shrink-0 text-[#8a5d00]"
                  aria-hidden="true"
                />
                草案の基準による準備を含みます。確定しても「草案基準による準備」として扱い、法定準拠の確定にはなりません。
              </p>
            )}
            <form action={confirmReportAction} className="space-y-2">
              <input type="hidden" name="projectId" value={projectId} />
              <SubmitButton
                size="sm"
                pendingLabel="確定中…"
                icon={<BadgeCheck aria-hidden="true" />}
                disabled={!readiness.canConfirm}
                aria-describedby={readiness.canConfirm ? undefined : blockerListId}
              >
                レポートを確定する
              </SubmitButton>
            </form>
            {!readiness.canConfirm && (
              <div id={blockerListId} className="text-[12px]">
                <p className="flex items-center gap-1 font-medium text-ink">
                  <AlertTriangle className="size-3.5 text-[#8a5d00]" aria-hidden="true" />
                  確定できない理由（
                  {readiness.actorBlockers.length + readiness.blockers.length} 件）
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-muted">
                  {readiness.actorBlockers.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                  {readiness.blockers.slice(0, MAX_BLOCKERS).map((blocker, index) => (
                    <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
                  ))}
                </ul>
                {readiness.blockers.length > MAX_BLOCKERS && (
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    ほか {readiness.blockers.length - MAX_BLOCKERS} 件
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 基準ごとの出力対象 */}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>基準ごとの出力対象</CardTitle>
        </CardHeader>
        <div className="t4d-scroll-x">
          <Table>
            <THead>
              <TR>
                <TH>基準</TH>
                <TH>目的</TH>
                <TH>適用判断</TH>
                <TH>区分</TH>
                <TH align="right">節</TH>
                <TH>出力</TH>
              </TR>
            </THead>
            <TBody>
              {readiness.frameworks.map((f) => (
                <TR key={f.frameworkVersionId}>
                  <TD className="font-medium">{f.label}</TD>
                  <TD>{DISCLOSURE_PURPOSE_LABELS[f.purpose]}</TD>
                  <TD>
                    {APPLICABILITY_STATUS_LABELS[f.applicabilityStatus]}
                    {!f.decided && (
                      <span className="ml-1 text-[11px] text-ink-muted">（判断未確定）</span>
                    )}
                  </TD>
                  <TD>{f.draftStandardPrep ? '草案基準による準備' : '—'}</TD>
                  <TD align="right">{f.blockCount}</TD>
                  <TD>{f.included ? '含める' : '含めない（対象外と判断）'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Card>

      {/* スナップショット一覧 */}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <History className="size-4 text-brand-600" aria-hidden="true" />
            スナップショット
          </CardTitle>
          <span className="text-[11px] text-ink-muted">{snapshots.length} 件（新しい順）</span>
        </CardHeader>
        {snapshots.length === 0 ? (
          <p className="px-3 py-4 text-[12px] text-ink-muted">
            まだスナップショットがありません。上のどちらかの版を作成すると、ここから出力できます。
          </p>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <THead className="sticky top-0 z-10 bg-surface">
                <TR>
                  <TH>No.</TH>
                  <TH>種別</TH>
                  <TH>作成</TH>
                  <TH>内容ハッシュ</TH>
                  <TH>上流の変更</TH>
                  <TH>出力</TH>
                </TR>
              </THead>
              <TBody>
                {snapshots.map((entry) => (
                  <TR key={entry.snapshot.id} className="align-top">
                    <TD className="tnum align-top">{entry.snapshot.snapshotNo}</TD>
                    <TD className="align-top">
                      <SnapshotKindBadge kind={entry.snapshot.snapshotKind} />
                      <p className="mt-0.5 text-[11px] text-ink-muted">{entry.snapshot.label}</p>
                    </TD>
                    <TD className="align-top text-[12px]">
                      {entry.createdByName}
                      <br />
                      <span className="text-ink-muted">{formatJst(entry.snapshot.createdAt)}</span>
                    </TD>
                    <TD className="align-top">
                      <code className="text-[11px]" title={entry.snapshot.contentHash}>
                        {entry.snapshot.contentHash.slice(0, 12)}
                      </code>
                    </TD>
                    <TD className="align-top text-[12px]">
                      {entry.upstreamChanges.length === 0 ? (
                        <span className="text-ink-muted">なし</span>
                      ) : (
                        <details>
                          <summary className="cursor-pointer text-[#8a5d00]">
                            <AlertTriangle
                              className="mr-1 inline size-3 align-[-2px]"
                              aria-hidden="true"
                            />
                            作成後に上流が更新（{entry.upstreamChanges.length} 件）
                          </summary>
                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-ink-muted">
                            {entry.upstreamChanges.map((change, index) => (
                              <li key={index}>
                                {change.label}: {change.detail}
                              </li>
                            ))}
                          </ul>
                          <p className="mt-1 text-[11px] text-ink-muted">
                            このスナップショットの内容は変わりません。最新の内容で出力するには新しいスナップショットを作成してください。
                          </p>
                        </details>
                      )}
                    </TD>
                    <TD className="align-top">
                      <SnapshotDownloads entry={entry} canExport={canExport} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>

      {/* 出力の記録 */}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <FileSpreadsheet className="size-4 text-brand-600" aria-hidden="true" />
            出力の記録
          </CardTitle>
        </CardHeader>
        <p className="px-3 pt-2 text-[11px] text-ink-muted">
          同じスナップショットから再出力すると、内容ハッシュ（本文・数値・参照）は一致します。ファイルのハッシュは生成日時を含むため、DOCX・XLSX
          では出力ごとに変わります。
        </p>
        {artifacts.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-ink-muted">まだ出力していません。</p>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <THead className="sticky top-0 z-10 bg-surface">
                <TR>
                  <TH>出力日時</TH>
                  <TH>スナップショット</TH>
                  <TH>形式</TH>
                  <TH>区分</TH>
                  <TH>ファイル名</TH>
                  <TH>出力者</TH>
                  <TH align="right">サイズ</TH>
                  <TH>ファイルのハッシュ</TH>
                  <TH>内容ハッシュ</TH>
                </TR>
              </THead>
              <TBody>
                {artifacts.map((artifact) => (
                  <TR key={artifact.id}>
                    <TD className="text-[12px]">{formatJst(artifact.generatedAt)}</TD>
                    <TD className="text-[12px]">
                      {snapshotNoById.get(artifact.snapshotId) ??
                        '（このサーバーに無いスナップショット）'}
                    </TD>
                    <TD className="text-[12px]">
                      {EXPORT_ARTIFACT_FORMAT_LABELS[artifact.format]}
                    </TD>
                    <TD className="text-[12px]">{AUDIENCE_DISPLAY[artifact.audience]}</TD>
                    <TD className="max-w-[280px] truncate text-[12px]" title={artifact.fileName}>
                      {artifact.fileName}
                    </TD>
                    <TD className="text-[12px]">{artifact.generatedByName}</TD>
                    <TD align="right" className="text-[12px]">
                      {formatNumber(artifact.byteSize)} B
                    </TD>
                    <TD>
                      <code className="text-[11px]" title={artifact.fileSha256}>
                        {artifact.fileSha256.slice(0, 12)}
                      </code>
                    </TD>
                    <TD>
                      <code className="text-[11px]" title={artifact.contentHash}>
                        {artifact.contentHash.slice(0, 12)}
                      </code>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
