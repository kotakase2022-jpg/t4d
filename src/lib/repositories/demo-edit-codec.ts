import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  deflateRawSync,
  inflateRawSync,
} from 'node:zlib';

import { permissionsFor } from '@/lib/authorization/can';
import { availabilityFromValue } from '@/lib/domain/disclosure-status';
import type { FixtureDb } from '@/lib/fixtures/store';
import { expandRow, isCompactedTable, type ReplayBudget } from './demo-compact';
import {
  CSRD_DEFERRED_ORDER,
  CSRD_PERSISTED_TABLES,
  acceptCsrdEdit,
  isCsrdCheckedTable,
} from './demo-csrd-checks';
import {
  GHG_APPEND_ONLY_TABLES,
  GHG_DEFERRED_ORDER,
  GHG_PERSISTED_TABLES,
  acceptGhgEdit,
  isGhgCheckedTable,
  restoreRunLines,
} from './demo-ghg-checks';
import {
  TRIAL_APPEND_ONLY_TABLES,
  TRIAL_DEFERRED_ORDER,
  TRIAL_PERSISTED_TABLES,
  acceptTrialEdit,
  isTrialCheckedTable,
} from './demo-trial-checks';
import type {
  Approval,
  DataPoint,
  DataPointVersion,
  DisclosureBlock,
  DisclosureBlockVersion,
  DisclosureProject,
  ExportArtifact,
  NarrativeVersion,
  OrganizationFeatureSettings,
  PermissionKey,
  ProjectFramework,
  ProjectFrameworkDecision,
  QuantitativeImportBatch,
  ReportSnapshot,
  ReviewEvent,
  ReviewRequest,
  SourceAnchor,
  Uuid,
} from '@/types/domain';
import type { TableName } from './types';

/**
 * Demo Mode の変更差分を Cookie へ収めるための符号化。
 *
 * Cookie は 4KB 程度が上限で、取込 1 行は UUID を 7 個持つ。
 * そのうち jobId・jobFileId・organizationId・reportingPeriodId・aiRunId は
 * 同じジョブの全行で同じ値になる。
 *
 * 形式は 2 つ。書くのは '3'（STREAM_MARK）だけで、'2' は以前のデプロイの Cookie を読むために残す。
 *  - '3': すべての編集の JSON を 1 本に Brotli で圧縮し、呼び出し側が Cookie の上限ごとに切り分ける
 *  - '2': Cookie ごとに、**2 回以上現れる文字列を辞書へ移して参照に置き換えてから** deflate したもの
 *    （deflate だけでは 2 倍程度にしか縮まなかった。辞書化で 8〜10 倍）
 *
 * 副作用が無く Cookie にも依存しないので、この層だけ単体テストできる
 * （`demo-persistence.ts` は `server-only` のため直接はテストできない）。
 */

/** 1 件の変更（upsert）。v は「変更のあった列」だけを持つ */
export interface DemoEdit {
  /** テーブル名 */
  t: string;
  /** 主キー */
  id: string;
  /** 変更後の列（部分） */
  v: Record<string, unknown>;
  /**
   * 追記した順番（大きいほど新しい）。以前の形式（'2'）ではチャンクへ空きのあるところへ詰めたため、
   * 読んだ順が追記の順と一致しない。押し出す順（古いものから）を保つのに使う
   */
  n?: number;
}

/**
 * 圧縮形式の目印。
 * 旧形式は必ず `JSON.stringify([...])` の base64url なので先頭は 'W' になる。
 * '2' と衝突しないため、この 1 文字で新旧を判別できる。
 */
const VERSION_2 = '2';

/**
 * 1 本の圧縮列を複数の Cookie に分けて持つ形式の目印（'3'）。中身は編集の JSON を Brotli で圧縮したもの。
 *
 * 以前は編集を Cookie ごとに分けて別々に圧縮していた（'2': 文字列の辞書化 ＋ deflate）。同じ UUID・列名・
 * 日時の接頭辞が Cookie ごとに辞書へ載り直すため、実演の流れでは 3 分割で 11.2KB になり、前半の取込が
 * 押し出されていた。全部を 1 本にすると、辞書化 ＋ deflate で 10.0KB、JSON をそのまま Brotli で 8.4KB
 * （2026-09-30 実測・実演の流れの終わりの編集 47 件）。Brotli は文脈で次の文字を予測するため、同じ列名・
 * UUID の繰り返しと日本語の定型文に強く、辞書化（参照番号への置き換え）はかえって妨げになる。
 * 全部を 1 本に圧縮してから Cookie の上限ごとに切り分け、読むときは順につなげて戻す（demo-persistence.ts）。
 * 先頭の Cookie がこの目印で始まれば分割形式、'2' なら以前の形式として Cookie ごとに読む
 */
export const STREAM_MARK = '3';

/**
 * Brotli の設定。品質 9 は 34KB の JSON を 1ms 未満で圧縮できる（品質 10 以上は約 10〜30 倍遅く、
 * 1 回の書き込みで何度も圧縮し直す押し出しの繰り返しや、数百行の取込で書き込みが遅くなる）。
 * 窓 64KB（lgwin 16）は、展開後の上限（MAX_INFLATED_BYTES）より小さいが、Cookie に収まる量の JSON
 * （実測 34KB）を覆う
 */
const BROTLI_OPTIONS = {
  params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
    [zlibConstants.BROTLI_PARAM_LGWIN]: 16,
    [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
  },
};

/**
 * 辞書参照の目印。制御文字なので実データにはまず現れないが、
 * 万一含まれていても壊れないよう、二重化して退避する。
 */
const REF = String.fromCharCode(1);

/** 辞書に載せる最小長。短い文字列は参照にしても得しない */
const MIN_DICT_LENGTH = 8;

function countStrings(value: unknown, counts: Map<string, number>): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_DICT_LENGTH) counts.set(value, (counts.get(value) ?? 0) + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) countStrings(v, counts);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) countStrings(v, counts);
  }
}

function replaceStrings(value: unknown, index: Map<string, number>): unknown {
  if (typeof value === 'string') {
    const ref = index.get(value);
    if (ref !== undefined) return REF + ref;
    // 実データが目印で始まっていたら二重化しておき、復号時に区別できるようにする
    return value.startsWith(REF) ? REF + value : value;
  }
  if (Array.isArray(value)) return value.map((v) => replaceStrings(v, index));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceStrings(v, index)]));
  }
  return value;
}

function restoreStrings(value: unknown, table: string[]): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith(REF)) return value;
    if (value.startsWith(REF + REF)) return value.slice(1);
    return table[Number(value.slice(1))] ?? '';
  }
  if (Array.isArray(value)) return value.map((v) => restoreStrings(v, table));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreStrings(v, table)]));
  }
  return value;
}

function pack(edits: DemoEdit[]): [string[], unknown] {
  const counts = new Map<string, number>();
  countStrings(edits, counts);
  const table = [...counts.entries()].filter(([, n]) => n >= 2).map(([s]) => s);
  const index = new Map(table.map((s, i) => [s, i]));
  return [table, replaceStrings(edits, index)];
}

function unpack(packed: unknown): unknown {
  if (!Array.isArray(packed) || packed.length !== 2) return packed;
  const [table, body] = packed as [string[], unknown];
  return restoreStrings(body, Array.isArray(table) ? table : []);
}

function deflatePacked(edits: DemoEdit[]): string {
  return deflateRawSync(Buffer.from(JSON.stringify(pack(edits)), 'utf8')).toString('base64url');
}

export function encodeDemoEdits(edits: DemoEdit[]): string {
  return VERSION_2 + deflatePacked(edits);
}

/**
 * 容量に収まらないときに 1 回だけ試す、より強い圧縮（品質 10）。同じ JSON で約 5〜6% 小さくなるが
 * 約 10 倍遅い（実演の流れ＋CSRD の流れの終わりの 43KB で 9ms。2026-10-01 実測: 品質 9 で 11,015B、
 * 品質 10 で 10,414B）。人の操作 1 回の書き込みで、品質 9 で収まらないときだけ使う（取込の行のように
 * 1 回の操作で数百回書き込むときは使わない）。読むときの形式は同じ（Brotli）
 */
const BROTLI_DENSE_OPTIONS = {
  params: {
    ...BROTLI_OPTIONS.params,
    [zlibConstants.BROTLI_PARAM_QUALITY]: 10,
  },
};

/** 分割して持つための 1 本の圧縮列（STREAM_MARK で始まる）。切り分けは呼び出し側が行う */
export function encodeDemoEditStream(edits: DemoEdit[], options: { dense?: boolean } = {}): string {
  return (
    STREAM_MARK +
    brotliCompressSync(
      Buffer.from(JSON.stringify(edits), 'utf8'),
      options.dense ? BROTLI_DENSE_OPTIONS : BROTLI_OPTIONS,
    ).toString('base64url')
  );
}

/**
 * 展開後の上限。Cookie は 4KB 弱でも、圧縮を効かせれば展開後は数百 MB になりうる。
 * 偽造 Cookie 1 つでプロセスのメモリを枯渇させられないよう、展開時点で打ち切る。
 * 正規の Cookie は 40KB 程度（取込 45 行）に収まる。
 */
const MAX_INFLATED_BYTES = 512 * 1024;

export function decodeDemoEdits(raw: string): DemoEdit[] {
  try {
    if (raw.startsWith(STREAM_MARK)) {
      const json = brotliDecompressSync(Buffer.from(raw.slice(1), 'base64url'), {
        maxOutputLength: MAX_INFLATED_BYTES,
      }).toString('utf8');
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? (parsed as DemoEdit[]) : [];
    }
    if (raw.startsWith(VERSION_2)) {
      const json = inflateRawSync(Buffer.from(raw.slice(1), 'base64url'), {
        maxOutputLength: MAX_INFLATED_BYTES,
      }).toString('utf8');
      const parsed = unpack(JSON.parse(json));
      return Array.isArray(parsed) ? (parsed as DemoEdit[]) : [];
    }
    // 旧形式（無圧縮）の Cookie も読めるようにしておく
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? (parsed as DemoEdit[]) : [];
  } catch {
    // 壊れた Cookie で画面が落ちないよう、空として扱う
    return [];
  }
}

/**
 * Cookie に記録する対象テーブル（画面から人が編集するもの）。
 *
 * この一覧は書き込み時と読み取り時の**両方**で使う。
 * ここに無い表は Cookie 経由で一切触れないので、なりすましや証跡の改ざんに
 * 使える表（organizationMemberships / membershipRoles / auditEvents / signoffs）は
 * 意図的に外している。
 *
 * 逆に、ここへ入れた表は「偽の Cookie で作られた行」が混ざりうる。
 * Demo Mode のデータはすべて架空で、デモアカウントは誰でも使える前提
 * （docs/known-limitations.md D-4）なので、デモとして見せたい操作を優先している。
 */
const PERSISTED_TABLES = new Set<TableName>([
  // 取込系。1 ファイル数行程度のデモ操作なら Cookie に収まる。
  // 大量ファイルの取込は収まらないため、その場合は同一インスタンス内でのみ参照できる
  // （docs/known-limitations.md D-3 に記載）。
  'ingestionJobs',
  'ingestionJobFiles',
  'ingestionRows',
  // サプライヤーデータ取込が追記する Scope3 の算定版。
  // 1 回の取込で 1 行（inputs は十数行の JSON）なので Cookie に収まる。
  // 持ち回さないと、取込直後の GHG 画面で内訳が元に戻って見える。
  'calculations',
  'materialityTopics',
  'comments',
  'dataPoints',
  'dataPointVersions',
  'disclosureResponses',
  // CDP の質問と指標の対応付け（確定・追加・外す）。1 回の操作で 1 行。持ち回さないと、確定した対応付けが
  // 別のインスタンスで消える（T7。戻すときは demo-trial-checks.ts が CDP の質問・同じ組織・本人名義を検査）
  'disclosureMappings',
  'metrics',
  'units',
  'notifications',
  // 起票した案件・付与した許諾も持ち回す。
  // 入れないと「作った直後に開くと 404」になる（本番スモークで再現した）。
  'engagements',
  'engagementMembers',
  'grants',
  // AI の実行結果。?run=<id> で読み直す画面が多く、
  // 持ち回さないと「実行したのに何も出ない」になる。
  'aiRuns',
  // SSBJ の設定と開示ドラフト。どちらも「操作した直後に結果を見せる」画面なので、
  // 持ち回さないと本番 Demo Mode で操作が消えたように見える（本番スモークで再現した）。
  //
  // ssbjAssessments は**入れない**。要求事項 133 件の評価行を初回表示で一括作成するため、
  // Cookie の容量を使い切って他の操作（コメント・値編集）を押し出してしまう。
  'ssbjAnalysisSettings',
  'ssbjDisclosureDrafts',
  // 承認の道筋。段階を承認した結果が消えると、進み具合が巻き戻って見える。
  // 1 回の提出で作るのは 5 行なので容量に収まる
  'dataPointApprovalSteps',
  // 開示優先モード（docs/disclosure-first.md §2-6）。状態・ポインタ・短文だけの小さい行に限る。
  // 依頼・差戻し・承認の結果が消えると、レビューの流れが巻き戻って見えるため持ち回す。
  // 節（disclosureBlocks）の自動保存本文（workingBody）は大きくなりうるため、
  // DemoDbClient が Cookie へ書く前に外す（demo-client.ts の persistedColumns）。
  //
  //
  // 本文の版・定性情報の版・引用位置・スナップショット・出力記録・標準 CSV の確定の控え・データの承認の記録は、
  // 以前は「1 件で Cookie を使い切る」として載せず、同じインスタンスのメモリにだけ残していた。本番（Vercel）で
  // 実演の流れが別インスタンスで途切れた（2026-09-30）ため、**小さくした形**で載せる（demo-compact.ts）:
  // 計算できる列を落とし、版の本文は土台の版との差分に、スナップショットは目録にする。
  'narrativeVersions',
  'sourceAnchors',
  'disclosureBlockVersions',
  'reportSnapshots',
  'exportArtifacts',
  // 検証しただけのバッチは載せない。確定の控え（二重登録を止める確定キーと、書いた行）だけ
  'quantitativeImportBatches',
  // データの承認の記録（Data Point の承認だけ）。承認後に数値を訂正しても、引用・固定した版が
  // 承認済みだったことを別インスタンスでも示す（承認済みスナップショットの検査に要る）
  'approvals',
  'organizationFeatureSettings',
  'disclosureProjects',
  'projectFrameworks',
  'projectFrameworkDecisions',
  'narrativeRecords',
  'disclosureBlocks',
  'reviewRequests',
  'reviewEvents',
  'reviewComments',
  'recheckDecisions',
  'kpiTargets',
  // CSRD のダブル・マテリアリティ・評価・計画・開示ドラフト（docs/disclosure-first.md §9.3）。
  // 差分だけを記録する。FY2026 の評価 12 行は Fixture に全部置き、表示時に行を作らない
  // （ssbjAssessments の一括作成の問題を持ち込まない）。草案（AI のデモ生成）は 1 節 600 字以内。
  // 戻すときは DB の規則と同じ検査を通す（demo-csrd-checks.ts）
  ...CSRD_PERSISTED_TABLES,
  // 収集項目（指標 × 拠点 × 期間の割当）。作った直後の収集画面の行が別インスタンスで消えないように。
  // 割当を作るのは collection-item.ts の 1 か所だけで、1 回の操作で 1 行
  'metricAssignments',
  // 報告年度と収集キャンペーン（組織・拠点の「報告年度」「収集キャンペーン」タブ）。作成は保存のあと
  // 結果の通知付きの画面へ移る。その画面（別のリクエスト）が別のインスタンスに届くと、「追加しました」と
  // 出るのに一覧に行が無かった。年度・キャンペーンは 1 回の操作で 1 行。収集スコープは組織 × 指標の行だが、
  // 同じ ID の繰り返しが多く圧縮が効く（数十行で 2KB 前後）。収まらなければ古い編集から押し出す
  'periods',
  'campaigns',
  'campaignScopes',
  // トライアル対応（2026-10。plan 付録 B）: 人の判断・コメント・共有・評価の記録だけを小さい形で載せる。
  // 5 区分・対応表・トレース・Data Room・影響先・通知・XBRL の事実は導出し、書かない。
  // 戻すときは demo-trial-checks.ts が DB と同じ検査（組織・権限・職務分離・本人名義・大きさ）を通す。
  // メンバーシップは架空メンバーの担当拠点・状態の変更だけ（実在のデモ利用者の行・新しい行は戻さない）
  ...TRIAL_PERSISTED_TABLES,
  // Scope1・2 の算定と照合（2026-10-16 の要望。plan §2.7）。算定行は持ち回さない（記録を戻したときに作り直す）。
  // 戻すときは demo-ghg-checks.ts が DB と同じ検査（組織・権限・拠点スコープ・職務分離・状態の遷移・大きさ）を通す
  ...GHG_PERSISTED_TABLES,
]);

/**
 * 追記専用の表。Cookie から既存の行を書き換えさせない（新しい行の追加だけを受け付ける）。
 * DB では UPDATE ポリシーが無く t4d.forbid_mutation() が止める。Demo Mode でも同じにする
 */
const APPEND_ONLY_TABLES: ReadonlySet<string> = new Set([
  'reviewEvents',
  'recheckDecisions',
  'kpiTargets',
  // 数値の版と適用判断の記録も DB では追記専用（0014 data_point_versions_immutable・
  // 0035 project_framework_decisions_immutable）。Cookie から承認済みの版の値を書き換えさせない
  'dataPointVersions',
  'projectFrameworkDecisions',
  // Cookie から戻す版・引用位置・スナップショット・出力記録・確定の控え・承認の記録も DB では追記専用
  // （0036〜0039 の forbid_mutation。取込バッチは確定したら変えない）。既にある行は書き換えない
  'narrativeVersions',
  'sourceAnchors',
  'disclosureBlockVersions',
  'reportSnapshots',
  'exportArtifacts',
  'quantitativeImportBatches',
  'approvals',
  // トライアル対応の追記専用の表（0049〜0057 の forbid_mutation）
  ...TRIAL_APPEND_ONLY_TABLES,
  // Scope1・2 の算定と照合の追記専用の表（0062〜0065 の forbid_mutation）
  ...GHG_APPEND_ONLY_TABLES,
]);

/**
 * Cookie の容量が足りないときも押し出さない表。機能設定（開示優先モードの ON/OFF）が押し出されると、
 * 新しいインスタンスでメニューとホームが従来の構成へ戻り、実演の途中で画面が変わってしまう
 */
const PINNED_TABLES: ReadonlySet<string> = new Set(['organizationFeatureSettings']);

export function isPinnedEdit(edit: Pick<DemoEdit, 't'>): boolean {
  return PINNED_TABLES.has(edit.t);
}

/**
 * 容量を超えたときに落とす順: 押し出さない表以外の、いちばん古い編集から。
 * 落とせる編集が無ければ null
 */
export function dropOldestUnpinned(edits: readonly DemoEdit[]): DemoEdit[] | null {
  const index = edits.findIndex((e) => !isPinnedEdit(e));
  if (index === -1) return null;
  return [...edits.slice(0, index), ...edits.slice(index + 1)];
}

export function isPersistedTable(table: TableName): boolean {
  return PERSISTED_TABLES.has(table);
}

/**
 * Fixture へ変更を再適用する。
 * 対象行が見つからない場合（別インスタンスで作られた新規行など）は無視する。
 *
 * **Cookie の中身は信用しない。** httpOnly は JavaScript から読めなくするだけで、
 * 攻撃者が自分で Cookie ヘッダーを組み立てて送るのは防げない。
 * Fixture DB はプロセス全体で共有されるため、検証せずに適用すると
 * 「1 リクエストで全利用者のデータを書き換える」ことができてしまう。
 *
 * そこで、書き込み時と**同じ許可リスト**をここでも通す。
 * これにより organizationMemberships（ロール注入）・membershipRoles・auditEvents・signoffs
 * といった、なりすましや証跡の改ざんに使える表には一切届かない。
 */
/**
 * 互いを参照して検証する表と、戻す順番（小さいほど先）。受け付けられる順に、進まなくなるまで繰り返す。
 *  - 引用位置 → 定性情報の版 → 原稿の版（土台の版・引用した行が先に要る）
 *  - 依頼 ⇔ 記録 ⇔ 節（記録は対象の版が要る。職務分離を版の作成者で確かめるため）
 *  - Data Point → 数値の版・承認の道筋（現在の版と値の一致、承認の根拠）
 *  - 基準の適用区分 → 適用判断の記録（現在の判断と区分の一致）
 *  - データの承認の記録 → スナップショット（固定した版・数値の承認の根拠が要る）→ 出力記録
 */
const DEFERRED_ORDER: Readonly<Record<string, number>> = {
  sourceAnchors: 1,
  narrativeVersions: 2,
  disclosureBlockVersions: 3,
  reviewRequests: 4,
  reviewEvents: 4,
  disclosureBlocks: 4,
  dataPoints: 4,
  projectFrameworks: 4,
  projectFrameworkDecisions: 4,
  approvals: 5,
  reportSnapshots: 6,
  exportArtifacts: 7,
  quantitativeImportBatches: 8,
  // CSRD: 事項 → IRO、評価 → 計画、事項 → 分析条件（DMA の確定の条件）。割当は指標・拠点の後
  ...CSRD_DEFERRED_ORDER,
  // トライアル対応: 判断 → 履歴・申請、スナップショット → 共有した写し → コメント → 回答、道筋 → 段階
  ...TRIAL_DEFERRED_ORDER,
  // Scope1・2 の算定と照合: セット → 係数 → 割当、方針・規則・バッチ → 行 → 算定の記録 → 既存結果 → 照合 → 確認
  ...GHG_DEFERRED_ORDER,
};

/**
 * 1 回の適用で扱う編集の上限（新しいものから）。正規の Cookie（3 × 3,800B）に載る編集は数百件まで
 * （行ごとに乱数の ID を持ち、圧縮しても 1 件 20B を下回らない）。偽の Cookie は短い ID で数千件を詰められる
 */
export const MAX_APPLIED_EDITS = 1000;

/**
 * 受け付けられるものから適用し直す周回の上限。正規の Cookie は依存の深さが数段で、2〜3 周で落ち着く
 * （原稿の版は節・版番号の順に並べ直すため、長い版の鎖も 1 周で戻る）。以前は上限が無く、新しい順に並べた
 * 版の鎖で 1 周に 1 版しか進まず、9KB の偽の Cookie で 1 リクエストに約 18 秒かかった（自己監査 第 2 巡 F1）
 */
const MAX_PASSES = 8;

/**
 * Cookie から 1 つの節へ戻せる版の数の上限（インスタンスのメモリ全体で）。実演の流れで作る版は数個。
 * 偽の Cookie で ID を変えながら版を足し続け、共有のメモリを増やし続けさせない
 */
export const MAX_REPLAYED_VERSIONS_PER_BLOCK = 200;

/**
 * 1 回の適用で組み立て直してよい本文・スナップショットの写しの量（文字数）。実演の流れの終わりの Cookie で
 * 約 1.3 万字（2026-09-30 実測・stateless-demo-chain.test.ts）。展開後の大きさは Cookie の大きさでは抑えられない
 * （強く圧縮できる）。内容ハッシュ（BigInt の FNV）は 1 文字ずつ計算するため、この量が 1 リクエストの CPU 時間を決める
 */
const REPLAY_BUDGET_CHARS = 1_000_000;

/** 1 件の適用の結果。'retry' は依存する行が後から戻れば受け付けうる、'settled' はこの適用では変わらない */
type ApplyOutcome = 'applied' | 'retry' | 'settled';

interface ApplyContext {
  /** まだ適用していない依頼の編集（記録の検査で、依頼時点の内容を見る） */
  pendingRequests: readonly DemoEdit[];
  /** Cookie の原稿の版の編集が名乗る節（版の ID → 節の ID）。後の周で戻る版の持ち主を先に知る */
  cookieVersionBlocks: ReadonlyMap<string, ReadonlySet<string>>;
  budget: ReplayBudget;
  rowIndex: RowIndex;
  /**
   * スナップショットの目録が参照しうる行（版・節・引用位置・数値など）を受け付けた回数。目録の組み立て直しは
   * 重いため、失敗した後にこの数が変わっていなければ組み立て直さない
   */
  generation: number;
  failedAt: WeakMap<DemoEdit, number>;
  /** 節のレビュー状態が依頼と合わないとき、編集を捨てずに状態を下書きへ戻して受け付ける */
  lenientBlockStatus?: boolean;
}

/** 目録の組み立て直しに関わらない表（これらを受け付けても、失敗した目録を組み立て直さない） */
const SNAPSHOT_INDEPENDENT_TABLES: ReadonlySet<string> = new Set([
  'reportSnapshots',
  'exportArtifacts',
  'quantitativeImportBatches',
  // CSRD の表と割当は開示プロジェクトのスナップショットに含まれない
  ...CSRD_PERSISTED_TABLES,
  'metricAssignments',
  'disclosureMappings',
  // トライアル対応の表のうち、スナップショットの写し（v2 の判断の状態・承認の記録）に関わらないもの。
  // 要求事項の判断・その履歴・対象外の申請は v2 の目録が参照するため、ここに入れない
  ...TRIAL_PERSISTED_TABLES.filter(
    (t) =>
      t !== 'projectRequirementAssessments' &&
      t !== 'projectRequirementAssessmentEvents' &&
      t !== 'requirementExclusionEvents',
  ),
  // Scope1・2 の算定と照合の表は開示プロジェクトのスナップショットに含まれない
  ...GHG_PERSISTED_TABLES,
]);

/**
 * 表ごとの ID の位置（1 回の適用の間だけ使う）。行は末尾に足すか同じ位置で置き換えるだけなので、
 * 足したときに位置を覚えれば作り直さなくてよい
 */
class RowIndex {
  private readonly byTable = new Map<string, Map<unknown, number>>();

  indexOf(table: string, rows: ReadonlyArray<Record<string, unknown>>, id: unknown): number {
    let map = this.byTable.get(table);
    if (!map) {
      const built = new Map<unknown, number>();
      rows.forEach((row, i) => {
        if (!built.has(row.id)) built.set(row.id, i);
      });
      this.byTable.set(table, built);
      map = built;
    }
    return map.get(id) ?? -1;
  }

  pushed(table: string, id: unknown, index: number): void {
    this.byTable.get(table)?.set(id, index);
  }
}

/** 同じ表の中の並べ方。原稿の版は節・版番号の順（土台の版が先に戻る）、ほかは追記した順のまま */
function versionOrderKey(edit: DemoEdit): [string, number] {
  const blockId = typeof edit.v.blockId === 'string' ? edit.v.blockId : '';
  const versionNo = typeof edit.v.versionNo === 'number' ? edit.v.versionNo : 0;
  return [blockId, versionNo];
}

function compareDeferred(a: DemoEdit, b: DemoEdit): number {
  const order = (DEFERRED_ORDER[a.t] ?? 0) - (DEFERRED_ORDER[b.t] ?? 0);
  if (order !== 0 || a.t !== 'disclosureBlockVersions') return order;
  const [blockA, noA] = versionOrderKey(a);
  const [blockB, noB] = versionOrderKey(b);
  if (blockA !== blockB) return blockA < blockB ? -1 : 1;
  return noA - noB;
}

export function applyDemoEdits(db: FixtureDb, edits: DemoEdit[]): void {
  const ctx: ApplyContext = {
    pendingRequests: [],
    cookieVersionBlocks: new Map(),
    budget: { remaining: REPLAY_BUDGET_CHARS },
    rowIndex: new RowIndex(),
    generation: 0,
    failedAt: new WeakMap(),
  };
  const deferred: DemoEdit[] = [];
  // 新しい編集を残す（呼び出し側は追記の順に並べて渡す）。正規の Cookie はこの数に届かない
  for (const edit of edits.slice(-MAX_APPLIED_EDITS)) {
    // 書き込み側の許可リスト（isPersistedTable）と対にする。
    // 片側だけの防御は、Cookie を偽造されると意味を持たない。
    if (!edit || typeof edit.t !== 'string' || !isPersistedTable(edit.t as TableName)) continue;
    if (!edit.v || typeof edit.v !== 'object' || Array.isArray(edit.v)) continue;
    if (DEFERRED_ORDER[edit.t] !== undefined) {
      deferred.push(edit);
      continue;
    }
    applyOne(db, edit, ctx);
  }
  // 同じ順番の中は追記した順のまま（安定ソート）。原稿の版だけは節・版番号の順
  deferred.sort(compareDeferred);
  const versionBlocks = new Map<string, Set<string>>();
  for (const edit of deferred) {
    if (edit.t !== 'disclosureBlockVersions') continue;
    const blocks = versionBlocks.get(edit.id) ?? new Set<string>();
    blocks.add(typeof edit.v.blockId === 'string' ? edit.v.blockId : '');
    versionBlocks.set(edit.id, blocks);
  }
  ctx.cookieVersionBlocks = versionBlocks;
  // 承認・レビューの記録は、DB のトリガと同じ規則を満たすときだけ受け付ける
  // （Fixture DB はインスタンスの全利用者で共有される。偽の Cookie 1 つで、職務分離を通らない
  // 承認を全員の画面に出させない）。記録は依頼を、依頼の状態は記録を参照し、Cookie の中の順番は
  // 更新のたびに入れ替わるため、受け付けられるものから適用し、進まなくなるまで繰り返す（周回に上限あり）
  let pending = deferred;
  for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass += 1) {
    ctx.pendingRequests = pending.filter((e) => e.t === 'reviewRequests');
    const rest: DemoEdit[] = [];
    let progressed = false;
    for (const edit of pending) {
      const outcome = applyOne(db, edit, ctx);
      if (outcome === 'applied') progressed = true;
      else if (outcome === 'retry') rest.push(edit);
    }
    pending = rest;
    if (!progressed) break;
  }
  // 最後まで受け付けられなかった節の編集: レビューの状態だけが依頼と合わない（依頼の編集が
  // Cookie から押し出された等）なら、状態を下書きに戻して他の変更（現在の版・題名・担当）は残す。
  // 状態を残すと「レビュー依頼中」なのに取り下げる依頼が無く、節を編集できなくなる
  ctx.pendingRequests = [];
  ctx.lenientBlockStatus = true;
  for (const edit of pending) {
    if (edit.t === 'disclosureBlocks') applyOne(db, edit, ctx);
  }
}

/** 1 件を適用する */
function applyOne(db: FixtureDb, edit: DemoEdit, ctx: ApplyContext): ApplyOutcome {
  const rows = db[edit.t as TableName] as unknown as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rows)) return 'settled';
  const index = ctx.rowIndex.indexOf(edit.t, rows, edit.id);
  const row = index === -1 ? undefined : rows[index];
  const push = (next: Record<string, unknown>): ApplyOutcome => {
    rows.push(next);
    ctx.rowIndex.pushed(edit.t, next.id, rows.length - 1);
    if (!SNAPSHOT_INDEPENDENT_TABLES.has(edit.t)) ctx.generation += 1;
    return 'applied';
  };
  if (isCompactedTable(edit.t)) {
    // 小さくした形で載せた追記専用の行。既にある行（このインスタンスで作った・既に戻した）は書き換えない。
    // ただし標準 CSV の確定の控えは、このインスタンスで検証しただけのバッチに重ねる（検証と確定が
    // 別のインスタンスに届いた後、確定の再送が検証したインスタンスに届く場合）
    if (row) {
      if (edit.t === 'sharedReportCopies')
        return applySharedCopyWithdrawal(db, edit, row, index, ctx);
      if (edit.t !== 'quantitativeImportBatches') return 'settled';
      const receipt = expandRow(edit.t, edit.v, db);
      if (!receipt || receipt.id !== edit.id) return 'settled';
      const merged = mergeImportReceipt(db, row, receipt);
      if (!merged) return 'settled';
      rows[index] = merged;
      return 'applied';
    }
    // 無ければ組み立て直し（依存する行がまだ無ければ次の周で）、同じ規則で検査してから足す。
    // スナップショットの目録は組み立て直しが重いため、安い検査を先に通し、依存する行が変わるまで繰り返さない
    const isSnapshot = edit.t === 'reportSnapshots';
    if (isSnapshot) {
      if (ctx.failedAt.get(edit) === ctx.generation) return 'retry';
      if (!snapshotManifestPlausible(db, edit.v)) {
        ctx.failedAt.set(edit, ctx.generation);
        return 'retry';
      }
    }
    const expanded = expandRow(edit.t, edit.v, db, { budget: ctx.budget });
    if (!expanded || expanded.id !== edit.id || !acceptEdit(db, edit.t, undefined, expanded, ctx)) {
      if (isSnapshot) ctx.failedAt.set(edit, ctx.generation);
      return 'retry';
    }
    const outcome = push(expanded);
    // 算定行は持ち回さない。記録を戻したら、同じ純関数で作り直した算定行をメモリへ足す（ID は決定論）
    if (edit.t === 'ghgCalculationRuns') {
      restoreRunLines(db, expanded as unknown as Parameters<typeof restoreRunLines>[1]);
    }
    return outcome;
  }
  if (!row && !('id' in edit.v)) return 'settled';
  // 追記専用の表の既にある行は書き換えない（何度繰り返しても変わらない）
  if (row && APPEND_ONLY_TABLES.has(edit.t)) return 'settled';
  const next = normalizeLegacyRow(edit.t, row ? { ...row, ...edit.v } : { ...edit.v });
  if (!acceptEdit(db, edit.t, row, next, ctx)) return 'retry';
  if (row) {
    rows[index] = next;
    if (!SNAPSHOT_INDEPENDENT_TABLES.has(edit.t)) ctx.generation += 1;
    return 'applied';
  }
  // 新規作成された行（コメントなど）は、そのまま足す
  return push(next);
}

/**
 * 保証側へ共有した写しの取り下げを、このインスタンスに既にある写しに重ねる（トライアル対応 NF-20）。
 * 写しは追記専用で、取り下げ（withdrawn_at・withdrawn_by を 1 回だけ入れる）だけが更新。取り下げを戻さないと、
 * 共有したインスタンスでは保証側に写しが見え続ける。目録から写しを作り直し、取り下げ以外が同じときだけ重ねる
 */
function applySharedCopyWithdrawal(
  db: FixtureDb,
  edit: DemoEdit,
  row: Record<string, unknown>,
  index: number,
  ctx: ApplyContext,
): ApplyOutcome {
  if (row.withdrawnAt !== null || edit.v.withdrawnAt === undefined || edit.v.withdrawnAt === null) {
    return 'settled';
  }
  const expanded = expandRow(edit.t, edit.v, db, { budget: ctx.budget });
  if (!expanded || expanded.id !== edit.id) return 'settled';
  if (!acceptEdit(db, edit.t, row, expanded, ctx)) return 'settled';
  const rows = db.sharedReportCopies as unknown as Array<Record<string, unknown>>;
  rows[index] = expanded;
  return 'applied';
}

/**
 * 標準 CSV の確定の控え（Cookie）を、このインスタンスで検証しただけのバッチに重ねる。
 *
 * 検証がインスタンス A、確定が B に届くと、A のメモリには「検証済み」のバッチが残る。確定の応答が届かず
 * 同じ確定キーで押し直した再送が A に届くと、A は控えを「既にある行」として捨て、検証済みのバッチで
 * 確定し直そうとして「検証の後に既存の値が変わった」競合を返していた（確定は成功しているのに）。
 * 同じバッチ（同じ組織・期間・内容・検証した人・行と差分区分）の控えなら、確定の結果を重ねる。
 * 検証済みの行（元の入力・警告）はそのまま残し、確定キー・書いた行・除外だけを控えから写す
 */
function mergeImportReceipt(
  db: FixtureDb,
  existing: Record<string, unknown>,
  receipt: Record<string, unknown>,
): Record<string, unknown> | null {
  const before = existing as unknown as QuantitativeImportBatch;
  const after = receipt as unknown as QuantitativeImportBatch;
  if (before.status !== 'validated' || !acceptImportBatch(db, after)) return null;
  for (const key of ['organizationId', 'reportingPeriodId', 'fileSha256', 'createdBy'] as const) {
    if (before[key] !== after[key]) return null;
  }
  if (before.rows.length !== after.rows.length) return null;
  type ReceiptRow = QuantitativeImportBatch['rows'][number] & {
    writtenDataPointId?: string | null;
    writtenVersionId?: string | null;
  };
  const byRowNo = new Map((after.rows as ReceiptRow[]).map((r) => [r.rowNo, r]));
  const rows: ReceiptRow[] = [];
  for (const row of before.rows) {
    const committed = byRowNo.get(row.rowNo);
    if (!committed || committed.diffKind !== row.diffKind) return null;
    rows.push({
      ...row,
      included: committed.included,
      writtenDataPointId: committed.writtenDataPointId ?? null,
      writtenVersionId: committed.writtenVersionId ?? null,
    });
  }
  return {
    ...existing,
    status: 'committed',
    rows,
    commitIdempotencyKey: after.commitIdempotencyKey,
    committedAt: after.committedAt,
    committedBy: after.committedBy,
    excludedCount: after.excludedCount,
  };
}

/** トライアル対応で既存の表に足した列の既定値（DB の default と同じ） */
const TRIAL_ADDED_COLUMN_DEFAULTS: Readonly<Record<string, Record<string, unknown>>> = {
  csrdDmaIros: { sourceAnchorIds: [], policyActionNote: '' },
  ssbjAnalysisSettings: { frameworkVersionId: null },
  projectFrameworks: { taxonomyPackageId: null },
  approvalRoutes: { purpose: 'default' },
  // 2026-10-16 の要望の対応（0060）で足した列
  trialFeedbackItems: { scopeKind: null },
  organizationDataTerms: { backupResidualDays: null },
};

/**
 * 以前のデプロイの Cookie に残った行を、今の列の形へそろえる。
 * 0039 より前に作られた Data Point・版の行は、値の区分・値の有無・理由の列を持たない。
 * そのまま戻すと、それらの列を読む画面（一覧のバッジ・詳細の履歴）が落ちる
 */
export function normalizeLegacyRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  // トライアル対応（0052・0054・0056）で足した列。以前のデプロイの Cookie の行には無い
  const added = TRIAL_ADDED_COLUMN_DEFAULTS[table];
  if (added) {
    const out = { ...row };
    for (const [key, value] of Object.entries(added)) {
      if (out[key] === undefined) out[key] = structuredClone(value);
    }
    return out;
  }
  if (table !== 'dataPoints' && table !== 'dataPointVersions') return row;
  const out = { ...row };
  if (out.valueKind === undefined) out.valueKind = 'actual';
  if (out.availabilityStatus === undefined) {
    out.availabilityStatus = availabilityFromValue(
      out.value as number | null | undefined,
      out.textValue as string | null | undefined,
    );
  }
  if (out.absenceReason === undefined) out.absenceReason = null;
  return out;
}

// ----------------------------------------------------------------------
// 承認・レビューの記録の検証（0037 / 0041 のトリガと同じ規則を Demo Mode でも通す）
// ----------------------------------------------------------------------

function memberPermissions(db: FixtureDb, organizationId: Uuid, userId: Uuid): Set<PermissionKey> {
  const memberships = db.memberships.filter(
    (m) => m.organizationId === organizationId && m.userId === userId && m.status === 'active',
  );
  const roleKeys = db.membershipRoles
    .filter((r) => memberships.some((m) => m.id === r.membershipId))
    .map((r) => r.roleKey);
  return permissionsFor(roleKeys);
}

function hasEvent(
  db: FixtureDb,
  request: Pick<ReviewRequest, 'id' | 'targetVersionId'>,
  eventType: ReviewEvent['eventType'],
): boolean {
  return db.reviewEvents.some(
    (e) =>
      e.reviewRequestId === request.id &&
      e.eventType === eventType &&
      e.targetVersionId === request.targetVersionId,
  );
}

/**
 * 記録を受け付けられる依頼の状態（0042 の t4d.enforce_review_event と同じ規則）。
 *
 * 依頼の行がこのインスタンスに既にあれば、記録の前の状態を見る（状態は記録の後にしか進まない）。
 * まだ無い（別インスタンスで作られ、Cookie の依頼の編集だけがある）場合、編集は最新の状態に
 * まとめられているため、記録の後に到達しうる状態かを見る。差し戻して終わった依頼に承認を足すなど、
 * 起こりえない組み合わせを受け付けない
 */
function requestStatusAllows(
  event: Pick<ReviewEvent, 'eventType' | 'stage'>,
  status: ReviewRequest['status'],
  applied: boolean,
): boolean {
  if (applied) {
    switch (event.eventType) {
      case 'requested':
      case 'review_completed':
        return status === 'open';
      case 'approved':
        return status === 'reviewed';
      case 'returned':
        return event.stage === 'review' ? status === 'open' : status === 'reviewed';
      case 'withdrawn':
        return status === 'open' || status === 'reviewed';
      default:
        return false;
    }
  }
  switch (event.eventType) {
    case 'requested':
      return true;
    case 'review_completed':
      return status !== 'open';
    case 'approved':
      return status === 'approved';
    case 'returned':
      return status === 'returned';
    case 'withdrawn':
      return status === 'withdrawn';
    default:
      return false;
  }
}

/**
 * 依頼の行の実際の段階。Cookie は依頼を最新の 1 行にまとめて持ち回すため、「依頼中」の行を
 * 持つインスタンスには「レビュー完了」の状態が届かないまま「承認済み」「差戻し（最終段）」が届く。
 * 行が「依頼中」でも、同じ版のレビュー完了の記録が既にあれば「レビュー完了」として扱う
 * （状態は記録の後にしか進まないため、記録が段階を表す）
 */
function effectiveRequestStatus(
  db: FixtureDb,
  request: Pick<ReviewRequest, 'id' | 'targetVersionId' | 'status'>,
): ReviewRequest['status'] {
  if (request.status === 'open' && hasEvent(db, request, 'review_completed')) return 'reviewed';
  return request.status;
}

function acceptReviewEvent(
  db: FixtureDb,
  event: ReviewEvent,
  pendingRequests: readonly DemoEdit[],
): boolean {
  // 依頼の行がまだ適用されていなければ、同じ Cookie の依頼の編集（依頼時点の内容は変わらない）を見る
  const applied = db.reviewRequests.find((r) => r.id === event.reviewRequestId);
  const pending = pendingRequests.find((e) => e.id === event.reviewRequestId);
  const request = applied ?? (pending ? (pending.v as unknown as ReviewRequest) : undefined);
  if (!request || request.organizationId !== event.organizationId) return false;
  if (event.targetVersionId !== request.targetVersionId) return false;
  const status = applied ? effectiveRequestStatus(db, applied) : request.status;
  if (!requestStatusAllows(event, status, applied !== undefined)) return false;
  // 指名: レビュー担当・最終承認者を指名した依頼は、その人の判断だけを受け付ける
  const reviewStage =
    event.eventType === 'review_completed' ||
    (event.eventType === 'returned' && event.stage === 'review');
  const finalStage =
    event.eventType === 'approved' || (event.eventType === 'returned' && event.stage === 'final');
  if (reviewStage && request.reviewerUserId && request.reviewerUserId !== event.actorUserId) {
    return false;
  }
  if (finalStage && request.approverUserId && request.approverUserId !== event.actorUserId) {
    return false;
  }
  const permissions = memberPermissions(db, event.organizationId, event.actorUserId);
  if (event.eventType === 'returned') {
    if (!event.reason?.trim() || !event.paragraphId?.trim()) return false;
    if (event.actorUserId === request.requestedBy) return false;
    return event.stage === 'review'
      ? permissions.has('enterprise.disclosure.write')
      : permissions.has('enterprise.disclosure.approve');
  }
  if (event.eventType === 'withdrawn') {
    const block = db.disclosureBlocks.find((b) => b.id === request.targetId);
    if (event.actorUserId !== request.requestedBy && event.actorUserId !== block?.ownerUserId) {
      return false;
    }
    return permissions.has('enterprise.disclosure.write');
  }
  if (event.eventType === 'requested') {
    return permissions.has('enterprise.disclosure.write');
  }
  // レビュー完了・最終承認: 依頼者・版の作成者・本文を書いた人ではないこと
  if (event.actorUserId === request.requestedBy) return false;
  const version = db.disclosureBlockVersions.find((v) => v.id === request.targetVersionId);
  // 対象の版が戻るまで受け付けない（版は Cookie でも持ち回し、記録より先に戻す）。以前は版がメモリに
  // しか無く、別インスタンスでは版が無いまま作成者の検査を飛ばしていた（偽の Cookie で作成者自身の
  // 承認を戻せた）。版は依頼の対象の節のもの（別の節の版を承認済みにさせない）
  if (!version || version.blockId !== request.targetId) return false;
  if (
    version.createdBy === event.actorUserId ||
    (version.contributorUserIds ?? []).includes(event.actorUserId)
  ) {
    return false;
  }
  if (event.eventType === 'review_completed') {
    return permissions.has('enterprise.disclosure.write');
  }
  // 最終承認: 別の人のレビュー完了の記録があり、自分はレビューを完了していないこと
  const reviewers = db.reviewEvents
    .filter(
      (e) =>
        e.reviewRequestId === request.id &&
        e.eventType === 'review_completed' &&
        e.targetVersionId === request.targetVersionId,
    )
    .map((e) => e.actorUserId);
  if (reviewers.length === 0 || reviewers.includes(event.actorUserId)) return false;
  return permissions.has('enterprise.disclosure.approve');
}

const REQUEST_IMMUTABLE_KEYS = [
  'organizationId',
  'projectId',
  'targetType',
  'targetId',
  'targetVersionId',
  'requestedBy',
  'reviewerUserId',
  'approverUserId',
  'policyVersion',
  'policy',
  'decisionIds',
  'referencedVersions',
  'projectScopeRevision',
  'createdAt',
  'createdBy',
] as const;

const TERMINAL_REQUEST_STATUSES: ReadonlyArray<ReviewRequest['status']> = [
  'returned',
  'approved',
  'withdrawn',
];

function acceptReviewRequest(
  db: FixtureDb,
  existing: ReviewRequest | undefined,
  next: ReviewRequest,
): boolean {
  if (existing) {
    for (const key of REQUEST_IMMUTABLE_KEYS) {
      if (JSON.stringify(existing[key] ?? null) !== JSON.stringify(next[key] ?? null)) return false;
    }
    if (existing.status === next.status) return true;
    if (TERMINAL_REQUEST_STATUSES.includes(existing.status)) return false;
  } else {
    // 新しい依頼: 依頼者は書込権限を持つ組織の利用者で、指名は依頼者と別の人（0037 の検査制約と同じ）
    if (
      !memberPermissions(db, next.organizationId, next.requestedBy).has(
        'enterprise.disclosure.write',
      )
    ) {
      return false;
    }
    if (next.reviewerUserId && next.reviewerUserId === next.requestedBy) return false;
    if (
      next.approverUserId &&
      (next.approverUserId === next.requestedBy || next.approverUserId === next.reviewerUserId)
    ) {
      return false;
    }
    // 範囲の改訂番号はプロジェクトの番号を写したもの（0042 は DB が写す）。先の番号を名乗って
    // 範囲の変更後の再確認を外させない
    const project = db.disclosureProjects.find((p) => p.id === next.projectId);
    if (!project || (next.projectScopeRevision ?? 0) > (project.scopeRevision ?? 0)) return false;
  }
  // 「依頼中」の行を持つインスタンスへ「承認済み」が直接届いても、レビュー完了の記録があれば進める
  const existingStatus = existing ? effectiveRequestStatus(db, existing) : undefined;
  switch (next.status) {
    case 'open':
      return !existing;
    case 'reviewed':
      return (!existing || existing.status === 'open') && hasEvent(db, next, 'review_completed');
    case 'approved':
      return (
        (!existing || existingStatus === 'reviewed') &&
        hasEvent(db, next, 'review_completed') &&
        hasEvent(db, next, 'approved')
      );
    case 'returned':
      return hasEvent(db, next, 'returned');
    case 'withdrawn':
      return hasEvent(db, next, 'withdrawn');
    default:
      return false;
  }
}

/** 節の状態が求める依頼の状態（その依頼の対象版は submittedVersionId） */
const BLOCK_REVIEW_REQUEST_STATUSES: Partial<
  Record<DisclosureBlock['status'], ReadonlyArray<ReviewRequest['status']>>
> = {
  review_requested: ['open'],
  approval_pending: ['reviewed'],
  returned: ['returned'],
};

function hasRequestFor(
  db: FixtureDb,
  block: Pick<DisclosureBlock, 'id'>,
  versionId: Uuid | null,
  statuses: ReadonlyArray<ReviewRequest['status']>,
  eventType?: ReviewEvent['eventType'],
): boolean {
  return db.reviewRequests.some(
    (r) =>
      r.targetId === block.id &&
      r.targetVersionId === versionId &&
      statuses.includes(r.status) &&
      (eventType === undefined || hasEvent(db, r, eventType)),
  );
}

function acceptBlock(
  db: FixtureDb,
  existing: DisclosureBlock | undefined,
  next: DisclosureBlock,
  ctx: ApplyContext,
): boolean {
  // 対応する要求事項は節の基準の版のもの（0049 の t4d.block_requirement_items_guard と同じ）。
  // 対応付けを変えた編集だけを見る（以前の行の対応付けはそのまま戻す）
  const items = next.requirementItemIds;
  if (!existing || JSON.stringify(existing.requirementItemIds) !== JSON.stringify(items ?? null)) {
    if (
      !Array.isArray(items) ||
      items.length > 200 ||
      !items.every((id) =>
        db.disclosureItems.some(
          (i) => i.id === id && i.frameworkVersionId === next.frameworkVersionId,
        ),
      )
    ) {
      return false;
    }
  }
  // 現在の版は、この節の版でなければならない（版も Cookie で持ち回すため、先に戻っている。
  // 押し出されて無いときは、画面が「版を読み込めない」として編集を止める）。
  // まだ戻っていない版でも、同じ Cookie の版の編集が別の節の版を名乗っていれば受け付けない
  // （後の周で戻ると、別の節の本文をこの節の現在の版として出してしまう）。別のリクエストで後から
  // 届く版は、acceptBlockVersion が「別の節が既に指している版」として止める
  if (next.currentVersionId) {
    const current = db.disclosureBlockVersions.find((v) => v.id === next.currentVersionId);
    if (current && current.blockId !== next.id) return false;
    const claimed = ctx.cookieVersionBlocks.get(next.currentVersionId);
    if (!current && claimed && [...claimed].some((blockId) => blockId !== next.id)) return false;
  }
  const before = existing ?? { status: 'draft', approvedVersionId: null };
  const approvalChanged =
    (next.approvedVersionId !== null && next.approvedVersionId !== before.approvedVersionId) ||
    (next.status === 'approved' && before.status !== 'approved');
  if (approvalChanged) {
    // 承認済みにできるのは、最終承認で終わった依頼（記録あり）の版だけ（0042 のトリガと同じ）。
    // 差し戻して終わった依頼に承認の記録を足しても承認済みにはできない
    if (
      !next.approvedVersionId ||
      !hasRequestFor(db, next, next.approvedVersionId, ['approved'], 'approved')
    ) {
      return false;
    }
  }
  // レビュー中・差戻しの状態は、その状態の依頼があるときだけ（依頼が押し出されて無いまま
  // 「レビュー依頼中」だけが残ると、取り下げる依頼が無く節を編集できなくなる）
  const required = BLOCK_REVIEW_REQUEST_STATUSES[next.status];
  if (required && next.status !== before.status) {
    const recorded = hasRequestFor(
      db,
      next,
      next.submittedVersionId,
      required,
      next.status === 'approval_pending' ? 'review_completed' : undefined,
    );
    if (!recorded) {
      if (!ctx.lenientBlockStatus) return false;
      // 承認済みの版（approvedVersionId）はそのまま残る。下書きは「承認後に修正中」と同じ状態
      next.status = 'draft';
      next.submittedVersionId = existing?.submittedVersionId ?? null;
    }
  }
  return true;
}

// ----------------------------------------------------------------------
// 数値・適用判断・機能設定の検査（Cookie から承認・判断・設定を作らせない）
//
// 版の行は追記専用でも、表示する値は Data Point の行（現在の版を指すポインタと値の写し）にある。
// ポインタと写しを自由に書けると、承認していない値を「承認済み」として全員の画面に出せてしまう
// ----------------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Data Point の行が写す、現在の版の値の列 */
const DATA_POINT_VALUE_KEYS = [
  'value',
  'textValue',
  'unitOfMeasure',
  'valueKind',
  'availabilityStatus',
] as const;

/** 状態ごとに要る権限（DB の t4d.enforce_data_point_transition と同じ） */
const DATA_POINT_STATUS_PERMISSION: Partial<Record<DataPoint['status'], PermissionKey>> = {
  approved: 'enterprise.data.approve',
  in_review: 'enterprise.data.review',
  returned: 'enterprise.data.review',
  draft: 'enterprise.data.write',
  submitted: 'enterprise.data.write',
};

function acceptDataPointVersion(next: DataPointVersion): boolean {
  // 版は作成時点の状態で作られる（承認は Data Point と承認の記録で表す）。承認済みの版を Cookie から
  // 足させない（承認の道筋・職務分離・監査記録を経ない「承認済み」の値になる）
  return next.status !== 'approved';
}

function acceptDataPoint(db: FixtureDb, existing: DataPoint | undefined, next: DataPoint): boolean {
  const version = next.currentVersionId
    ? db.dataPointVersions.find((v) => v.id === next.currentVersionId)
    : undefined;
  if (next.currentVersionId) {
    // 現在の版は、この Data Point の版でなければならない
    if (!version || version.dataPointId !== next.id) return false;
    if (version.organizationId !== next.organizationId) return false;
  }
  const pointerChanged = !existing || existing.currentVersionId !== next.currentVersionId;
  const valueChanged =
    !existing || DATA_POINT_VALUE_KEYS.some((key) => !sameValue(existing[key], next[key]));
  if (pointerChanged || valueChanged) {
    // 値は現在の版の写し。版の無い値・版と違う値を書かせない
    if (!version) {
      if (next.value !== null || next.textValue !== null) return false;
    } else {
      const normalized = normalizeLegacyRow('dataPointVersions', { ...version });
      if (DATA_POINT_VALUE_KEYS.some((key) => !sameValue(normalized[key], next[key]))) {
        return false;
      }
    }
  }
  const statusChanged = !existing || existing.status !== next.status;
  const actor = next.updatedBy ?? null;
  if (statusChanged && existing) {
    const required = DATA_POINT_STATUS_PERMISSION[next.status];
    if (required && (!actor || !memberPermissions(db, next.organizationId, actor).has(required))) {
      return false;
    }
  }
  // 承認済みにする（または承認済みのまま別の版を指す）には、承認者の権限と承認の道筋の完了が要る
  // （data-point-workflow.ts の transitionDataPoint と同じ規則）
  if (next.status === 'approved' && (statusChanged || pointerChanged)) {
    const approver = next.approvedBy ?? null;
    if (
      !approver ||
      !memberPermissions(db, next.organizationId, approver).has('enterprise.data.approve')
    ) {
      return false;
    }
    const steps = db.dataPointApprovalSteps.filter(
      (s) => s.dataPointId === next.id && s.organizationId === next.organizationId,
    );
    if (steps.length > 0) {
      const round = Math.max(...steps.map((s) => s.round));
      const current = steps.filter((s) => s.round === round);
      if (!current.every((s) => s.status === 'approved')) return false;
    }
  }
  return true;
}

function acceptFrameworkDecision(db: FixtureDb, next: ProjectFrameworkDecision): boolean {
  // 「適用判断を確定」と同じく、開示の編集権限を持つ組織の利用者の判断で、番号は前の判断より後
  if (
    !memberPermissions(db, next.organizationId, next.decidedBy).has('enterprise.disclosure.write')
  ) {
    return false;
  }
  const previous = db.projectFrameworkDecisions.filter(
    (d) => d.projectFrameworkId === next.projectFrameworkId,
  );
  return previous.every((d) => d.decisionNo < next.decisionNo);
}

/** 判断の記録が無いまま名乗れる区分（準備の区分と未判定） */
const UNDECIDED_STATUSES: ReadonlyArray<ProjectFramework['applicabilityStatus']> = [
  'not_assessed',
  'candidate',
  'awaiting_confirmation',
];

function acceptProjectFramework(
  db: FixtureDb,
  existing: ProjectFramework | undefined,
  next: ProjectFramework,
): boolean {
  // XBRL のプロファイル（0054）はマスターにあるパッケージだけ
  if (
    next.taxonomyPackageId != null &&
    !db.xbrlTaxonomyPackages.some((p) => p.id === next.taxonomyPackageId)
  ) {
    return false;
  }
  if (next.currentDecisionId === null) {
    // 確定した判断を外す操作は無い。判断なしで確定の区分（適用・対象外など）を名乗らせない
    if (existing?.currentDecisionId) return false;
    return UNDECIDED_STATUSES.includes(next.applicabilityStatus);
  }
  const decision = db.projectFrameworkDecisions.find((d) => d.id === next.currentDecisionId);
  if (
    !decision ||
    decision.projectFrameworkId !== next.id ||
    decision.organizationId !== next.organizationId ||
    decision.applicabilityStatus !== next.applicabilityStatus
  ) {
    return false;
  }
  // 古い判断へ戻さない（判断は追記で見直す）
  if (existing?.currentDecisionId && existing.currentDecisionId !== next.currentDecisionId) {
    const before = db.projectFrameworkDecisions.find((d) => d.id === existing.currentDecisionId);
    if (before && before.decisionNo > decision.decisionNo) return false;
  }
  return true;
}

function acceptFeatureSettings(db: FixtureDb, next: OrganizationFeatureSettings): boolean {
  // 開示優先モードの切り替えは、その組織の管理者（enterprise.org.manage）だけ（setDisclosureFirst と同じ）
  const actor = next.updatedBy ?? null;
  return (
    actor !== null && memberPermissions(db, next.organizationId, actor).has('enterprise.org.manage')
  );
}

// ----------------------------------------------------------------------
// 小さくした形で持ち回す追記専用の表の検査（demo-compact.ts が組み立て直した行に対して行う）
//
// Fixture DB はインスタンスの全利用者で共有される。偽の Cookie で、別の組織の行を指す版・権限の無い
// 人の名義の版・承認していない「承認済み」のスナップショットを全員の画面に出させない。
// DB の RLS（書込権限・組織）と、0041〜0043 のトリガ（職務分離・スナップショットの検証）と同じ規則を通す。
// 後から変わりうる行（節の状態・Data Point の現在の版）ではなく、追記専用の記録（依頼・承認の記録・版）で
// 確かめる。Cookie は最終の状態をまとめて戻すため、作成時点の状態を再現できないため
// ----------------------------------------------------------------------

function hasPermission(
  db: FixtureDb,
  organizationId: unknown,
  userId: unknown,
  permission: PermissionKey,
): boolean {
  return (
    typeof organizationId === 'string' &&
    typeof userId === 'string' &&
    memberPermissions(db, organizationId, userId).has(permission)
  );
}

function acceptBlockVersion(db: FixtureDb, next: DisclosureBlockVersion): boolean {
  const block = db.disclosureBlocks.find((b) => b.id === next.blockId);
  if (!block || block.organizationId !== next.organizationId) return false;
  if (!hasPermission(db, next.organizationId, next.createdBy, 'enterprise.disclosure.write')) {
    return false;
  }
  const siblings = db.disclosureBlockVersions.filter((v) => v.blockId === next.blockId);
  if (siblings.length >= MAX_REPLAYED_VERSIONS_PER_BLOCK) return false;
  if (siblings.some((v) => v.versionNo === next.versionNo)) return false;
  if (next.baseVersionId !== null) {
    const base = siblings.find((v) => v.id === next.baseVersionId);
    if (!base || base.versionNo >= next.versionNo) return false;
  }
  // 別の節が既にこの ID を現在の版・承認済みの版・審査中の版として指していれば足さない。
  // 節のポインタは版が無いまま受け付けることがある（版が Cookie から押し出された場合）ため、
  // 後から（同じ Cookie の後の周・別のリクエストで）その ID の別の節の版を足すと、別の節の本文を指してしまう
  return !db.disclosureBlocks.some(
    (b) =>
      b.id !== next.blockId &&
      (b.currentVersionId === next.id ||
        b.approvedVersionId === next.id ||
        b.submittedVersionId === next.id),
  );
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function acceptSourceAnchor(db: FixtureDb, next: SourceAnchor): boolean {
  if (!hasPermission(db, next.organizationId, next.createdBy, 'enterprise.disclosure.write')) {
    return false;
  }
  // 引用位置は資料の抽出結果（または手動の抜粋）から作る（source-anchor.ts の createAnchorFromFragment）。
  // 引用文はその箇所に実在する文言に限る
  const fragment = next.fragmentId ? db.fragments.find((f) => f.id === next.fragmentId) : undefined;
  if (
    !fragment ||
    fragment.organizationId !== next.organizationId ||
    fragment.fileVersionId !== next.fileVersionId
  ) {
    return false;
  }
  return normalizeSpace(fragment.text).includes(normalizeSpace(next.quoteText));
}

function acceptNarrativeVersion(db: FixtureDb, next: NarrativeVersion): boolean {
  const record = db.narrativeRecords.find((r) => r.id === next.narrativeRecordId);
  if (!record || record.organizationId !== next.organizationId) return false;
  if (!hasPermission(db, next.organizationId, next.createdBy, 'enterprise.disclosure.write')) {
    return false;
  }
  if (
    db.narrativeVersions.some(
      (v) => v.narrativeRecordId === next.narrativeRecordId && v.versionNo === next.versionNo,
    )
  ) {
    return false;
  }
  const period = db.periods.find((p) => p.id === next.reportingPeriodId);
  if (!period || period.organizationId !== next.organizationId) return false;
  // 根拠の引用位置は同じ組織のもの（先に戻しておく）
  if (
    !next.sourceAnchorIds.every((id) =>
      db.sourceAnchors.some((a) => a.id === id && a.organizationId === next.organizationId),
    )
  ) {
    return false;
  }
  // 説明するインパクト・リスク・機会も同じ組織のもの（0052 の t4d.narrative_iro_refs_guard と同じ）
  const iroRefs = (next as { iroRefs?: unknown }).iroRefs ?? [];
  return (
    Array.isArray(iroRefs) &&
    iroRefs.length <= 50 &&
    iroRefs.every((id) =>
      db.csrdDmaIros.some((i) => i.id === id && i.organizationId === next.organizationId),
    )
  );
}

/**
 * その版を承認した記録（最終承認で終わった依頼と、その最終承認の日時）。追記専用の記録で確かめる
 * （節の現在の状態は見ない）
 */
function approvalsOf(
  db: FixtureDb,
  blockId: Uuid,
  versionId: Uuid,
): Array<{ request: ReviewRequest; approvedAt: number }> {
  const out: Array<{ request: ReviewRequest; approvedAt: number }> = [];
  for (const request of db.reviewRequests) {
    if (
      request.targetId !== blockId ||
      request.targetVersionId !== versionId ||
      request.status !== 'approved'
    ) {
      continue;
    }
    for (const event of db.reviewEvents) {
      if (
        event.reviewRequestId === request.id &&
        event.eventType === 'approved' &&
        event.targetVersionId === versionId
      ) {
        out.push({ request, approvedAt: Date.parse(event.createdAt) });
      }
    }
  }
  return out;
}

/** 時刻のずれの許容（インスタンスの時計の差）。これより先の作成日時は名乗らせない */
const CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * 固定した時点で出力の対象だった基準（プロジェクトの基準の行と、追記専用の適用判断の記録で決める）。
 * 目録が名乗る基準の一覧は信用しない（空にすれば、どの節も「対象外の基準の節」として外せてしまう）。
 * 固定の後に登録した基準は含めない。判断が固定の後なら、固定時点は未判定（対象外ではない）として含める
 * （判断の記録が無いまま名乗れるのは準備の区分と未判定だけ。acceptProjectFramework）
 */
function frameworksInForceAt(db: FixtureDb, project: DisclosureProject, at: number): Set<Uuid> {
  const out = new Set<Uuid>();
  for (const pf of db.projectFrameworks) {
    if (pf.projectId !== project.id || pf.organizationId !== project.organizationId) continue;
    if (!(Date.parse(pf.createdAt) <= at)) continue;
    let latest: ProjectFrameworkDecision | undefined;
    for (const decision of db.projectFrameworkDecisions) {
      if (decision.projectFrameworkId !== pf.id || !(Date.parse(decision.decidedAt) <= at)) {
        continue;
      }
      if (!latest || decision.decisionNo > latest.decisionNo) latest = decision;
    }
    if (latest?.applicabilityStatus !== 'not_applicable') out.add(pf.frameworkVersionId);
  }
  return out;
}

/**
 * 目録の組み立て直しの前に通す安い検査（プロジェクト・組織・作成者の権限・節の所属・番号の重複）。
 * 組み立て直しは本文の写しと内容ハッシュの計算で重いため、明らかに受け付けない目録で行わない
 * （acceptReportSnapshot は組み立てた写しに対して同じ検査を改めて行う）
 */
function snapshotManifestPlausible(db: FixtureDb, v: Record<string, unknown>): boolean {
  const project = db.disclosureProjects.find((p) => p.id === v.projectId);
  if (!project || project.organizationId !== v.organizationId) return false;
  const permitted =
    v.snapshotKind === 'approved'
      ? hasPermission(db, v.organizationId, v.createdBy, 'enterprise.disclosure.approve')
      : hasPermission(db, v.organizationId, v.createdBy, 'enterprise.disclosure.write') ||
        hasPermission(db, v.organizationId, v.createdBy, 'enterprise.export.run');
  if (!permitted) return false;
  if (
    db.reportSnapshots.some(
      (s) =>
        s.projectId === v.projectId &&
        s.snapshotKind === v.snapshotKind &&
        s.snapshotNo === v.snapshotNo,
    )
  ) {
    return false;
  }
  if (!Array.isArray(v.bl)) return false;
  const projectBlocks = new Set(
    db.disclosureBlocks
      .filter((b) => b.projectId === project.id && b.organizationId === project.organizationId)
      .map((b) => b.id),
  );
  const seen = new Set<unknown>();
  for (const entry of v.bl as unknown[]) {
    const blockId = (entry as { i?: unknown } | null)?.i;
    if (typeof blockId !== 'string' || !projectBlocks.has(blockId) || seen.has(blockId)) {
      return false;
    }
    seen.add(blockId);
  }
  return true;
}

/** 数値の版が承認されていた根拠（0042 の t4d.verify_report_snapshot と同じ 3 つ） */
function dataPointVersionApproved(db: FixtureDb, version: DataPointVersion): boolean {
  if (version.status === 'approved') return true;
  const dp = db.dataPoints.find((d) => d.id === version.dataPointId);
  if (dp?.status === 'approved' && dp.currentVersionId === version.id) return true;
  return db.approvals.some(
    (a) =>
      a.targetType === 'data_point' &&
      a.targetId === version.dataPointId &&
      a.targetVersionId === version.id &&
      a.decision === 'approved',
  );
}

/**
 * スナップショットの目録（組み立て直した写し）。内容ハッシュの一致は組み立て直しで確かめ済み
 * （demo-compact.ts）。ここでは 0042 の t4d.verify_report_snapshot と同じ主張の検査を、
 * 追記専用の記録に対して行う（ハッシュは鍵の無い sha256 で、偽の目録でも合わせられるため）
 */
function acceptReportSnapshot(db: FixtureDb, next: ReportSnapshot): boolean {
  const project = db.disclosureProjects.find((p) => p.id === next.projectId);
  if (!project || project.organizationId !== next.organizationId) return false;
  const approvedKind = next.snapshotKind === 'approved';
  // 作成日時はプロジェクトの作成より後で、未来ではないこと（作成日時で完全性の検査の範囲が決まる。
  // 過去へずらして、後から作った節・後から確定した判断を「固定時点に無かった」ことにさせない）
  const createdAt = Date.parse(next.createdAt);
  if (
    !Number.isFinite(createdAt) ||
    createdAt > Date.now() + CLOCK_SKEW_MS ||
    !(createdAt >= Date.parse(project.createdAt))
  ) {
    return false;
  }
  if (approvedKind) {
    if (!hasPermission(db, next.organizationId, next.createdBy, 'enterprise.disclosure.approve')) {
      return false;
    }
  } else if (
    !hasPermission(db, next.organizationId, next.createdBy, 'enterprise.disclosure.write') &&
    !hasPermission(db, next.organizationId, next.createdBy, 'enterprise.export.run')
  ) {
    return false;
  }
  // 番号は (プロジェクト, 種別) ごとの通し番号（report_snapshots_unique）
  if (
    db.reportSnapshots.some(
      (s) =>
        s.projectId === next.projectId &&
        s.snapshotKind === next.snapshotKind &&
        s.snapshotNo === next.snapshotNo,
    )
  ) {
    return false;
  }
  const blocks = next.blocks as Array<ReportSnapshot['blocks'][number] & SnapshotClaims>;
  // 固定時点の報告範囲の改訂番号（目録の pj.r）。番号は上がるだけなので、プロジェクトより先の番号は名乗れない
  const claimedRevision =
    (next.frameworkVersions[0] as { scopeRevision?: number | null } | undefined)?.scopeRevision ??
    0;
  const projectRevision = project.scopeRevision ?? 0;
  if (claimedRevision > projectRevision) return false;
  // 確定版の再確認は、プロジェクトの今の番号でも求める（DB の verify_report_snapshot は作成時のプロジェクトの
  // 番号と比べる）。目録の番号は偽れるうえ、Cookie には範囲を変えた日時が残らず、固定時点の番号を
  // 確かめられない。範囲を変えた後は、変える前に確定した確定版を別のインスタンスでは戻さない（上流の行が
  // 変わった目録と同じく「見つからない」になる。docs/known-limitations.md D-3）
  const frozenRevision = Math.max(claimedRevision, projectRevision);
  // 確定版が含むべき基準は、目録の一覧ではなくプロジェクトの行で決める
  const inForce = approvedKind ? frameworksInForceAt(db, project, createdAt) : new Set<Uuid>();
  let versionCount = 0;
  let allSelf = true;
  for (const entry of blocks) {
    const block = db.disclosureBlocks.find((b) => b.id === entry.blockId);
    if (
      !block ||
      block.projectId !== next.projectId ||
      block.organizationId !== next.organizationId
    ) {
      return false;
    }
    // 確定版は、固定時点で対象だった基準の節だけを含む（report-snapshot.ts の assemble と同じ）
    if (approvedKind && !inForce.has(block.frameworkVersionId)) return false;
    if (entry.versionId === null) {
      if (approvedKind) return false;
      continue;
    }
    const version = db.disclosureBlockVersions.find((v) => v.id === entry.versionId);
    if (!version || version.blockId !== block.id) return false;
    versionCount += 1;
    if (
      version.createdBy !== next.createdBy &&
      !(version.contributorUserIds ?? []).includes(next.createdBy)
    ) {
      allSelf = false;
    }
    if (
      approvedKind &&
      (!entry.isApprovedVersion ||
        entry.status !== 'approved' ||
        entry.approvedVersionId !== version.id)
    ) {
      return false;
    }
    // 承認済みの版と名乗るなら、最終承認で終わった依頼がその版にあること（草稿でも同じ）
    if (entry.isApprovedVersion || approvedKind) {
      const approvals = approvalsOf(db, block.id, version.id);
      if (approvals.length === 0) return false;
      // 確定版: 固定時点までに最終承認されていること（作成日時を最終承認より前にずらさせない）。
      // 報告範囲の変更より前の依頼でしか承認されていない版は含めない
      if (
        approvedKind &&
        !approvals.some(
          (a) =>
            a.approvedAt <= createdAt && (a.request.projectScopeRevision ?? 0) >= frozenRevision,
        )
      ) {
        return false;
      }
    }
  }
  for (const value of next.metricValues as Array<
    ReportSnapshot['metricValues'][number] & { versionApproved?: boolean }
  >) {
    const version = db.dataPointVersions.find((v) => v.id === value.dataPointVersionId);
    if (!version || version.organizationId !== next.organizationId) return false;
    if (value.versionApproved === true) {
      if (!dataPointVersionApproved(db, version)) return false;
    } else if (approvedKind || value.status === 'approved') {
      return false;
    }
  }
  for (const anchor of next.anchors) {
    const row = db.sourceAnchors.find((a) => a.id === anchor.sourceAnchorId);
    if (!row || row.organizationId !== next.organizationId) return false;
  }
  if (
    !next.narrativeVersionIds.every((id) =>
      db.narrativeVersions.some((v) => v.id === id && v.organizationId === next.organizationId),
    )
  ) {
    return false;
  }
  if (approvedKind) {
    // 固定した基準の一覧は、固定時点で対象だった基準（対象外と判断した基準以外）と一致すること
    // （0042 の verify_report_snapshot はプロジェクトの基準の行で見る。以前は目録の一覧を信用し、
    // 一覧を空にすればどの節も外せた）
    const frozen = next.frameworkVersions.map((f) => f.frameworkVersionId);
    if (
      frozen.length === 0 ||
      frozen.length !== inForce.size ||
      !frozen.every((id) => inForce.has(id)) ||
      next.frameworkVersions.some((f) => f.applicabilityStatus === 'not_applicable')
    ) {
      return false;
    }
    // 対象の基準の節をすべて含める（固定時点にあった節で見る）
    const fixed = new Set(blocks.map((b) => b.blockId));
    const omitted = db.disclosureBlocks.some(
      (b) =>
        b.projectId === next.projectId &&
        inForce.has(b.frameworkVersionId) &&
        Date.parse(b.createdAt) <= createdAt &&
        (b.deletedAt === null || Date.parse(b.deletedAt) > createdAt) &&
        !fixed.has(b.id),
    );
    if (omitted) return false;
    if (project.finalApproverUserId !== null && project.finalApproverUserId !== next.createdBy) {
      return false;
    }
    if (versionCount > 0 && allSelf) return false;
  }
  return true;
}

interface SnapshotClaims {
  approvedVersionId: Uuid | null;
  isApprovedVersion: boolean;
}

function acceptExportArtifact(db: FixtureDb, next: ExportArtifact): boolean {
  const snapshot = db.reportSnapshots.find((s) => s.id === next.snapshotId);
  if (!snapshot || snapshot.organizationId !== next.organizationId) return false;
  return hasPermission(db, next.organizationId, next.generatedBy, 'enterprise.export.run');
}

function acceptImportBatch(db: FixtureDb, next: QuantitativeImportBatch): boolean {
  // 確定できるのは検証した本人だけ（quantitative-import.ts の commit と同じ）
  if (next.status !== 'committed' || next.committedBy !== next.createdBy) return false;
  if (
    !hasPermission(db, next.organizationId, next.committedBy, 'enterprise.import.run') ||
    !hasPermission(db, next.organizationId, next.committedBy, 'enterprise.data.write')
  ) {
    return false;
  }
  const period = db.periods.find((p) => p.id === next.reportingPeriodId);
  return period !== undefined && period.organizationId === next.organizationId;
}

function acceptApproval(db: FixtureDb, next: Approval): boolean {
  if (next.targetType !== 'data_point') return false;
  const dp = db.dataPoints.find((d) => d.id === next.targetId);
  if (!dp || dp.organizationId !== next.organizationId) return false;
  if (next.targetVersionId !== null) {
    const version = db.dataPointVersions.find((v) => v.id === next.targetVersionId);
    if (!version || version.dataPointId !== dp.id) return false;
  }
  if (next.decision === 'returned') {
    return hasPermission(db, next.organizationId, next.actorUserId, 'enterprise.data.review');
  }
  if (next.decision !== 'approved') return false;
  if (!hasPermission(db, next.organizationId, next.actorUserId, 'enterprise.data.approve')) {
    return false;
  }
  // 承認の道筋がある Data Point は、全段階を承認した巡があること（transitionDataPoint と同じ）
  const steps = db.dataPointApprovalSteps.filter(
    (s) => s.dataPointId === dp.id && s.organizationId === dp.organizationId,
  );
  if (steps.length === 0) return true;
  const rounds = [...new Set(steps.map((s) => s.round))];
  return rounds.some((round) =>
    steps.filter((s) => s.round === round).every((s) => s.status === 'approved'),
  );
}

function acceptEdit(
  db: FixtureDb,
  table: string,
  existing: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  ctx: ApplyContext,
): boolean {
  if (existing && APPEND_ONLY_TABLES.has(table)) return false;
  switch (table) {
    case 'disclosureBlockVersions':
      return acceptBlockVersion(db, next as unknown as DisclosureBlockVersion);
    case 'sourceAnchors':
      return acceptSourceAnchor(db, next as unknown as SourceAnchor);
    case 'narrativeVersions':
      return acceptNarrativeVersion(db, next as unknown as NarrativeVersion);
    case 'reportSnapshots':
      return acceptReportSnapshot(db, next as unknown as ReportSnapshot);
    case 'exportArtifacts':
      return acceptExportArtifact(db, next as unknown as ExportArtifact);
    case 'quantitativeImportBatches':
      return acceptImportBatch(db, next as unknown as QuantitativeImportBatch);
    case 'approvals':
      return acceptApproval(db, next as unknown as Approval);
    case 'dataPointVersions':
      return acceptDataPointVersion(next as unknown as DataPointVersion);
    case 'dataPoints':
      return acceptDataPoint(
        db,
        existing as unknown as DataPoint | undefined,
        next as unknown as DataPoint,
      );
    case 'projectFrameworkDecisions':
      return acceptFrameworkDecision(db, next as unknown as ProjectFrameworkDecision);
    case 'projectFrameworks':
      return acceptProjectFramework(
        db,
        existing as unknown as ProjectFramework | undefined,
        next as unknown as ProjectFramework,
      );
    case 'organizationFeatureSettings':
      return acceptFeatureSettings(db, next as unknown as OrganizationFeatureSettings);
    case 'reviewEvents':
      return acceptReviewEvent(db, next as unknown as ReviewEvent, ctx.pendingRequests);
    case 'reviewRequests':
      return acceptReviewRequest(
        db,
        existing as unknown as ReviewRequest | undefined,
        next as unknown as ReviewRequest,
      );
    case 'disclosureProjects':
      // 範囲の改訂番号は下げられない（0042 の t4d.guard_project_scope_revision と同じ）
      return (
        !existing ||
        ((next as { scopeRevision?: number }).scopeRevision ?? 0) >=
          ((existing as { scopeRevision?: number }).scopeRevision ?? 0)
      );
    case 'disclosureBlocks':
      return acceptBlock(
        db,
        existing as unknown as DisclosureBlock | undefined,
        next as unknown as DisclosureBlock,
        ctx,
      );
    default:
      // CSRD の表と割当（0044〜0046・収集項目）は DB の規則と同じ検査を通す
      if (isCsrdCheckedTable(table)) {
        return acceptCsrdEdit(db, table, existing, next, (organizationId, userId, permission) =>
          hasPermission(db, organizationId, userId, permission),
        );
      }
      // Scope1・2 の算定と照合の表（0061〜0065）も DB の規則と同じ検査を通す
      if (isGhgCheckedTable(table)) {
        return acceptGhgEdit(db, table, existing, next, (organizationId, userId, permission) =>
          hasPermission(db, organizationId, userId, permission),
        );
      }
      // トライアル対応の表（0049〜0057）も DB の規則と同じ検査を通す
      if (isTrialCheckedTable(table)) {
        return acceptTrialEdit(db, table, existing, next, (organizationId, userId, permission) =>
          hasPermission(db, organizationId, userId, permission),
        );
      }
      return true;
  }
}
