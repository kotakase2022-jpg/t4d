import Link from 'next/link';
import { FileArchive } from 'lucide-react';
import { CreatePanel, createPanelHref } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { BACKUP_RESIDUAL_DAYS_MAX } from '@/lib/domain/data-disposal';
import { formatJst } from '@/lib/format/datetime';
import {
  AI_PROVIDER_STORAGE_LABELS,
  AI_TRAINING_USE_LABELS,
  dataTermsItems,
  MAX_SUBPROCESSORS,
  NDA_STATUS_LABELS,
  normalizeSubprocessor,
  SUBPROCESSOR_CATEGORY_ORDER,
  SUBPROCESSOR_FIELD_LIMITS,
  type DataTermsItemView,
  type DataTermsView,
  type SubprocessorRow,
  type SystemFact,
} from '@/lib/services/data-terms';
import type { TenantExportPlan } from '@/lib/services/tenant-export';
import { statusLabel } from '@/lib/ui/status/registry';
import {
  AI_PROVIDER_STORAGES,
  AI_TRAINING_USES,
  NDA_STATUSES,
  type SubprocessorCategory,
} from '@/types/domain';
import { recordDataTermsAction } from '../actions';
import { TenantExportDialog } from '../_components/tenant-export-dialog';

/**
 * 設定「データの取扱い」タブ（トライアル対応 NF-28・NF-29・NF-30）。
 *  - 上段: システムの実態（設定から自動で読む。推測の値・最終バックアップ日時は出さない）
 *  - 下段: 合意した条件（版・追記）。未合意の項目は「未合意」と出す（推測で埋めない）
 *  - 終了時: 全データの書き出し（返却用。確認ダイアログ）と、削除は運営が手順書で行うこと
 */

const BASE = '/enterprise/settings';

export function dataHandlingHref(extra?: Record<string, string>): string {
  return `${BASE}?${new URLSearchParams({ tab: 'data-handling', ...extra }).toString()}`;
}

/** 全データの書き出しの失敗（API が戻す種類）ごとの文。URL の文をそのまま出さない */
const TENANT_EXPORT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  part: '書き出す内容を選び直してください（データ・資料の実体のどちらか）。',
  storage: '書き出しを保管できませんでした。時間をおいて、もう一度書き出してください。',
  link: '書き出しのリンクを発行できませんでした。時間をおいて、もう一度書き出してください。',
};

export function DataHandlingTab({
  params,
  facts,
  terms,
  textLimit,
  creatorNames,
  demo,
  exportPlan,
  canExport,
}: {
  params: Record<string, string | string[] | undefined>;
  facts: readonly SystemFact[];
  terms: DataTermsView;
  textLimit: number;
  creatorNames: ReadonlyMap<string, string>;
  demo: boolean;
  /** 書き出しの確認を開いたときだけ数える（?confirm=tenant-export） */
  exportPlan: TenantExportPlan | null;
  canExport: boolean;
}) {
  const current = terms.current;
  const exportErrorKind = typeof params.exportError === 'string' ? params.exportError : null;
  const exportError = exportErrorKind
    ? (TENANT_EXPORT_ERROR_MESSAGES[exportErrorKind] ?? null)
    : null;
  const columns: DataTableColumn<DataTermsItemView>[] = [
    {
      key: 'item',
      header: '項目',
      importance: 'primary',
      lockVisible: true,
      cell: (row) => <span className="font-medium">{row.label}</span>,
    },
    {
      key: 'value',
      header: '内容',
      importance: 'primary',
      cell: (row) => <span className="text-small">{row.value}</span>,
    },
    {
      key: 'state',
      header: '合意',
      importance: 'primary',
      cell: (row) => <StatusBadge domain="dataTerms" value={row.state} />,
    },
  ];

  return (
    <>
      <Section title="システムの実態（自動）" divider="none">
        <p className="mb-1.5 text-small text-ink-muted">
          この環境の設定から読んだ値です。合意した条件と食い違っていないかを確かめてください。
        </p>
        <dl className="grid gap-x-3 gap-y-1 rounded-t4d border border-line px-3 py-2 text-small md:grid-cols-[minmax(10rem,auto)_1fr]">
          {facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="font-medium text-ink">{fact.label}</dt>
              <dd className="text-ink">{fact.value}</dd>
            </div>
          ))}
        </dl>
        {/* 合意した処理先との食い違いは折りたたまない（区分ごとに 1 文） */}
        {terms.mismatches.length > 0 && (
          <Notice
            tone="warning"
            title="この環境の外部の処理先が、合意した処理先の区分にありません"
            className="mt-2"
          >
            <ul className="list-disc space-y-0.5 pl-4">
              {terms.mismatches.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            <p className="mt-1">
              データ取扱条件の版を記録し直すか、この環境の設定（接続先）を合意に合わせてください。
            </p>
          </Notice>
        )}
      </Section>

      <CreatePanel
        id="record-data-terms"
        title="条件の版を記録"
        searchParams={params}
        closeHref={createPanelHref(BASE, params, { open: false })}
        description="合意した項目を入れて、新しい版として記録します（前の版は残ります）。合意していない項目は空・「未定」のままにします。"
      >
        <DataTermsForm
          current={current}
          textLimit={textLimit}
          subprocessorLimit={SUBPROCESSOR_FIELD_LIMITS[demo ? 'demo' : 'supabase']}
        />
      </CreatePanel>

      <Section
        title={current ? `合意した条件（第 ${current.versionNo} 版）` : '合意した条件'}
        summary={`未合意 ${terms.notAgreedCount} 項目`}
        actions={demo ? <HonestyBadge kind="fictional" /> : undefined}
      >
        {/* 未合意を推測で埋めない旨と、デモの記録が架空である旨は折りたたまない */}
        {demo && (
          <Notice tone="warning" className="mb-2">
            デモの条件は架空の記録です。実際の合意内容ではありません。
          </Notice>
        )}
        {current ? (
          <>
            <p className="mb-1.5 text-caption text-ink-muted">
              記録 {formatJst(current.createdAt)}（{creatorNames.get(current.createdBy) ?? '管理者'}
              ）。未合意の項目は推測で埋めず「未合意」と表示します。
            </p>
            <DataTable<DataTermsItemView>
              id="settings-data-terms"
              caption="合意した条件"
              columns={columns}
              rows={terms.items}
              getRowId={(row) => row.item}
              getRowLabel={(row) => row.label}
              getRowStatus={(row) => (row.state === 'agreed' ? '合意済み' : '未合意')}
              searchParams={params}
              basePath={BASE}
              search={false}
              empty={{
                noData: {
                  title: '項目がありません',
                  action: (
                    <Link
                      href={dataHandlingHref({ new: '1' })}
                      className="text-small text-brand-700 hover:underline"
                    >
                      条件の版を記録
                    </Link>
                  ),
                },
              }}
            />
            <SubprocessorTable rows={terms.processors} />
          </>
        ) : (
          <EmptyState
            kind="no-data"
            size="compact"
            title="合意した条件はまだ記録されていません"
            description="すべての項目が未合意です。NDA・保管場所・保存期間・AI の扱い・処理を委ねる先（業務委託先・クラウド・AI）・終了時の返却と削除・バックアップの残存期間を合意したら記録します。"
            action={
              <Link
                href={dataHandlingHref({ new: '1' })}
                className="text-small text-brand-700 hover:underline"
              >
                条件の版を記録
              </Link>
            }
          />
        )}
        {/* 削除の後のバックアップの扱い（固定の文。合意した日数を入れる。折りたたまない） */}
        <Notice tone="info" title="削除の後のバックアップ" className="mt-2">
          <span data-backup-residual="">{terms.residualText}</span>
        </Notice>
      </Section>

      {terms.versions.length > 0 && (
        <Section
          id="data-terms-history"
          title="記録の履歴"
          collapsible
          summary={`${terms.versions.length} 版`}
        >
          <div className="t4d-scroll-x rounded-t4d border border-line">
            <Table>
              <THead>
                <TR>
                  <TH>版</TH>
                  <TH>記録</TH>
                  <TH>記録した人</TH>
                  <TH>未合意</TH>
                  <TH>合意日</TH>
                  <TH>メモ</TH>
                </TR>
              </THead>
              <TBody>
                {terms.versions.map((version) => (
                  <TR key={version.id}>
                    <TD className="tnum">第 {version.versionNo} 版</TD>
                    <TD className="text-caption text-ink-muted">{formatJst(version.createdAt)}</TD>
                    <TD className="text-small">
                      {creatorNames.get(version.createdBy) ?? '管理者'}
                    </TD>
                    <TD className="tnum text-small">
                      {dataTermsItems(version).filter((i) => i.state === 'not_agreed').length} 項目
                    </TD>
                    <TD className="text-small">{version.agreedOn ?? '—'}</TD>
                    <TD className="text-small">{version.note || '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Section>
      )}

      {/* 書き出しの失敗の理由は折りたたまない（section.tsx の規則） */}
      {exportError && (
        <Notice tone="danger" role="alert" title="全データを書き出せませんでした">
          {exportError}
        </Notice>
      )}
      <Section
        id="data-return-deletion"
        title="終了時の返却・削除"
        collapsible
        open={exportPlan !== null}
        summary="全データの書き出し（返却用）・削除の手続き"
      >
        <div className="space-y-2 text-small text-ink">
          <p className="flex items-start gap-1.5">
            <FileArchive className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
            <span>
              返却用に、自社のデータを表ごとの CSV と
              manifest（行数・sha256）にまとめて書き出せます。資料の実体は別の ZIP
              です。データの削除（テナントの終了）は、返却の受け取りを確かめたあと、運営が手順書に従って行います。この画面からは削除できません。
              削除の後のバックアップの扱いは、上の「削除の後のバックアップ」のとおりです（削除完了の報告に、削除日と消去の見込み日を書きます）。
            </span>
          </p>
          {!canExport ? (
            <p className="text-ink-muted">
              書き出しには「出力」の権限も必要です。企業管理者に依頼してください。
            </p>
          ) : exportPlan ? (
            <TenantExportDialog plan={exportPlan} defaultOpen />
          ) : (
            <Link
              href={dataHandlingHref({ confirm: 'tenant-export' })}
              className="text-small text-brand-700 hover:underline"
            >
              全データを書き出す（返却用）…
            </Link>
          )}
        </div>
      </Section>
    </>
  );
}

/** 処理を委ねる先の表（区分・名称・役割・所在地・秘密保持の根拠・AI の再学習） */
function SubprocessorTable({ rows }: { rows: readonly SubprocessorRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      <p className="text-small font-medium text-ink">
        処理を委ねる先（業務委託先・クラウド・AI）{rows.length} 社
      </p>
      <div className="t4d-scroll-x rounded-t4d border border-line">
        <Table>
          <caption className="sr-only">処理を委ねる先</caption>
          <THead>
            <TR>
              <TH>区分</TH>
              <TH>名称</TH>
              <TH>役割</TH>
              <TH>所在地（処理地域）</TH>
              <TH>秘密保持の根拠</TH>
              <TH>AI の再学習</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row, index) => (
              <TR key={`${row.category}-${row.name}-${index}`}>
                <TD>
                  <StatusBadge domain="subprocessorCategory" value={row.category} />
                </TD>
                <TD className="text-small font-medium">{row.name}</TD>
                <TD className="text-small">{row.role || '—'}</TD>
                <TD className="text-small">{row.location || '—'}</TD>
                <TD className="text-small">
                  {row.basisState === 'agreed' ? (
                    row.confidentialityBasis
                  ) : (
                    <StatusBadge domain="dataTerms" value="not_agreed" />
                  )}
                </TD>
                <TD className="text-small">{row.aiTraining ?? '—'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </div>
  );
}

/** 区分ごとの入力欄の既定値（1 行に 1 社「名称／役割／所在地／秘密保持の根拠」） */
function subprocessorDefaults(
  current: DataTermsView['current'],
): Record<SubprocessorCategory, string> {
  const rows = (current?.subprocessors ?? []).map(normalizeSubprocessor);
  return Object.fromEntries(
    SUBPROCESSOR_CATEGORY_ORDER.map((category) => [
      category,
      rows
        .filter((row) => row.category === category)
        .map((row) =>
          [row.name, row.role, row.location, row.confidentialityBasis]
            .join('／')
            .replace(/(／)+$/, ''),
        )
        .join('\n'),
    ]),
  ) as Record<SubprocessorCategory, string>;
}

function DataTermsForm({
  current,
  textLimit,
  subprocessorLimit,
}: {
  current: DataTermsView['current'];
  textLimit: number;
  subprocessorLimit: number;
}) {
  const subprocessors = subprocessorDefaults(current);
  const hasSubprocessors = SUBPROCESSOR_CATEGORY_ORDER.some((c) => subprocessors[c] !== '');
  return (
    <form action={recordDataTermsAction} className="space-y-2">
      <FormSection
        title="秘密保持・データ処理"
        kind="optional"
        open
        description="合意の文書名や版を書きます（文書そのものはこの画面に保存しません）。"
      >
        <div className="grid gap-2 md:grid-cols-2">
          <Field label="秘密保持契約（NDA）" name="ndaStatus">
            {(p) => (
              <NativeSelect
                {...p}
                name="ndaStatus"
                defaultValue={current?.ndaStatus ?? 'undecided'}
              >
                {NDA_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {NDA_STATUS_LABELS[status]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="データ処理条件の文書" name="processingTermsRef">
            {(p) => (
              <Input
                {...p}
                name="processingTermsRef"
                defaultValue={current?.processingTermsRef ?? ''}
                maxLength={textLimit}
              />
            )}
          </Field>
        </div>
      </FormSection>
      <FormSection title="保管と保存" kind="optional" open>
        <div className="grid gap-2 md:grid-cols-2">
          <Field label="保管場所" name="storageLocation" hint="例: 国内リージョン（合意した表現）">
            {(p) => (
              <Input
                {...p}
                name="storageLocation"
                defaultValue={current?.storageLocation ?? ''}
                maxLength={textLimit}
              />
            )}
          </Field>
          <Field label="保存期間" name="retentionPolicy">
            {(p) => (
              <Input
                {...p}
                name="retentionPolicy"
                defaultValue={current?.retentionPolicy ?? ''}
                maxLength={textLimit}
              />
            )}
          </Field>
          <Field
            label="バックアップの残存期間（日）"
            name="backupResidualDays"
            hint={`削除の後もバックアップに残る日数の合意値（0〜${BACKUP_RESIDUAL_DAYS_MAX}）。空は未合意（消去の見込み日を出しません）`}
          >
            {(p) => (
              <Input
                {...p}
                name="backupResidualDays"
                type="number"
                min={0}
                max={BACKUP_RESIDUAL_DAYS_MAX}
                step={1}
                inputMode="numeric"
                defaultValue={current?.backupResidualDays ?? ''}
              />
            )}
          </Field>
        </div>
      </FormSection>
      <FormSection title="AI の扱い" kind="optional" open>
        <div className="grid gap-2 md:grid-cols-2">
          <Field label="AI の再学習への利用" name="aiTrainingUse">
            {(p) => (
              <NativeSelect
                {...p}
                name="aiTrainingUse"
                defaultValue={current?.aiTrainingUse ?? 'undecided'}
              >
                {AI_TRAINING_USES.map((value) => (
                  <option key={value} value={value}>
                    {AI_TRAINING_USE_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="AI の提供元での保存" name="aiProviderStorage">
            {(p) => (
              <NativeSelect
                {...p}
                name="aiProviderStorage"
                defaultValue={current?.aiProviderStorage ?? 'undecided'}
              >
                {AI_PROVIDER_STORAGES.map((value) => (
                  <option key={value} value={value}>
                    {AI_PROVIDER_STORAGE_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>
      </FormSection>
      <FormSection
        title="処理を委ねる先（業務委託先・クラウド・AI）"
        kind="optional"
        open={hasSubprocessors}
        description={`区分ごとに、1 行に 1 社「名称／役割／所在地（処理地域）／秘密保持の根拠」の形で書きます（合計 ${MAX_SUBPROCESSORS} 社まで・各項目 ${subprocessorLimit} 字まで）。秘密保持の根拠が空の行は「未合意」と表示します。`}
      >
        <div className="grid gap-2 md:grid-cols-2">
          {SUBPROCESSOR_CATEGORY_ORDER.map((category) => (
            <Field
              key={category}
              label={statusLabel('subprocessorCategory', category)}
              id={`data-terms-subprocessors-${category}`}
            >
              {(p) => (
                <Textarea
                  {...p}
                  name={`subprocessors.${category}`}
                  rows={2}
                  defaultValue={subprocessors[category]}
                />
              )}
            </Field>
          ))}
        </div>
      </FormSection>
      <FormSection title="終了時の返却・削除" kind="optional" open>
        <div className="grid gap-2 md:grid-cols-2">
          <Field label="返却方法" name="returnMethod">
            {(p) => (
              <Input
                {...p}
                name="returnMethod"
                defaultValue={current?.returnMethod ?? ''}
                maxLength={textLimit}
              />
            )}
          </Field>
          <Field label="削除方法" name="deletionMethod">
            {(p) => (
              <Input
                {...p}
                name="deletionMethod"
                defaultValue={current?.deletionMethod ?? ''}
                maxLength={textLimit}
              />
            )}
          </Field>
        </div>
      </FormSection>
      <FormSection title="合意" kind="optional" open>
        <div className="grid gap-2 md:grid-cols-3">
          <Field label="合意日" name="agreedOn">
            {(p) => (
              <Input {...p} name="agreedOn" type="date" defaultValue={current?.agreedOn ?? ''} />
            )}
          </Field>
          <Field label="合意者（会議体・役職など）" name="agreedByLabel">
            {(p) => (
              <Input
                {...p}
                name="agreedByLabel"
                defaultValue={current?.agreedByLabel ?? ''}
                maxLength={textLimit}
              />
            )}
          </Field>
          <Field label="メモ" name="note">
            {(p) => <Input {...p} name="note" defaultValue="" maxLength={textLimit} />}
          </Field>
        </div>
      </FormSection>
      <SubmitButton variant="primary" size="sm" pendingLabel="記録中…">
        この内容で版を記録
      </SubmitButton>
    </form>
  );
}
