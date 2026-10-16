import Link from 'next/link';
import { Archive, CheckCircle2, Plus, Save, Send } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { GhgNotice } from '@/components/shared/ghg-notices';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { formatJst } from '@/lib/format/datetime';
import {
  approvalBlockedReason,
  cargoKindLabel,
  CARRIER_KIND_LABELS,
  listClassificationRules,
  listDoubleCountChecks,
  type RuleView,
} from '@/lib/services/ghg/classification-rules';
import { loadGhgSource } from '@/lib/services/ghg/inputs';
import {
  loadCalculationPolicy,
  ROUNDING_METHOD_LABELS,
  ROUNDING_STAGE_LABELS,
  type PolicyOverview,
} from '@/lib/services/ghg/policy';
import { statusLabel } from '@/lib/ui/status/registry';
import {
  GHG_RULE_STATUSES,
  ROUNDING_METHODS,
  ROUNDING_STAGES,
  type OrganizationUnit,
  type ReportingPeriod,
} from '@/types/domain';
import { CalcNav } from '../_components/calc-nav';
import { loadCalcContext } from '../_components/calc-context';
import { PeriodContext, PeriodSwitch } from '../factors/_components/s1-chrome';
import {
  approveRuleAction,
  proposeRuleAction,
  savePolicyAction,
  withdrawRuleAction,
} from './actions';

export const metadata = { title: '算定ルール（Scope1・2算定）' };

type SearchParams = Record<string, string | string[] | undefined>;

const BASE = '/enterprise/ghg/calculation/rules';

/** 公的資料で扱いを確認できなかった項目の説明（plan K5。組織のパラメータで、既定は止めるか警告） */
const ORG_DECIDES = '組織が決める項目です（公的資料で扱いを確認できませんでした）';

function param(query: SearchParams, key: string): string | null {
  const value = query[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * P93 算定ルール（plan §2.4・CR-03・CR-04・CR-06 の組織の設定・CR-07。S1）。
 *
 * - 算定方針（期間ごとの版）: 丸め（段ごとに 桁・kg/t・方式）、組織の単位換算（種類をまたぐ換算だけ）、
 *   改良トンキロ法の組織の設定。主な操作は「規則を保存（方針の新しい版）」。前の版は残る
 * - 区分規則: 一覧・提案（CreatePanel ?new=1。根拠は必須）・承認（提案者以外。確認ダイアログ）・取り下げ（その他）
 * - 温対法の荷主の排出との関係（N6）とデモの注記（N9）は折りたたまずに出す
 */
export default async function GhgRulesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const { shell, period, status } = await loadCalcContext(query);
  const { ctx, db } = shell;
  const [policy, rules, source, doubleCounts] = await Promise.all([
    loadCalculationPolicy(db, ctx, period.id),
    listClassificationRules(db, ctx),
    loadGhgSource(db, ctx, period.id),
    listDoubleCountChecks(db, ctx, period.id),
  ]);
  const canManage = can(ctx, 'enterprise.metric.manage');
  const canApprove = can(ctx, 'enterprise.data.approve');
  const proposeOpen = canManage && isCreatePanelOpen(query);
  const cargoKinds = [
    ...new Set(source.lines.map((l) => l.cargoKind).filter((k): k is string => !!k)),
  ];
  const sites = shell.units.filter((u) => u.unitType !== 'supplier' && !u.deletedAt);

  return (
    <>
      <PageHeader
        title="算定ルール（Scope1・2算定）"
        description="丸め・単位換算・改良トンキロ法の組織の設定と、区分規則（提案・承認）"
        autoBreadcrumbs
        context={<PeriodContext period={period} demo={ctx.demo} />}
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'propose-rule',
                label: '区分規則を提案',
                icon: <Plus aria-hidden="true" />,
                href: `${createPanelHref(BASE, query, { open: true })}#rule-propose`,
                hidden: !canManage || proposeOpen,
              },
            ]}
          />
        }
      />
      <CalcNav current="rules" periodId={period.id} attention={status.attention} />

      <div className="space-y-3 px-4 pb-4 pt-3">
        <FlashMessage searchParams={query} />
        {ctx.demo && <GhgNotice id="N9" />}
        <PeriodSwitch
          basePath={BASE}
          periods={shell.periods}
          current={period}
          searchParams={query}
        />

        {proposeOpen && (
          <ProposePanel
            query={query}
            period={period}
            periods={shell.periods}
            sites={sites}
            cargoKinds={cargoKinds}
          />
        )}

        <Section
          id="calculation-policy"
          title={`算定方針（${period.code}${policy.current ? `・版 ${policy.current.versionNo}` : '・まだありません'}）`}
          summary={
            policy.current
              ? `${policy.names.get(policy.current.createdBy ?? '') ?? '—'}・${formatJst(policy.current.createdAt)}`
              : undefined
          }
        >
          <div className="space-y-2">
            {!policy.current && (
              <p className="text-small text-ink-muted">
                この期間の算定方針はまだありません。下の初期値（改良トンキロ法はガイドラインの記載と、確認できなかった扱いを「止める／警告」にした値）を確かめて保存すると、版
                1 になります。算定は方針を保存してから実行できます。
              </p>
            )}
            <GhgNotice id="N6" />
            <PolicyForm
              policy={policy}
              periodId={period.id}
              canManage={canManage && period.status !== 'closed'}
              primary={!proposeOpen}
            />
          </div>
        </Section>

        {policy.versions.length > 0 && (
          <Section
            id="policy-versions"
            title={`方針の版（${policy.versions.length}）`}
            collapsible
            summary={`最新は版 ${policy.versions[0]!.versionNo}（前の版は残ります）`}
          >
            <PolicyVersions policy={policy} />
          </Section>
        )}

        <Section
          title={`区分規則（${rules.length}）`}
          actions={rules.length > 0 ? <HonestyBadge kind="company-rule" /> : undefined}
        >
          {doubleCounts.length > 0 && (
            <Notice tone="warning" title={`二重計上の確認（${period.code}）`} className="mb-2">
              <p>
                委託物流を Scope3 カテゴリ4 から動かす区分規則があり、同じ期間の Scope3 カテゴリ1
                の内訳に物流の購入らしい行があります。同じ輸送を両方に計上していないかを確かめてください（止めません）。
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {doubleCounts.flatMap((check) =>
                  check.warnings.slice(0, 5).map((w) => (
                    <li key={`${check.rule.id}-${w.inputLabel}`}>
                      {check.rule.code}（{statusLabel('ghgRule', check.rule.status)}）: {w.message}
                    </li>
                  )),
                )}
              </ul>
            </Notice>
          )}
          <RulesTable
            rules={rules}
            query={query}
            periodId={period.id}
            canManage={canManage}
            canApprove={canApprove}
            ctx={ctx}
          />
        </Section>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------
// 算定方針
// ----------------------------------------------------------------------

function PolicyForm({
  policy,
  periodId,
  canManage,
  primary,
}: {
  policy: PolicyOverview;
  periodId: string;
  canManage: boolean;
  primary: boolean;
}) {
  const { draft } = policy;
  const conversions = [
    ...draft.conversions,
    { from: '', to: '', multiplier: '', source: '' },
    { from: '', to: '', multiplier: '', source: '' },
  ];
  const ruleOf = (stage: (typeof ROUNDING_STAGES)[number]) =>
    draft.rounding.find((r) => r.stage === stage) ?? null;
  const tonkm = draft.tonkm;
  return (
    <PreservingForm action={savePolicyAction} className="space-y-3" aria-label="算定方針">
      <input type="hidden" name="periodId" value={periodId} />
      <input type="hidden" name="baseVersionNo" value={policy.current?.versionNo ?? ''} />
      <input type="hidden" name="conv:count" value={conversions.length} />

      <FormSection
        title="丸め"
        kind="optional"
        open={draft.rounding.length > 0}
        description="段を選ぶと、その段の丸め後の値を次の段で足します（行 → 月 → 拠点×活動 → 拠点×区分 → 合計）。未丸めの値も記録に残します。何も選ばなければ丸めません。"
      >
        <div className="t4d-scroll-x">
          <Table>
            <caption className="sr-only">丸めの段</caption>
            <THead>
              <TR>
                <TH>段</TH>
                <TH>この段で丸める</TH>
                <TH>小数の桁（0 は整数）</TH>
                <TH>単位</TH>
                <TH>方式</TH>
              </TR>
            </THead>
            <TBody>
              {ROUNDING_STAGES.map((stage) => {
                const rule = ruleOf(stage);
                const label = ROUNDING_STAGE_LABELS[stage];
                return (
                  <TR key={stage}>
                    <TD className="text-small">{label}</TD>
                    <TD>
                      <NativeCheckbox
                        name={`round:${stage}`}
                        defaultChecked={rule !== null}
                        aria-label={`${label}で丸める`}
                      />
                    </TD>
                    <TD>
                      <Input
                        name={`round:${stage}:digits`}
                        type="number"
                        min={0}
                        max={12}
                        step={1}
                        defaultValue={rule?.digits ?? 3}
                        aria-label={`${label}の桁`}
                        className="w-20"
                      />
                    </TD>
                    <TD>
                      <NativeSelect
                        name={`round:${stage}:unit`}
                        defaultValue={rule?.unit ?? 't'}
                        aria-label={`${label}の単位`}
                        className="w-24"
                      >
                        <option value="t">t-CO2e</option>
                        <option value="kg">kg-CO2e</option>
                      </NativeSelect>
                    </TD>
                    <TD>
                      <NativeSelect
                        name={`round:${stage}:method`}
                        defaultValue={rule?.method ?? 'half_up'}
                        aria-label={`${label}の方式`}
                      >
                        {ROUNDING_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {ROUNDING_METHOD_LABELS[m]}
                          </option>
                        ))}
                      </NativeSelect>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      </FormSection>

      <FormSection
        title="単位換算（組織の換算）"
        kind="optional"
        open={draft.conversions.length > 0}
        description="m3→Nm3（温度・圧力補正）のように、種類をまたぐ換算だけを書きます。L→kL・kWh→MWh など同じ種類の換算は内蔵の換算を使います。換算が無い単位は算定でエラーになります（同一視しません）。"
      >
        <div className="t4d-scroll-x">
          <Table>
            <caption className="sr-only">組織の単位換算</caption>
            <THead>
              <TR>
                <TH>換算前の単位</TH>
                <TH>換算後の単位</TH>
                <TH>倍率</TH>
                <TH>出典（換算の根拠）</TH>
              </TR>
            </THead>
            <TBody>
              {conversions.map((c, index) => (
                <TR key={index}>
                  <TD>
                    <Input
                      name={`conv:${index}:from`}
                      defaultValue={c.from}
                      aria-label={`換算 ${index + 1} の換算前の単位`}
                      placeholder="例 m3"
                      className="w-24"
                    />
                  </TD>
                  <TD>
                    <Input
                      name={`conv:${index}:to`}
                      defaultValue={c.to}
                      aria-label={`換算 ${index + 1} の換算後の単位`}
                      placeholder="例 Nm3"
                      className="w-24"
                    />
                  </TD>
                  <TD>
                    <Input
                      name={`conv:${index}:multiplier`}
                      defaultValue={String(c.multiplier)}
                      inputMode="decimal"
                      aria-label={`換算 ${index + 1} の倍率`}
                      className="w-28"
                    />
                  </TD>
                  <TD>
                    <Input
                      name={`conv:${index}:source`}
                      defaultValue={c.source}
                      maxLength={100}
                      aria-label={`換算 ${index + 1} の出典`}
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </FormSection>

      <FormSection
        title="改良トンキロ法の組織の設定"
        kind="required"
        description="式の形・積載率の下限・原単位の丸めはガイドラインの記載を初期値にしています。係数（A・B・S・見なし積載率の原単位表）は係数のセットの行です。"
      >
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <Field
            label="式の形"
            name="tonkm:shape"
            required
            hint="告示の形が現行の正式な式です。対数式は差の確認用"
          >
            {(p) => (
              <NativeSelect {...p} name="tonkm:shape" defaultValue={tonkm.shape}>
                <option value="kokuji">告示の形（既定）</option>
                <option value="log">対数式（比較用）</option>
              </NativeSelect>
            )}
          </Field>
          <Field
            label="積載率の下限（%）"
            name="tonkm:minLoadPct"
            required
            hint="これ未満の積載率は下限の値で算定し、行に印を残します（ガイドラインは 10%）"
          >
            {(p) => (
              <Input
                {...p}
                name="tonkm:minLoadPct"
                inputMode="decimal"
                defaultValue={String(tonkm.minLoadPct)}
              />
            )}
          </Field>
          <Field label="積載率 100% 超の扱い" name="tonkm:over100" required hint={ORG_DECIDES}>
            {(p) => (
              <NativeSelect {...p} name="tonkm:over100" defaultValue={tonkm.over100}>
                <option value="error">止める（エラー）</option>
                <option value="cap">100% として算定し、行に警告</option>
              </NativeSelect>
            )}
          </Field>
          <Field
            label="式を当てる最大積載量の下限（kg）"
            name="tonkm:payloadMinKg"
            hint={`${ORG_DECIDES}。空は下限なし`}
          >
            {(p) => (
              <Input
                {...p}
                name="tonkm:payloadMinKg"
                inputMode="decimal"
                defaultValue={tonkm.payloadRangeKg.min ?? ''}
              />
            )}
          </Field>
          <Field
            label="式を当てる最大積載量の上限（kg）"
            name="tonkm:payloadMaxKg"
            hint={`${ORG_DECIDES}。空は上限なし`}
          >
            {(p) => (
              <Input
                {...p}
                name="tonkm:payloadMaxKg"
                inputMode="decimal"
                defaultValue={tonkm.payloadRangeKg.max ?? ''}
              />
            )}
          </Field>
          <Field
            label="範囲外の最大積載量の扱い"
            name="tonkm:payloadOutOfRange"
            required
            hint={ORG_DECIDES}
          >
            {(p) => (
              <NativeSelect
                {...p}
                name="tonkm:payloadOutOfRange"
                defaultValue={tonkm.payloadOutOfRange}
              >
                <option value="warn">算定し、行に警告</option>
                <option value="error">止める（エラー）</option>
              </NativeSelect>
            )}
          </Field>
          <Field label="海外拠点の輸送" name="tonkm:overseas" required hint={ORG_DECIDES}>
            {(p) => (
              <NativeSelect {...p} name="tonkm:overseas" defaultValue={tonkm.overseas}>
                <option value="warn">算定し、行に警告（国内分と分けて表示）</option>
                <option value="block">改良トンキロ法を止める（エラー）</option>
              </NativeSelect>
            )}
          </Field>
          <Field
            label="原単位の丸め（有効数字）"
            name="tonkm:intensitySignificant"
            hint="ガイドラインの参考表は有効数字 3 桁。空は丸めない"
          >
            {(p) => (
              <Input
                {...p}
                name="tonkm:intensitySignificant"
                type="number"
                min={1}
                max={10}
                step={1}
                defaultValue={tonkm.intensityRounding?.significant ?? ''}
              />
            )}
          </Field>
          <Field label="原単位の丸めの方式" name="tonkm:intensityMethod">
            {(p) => (
              <NativeSelect
                {...p}
                name="tonkm:intensityMethod"
                defaultValue={tonkm.intensityRounding?.method ?? 'half_up'}
              >
                {ROUNDING_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {ROUNDING_METHOD_LABELS[m]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>
      </FormSection>

      <Field
        label="メモ"
        name="notes"
        hint="この版で何を変えたか（例: 先方の既存の算定に合わせて月ごとに kg で切り捨て）"
      >
        {(p) => (
          <Textarea {...p} name="notes" rows={2} maxLength={300} defaultValue={draft.notes} />
        )}
      </Field>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton
            variant={primary ? 'primary' : 'secondary'}
            size="sm"
            icon={<Save aria-hidden="true" />}
            pendingLabel="保存中…"
          >
            規則を保存（方針の新しい版）
          </SubmitButton>
          <span className="text-caption text-ink-muted">
            保存すると版 {(policy.current?.versionNo ?? 0) + 1}{' '}
            になります（前の版は残ります）。算定の記録は「入力が変わった」になります。
          </span>
        </div>
      ) : (
        <p className="text-caption text-ink-muted">
          算定方針を保存するには、指標・係数の管理の権限が必要です（締めた期間は変更できません）。
        </p>
      )}
    </PreservingForm>
  );
}

function roundingSummary(rounding: PolicyOverview['draft']['rounding']): string {
  if (rounding.length === 0) return '丸めなし';
  return rounding
    .map(
      (r) =>
        `${ROUNDING_STAGE_LABELS[r.stage]} ${r.unit === 'kg' ? 'kg' : 't'} 小数 ${r.digits} 桁 ${ROUNDING_METHOD_LABELS[r.method]}`,
    )
    .join(' ／ ');
}

function PolicyVersions({ policy }: { policy: PolicyOverview }) {
  return (
    <div className="t4d-scroll-x">
      <Table>
        <caption className="sr-only">算定方針の版</caption>
        <THead>
          <TR>
            <TH align="right">版</TH>
            <TH>保存</TH>
            <TH>丸め</TH>
            <TH>組織の換算</TH>
            <TH>改良トンキロ法</TH>
            <TH>メモ</TH>
          </TR>
        </THead>
        <TBody>
          {policy.versions.map((v) => (
            <TR key={v.id}>
              <TD align="right" className="tnum">
                {v.versionNo}
              </TD>
              <TD className="whitespace-nowrap text-caption">
                {policy.names.get(v.createdBy ?? '') ?? '—'}・{formatJst(v.createdAt)}
              </TD>
              <TD className="text-caption">{roundingSummary(v.rounding)}</TD>
              <TD className="text-caption">
                {v.conversions.length === 0
                  ? 'なし'
                  : v.conversions
                      .map((c) => `${c.from}→${c.to} ×${c.multiplier}（${c.source}）`)
                      .join(' ／ ')}
              </TD>
              <TD className="text-caption">
                {v.tonkm.shape === 'kokuji' ? '告示の形' : '対数式'}・下限 {v.tonkm.minLoadPct}
                %・100% 超 {v.tonkm.over100 === 'error' ? '止める' : '100% で警告'}・範囲外{' '}
                {v.tonkm.payloadOutOfRange === 'error' ? '止める' : '警告'}・海外{' '}
                {v.tonkm.overseas === 'block' ? '止める' : '警告'}
              </TD>
              <TD className="text-caption text-ink-muted">{v.notes || '—'}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

// ----------------------------------------------------------------------
// 区分規則
// ----------------------------------------------------------------------

function periodRange(view: RuleView): string {
  const from = view.fromPeriod?.code ?? '指定なし';
  const to = view.toPeriod?.code ?? '指定なし';
  return `${from} 〜 ${to}`;
}

function RulesTable({
  rules,
  query,
  periodId,
  canManage,
  canApprove,
  ctx,
}: {
  rules: RuleView[];
  query: SearchParams;
  periodId: string;
  canManage: boolean;
  canApprove: boolean;
  ctx: Parameters<typeof approvalBlockedReason>[0];
}) {
  const statusFilter = param(query, 'status');
  const rows = rules.filter((r) => (statusFilter ? r.rule.status === statusFilter : true));
  const columns: DataTableColumn<RuleView>[] = [
    {
      key: 'name',
      header: '名称',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <span className="block min-w-0">
          <span className="block text-small text-ink">{row.rule.name}</span>
          <span className="font-mono text-caption text-ink-muted">{row.rule.code}</span>
        </span>
      ),
    },
    {
      key: 'scopes',
      header: '既定区分 → 報告区分',
      importance: 'primary',
      cell: (row) => (
        <span className="whitespace-nowrap text-small">
          {GHG_SCOPE_LABELS[row.rule.protocolScope]} → {GHG_SCOPE_LABELS[row.rule.reportedScope]}
        </span>
      ),
    },
    {
      key: 'match',
      header: '条件',
      importance: 'secondary',
      cell: (row) => <span className="text-caption">{row.matchText}</span>,
    },
    {
      key: 'rationale',
      header: '根拠',
      importance: 'secondary',
      cell: (row) => <span className="line-clamp-2 text-caption">{row.rule.rationale}</span>,
    },
    {
      key: 'period',
      header: '適用期間',
      importance: 'secondary',
      cell: (row) => <span className="whitespace-nowrap text-caption">{periodRange(row)}</span>,
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (row) => <StatusBadge domain="ghgRule" value={row.rule.status} />,
    },
    {
      key: 'proposer',
      header: '提案者',
      importance: 'secondary',
      cell: (row) => (
        <span className="text-caption">
          {row.proposerName ?? '—'}
          <span className="block text-ink-muted">{formatJst(row.rule.createdAt)}</span>
        </span>
      ),
    },
    {
      key: 'approver',
      header: '承認者',
      importance: 'secondary',
      cell: (row) =>
        row.rule.approvedAt ? (
          <span className="text-caption">
            {row.approverName ?? '—'}
            <span className="block text-ink-muted">{formatJst(row.rule.approvedAt)}</span>
          </span>
        ) : (
          <span className="text-caption text-ink-muted">—</span>
        ),
    },
  ];
  return (
    <DataTable<RuleView>
      id="ghg-classification-rules"
      caption="区分規則"
      columns={columns}
      rows={rows}
      getRowId={(row) => row.rule.id}
      getRowLabel={(row) => `${row.rule.code} ${row.rule.name}`}
      getRowStatus={(row) => statusLabel('ghgRule', row.rule.status)}
      searchParams={query}
      basePath={BASE}
      search={false}
      filters={[
        {
          key: 'status',
          label: '状態',
          options: GHG_RULE_STATUSES.map((s) => ({ value: s, label: statusLabel('ghgRule', s) })),
        },
      ]}
      rowActions={(row) => {
        const rule = row.rule;
        const scopeLine = `${rule.code}「${rule.name}」（${GHG_SCOPE_LABELS[rule.protocolScope]} → ${GHG_SCOPE_LABELS[rule.reportedScope]}）`;
        const blocked = approvalBlockedReason(ctx, rule);
        return {
          rowLabel: `${rule.code} ${rule.name}`,
          primary: {
            kind: 'confirm',
            id: `approve-${rule.id}`,
            label: '承認する',
            icon: <CheckCircle2 aria-hidden="true" />,
            action: approveRuleAction,
            fields: { ruleId: rule.id, periodId },
            hidden: !canApprove || rule.status !== 'proposed',
            disabledReason: blocked ?? undefined,
            confirm: {
              tier: 'irreversible',
              title: 'この区分規則を承認しますか',
              scope: scopeLine,
              consequences: [
                `承認すると、適用期間（${periodRange(row)}）の算定で「${row.matchText}」の報告区分が ${GHG_SCOPE_LABELS[rule.protocolScope]} から ${GHG_SCOPE_LABELS[rule.reportedScope]} に変わります（次の算定から）。`,
                '既定区分（GHG プロトコル）の値は参考として並べて表示します（二重表示）。製品は方針の当否を判断しません。',
                `根拠: ${rule.rationale}`,
                '承認は取り消せません（取り下げはできます）。提案者は承認できません。',
              ],
              confirmLabel: '承認する',
              destructive: false,
            },
          },
          items: [
            {
              kind: 'confirm',
              id: `withdraw-${rule.id}`,
              label: '取り下げる…',
              icon: <Archive aria-hidden="true" />,
              action: withdrawRuleAction,
              fields: { ruleId: rule.id, periodId },
              hidden: (!canManage && !canApprove) || rule.status === 'withdrawn',
              destructive: true,
              confirm: {
                tier: 'irreversible',
                title: 'この区分規則を取り下げますか',
                scope: scopeLine,
                consequences: [
                  '取り下げると、次の算定から報告区分は既定区分（GHG プロトコル）に戻ります。',
                  '内容を直すときは、取り下げてから新しく提案します（取り下げた規則は戻せません）。',
                ],
                reason: {
                  name: 'reason',
                  label: '取り下げの理由（任意）',
                  required: false,
                  maxLength: 300,
                },
                confirmLabel: '取り下げる',
              },
            },
          ],
        };
      }}
      expand={(row) => (
        <dl className="grid gap-x-4 gap-y-0.5 text-small sm:grid-cols-[auto_1fr]">
          <dt className="text-ink-muted">根拠</dt>
          <dd className="whitespace-pre-wrap">{row.rule.rationale}</dd>
          <dt className="text-ink-muted">開示の注記</dt>
          <dd className="whitespace-pre-wrap">{row.rule.disclosureNote || '—'}</dd>
          {row.rule.withdrawnAt && (
            <>
              <dt className="text-ink-muted">取り下げ</dt>
              <dd>
                {row.withdrawerName ?? '—'}・{formatJst(row.rule.withdrawnAt)}
              </dd>
            </>
          )}
        </dl>
      )}
      empty={{
        noData: {
          title: '区分規則はありません',
          description:
            '区分規則が無ければ、算定はすべて既定区分（GHG プロトコル）で行います。組織の方針で区分を変えるときに提案します。',
          action: canManage ? (
            <Link
              href={`${createPanelHref(BASE, query, { open: true })}#rule-propose`}
              className="text-small text-brand-700 hover:underline"
            >
              区分規則を提案
            </Link>
          ) : (
            <span className="text-small text-ink-muted">
              提案には指標・係数の管理の権限が要ります
            </span>
          ),
        },
        filtered: { title: '条件に合う区分規則はありません' },
      }}
    />
  );
}

function ProposePanel({
  query,
  period,
  periods,
  sites,
  cargoKinds,
}: {
  query: SearchParams;
  period: ReportingPeriod;
  periods: readonly ReportingPeriod[];
  sites: readonly OrganizationUnit[];
  cargoKinds: readonly string[];
}) {
  const sorted = [...periods].sort((a, b) => b.startDate.localeCompare(a.startDate));
  return (
    <CreatePanel
      id="rule-propose"
      title="区分規則を提案"
      searchParams={query}
      closeHref={createPanelHref(BASE, query, { open: false })}
      description="提案は承認待ちになり、承認されるまで算定は既定区分のままです。承認は提案者以外の承認権限を持つ人が行います。"
    >
      <PreservingForm action={proposeRuleAction} className="space-y-2" aria-label="区分規則の提案">
        <input type="hidden" name="periodId" value={period.id} />
        <div className="grid gap-2 sm:grid-cols-2">
          <Field
            label="規則のコード"
            name="code"
            required
            hint="例 LOGI-02（空白なし・40 文字まで）"
          >
            {(p) => <Input {...p} name="code" maxLength={40} autoComplete="off" />}
          </Field>
          <Field label="名称" name="name" required>
            {(p) => <Input {...p} name="name" maxLength={200} />}
          </Field>
          <Field
            label="対象の輸送"
            name="carrierKind"
            required
            hint="既定区分は対象から決まります（委託 → Scope3 カテゴリ4、自社便 → Scope1）"
          >
            {(p) => (
              <NativeSelect {...p} name="carrierKind" defaultValue="contracted">
                <option value="contracted">{CARRIER_KIND_LABELS.contracted}</option>
                <option value="own_fleet">{CARRIER_KIND_LABELS.own_fleet}</option>
              </NativeSelect>
            )}
          </Field>
          <Field
            label="報告区分"
            name="reportedScope"
            required
            hint="再分類は Scope1 と Scope3 カテゴリ4 の間だけ"
          >
            {(p) => (
              <NativeSelect {...p} name="reportedScope" defaultValue="scope1">
                <option value="scope1">{GHG_SCOPE_LABELS.scope1}</option>
                <option value="scope3_cat4">{GHG_SCOPE_LABELS.scope3_cat4}</option>
              </NativeSelect>
            )}
          </Field>
          <Field
            label="貨物の区分"
            name="cargoKinds"
            hint={
              cargoKinds.length > 0
                ? `カンマ区切り。空はすべての貨物。活動量に出てくる区分: ${cargoKinds.map(cargoKindLabel).join('・')}`
                : 'カンマ区切り。空はすべての貨物'
            }
          >
            {(p) => <Input {...p} name="cargoKinds" placeholder="例 主要製品" />}
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="適用開始の期間" name="effectiveFromPeriodId">
              {(p) => (
                <NativeSelect {...p} name="effectiveFromPeriodId" defaultValue={period.id}>
                  <option value="">指定なし</option>
                  {sorted.map((p2) => (
                    <option key={p2.id} value={p2.id}>
                      {p2.code}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="適用終了の期間" name="effectiveToPeriodId">
              {(p) => (
                <NativeSelect {...p} name="effectiveToPeriodId" defaultValue="">
                  <option value="">指定なし</option>
                  {sorted.map((p2) => (
                    <option key={p2.id} value={p2.id}>
                      {p2.code}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
        </div>
        {sites.length > 0 && (
          <fieldset className="space-y-1">
            <legend className="text-small font-medium text-ink">
              拠点で絞る（任意。選ばなければすべての拠点）
            </legend>
            <div className="flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
              {sites.map((u) => (
                <NativeCheckbox
                  key={u.id}
                  name="unitIds"
                  value={u.id}
                  label={`${u.name}〔${u.countryCode}〕`}
                />
              ))}
            </div>
          </fieldset>
        )}
        <Field
          label="根拠"
          name="rationale"
          required
          hint="なぜ既定区分と違う区分にするのか（承認者・保証側が読みます。300 文字まで）"
        >
          {(p) => <Textarea {...p} name="rationale" rows={3} maxLength={300} />}
        </Field>
        <Field
          label="開示の注記"
          name="disclosureNote"
          hint="開示に区分方針の注記を書くときの文案（任意）"
        >
          {(p) => <Textarea {...p} name="disclosureNote" rows={2} maxLength={300} />}
        </Field>
        <SubmitButton
          variant="primary"
          size="sm"
          icon={<Send aria-hidden="true" />}
          pendingLabel="提案中…"
        >
          提案する
        </SubmitButton>
      </PreservingForm>
    </CreatePanel>
  );
}
