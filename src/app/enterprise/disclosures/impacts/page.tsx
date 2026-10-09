import Link from 'next/link';
import { BookOpen, FileQuestion, Globe, HandHeart, Plus, Settings2 } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AuthorizationError, can } from '@/lib/authorization/can';
import { ESRS_TOPIC_LABEL } from '@/lib/domain/csrd';
import { IRO_TYPE_LABEL } from '@/lib/domain/dma';
import {
  CSRD_LEDGER_NOTE,
  ESRS40A_REFERENCE_NOTE,
  LEDGER_PERSPECTIVE_NOTE,
  loadImpactLedger,
  type ImpactLedger,
  type ImpactLedgerRow,
} from '@/lib/services/impact-ledger';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import { ESRS_TOPICS, IRO_TYPES, type EsrsTopic, type IroType } from '@/types/domain';
import { DmaOutcomeBadge, ProvisionalBadge } from '../csrd/_components/csrd-badges';

export const metadata = { title: 'インパクト・リスク・機会の台帳' };

const BASE_PATH = '/enterprise/disclosures/impacts';
const MATTERS = '/enterprise/disclosures/csrd/settings/matters';

function isIroType(value: unknown): value is IroType {
  return typeof value === 'string' && (IRO_TYPES as readonly string[]).includes(value);
}

function isTopic(value: unknown): value is EsrsTopic {
  return typeof value === 'string' && (ESRS_TOPICS as readonly string[]).includes(value);
}

/**
 * インパクト・リスク・機会の台帳（トライアル対応 NF-10。スライド 7「インパクト記載情報の格納・整理」）。
 *
 * - 格納は CSRD の DMA の IRO（新しい表は作らない）。台帳は読み取り時に導く（書かない）
 * - 列で意味を分ける: CSRD（DMA の結果）と ESRS-40a（インパクト軸の参考・表示だけ）は「人・環境へのインパクト」、
 *   SSBJ は「企業への影響（財務的影響を含む）」を説明する定性情報。誠実さの注記は折りたたまない
 * - 主操作は「IRO を追加」（既存の事項の画面の作成パネル）。編集・削除は事項の画面で行う（DMA の確定を外す規則を保つ）
 */
export default async function ImpactLedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const type = isIroType(query.type) ? query.type : null;
  const topic = isTopic(query.topic) ? query.topic : null;
  const q = typeof query.q === 'string' ? query.q : '';

  let ledger: ImpactLedger | null;
  try {
    ledger = await loadImpactLedger(db, ctx, {
      periodId: shell.currentPeriod.id,
      filter: { type, topic, q },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader title="インパクト・リスク・機会の台帳" autoBreadcrumbs />
          <PermissionDeniedState
            description="インパクト・リスク・機会の台帳を見るには、開示の閲覧権限が必要です。"
            permission="enterprise.disclosure.read"
          />
        </>
      );
    }
    throw error;
  }

  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const addTopic: EsrsTopic = topic ?? 'E1';

  if (!ledger) {
    return (
      <>
        <PageHeader title="インパクト・リスク・機会の台帳" autoBreadcrumbs />
        <div className="p-4">
          <EmptyState
            kind="not-applicable"
            title="ESRS 項目マスターが登録されていません"
            description="インパクト・リスク・機会は CSRD（ESRS サンプル）のダブル・マテリアリティ評価に登録します。マスターの登録は管理者が行います。"
          />
        </div>
      </>
    );
  }

  const pageSize = parsePageSize(query.size);
  const page = Math.min(
    parsePage(query.page),
    Math.max(1, Math.ceil(ledger.rows.length / pageSize)),
  );
  const pageRows = ledger.rows.slice((page - 1) * pageSize, page * pageSize);

  const columns: DataTableColumn<ImpactLedgerRow>[] = [
    {
      key: 'topic',
      header: '事項',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      width: 'sm',
      cell: (row) => (
        <Link
          href={`${MATTERS}/${row.topic}`}
          className="whitespace-nowrap font-medium text-brand-800 hover:underline"
        >
          {row.topicLabel}
        </Link>
      ),
    },
    {
      key: 'type',
      header: '種別',
      importance: 'primary',
      cell: (row) => (
        <span className="flex flex-wrap gap-1 text-small">
          <Badge tone="neutral">
            {row.iro.iroType === 'impact' ? (
              <Globe className="size-3" aria-hidden="true" />
            ) : (
              <BookOpen className="size-3" aria-hidden="true" />
            )}
            {row.iroTypeLabel}
          </Badge>
          {row.occurrenceLabel && <span>{row.occurrenceLabel}</span>}
          {row.directionLabel && <span>・{row.directionLabel}</span>}
        </span>
      ),
    },
    {
      key: 'description',
      header: '記述',
      importance: 'primary',
      width: 'lg',
      cell: (row) => (
        <span className="text-small">
          {row.iro.description}
          {row.iro.subTopic && (
            <span className="block text-caption text-ink-muted">{row.iro.subTopic}</span>
          )}
        </span>
      ),
    },
    {
      key: 'stage',
      header: '段階・期間',
      importance: 'secondary',
      cell: (row) => (
        <span className="whitespace-nowrap text-small">
          {row.valueChainLabel}
          {row.timeHorizonLabel ? `／${row.timeHorizonLabel}` : ''}
        </span>
      ),
    },
    {
      key: 'stakeholders',
      header: '影響を受けるステークホルダー',
      importance: 'secondary',
      cell: (row) => (
        <span className="text-small">
          {row.iro.affectedStakeholders || '—'}
          {row.iro.humanRights && (
            <Badge tone="warning" className="ml-1">
              <HandHeart className="size-3" aria-hidden="true" />
              人権
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'evidence',
      header: '根拠件数',
      importance: 'secondary',
      align: 'right',
      cell: (row) => <span className="text-small">{row.evidenceCount}</span>,
    },
    {
      key: 'csrd',
      header: 'CSRD: 人・環境へのインパクト（DMA の結果）',
      importance: 'primary',
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          <DmaOutcomeBadge outcome={row.csrd.outcome} />
          {row.csrd.provisional && <ProvisionalBadge />}
        </span>
      ),
    },
    {
      key: 'esrs40a',
      header: 'ESRS-40a: 人・環境へのインパクト（参考）',
      importance: 'primary',
      cell: (row) =>
        row.esrs40a ? (
          <span className="text-small">
            インパクト軸: {row.esrs40a.label}
            <span className="block text-caption text-ink-muted">参考（判断ではない）</span>
          </span>
        ) : (
          <span className="text-caption text-ink-muted">—（リスク・機会は対象外）</span>
        ),
    },
    {
      key: 'ssbj',
      header: 'SSBJ: 企業への影響（財務的影響を含む）',
      importance: 'primary',
      width: 'md',
      cell: (row) =>
        row.ssbj.length === 0 ? (
          <span className="text-caption text-ink-muted">説明する定性情報なし</span>
        ) : (
          <ul className="space-y-0.5 text-small">
            {row.ssbj.map((n) => (
              <li key={n.recordId}>
                <Link
                  href={`/enterprise/narratives/${n.recordId}`}
                  className="text-brand-800 hover:underline"
                >
                  {n.title}
                </Link>
                <span className="text-caption text-ink-muted">
                  （{n.themeLabel}・版 {n.versionNo}）
                </span>
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: 'policy',
      header: '方針・取組',
      importance: 'detail',
      width: 'md',
      cell: (row) => <span className="text-small">{row.iro.policyActionNote || '—'}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="インパクト・リスク・機会の台帳"
        description={`${shell.currentPeriod.label} ／ ${ledger.versionLabel}`}
        help={
          <p>
            CSRD
            のダブル・マテリアリティ評価に登録したインパクト・リスク・機会（IRO）を、基準ごとの見え方と並べます。
            編集・削除は事項の画面で行います（保存すると DMA
            の確定は取り消されます）。定性情報（リスク・機会／財務的影響）
            の編集画面で「関連するインパクト・リスク・機会」を選ぶと、SSBJ の列に出ます。
          </p>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'add-iro',
              label: 'IRO を追加',
              href: `${MATTERS}/${addTopic}?new=1#csrd-iro-create`,
              icon: <Plus aria-hidden="true" />,
              hidden: !canWrite,
            }}
            secondary={[
              {
                kind: 'link',
                id: 'csrd-settings',
                label: 'CSRD の設定（DMA）',
                href: '/enterprise/disclosures/csrd/settings',
                icon: <Settings2 aria-hidden="true" />,
              },
            ]}
            more={[
              {
                kind: 'link',
                id: 'narratives',
                label: '定性情報',
                href: '/enterprise/narratives',
                icon: <BookOpen aria-hidden="true" />,
              },
            ]}
          />
        }
      />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 列の意味と位置付け（誠実さの注記。折りたたまない） */}
        <div className="space-y-1 rounded-t4d-lg border border-line bg-surface px-3 py-2 text-small">
          <p className="text-ink">{LEDGER_PERSPECTIVE_NOTE}</p>
          <p className="flex flex-wrap items-center gap-1.5">
            <HonestyBadge kind="sample-master" />
            <span>CSRD: {CSRD_LEDGER_NOTE}</span>
          </p>
          <p className="flex flex-wrap items-center gap-1.5">
            <Badge tone="warning">
              <FileQuestion className="size-3" aria-hidden="true" />
              公開草案
            </Badge>
            <span>ESRS-40a: {ESRS40A_REFERENCE_NOTE}</span>
          </p>
          {!ledger.dmaConfirmed && (
            <p className="text-caption text-warning-ink">
              DMA が未確定のため、CSRD の結果は暫定です（確定は CSRD の設定で人が行います）。
            </p>
          )}
          <p className="text-caption text-ink-muted">
            全 {ledger.total} 件（
            {IRO_TYPES.map((t) => `${IRO_TYPE_LABEL[t]} ${ledger.countsByType[t]}`).join('・')}）
          </p>
        </div>

        <DataTable
          id="impact-ledger"
          caption="インパクト・リスク・機会の台帳"
          columns={columns}
          rows={pageRows}
          getRowId={(row) => row.iro.id}
          getRowLabel={(row) => row.iro.description}
          searchParams={query}
          basePath={BASE_PATH}
          search={{ placeholder: '記述・サブトピック・ステークホルダーで検索' }}
          filters={[
            {
              key: 'type',
              label: '種別',
              multiple: false,
              options: IRO_TYPES.map((t) => ({ value: t, label: IRO_TYPE_LABEL[t] })),
            },
          ]}
          overflowFilters={[
            {
              key: 'topic',
              label: '事項',
              multiple: false,
              options: ESRS_TOPICS.map((t) => ({ value: t, label: `${t} ${ESRS_TOPIC_LABEL[t]}` })),
            },
          ]}
          page={{ page, pageSize, total: ledger.rows.length, sizes: DEFAULT_PAGE_SIZES }}
          className="rounded-t4d-lg border border-line bg-surface"
          empty={{
            noData: {
              title: 'インパクト・リスク・機会はまだありません',
              description: canWrite
                ? 'CSRD の設定の事項の画面で IRO を登録すると、ここに並びます。'
                : 'IRO は作成担当（開示の編集権限を持つ人）が CSRD の設定で登録します。',
              action: (
                <Button variant="secondary" size="sm" asChild>
                  <Link href="/enterprise/disclosures/csrd/settings">CSRD の設定を開く</Link>
                </Button>
              ),
            },
            filtered: { title: '該当するインパクト・リスク・機会はありません' },
          }}
        />
      </div>
    </>
  );
}
