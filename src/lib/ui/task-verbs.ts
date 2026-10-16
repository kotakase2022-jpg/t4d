import type { PermissionKey } from '@/types/domain';
import type { Can, HomeProfile } from './home-profile';

/**
 * タスク動詞（plan §1.4）。「どの画面を開けばよいか」を利用者に判断させないため、業務の動詞に
 * 既存の URL と絞り込みを対応付ける（新しい画面は作らない）。
 * ホームの「次にやること」・Command Palette の「操作」・各一覧の「自分の作業」プリセットが
 * 同じ定義を使う（同じ動詞が画面によって違う行き先にならないように）。
 *
 * 実行はしない: 承認・確定・リセットのような操作も、移動した先の画面で人が押す（CLAUDE.md §0-4）。
 */

export interface TaskVerbContext {
  /** 担当範囲（空＝全社）。拠点担当の一覧は担当拠点で絞った URL にする（plan D2） */
  unitScopeIds: readonly string[];
  /** 開いている開示プロジェクト（原稿の動詞の行き先）。無ければ一覧へ */
  currentProjectId?: string | null;
  /** Demo Mode（デモのリセットの動詞を出すか） */
  demo?: boolean;
  /** 開示優先モード（開示デモのリセットは開示優先のホームにある） */
  disclosureFirst?: boolean;
}

export const TASK_VERB_IDS = [
  'enter-data',
  'fix-returned-data',
  'review-data',
  'approve-data',
  'start-import',
  'standard-csv',
  'check-import',
  'register-evidence',
  'respond-pbc',
  'write-manuscript',
  'fix-returned-manuscript',
  'review-manuscript',
  'see-disclosure-status',
  'open-top-gap',
  'see-totals',
  'make-report',
  'add-metric',
  'add-unit',
  'add-period',
  'create-campaign',
  'invite-member',
  'grant-access',
  'create-project',
  'register-narrative',
  'register-target',
  'send-feedback',
  'export-requirement-matrix',
  'open-trace',
  'answer-assurance-comments',
  'map-xbrl',
  'see-audit-log',
  'import-factor-set',
  'assign-factors',
  'approve-classification-rule',
  'import-activity',
  'run-ghg-calculation',
  'import-ghg-baseline',
  'reconcile-ghg',
  'reset-demo',
] as const;
export type TaskVerbId = (typeof TASK_VERB_IDS)[number];

export interface TaskVerb {
  id: TaskVerbId;
  /** 動詞で始まる業務の言葉 */
  label: string;
  /** 補足（パレットの右に出す短い説明） */
  hint?: string;
  /** すべて満たす必要がある権限 */
  requires: readonly PermissionKey[];
  /** 行き先。null ならこの文脈では出さない */
  href: (c: TaskVerbContext) => string | null;
  keywords?: readonly string[];
  /** Demo Mode のときだけ出す */
  demoOnly?: true;
}

/** 担当範囲があれば unit= を足す（データの一覧の既定の絞り込みと同じ） */
function withUnits(base: string, c: TaskVerbContext): string {
  if (c.unitScopeIds.length === 0) return base;
  const units = c.unitScopeIds.map((id) => `unit=${encodeURIComponent(id)}`).join('&');
  return `${base}&${units}`;
}

/** 現在のプロジェクトのタブ（無ければプロジェクトの一覧。行き先の ID を推測しない） */
function projectTab(c: TaskVerbContext, query: string): string {
  return c.currentProjectId
    ? `/enterprise/disclosure-projects/${encodeURIComponent(c.currentProjectId)}?${query}`
    : '/enterprise/disclosure-projects';
}

function projectManuscripts(c: TaskVerbContext, filter: 'mine' | 'returned'): string {
  return c.currentProjectId
    ? `/enterprise/disclosure-projects/${encodeURIComponent(c.currentProjectId)}?tab=manuscripts&filter=${filter}`
    : '/enterprise/disclosure-projects';
}

export const TASK_VERBS: readonly TaskVerb[] = [
  {
    id: 'enter-data',
    label: 'データを入力する',
    hint: '未着手・入力中のデータ',
    requires: ['enterprise.data.write'],
    href: (c) => withUnits('/enterprise/data?status=not_started&status=draft', c),
    keywords: ['入力', '値', '非財務データ'],
  },
  {
    id: 'fix-returned-data',
    label: '差戻しを直す（データ）',
    hint: '差し戻されたデータ',
    requires: ['enterprise.data.write'],
    href: (c) => withUnits('/enterprise/data?status=returned', c),
    keywords: ['差戻し', '修正', '再提出'],
  },
  {
    id: 'review-data',
    label: 'データを確認する',
    hint: '提出済みのデータ',
    requires: ['enterprise.data.review'],
    href: () => '/enterprise/data?status=submitted',
    keywords: ['レビュー', '確認', '提出済み'],
  },
  {
    id: 'approve-data',
    label: 'データを承認する',
    hint: 'レビュー中のデータ（承認は開いた画面で人が押します）',
    requires: ['enterprise.data.approve'],
    href: () => '/enterprise/data?status=in_review',
    keywords: ['承認', '承認待ち'],
  },
  {
    id: 'start-import',
    label: '取込を始める',
    hint: 'ファイルを取り込む',
    requires: ['enterprise.import.run'],
    href: () => '/enterprise/imports',
    keywords: ['取込', 'アップロード', 'CSV', 'Excel'],
  },
  {
    id: 'standard-csv',
    label: '標準 CSV で登録する',
    hint: '数値を登録（標準CSV）',
    requires: ['enterprise.import.run', 'enterprise.data.write'],
    href: () => '/enterprise/imports/standard',
    keywords: ['CSV', '標準', '数値', '登録'],
  },
  {
    id: 'check-import',
    label: '取込を確認する',
    hint: '確認待ちの取込',
    requires: ['enterprise.import.run'],
    href: () => '/enterprise/imports?job=needs_review',
    keywords: ['取込', '要確認', 'プレビュー', '確定'],
  },
  {
    id: 'register-evidence',
    label: '資料を登録する',
    hint: '根拠資料・証跡',
    requires: ['enterprise.evidence.write'],
    href: () => '/enterprise/evidence?new=1',
    keywords: ['資料', '証跡', 'Evidence', 'アップロード'],
  },
  {
    id: 'respond-pbc',
    label: '資料依頼に回答する',
    hint: '監査法人からの資料依頼（PBC）',
    requires: ['enterprise.pbc.respond'],
    href: () => '/enterprise/workflows#pbc',
    keywords: ['PBC', '資料依頼', '回答', '監査法人'],
  },
  {
    id: 'write-manuscript',
    label: '原稿を書く',
    hint: '自分が担当する原稿',
    requires: ['enterprise.disclosure.write'],
    href: (c) => projectManuscripts(c, 'mine'),
    keywords: ['原稿', '開示', '執筆', 'プロジェクト'],
  },
  {
    id: 'fix-returned-manuscript',
    label: '差戻しを直す（原稿）',
    hint: '差し戻された原稿',
    requires: ['enterprise.disclosure.write'],
    href: (c) => projectManuscripts(c, 'returned'),
    keywords: ['原稿', '差戻し', '修正'],
  },
  {
    id: 'review-manuscript',
    label: '原稿をレビューする',
    hint: '自分に依頼されたレビュー',
    requires: ['enterprise.disclosure.read'],
    href: () => '/enterprise/workflows#reviews',
    keywords: ['レビュー', '原稿', '最終承認'],
  },
  {
    id: 'see-disclosure-status',
    label: '開示の状況を見る',
    hint: 'SSBJ 対応状況',
    requires: [],
    href: () => '/enterprise/disclosures/ssbj',
    keywords: ['SSBJ', '対応状況', '開示'],
  },
  {
    id: 'open-top-gap',
    label: '最優先のギャップを開く',
    hint: 'SSBJ 要求事項（優先度が最も高い未対応）',
    // 行き先の画面のゲートと同じ（SSBJ の画面は閲覧の権限を求めない。R6 は発注者確認）
    requires: [],
    href: () => '/enterprise/disclosures/ssbj/requirements/top-priority',
    keywords: ['SSBJ', '優先', 'ギャップ', '次', '要求事項'],
  },
  {
    id: 'see-totals',
    label: '集計を見る',
    hint: 'GHG 算定サマリー',
    requires: ['enterprise.data.read'],
    href: () => '/enterprise/ghg',
    keywords: ['集計', 'GHG', '排出量', 'Scope'],
  },
  {
    id: 'make-report',
    label: 'レポートを作る',
    hint: 'レポート出力',
    requires: ['enterprise.export.run'],
    href: () => '/enterprise/reports',
    keywords: ['レポート', '出力', 'Excel', 'Word', 'エクスポート'],
  },
  {
    id: 'add-metric',
    label: '指標を追加する',
    hint: '指標マスター',
    requires: ['enterprise.metric.manage'],
    // 追加の専用ページへ直接（タブを開いてからもう 1 回押させない）
    href: () => '/enterprise/organizations/metrics/new',
    keywords: ['指標', 'マスター', 'KPI'],
  },
  {
    id: 'add-unit',
    label: '拠点を追加する',
    hint: '組織・拠点',
    requires: ['enterprise.org.manage'],
    // 作成パネルを開いた状態で着く（?new=1）
    href: () => '/enterprise/organizations?tab=units&new=1#unit-create',
    keywords: ['拠点', '組織', '子会社', '連結'],
  },
  {
    id: 'add-period',
    label: '報告年度を追加する',
    hint: '報告年度',
    // サービスは組織の管理を求める（R2）。画面の表示条件も同じにする
    requires: ['enterprise.org.manage'],
    href: () => '/enterprise/organizations?tab=periods',
    keywords: ['報告年度', '期間', '年度'],
  },
  {
    id: 'create-campaign',
    label: '収集キャンペーンを作成する',
    hint: '組織・拠点 › 収集キャンペーン',
    requires: ['enterprise.period.manage'],
    href: () => '/enterprise/organizations/campaigns/new',
    keywords: ['キャンペーン', '収集', '依頼', '期限'],
  },
  {
    id: 'invite-member',
    label: 'メンバーを招待する',
    hint: '設定 › 招待',
    // 設定の画面は企業管理者だけが開ける（権限の挙動は変えない。R1 は見送り）
    requires: ['enterprise.org.manage', 'enterprise.member.manage'],
    href: () => '/enterprise/settings?tab=invitations',
    keywords: ['招待', 'メンバー', 'ユーザー', '利用者'],
  },
  {
    id: 'grant-access',
    label: '監査法人へのアクセス許諾',
    hint: '設定 › アクセス許諾',
    requires: ['enterprise.org.manage', 'enterprise.grant.manage'],
    href: () => '/enterprise/settings?tab=grants',
    keywords: ['許諾', 'Grant', '監査法人', '保証'],
  },
  {
    id: 'create-project',
    label: '開示プロジェクトを作る',
    hint: '開示プロジェクトの作成',
    requires: ['enterprise.disclosure.write'],
    href: () => '/enterprise/disclosure-projects/new',
    keywords: ['プロジェクト', '作成', '開示'],
  },
  {
    id: 'register-narrative',
    label: '定性情報を登録する',
    hint: '定性情報の登録',
    requires: ['enterprise.disclosure.write'],
    href: () => '/enterprise/narratives/new',
    keywords: ['定性', 'ガバナンス', 'リスク', '戦略'],
  },
  {
    id: 'register-target',
    label: '目標を登録する',
    hint: 'ESG 経営の目標',
    requires: ['enterprise.metric.manage'],
    href: () => '/enterprise/esg/targets?new=1',
    keywords: ['目標', 'KPI', '削減目標'],
  },
  // ---- トライアル対応（2026-10。plan §4.3-2）。移った先の画面で人が操作する（出力・回答も実行しない）
  {
    id: 'send-feedback',
    label: 'フィードバックを送る',
    hint: 'ご意見・不具合（改善管理表）',
    requires: ['enterprise.data.read'],
    // 送る窓はヘッダーの「ご意見・不具合」と改善管理表の画面にある。改善管理表で送った結果も見られる
    href: () => '/enterprise/trial?tab=feedback',
    keywords: ['ご意見', '不具合', '要望', '質問', 'フィードバック', '改善管理表', 'トライアル'],
  },
  {
    id: 'export-requirement-matrix',
    label: '対応表を出力する',
    hint: '要求事項・情報対応表（すべての基準。XLSX・CSV）',
    requires: ['enterprise.disclosure.read', 'enterprise.export.run'],
    href: (c) => projectTab(c, 'tab=requirements&fw=all'),
    keywords: ['対応表', '要求事項', '情報対応表', '対象外', '未対応', 'XLSX', 'CSV', '出力'],
  },
  {
    id: 'open-trace',
    label: 'トレースを開く',
    hint: '出力タブの承認版から「内容とトレース」へ',
    requires: ['enterprise.disclosure.read'],
    href: (c) => projectTab(c, 'tab=outputs'),
    keywords: ['トレース', '追跡率', '追跡番号', '遡る', '承認版', 'スナップショット', '突合'],
  },
  {
    id: 'answer-assurance-comments',
    label: '保証側のコメントに回答する',
    hint: '保証側のコメント（未回答）',
    requires: ['enterprise.disclosure.write'],
    href: () => '/enterprise/assurance-comments?state=unanswered',
    keywords: ['保証', '監査法人', 'コメント', '回答', 'レビューNote'],
  },
  {
    id: 'map-xbrl',
    label: 'XBRL の対応付けを確認する',
    hint: 'XBRL（開示プロジェクト。社内確認用）',
    requires: ['enterprise.disclosure.read'],
    href: (c) => projectTab(c, 'tab=xbrl'),
    keywords: ['XBRL', 'iXBRL', 'xBRL-JSON', 'タクソノミ', 'タグ', 'SAMPLE'],
  },
  {
    id: 'see-audit-log',
    label: '監査ログを見る',
    hint: '監査ログ（操作・資料アクセスの記録）',
    requires: ['common.audit.read'],
    href: () => '/enterprise/audit-log',
    keywords: ['監査ログ', '操作履歴', '証跡', '資料アクセス', 'ダウンロード履歴'],
  },
  // ---- Scope1・2 の算定と照合（2026-10-16 の要望）。行き先の画面で人が押す（取込の確定・承認・算定・照合も実行しない）
  {
    id: 'import-factor-set',
    label: '係数セットを取り込む',
    hint: 'Scope1・2算定 › 排出係数（下書きで取り込み、確かめてから有効にします）',
    requires: ['enterprise.metric.manage'],
    href: () => '/enterprise/ghg/calculation/factors?new=1#factor-import',
    keywords: ['排出係数', '係数セット', '組織指定', '取込', 'Scope1', 'Scope2'],
  },
  {
    id: 'assign-factors',
    label: '係数の未割当を直す',
    hint: 'Scope1・2算定 › 排出係数 › 割当（係数が決まらない活動）',
    requires: ['enterprise.metric.manage'],
    href: () => '/enterprise/ghg/calculation/factors?view=assignments&state=unresolved',
    keywords: ['未割当', '割当', '排出係数', '係数の解決'],
  },
  {
    id: 'approve-classification-rule',
    label: '区分規則を承認する',
    hint: 'Scope1・2算定 › 算定ルール（承認待ち。承認は開いた画面で人が押します）',
    requires: ['enterprise.data.approve'],
    href: () => '/enterprise/ghg/calculation/rules?status=proposed',
    keywords: ['区分規則', '承認待ち', '報告区分', '既定区分', '委託物流', 'Scope1', 'Scope3'],
  },
  {
    id: 'import-activity',
    label: '活動量を取り込む',
    hint: 'Scope1・2算定 › 活動量（エネルギー・輸送実績）',
    requires: ['enterprise.import.run', 'enterprise.data.write'],
    href: () => '/enterprise/ghg/calculation/activity?new=1#activity-import',
    keywords: ['活動量', '燃料', '電力', '輸送実績', 'トンキロ', '改良トンキロ法', '取込'],
  },
  {
    id: 'run-ghg-calculation',
    label: '算定を実行する',
    hint: 'Scope1・2算定の概要（実行は開いた画面で人が押します）',
    requires: ['enterprise.data.write'],
    href: () => '/enterprise/ghg/calculation',
    keywords: ['算定', 'Scope1', 'Scope2', '算定の記録', '二重表示'],
  },
  {
    id: 'import-ghg-baseline',
    label: '既存の算定結果を取り込む',
    hint: 'Scope1・2算定 › 照合（照合の前に既存の結果を取り込みます）',
    requires: ['enterprise.import.run', 'enterprise.data.write'],
    href: () => '/enterprise/ghg/calculation/reconciliation?import=1#import-baseline',
    keywords: ['既存の算定結果', '既存結果', '照合', '取込'],
  },
  {
    id: 'reconcile-ghg',
    label: '既存結果と照合する',
    hint: 'Scope1・2算定 › 照合（整合性の確認と差異の原因）',
    requires: ['enterprise.data.write'],
    href: () => '/enterprise/ghg/calculation/reconciliation?reconcile=1#reconcile',
    keywords: ['照合', '整合性', '差異の原因', '許容差', '既存結果'],
  },
  {
    id: 'reset-demo',
    label: 'デモを初期状態に戻す',
    hint: 'ホームの確認ダイアログを開きます（実行は確認のあと）',
    requires: ['enterprise.disclosure.write'],
    // 開示デモのリセットは開示優先のホーム（開示業務タブ）の「その他」にある。そこが無い組織には出さない
    href: (c) => (c.demo && c.disclosureFirst ? '/enterprise/dashboard?confirm=reset-demo' : null),
    keywords: ['デモ', 'リセット', '初期化'],
    demoOnly: true,
  },
];

/**
 * 「原稿を書く」などの行き先にする「現在のプロジェクト」（plan §1.3 の {現在}）。
 * プロジェクトの画面の外では、選択中の報告期間のプロジェクト（無ければ先頭）にする。
 * プロジェクトの画面ではパスのプロジェクトが優先する（command-palette.tsx・header-context.tsx と同じ決め方）
 */
export function defaultProjectId(
  projects: ReadonlyArray<{ id: string; reportingPeriodId: string }>,
  currentPeriodId: string | null | undefined,
): string | undefined {
  return (projects.find((p) => p.reportingPeriodId === currentPeriodId) ?? projects[0])?.id;
}

export function taskVerb(id: TaskVerbId): TaskVerb {
  const found = TASK_VERBS.find((verb) => verb.id === id);
  if (!found) throw new Error(`タスク動詞 ${id} がありません`);
  return found;
}

export interface ResolvedTaskVerb {
  id: TaskVerbId;
  label: string;
  hint?: string;
  href: string;
  keywords: readonly string[];
}

export function resolveTaskVerb(
  verb: TaskVerb,
  can: Can,
  c: TaskVerbContext,
): ResolvedTaskVerb | null {
  if (verb.demoOnly && !c.demo) return null;
  if (!verb.requires.every((permission) => can(permission))) return null;
  const href = verb.href(c);
  if (!href) return null;
  return { id: verb.id, label: verb.label, hint: verb.hint, href, keywords: verb.keywords ?? [] };
}

/** 権限と文脈で使える動詞だけを、定義の順に返す */
export function availableTaskVerbs(can: Can, c: TaskVerbContext): ResolvedTaskVerb[] {
  return TASK_VERBS.map((verb) => resolveTaskVerb(verb, can, c)).filter(
    (verb): verb is ResolvedTaskVerb => verb !== null,
  );
}

/**
 * Command Palette の「おすすめ」（空のクエリのときだけ。plan §1.3 の表）。
 * 動詞か画面（ROUTE_CATALOG の href）を指す。権限の無いものは解決時に落ちる
 */
export type Recommendation =
  { kind: 'verb'; id: TaskVerbId } | { kind: 'route'; href: string; label: string };

export const RECOMMENDATIONS: Record<HomeProfile, readonly Recommendation[]> = {
  contributor: [
    { kind: 'verb', id: 'enter-data' },
    { kind: 'verb', id: 'fix-returned-data' },
    { kind: 'verb', id: 'register-evidence' },
    { kind: 'verb', id: 'start-import' },
  ],
  preparer: [
    { kind: 'verb', id: 'write-manuscript' },
    { kind: 'verb', id: 'start-import' },
    { kind: 'route', href: '/enterprise/disclosures/ssbj/requirements', label: 'SSBJ 要求事項' },
    { kind: 'route', href: '/enterprise/disclosure-projects', label: '開示プロジェクト' },
  ],
  reviewer: [
    { kind: 'verb', id: 'review-manuscript' },
    { kind: 'verb', id: 'review-data' },
  ],
  approver: [
    { kind: 'verb', id: 'review-manuscript' },
    { kind: 'verb', id: 'approve-data' },
    { kind: 'verb', id: 'make-report' },
  ],
  admin: [
    { kind: 'route', href: '/enterprise/organizations', label: '組織・拠点' },
    { kind: 'route', href: '/enterprise/settings', label: '設定' },
    { kind: 'verb', id: 'invite-member' },
    { kind: 'verb', id: 'grant-access' },
  ],
  viewer: [
    { kind: 'route', href: '/enterprise/analysis/diagnosis', label: '現状診断' },
    { kind: 'route', href: '/enterprise/analysis/trends', label: '自社経年比較' },
    { kind: 'route', href: '/enterprise/esg', label: 'ESG経営' },
  ],
};
