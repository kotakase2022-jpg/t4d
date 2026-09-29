import { AlertTriangle, CheckCircle2 } from 'lucide-react';

/**
 * 操作の完了を伝える一行メッセージ。
 *
 * 完了後は `?flash=...` を付けてリダイレクトしているが、読み取る側が無いと
 * 「取込を確定した」「前年度から複製した」といった結果が画面に一切出ず、
 * 成功したのかどうか分からないまま一覧へ戻ることになる。
 *
 * 色だけで状態を表さない（ラベルとアイコンを併記する）。
 */
const MESSAGES: Record<string, (params: URLSearchParams) => string> = {
  imported: () => '取込内容を確定し、非財務データへ反映しました。',
  supplierImported: (params) => {
    const added = params.get('added') ?? '0';
    const replaced = params.get('replaced') ?? '0';
    const total = params.get('total');
    return (
      `サプライヤーデータを取り込み、Scope3 Cat.1 の算定根拠へ新しい版を追記しました` +
      `（新規 ${added} 社 ／ 置き換え ${replaced} 社${total ? ` ／ 一次データ合計 ${total} t-CO2e` : ''}）。`
    );
  },
  supplierDemoReset: (params) => {
    const removed = params.get('removed') ?? '0';
    return (
      `サプライヤーデモの算定版をリセットしました（削除した版 ${removed} 件）。` +
      `初期の算定内訳（版 1）は残っています。同じファイルを再投入すると同じ結果になります。`
    );
  },
  factorRelinked: (params) => {
    const rows = params.get('rows') ?? '1';
    const value = params.get('value');
    const total = params.get('total');
    return (
      `排出量原単位を紐づけ直し、新しい算定版を追記しました` +
      `（対象 ${rows} 行 ／ 行の排出量 ${value ?? '—'} t-CO2e ／ 一次データ合計 ${total ?? '—'} t-CO2e）。`
    );
  },
  carried: (params) => {
    const count = params.get('count');
    return count ? `前年度から ${count} 件を複製しました。` : '前年度から複製しました。';
  },
  bulkAnalyzed: (params) => {
    const analyzed = params.get('analyzed') ?? '0';
    const remaining = params.get('remaining') ?? '0';
    return (
      `${analyzed} 件を人工知能で分析しました。判定は候補です。担当者の確認で最終判定を入れてください。` +
      (remaining !== '0' ? ` 未分析が残り ${remaining} 件あります（もう一度実行できます）。` : '')
    );
  },
  secReport: (params) => {
    const file = params.get('file') ?? '有価証券報告書';
    const checked = params.get('checked') ?? '';
    const equity = params.get('equity');
    return (
      `「${file}」を読み込み、報告対象へ ${checked} を自動選択しました。` +
      (equity
        ? ` ${equity} は本文にありますが持分法適用のため自動選択していません（含める場合は手動でチェックしてください）。`
        : '')
    );
  },
  disclosureFirstChanged: (params) =>
    params.get('state') === 'on'
      ? '開示優先モードを有効にしました。左メニューとホームが開示業務の構成に切り替わりました（既存の画面の URL はそのまま使えます）。'
      : '開示優先モードを無効にしました。従来の左メニューとホームに戻りました。',
  disclosureDemoReset: (params) => {
    const removed = params.get('removed') ?? '0';
    const restored = params.get('restored') ?? '0';
    return (
      `開示デモのデータを初期状態に戻しました（デモ中に作成した行 ${removed} 件を削除・変更された行 ${restored} 件を復元）。` +
      '数値データ・資料・SSBJ の評価などの他の領域には触れていません。'
    );
  },
  // 開示プロジェクト・定性情報・資料（S-c）
  projectCreated: () =>
    '開示プロジェクトを作成しました（準備を開始）。適用判断は「設定」タブで確定します。未確定のままでも下書きの準備はできます。',
  projectUpdated: (params) => {
    const impacted = Number(params.get('impacted') ?? '0');
    return impacted > 0
      ? `プロジェクトを更新しました。影響する原稿 ${impacted} 節の本文・承認は自動では書き換えていません。必要に応じて見直してください。`
      : 'プロジェクトを更新しました。';
  },
  frameworkSaved: () =>
    '適用条件を保存しました（保存して準備を始める）。適用判断はまだ確定していません。',
  applicabilityConfirmed: (params) =>
    `適用判断を確定しました（判断 ${params.get('no') ?? ''}）。理由・参照規則・確認日・判断者を記録しました。`,
  frameworkVersionAttached: () =>
    '新しい版をプロジェクトに追加しました。旧版の原稿・判断はそのまま残っています。新しい版の適用判断を確定してください。',
  narrativeCreated: () =>
    '定性情報を登録しました（下書き）。内容を確かめて、人が確認してください。',
  narrativeSaved: (params) =>
    `定性情報を版 ${params.get('v') ?? ''} として保存しました（未確認）。引用している原稿の本文は書き換わっていません。`,
  narrativeConfirmed: () => '定性情報を確認済みにしました（確認者と日時を記録しました）。',
  narrativeCarried: () =>
    '前年の版から新しい年度の下書きを作りました。前年の確認と資料の引用は引き継いでいません。当年度の根拠を付けてください。',
  narrativeCandidate: (params) => {
    const warnings = Number(params.get('warnings') ?? '0');
    return (
      '資料の抜粋から候補（下書き）を作りました。テンプレート項目は人が記入してください。' +
      (warnings > 0
        ? ' 当年度の根拠ではない資料の抜粋が含まれています（本文に明示しました）。'
        : '')
    );
  },
  documentRegistered: (params) => {
    const extraction = params.get('extraction');
    const count = params.get('count') ?? '0';
    if (extraction === 'extracted')
      return `資料を登録しました（引用できる箇所を ${count} 件抽出）。`;
    if (extraction === 'needs_manual') {
      return '資料を登録しました。テキストは抽出できませんでした（抽出の成功としては扱っていません）。';
    }
    return '資料を登録しました。';
  },
  manualExcerptAdded: () =>
    '手動抜粋を登録しました。「手動の抜粋」として区別され、定性情報の根拠に引用できます。',
  // 原稿編集・レビュー・再確認（S-d）
  blockCreated: () => '節を追加しました（下書き）。本文を書いて「版として保存」してください。',
  blockVersionSaved: (params) =>
    `本文を版 ${params.get('version') ?? ''} として保存しました。以前の版は履歴に残っています。`,
  reviewRequested: () =>
    'レビューを依頼しました。依頼した版・規則・引用した版を固定し、レビュー担当へ通知しました。',
  reviewReturned: () => '差し戻しました（理由と対象の段落を記録しました）。',
  reviewCompleted: () => 'レビューを完了しました。最終承認者へ通知しました。',
  reviewApproved: () =>
    '最終承認しました（社内承認の記録。第三者保証ではありません）。承認した版は以後も変わりません。',
  reviewWithdrawn: () => 'レビュー依頼を取り下げました。節は下書きに戻り、編集できます。',
  recheckDecided: (params) => {
    const decision = params.get('decision');
    if (decision === 'keep_old') return '引用中の版を維持すると記録しました（理由付き）。';
    if (decision === 'return_to_owner')
      return '担当者へ差し戻しました（通知済み）。再確認は未了のままです。';
    return '新しい版を採用した次の版を作りました。承認済みの版はそのまま残っています。再レビューしてください。';
  },
};

export function FlashMessage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // 利用者向けのエラー（権限・入力の誤り）は ?error= に載って戻ってくる。
  // 本番ビルドでは例外メッセージが伏せられるため、この経路が唯一の伝達手段になる。
  const error = typeof searchParams.error === 'string' ? searchParams.error : null;
  if (error) {
    return (
      <p
        role="alert"
        className="mb-2 flex items-center gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
      >
        <AlertTriangle className="size-3.5 text-danger" aria-hidden="true" />
        {error}
      </p>
    );
  }

  const flash = typeof searchParams.flash === 'string' ? searchParams.flash : null;
  if (!flash) return null;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') params.set(key, value);
  }
  const build = MESSAGES[flash];
  if (!build) return null;

  return (
    <p
      role="status"
      aria-live="polite"
      className="mb-2 flex items-center gap-1.5 rounded-t4d border border-success/40 bg-success-soft px-3 py-1.5 text-[12px] text-ink"
    >
      <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
      {build(params)}
    </p>
  );
}
