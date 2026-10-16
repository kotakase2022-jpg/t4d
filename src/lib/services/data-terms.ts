import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { getAppMode, getOpenAiConfig } from '@/lib/config';
import {
  backupResidualLabel,
  backupResidualText,
  BACKUP_RESIDUAL_DAYS_MAX,
  isBackupResidualDays,
} from '@/lib/domain/data-disposal';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import { DEMO_TEXT_LIMITS, DEMO_TRIAL_JSON_MAX_CHARS } from '@/lib/repositories/demo-trial-checks';
import type { DataTermsState } from '@/lib/ui/status/dataTerms';
import { statusLabel } from '@/lib/ui/status/registry';
import type { DbClient } from '@/lib/repositories/types';
import {
  AI_PROVIDER_STORAGES,
  AI_TRAINING_USES,
  NDA_STATUSES,
  SUBPROCESSOR_CATEGORIES,
  type AiProviderStorage,
  type AiTrainingUse,
  type AuthorizationContext,
  type DataTermsSubprocessor,
  type NdaStatus,
  type OrganizationDataTerms,
  type SubprocessorCategory,
} from '@/types/domain';

/**
 * データ取扱条件（トライアル対応 NF-28・2026-10-16 の要望 ⑥⑦）。合意した条件の版（追記専用
 * organization_data_terms）と、システムの実態（設定から自動で読む）を並べる。
 *
 *  - 未合意の項目は「未合意」と出す。推測で埋めない（空・undecided・NDA の未締結は未合意）
 *  - 版は追記だけ（DB は forbid_mutation）。記録は組織の管理者（enterprise.org.manage）
 *  - システムの実態は Secret を出さない（API キーの有無だけ。値は読まない）
 *  - 処理を委ねる先は区分（業務委託先・クラウドサービス提供者・AI サービス提供者・その他）と秘密保持の根拠を持つ。
 *    以前の版（区分なしの 3 項目）は読むときに「その他」・根拠なしに読み替える（版は追記専用なので書き換えない）
 *  - この環境が使う外部の処理先（ホスティング・データベース・AI の API）と、合意した処理先の区分を突き合わせる
 *  - バックアップの残存期間（0060）は合意値の日数。未合意なら消去の見込み日を出さない
 */

export const NDA_STATUS_LABELS: Record<NdaStatus, string> = {
  signed: '締結済み',
  pending: '手続中',
  undecided: '未定',
};

export const AI_TRAINING_USE_LABELS: Record<AiTrainingUse, string> = {
  not_allowed: '再学習に使わない',
  allowed: '再学習に使ってよい',
  undecided: '未定',
};

export const AI_PROVIDER_STORAGE_LABELS: Record<AiProviderStorage, string> = {
  none: '提供元に保存しない',
  provider_default: '提供元の既定の保存に従う',
  undecided: '未定',
};

/** 項目（表の行の並び） */
export const DATA_TERMS_ITEMS = [
  'ndaStatus',
  'processingTermsRef',
  'storageLocation',
  'retentionPolicy',
  'aiTrainingUse',
  'aiProviderStorage',
  'subprocessors',
  'returnMethod',
  'deletionMethod',
  'backupResidualDays',
  'agreement',
] as const;
export type DataTermsItem = (typeof DATA_TERMS_ITEMS)[number];

export const DATA_TERMS_ITEM_LABELS: Record<DataTermsItem, string> = {
  ndaStatus: '秘密保持契約（NDA）',
  processingTermsRef: 'データ処理条件の文書',
  storageLocation: '保管場所',
  retentionPolicy: '保存期間',
  aiTrainingUse: 'AI の再学習への利用',
  aiProviderStorage: 'AI の提供元での保存',
  subprocessors: '処理を委ねる先（業務委託先・クラウド・AI）',
  returnMethod: '終了時の返却方法',
  deletionMethod: '終了時の削除方法',
  backupResidualDays: 'バックアップの残存期間',
  agreement: '合意日・合意者',
};

/** 区分の並び（入力欄・表の順） */
export const SUBPROCESSOR_CATEGORY_ORDER: readonly SubprocessorCategory[] = [
  'contractor',
  'cloud',
  'ai',
  'other',
];

/** 処理を委ねる先の 1 行（表示用。以前の版の行は「その他」・根拠なしに読み替えたもの） */
export interface SubprocessorRow {
  category: SubprocessorCategory;
  name: string;
  role: string;
  location: string;
  confidentialityBasis: string;
  /** 秘密保持の根拠が空なら未合意（推測で埋めない） */
  basisState: DataTermsState;
  /** AI の再学習（AI サービス提供者の行だけ。合意項目 aiTrainingUse の語。それ以外は null） */
  aiTraining: string | null;
}

/** 以前の版（3 項目）を読み替える。区分の値が知らないものなら「その他」 */
export function normalizeSubprocessor(s: DataTermsSubprocessor): Required<DataTermsSubprocessor> {
  const category =
    s.category && (SUBPROCESSOR_CATEGORIES as readonly string[]).includes(s.category)
      ? s.category
      : 'other';
  return {
    name: s.name ?? '',
    role: s.role ?? '',
    location: s.location ?? '',
    category,
    confidentialityBasis: s.confidentialityBasis ?? '',
  };
}

/** 処理を委ねる先の表の行（区分の順。区分の中は記録の順） */
export function subprocessorRows(terms: OrganizationDataTerms | null): SubprocessorRow[] {
  if (!terms) return [];
  const rows = terms.subprocessors.map(normalizeSubprocessor);
  return SUBPROCESSOR_CATEGORY_ORDER.flatMap((category) =>
    rows
      .filter((row) => row.category === category)
      .map((row) => ({
        ...row,
        basisState: (row.confidentialityBasis.trim() === ''
          ? 'not_agreed'
          : 'agreed') as DataTermsState,
        aiTraining: category === 'ai' ? AI_TRAINING_USE_LABELS[terms.aiTrainingUse] : null,
      })),
  );
}

/** この環境が使う外部の処理先（環境変数から読む。値は読まない） */
export interface EnvironmentProcessor {
  category: SubprocessorCategory;
  /** 環境から分かる提供元の名前（実在のサービス名はここにだけ出す） */
  name: string;
  role: string;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * この環境の外部の処理先。Vercel 上で動いているか（VERCEL）、Supabase Mode か、AI の API キーがあるか
 * （値は読まない）から決める。分からないものは出さない（推測しない）
 */
export function environmentProcessors(
  env: EnvLike = process.env,
  facts: { mode: 'demo' | 'supabase'; aiConnected: boolean } = {
    mode: getAppMode(),
    aiConnected: getOpenAiConfig().apiKey !== null,
  },
): EnvironmentProcessor[] {
  const out: EnvironmentProcessor[] = [];
  if ((env.VERCEL ?? '').trim() !== '') {
    out.push({ category: 'cloud', name: 'Vercel', role: 'アプリケーションの実行（ホスティング）' });
  }
  if (facts.mode === 'supabase') {
    out.push({
      category: 'cloud',
      name: 'Supabase',
      role: 'データベース・認証・ファイルの保管',
    });
  }
  if (facts.aiConnected) {
    out.push({
      category: 'ai',
      name: 'OpenAI',
      role: '文章の候補の生成（採用は利用者が確定）',
    });
  }
  return out;
}

/**
 * 環境が使う区分のうち、合意した処理先に無いもの（区分ごとに 1 つの文）。
 * 合意の版が無ければ、環境が使う区分はすべて「合意に無い」
 */
export function processorMismatches(
  environment: readonly EnvironmentProcessor[],
  terms: OrganizationDataTerms | null,
): string[] {
  const agreed = new Set(
    (terms?.subprocessors ?? []).map((s) => normalizeSubprocessor(s).category),
  );
  const used = SUBPROCESSOR_CATEGORY_ORDER.filter((c) => environment.some((p) => p.category === c));
  return used
    .filter((category) => !agreed.has(category))
    .map((category) => {
      const label = statusLabel('subprocessorCategory', category);
      const names = environment
        .filter((p) => p.category === category)
        .map((p) => p.name)
        .join('・');
      return `この環境は「${label}」（${names}）を使っていますが、合意した処理先に「${label}」がありません。`;
    });
}

export interface DataTermsItemView {
  item: DataTermsItem;
  label: string;
  /** 表示する値（未合意なら「—」） */
  value: string;
  state: DataTermsState;
}

/** 版の項目ごとの値と合意の状態（純関数。未合意を推測で埋めない） */
export function dataTermsItems(terms: OrganizationDataTerms | null): DataTermsItemView[] {
  const text = (value: string | undefined) => (value ?? '').trim();
  return DATA_TERMS_ITEMS.map((item): DataTermsItemView => {
    const label = DATA_TERMS_ITEM_LABELS[item];
    if (!terms) return { item, label, value: '—', state: 'not_agreed' };
    switch (item) {
      case 'ndaStatus':
        return {
          item,
          label,
          value: NDA_STATUS_LABELS[terms.ndaStatus],
          state: terms.ndaStatus === 'signed' ? 'agreed' : 'not_agreed',
        };
      case 'aiTrainingUse':
        return {
          item,
          label,
          value: AI_TRAINING_USE_LABELS[terms.aiTrainingUse],
          state: terms.aiTrainingUse === 'undecided' ? 'not_agreed' : 'agreed',
        };
      case 'aiProviderStorage':
        return {
          item,
          label,
          value: AI_PROVIDER_STORAGE_LABELS[terms.aiProviderStorage],
          state: terms.aiProviderStorage === 'undecided' ? 'not_agreed' : 'agreed',
        };
      case 'subprocessors': {
        if (terms.subprocessors.length === 0) {
          return { item, label, value: '—', state: 'not_agreed' };
        }
        // 区分ごとの社数（各社の名称・根拠は下の「処理を委ねる先」の表）
        const rows = subprocessorRows(terms);
        const counts = SUBPROCESSOR_CATEGORY_ORDER.flatMap((category) => {
          const n = rows.filter((r) => r.category === category).length;
          return n > 0 ? [`${statusLabel('subprocessorCategory', category)} ${n}`] : [];
        });
        const missingBasis = rows.filter((r) => r.basisState === 'not_agreed').length;
        return {
          item,
          label,
          value: `${counts.join('・')}（${rows.length} 社${
            missingBasis > 0 ? `。秘密保持の根拠が未合意 ${missingBasis} 社` : ''
          }）`,
          state: 'agreed',
        };
      }
      case 'backupResidualDays':
        return {
          item,
          label,
          value: isBackupResidualDays(terms.backupResidualDays)
            ? backupResidualLabel(terms.backupResidualDays)
            : '—',
          state: isBackupResidualDays(terms.backupResidualDays) ? 'agreed' : 'not_agreed',
        };
      case 'agreement':
        return terms.agreedOn && text(terms.agreedByLabel) !== ''
          ? { item, label, value: `${terms.agreedOn}（${terms.agreedByLabel}）`, state: 'agreed' }
          : {
              item,
              label,
              value: terms.agreedOn ?? (text(terms.agreedByLabel) || '—'),
              state: 'not_agreed',
            };
      default: {
        const value = text(terms[item]);
        return value === ''
          ? { item, label, value: '—', state: 'not_agreed' }
          : { item, label, value, state: 'agreed' };
      }
    }
  });
}

export interface SystemFact {
  label: string;
  value: string;
}

/**
 * システムの実態（自動）。設定・環境から読むだけ（推測の値を出さない。保管場所は環境から分からないので
 * 合意した条件を見るよう案内する）。API キーの値は読まない
 */
export function systemFacts(env: EnvLike = process.env): SystemFact[] {
  const mode = getAppMode();
  const ai = getOpenAiConfig();
  const connected = ai.apiKey !== null;
  const processors = environmentProcessors(env, { mode, aiConnected: connected });
  return [
    {
      label: 'この環境が使う外部の処理先',
      value:
        processors.length === 0
          ? '検出していません（ホスティング・データベース・AI の API のいずれの提供元にも接続していません）'
          : processors
              .map(
                (p) => `${p.name}（${statusLabel('subprocessorCategory', p.category)}・${p.role}）`,
              )
              .join('、'),
    },
    {
      label: '動作モード',
      value:
        mode === 'demo'
          ? 'デモ（架空のデータ。データベースに接続していません）'
          : 'Supabase（データベース・認証・保管庫に接続）',
    },
    {
      label: 'AI の提供元',
      value: connected ? 'OpenAI（API に接続）' : 'デモ生成（Mock。外部の AI に送っていません）',
    },
    { label: 'AI のモデル', value: connected ? ai.model : '—（接続していません）' },
    {
      label: 'AI の提供元での保存の指定',
      value: connected
        ? ai.store
          ? '保存する（提供元の既定。合意の後に設定したもの）'
          : '保存しない（呼び出しごとに保存しない指定を渡しています）'
        : '—（外部へ送っていません）',
    },
    {
      label: 'AI に送る範囲',
      value:
        '操作した人の権限で読める承認済みデータ・資料の抜粋だけ。API キー・権限外の資料は送りません。AI の出力は候補として保存し、人が確定します。',
    },
    { label: '監査ログ', value: '追記専用（変更・削除はデータベースで禁止）' },
    {
      label: '資料の受け渡し',
      value:
        mode === 'demo'
          ? 'サーバーが権限を確かめてから返します（直接のリンクは発行しません）'
          : '権限を確かめてから、有効期限 2 分の署名付きリンクを発行します',
    },
    { label: 'データの保管場所', value: '環境からは表示しません（下の「合意した条件」を参照）' },
  ];
}

export interface DataTermsView {
  /** 新しい版が先 */
  versions: OrganizationDataTerms[];
  current: OrganizationDataTerms | null;
  items: DataTermsItemView[];
  notAgreedCount: number;
  /** 処理を委ねる先の表（現在の版） */
  processors: SubprocessorRow[];
  /** この環境が使う外部の処理先と、合意に無い区分の文（Notice warning） */
  environment: EnvironmentProcessor[];
  mismatches: string[];
  /** 削除の後のバックアップの扱い（固定の文。合意した日数入り） */
  residualText: string;
}

/** 合意した条件の版（組織の管理者だけ。設定画面と同じ権限） */
export async function loadDataTerms(
  db: DbClient,
  ctx: AuthorizationContext,
  env: EnvLike = process.env,
): Promise<DataTermsView> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.org.manage');
  const versions = await db.select('organizationDataTerms', {
    where: { organizationId: ctx.workspace.organizationId },
    orderBy: { column: 'versionNo', dir: 'desc' },
  });
  const current = versions[0] ?? null;
  const items = dataTermsItems(current);
  const environment = environmentProcessors(env);
  return {
    versions,
    current,
    items,
    notAgreedCount: items.filter((i) => i.state === 'not_agreed').length,
    processors: subprocessorRows(current),
    environment,
    mismatches: processorMismatches(environment, current),
    residualText: backupResidualText(current?.backupResidualDays ?? null),
  };
}

export interface RecordDataTermsInput {
  ndaStatus: string;
  processingTermsRef: string;
  storageLocation: string;
  retentionPolicy: string;
  aiTrainingUse: string;
  aiProviderStorage: string;
  /**
   * 以前の入力（区分なし。1 行に 1 社「名称／役割／所在地／秘密保持の根拠」）。区分は「その他」として記録する
   */
  subprocessorsText?: string;
  /** 区分ごとの入力（1 行に 1 社「名称／役割／所在地（処理地域）／秘密保持の根拠」） */
  subprocessorsByCategory?: Partial<Record<SubprocessorCategory, string>>;
  returnMethod: string;
  deletionMethod: string;
  /**
   * バックアップの残存期間（日。0〜400。空は未合意）。渡さない（undefined）ときは前の版の合意値を引き継ぐ
   * （黙って未合意に戻さない）
   */
  backupResidualDays?: string | number | null;
  agreedOn: string;
  agreedByLabel: string;
  note: string;
}

/** 処理を委ねる先の上限（Demo の Cookie から戻すときの検査と同じ） */
export const MAX_SUBPROCESSORS = 10;

/**
 * Demo Mode の処理を委ねる先の JSON の上限（Cookie から戻すときの検査 demo-trial-checks.ts と同じ値。
 * 超えると Cookie から戻らないため、記録の前に断る）
 */
export const DEMO_SUBPROCESSORS_JSON_MAX = DEMO_TRIAL_JSON_MAX_CHARS;

/** 本文の上限。Demo Mode は Cookie の容量に合わせる（demo-trial-checks.ts と同じ値） */
export function dataTermsTextLimit(db: DbClient): number {
  return db.mode === 'demo' ? DEMO_TEXT_LIMITS.trialText : 2000;
}

/**
 * 処理を委ねる先の各項目の上限。Demo Mode は 1 項目 60 字（10 社分を Cookie の JSON 2,000 文字に収めるため。
 * 合計もあわせて検査する）
 */
export const SUBPROCESSOR_FIELD_LIMITS = { demo: 60, supabase: 200 } as const;

export function subprocessorFieldLimit(db: Pick<DbClient, 'mode'>): number {
  return db.mode === 'demo' ? SUBPROCESSOR_FIELD_LIMITS.demo : SUBPROCESSOR_FIELD_LIMITS.supabase;
}

function parseSubprocessorLines(
  text: string,
  category: SubprocessorCategory,
  limit: number,
): DataTermsSubprocessor[] {
  const label = statusLabel('subprocessorCategory', category);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      // 区切りは画面の案内どおり全角の「／」だけ（半角の「/」は区切らない。URL・「米国/EU」・「NDA/DPA」を
      // 所在地・根拠へずらさない）。区切るのは 3 回まで、4 つ目以降はそのまま根拠として読む（書き換えない）
      const parts = line.split('／');
      const [name = '', role = '', location = ''] = parts.slice(0, 3).map((v) => v.trim());
      const confidentialityBasis = parts.slice(3).join('／').trim();
      if (name === '') {
        throw new ValidationError(`処理を委ねる先（${label}）の名称を入力してください。`);
      }
      for (const value of [name, role, location, confidentialityBasis]) {
        if (value.length > limit) {
          throw new ValidationError(
            `処理を委ねる先の各項目（名称・役割・所在地・秘密保持の根拠）は ${limit} 文字以内で入力してください。`,
          );
        }
      }
      return { category, name, role, location, confidentialityBasis };
    });
}

/** 区分ごとの入力（と以前の区分なしの入力）を、区分の順に 1 つの一覧にする */
export function parseSubprocessors(
  input: Pick<RecordDataTermsInput, 'subprocessorsText' | 'subprocessorsByCategory'>,
  limit: number,
  options: { demo: boolean } = { demo: false },
): DataTermsSubprocessor[] {
  const byCategory = input.subprocessorsByCategory ?? {};
  const list = [
    ...SUBPROCESSOR_CATEGORY_ORDER.flatMap((category) =>
      parseSubprocessorLines(byCategory[category] ?? '', category, limit),
    ),
    ...parseSubprocessorLines(input.subprocessorsText ?? '', 'other', limit),
  ];
  if (list.length > MAX_SUBPROCESSORS) {
    throw new ValidationError(`処理を委ねる先は ${MAX_SUBPROCESSORS} 社までです（区分の合計）。`);
  }
  if (options.demo && JSON.stringify(list).length > DEMO_SUBPROCESSORS_JSON_MAX) {
    throw new ValidationError(
      `処理を委ねる先の記載が長すぎます（デモでは全社の合計で約 ${DEMO_SUBPROCESSORS_JSON_MAX.toLocaleString('ja-JP')} 文字まで）。各項目を短くしてください。`,
    );
  }
  return list;
}

/** バックアップの残存期間の入力（空は未合意。0〜400 の整数） */
function checkedResidualDays(raw: string | number | null): number | null {
  if (raw === null) return null;
  const text = String(raw).trim().replace(/,/g, '');
  if (text === '') return null;
  const value = Number(text);
  if (!isBackupResidualDays(value)) {
    throw new ValidationError(
      `バックアップの残存期間は 0〜${BACKUP_RESIDUAL_DAYS_MAX} の整数（日）で入力してください。`,
    );
  }
  return value;
}

/**
 * 合意した条件の新しい版を記録する（追記。前の版は残る）。enterprise.org.manage。
 * 未合意の項目は空・未定のまま記録できる（合意した項目から順に埋める）
 */
export async function recordDataTermsVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: RecordDataTermsInput,
): Promise<OrganizationDataTerms> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.org.manage');
  const organizationId = ctx.workspace.organizationId;
  const limit = dataTermsTextLimit(db);

  if (!(NDA_STATUSES as readonly string[]).includes(input.ndaStatus)) {
    throw new ValidationError('NDA の状態を選んでください。');
  }
  if (!(AI_TRAINING_USES as readonly string[]).includes(input.aiTrainingUse)) {
    throw new ValidationError('AI の再学習への利用を選んでください。');
  }
  if (!(AI_PROVIDER_STORAGES as readonly string[]).includes(input.aiProviderStorage)) {
    throw new ValidationError('AI の提供元での保存を選んでください。');
  }
  const texts = {
    processingTermsRef: input.processingTermsRef.trim(),
    storageLocation: input.storageLocation.trim(),
    retentionPolicy: input.retentionPolicy.trim(),
    returnMethod: input.returnMethod.trim(),
    deletionMethod: input.deletionMethod.trim(),
    agreedByLabel: input.agreedByLabel.trim(),
    note: input.note.trim(),
  };
  for (const [key, value] of Object.entries(texts)) {
    if (value.length > limit) {
      const label =
        key === 'note'
          ? 'メモ'
          : key === 'agreedByLabel'
            ? '合意者'
            : DATA_TERMS_ITEM_LABELS[key as DataTermsItem];
      throw new ValidationError(`${label}は ${limit} 文字以内で入力してください。`);
    }
  }
  const agreedOn = input.agreedOn.trim();
  if (agreedOn !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(agreedOn)) {
    throw new ValidationError('合意日は YYYY-MM-DD の形で入力してください。');
  }
  const subprocessors = parseSubprocessors(input, subprocessorFieldLimit(db), {
    demo: db.mode === 'demo',
  });
  const residualInput =
    input.backupResidualDays === undefined
      ? undefined
      : checkedResidualDays(input.backupResidualDays);

  const latest = await db.select('organizationDataTerms', {
    where: { organizationId },
    orderBy: { column: 'versionNo', dir: 'desc' },
    limit: 1,
  });
  const versionNo = (latest[0]?.versionNo ?? 0) + 1;
  const now = new Date().toISOString();
  const terms: OrganizationDataTerms = {
    id: fid('organization_data_terms', `${organizationId}/${versionNo}/${now}`),
    organizationId,
    versionNo,
    ndaStatus: input.ndaStatus as NdaStatus,
    processingTermsRef: texts.processingTermsRef,
    storageLocation: texts.storageLocation,
    retentionPolicy: texts.retentionPolicy,
    aiTrainingUse: input.aiTrainingUse as AiTrainingUse,
    aiProviderStorage: input.aiProviderStorage as AiProviderStorage,
    subprocessors,
    returnMethod: texts.returnMethod,
    deletionMethod: texts.deletionMethod,
    agreedOn: agreedOn === '' ? null : agreedOn,
    agreedByLabel: texts.agreedByLabel,
    note: texts.note,
    // バックアップの残存期間（0060）。入力が無い呼び出しは前の版の合意値を引き継ぐ（黙って未合意に戻さない）
    backupResidualDays:
      residualInput === undefined ? (latest[0]?.backupResidualDays ?? null) : residualInput,
    createdBy: ctx.userId,
    createdAt: now,
  };
  await db.insert('organizationDataTerms', [terms]);

  const notAgreed = dataTermsItems(terms).filter((i) => i.state === 'not_agreed').length;
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'organization_data_terms',
    resourceId: terms.id,
    afterSummary: `データ取扱条件の第 ${versionNo} 版を記録（未合意 ${notAgreed} 項目）`,
  });
  return terms;
}
