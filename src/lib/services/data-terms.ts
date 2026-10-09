import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { getAppMode, getOpenAiConfig } from '@/lib/config';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import type { DataTermsState } from '@/lib/ui/status/dataTerms';
import type { DbClient } from '@/lib/repositories/types';
import {
  AI_PROVIDER_STORAGES,
  AI_TRAINING_USES,
  NDA_STATUSES,
  type AiProviderStorage,
  type AiTrainingUse,
  type AuthorizationContext,
  type DataTermsSubprocessor,
  type NdaStatus,
  type OrganizationDataTerms,
} from '@/types/domain';

/**
 * データ取扱条件（トライアル対応 NF-28）。合意した条件の版（追記専用 organization_data_terms）と、
 * システムの実態（設定から自動で読む）を並べる。
 *
 *  - 未合意の項目は「未合意」と出す。推測で埋めない（空・undecided・NDA の未締結は未合意）
 *  - 版は追記だけ（DB は forbid_mutation）。記録は組織の管理者（enterprise.org.manage）
 *  - システムの実態は Secret を出さない（API キーの有無だけ。値は読まない）
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
  subprocessors: '再委託先',
  returnMethod: '終了時の返却方法',
  deletionMethod: '終了時の削除方法',
  agreement: '合意日・合意者',
};

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
      case 'subprocessors':
        return terms.subprocessors.length === 0
          ? { item, label, value: '—', state: 'not_agreed' }
          : {
              item,
              label,
              value: terms.subprocessors
                .map((s) => [s.name, s.role, s.location].filter((v) => v.trim() !== '').join('／'))
                .join('、'),
              state: 'agreed',
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
export function systemFacts(): SystemFact[] {
  const mode = getAppMode();
  const ai = getOpenAiConfig();
  const connected = ai.apiKey !== null;
  return [
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
}

/** 合意した条件の版（組織の管理者だけ。設定画面と同じ権限） */
export async function loadDataTerms(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<DataTermsView> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.org.manage');
  const versions = await db.select('organizationDataTerms', {
    where: { organizationId: ctx.workspace.organizationId },
    orderBy: { column: 'versionNo', dir: 'desc' },
  });
  const current = versions[0] ?? null;
  const items = dataTermsItems(current);
  return {
    versions,
    current,
    items,
    notAgreedCount: items.filter((i) => i.state === 'not_agreed').length,
  };
}

export interface RecordDataTermsInput {
  ndaStatus: string;
  processingTermsRef: string;
  storageLocation: string;
  retentionPolicy: string;
  aiTrainingUse: string;
  aiProviderStorage: string;
  /** 1 行に 1 社（「名称／役割／所在地」） */
  subprocessorsText: string;
  returnMethod: string;
  deletionMethod: string;
  agreedOn: string;
  agreedByLabel: string;
  note: string;
}

/** 再委託先の上限（Demo の Cookie から戻すときの検査と同じ） */
export const MAX_SUBPROCESSORS = 10;

/** 本文の上限。Demo Mode は Cookie の容量に合わせる（demo-trial-checks.ts と同じ値） */
export function dataTermsTextLimit(db: DbClient): number {
  return db.mode === 'demo' ? DEMO_TEXT_LIMITS.trialText : 2000;
}

function parseSubprocessors(text: string, limit: number): DataTermsSubprocessor[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length > MAX_SUBPROCESSORS) {
    throw new ValidationError(`再委託先は ${MAX_SUBPROCESSORS} 社までです。`);
  }
  return lines.map((line) => {
    const [name = '', role = '', location = ''] = line.split(/[／/]/).map((v) => v.trim());
    if (name === '') throw new ValidationError('再委託先の名称を入力してください。');
    for (const value of [name, role, location]) {
      if (value.length > limit) {
        throw new ValidationError(`再委託先の各項目は ${limit} 文字以内で入力してください。`);
      }
    }
    return { name, role, location };
  });
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
  const subprocessors = parseSubprocessors(input.subprocessorsText, limit);

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
