/**
 * 取込行の種別判定。
 *
 * 人事・給与システムの帳票は、明細行と**同じ列構成のまま**「小計」「合計」行を
 * 吐き出す（奉行の[汎用データ作成]は「計行出力」が既定で有効）。
 * 明細行と合計行を両方確定すると、台帳の合計が二重計上になる。
 *
 * ここでは行の種別を規則ベースで判定する。AI 判定にしないのは、
 * 「なぜこの行を確定しなかったか」を監査法人へ再現して説明する必要があるため
 * （バウンダリ検知 `boundary.ts` と同じ方針）。
 *
 * 判定は保守的に倒す。明細を合計と誤認すると**本物のデータが取り込まれなくなる**ので、
 * 少しでも怪しければ detail のままにする。
 */

export type RowRole =
  /** 明細行。通常の取込対象 */
  | 'detail'
  /** 小計・合計・総計。明細と重複するため確定させない */
  | 'total'
  /** 注記・フッター（※、以上、レコード件数、End of report） */
  | 'note';

/**
 * 集計行を示す語。行頭・行末の装飾（＜＞、括弧、空白）を除いた上で照合する。
 * 「経営企画部 小計」「Executive Officials and Managers Totals」のように
 * 見出し語の前に対象名が付く形が実際の帳票では大半を占める。
 */
const TOTAL_WORD =
  '小計|中計|大計|合計|総計|総合計|累計|計|sub[- ]?total|grand[- ]?total|totals?|overall|summe|gesamt(?:summe)?|zwischensumme|total\\s+g[ée]n[ée]ral|sous[- ]total|合[计計]|小[计計]|总[计計]';

const TOTAL_LABEL = new RegExp(
  // 単独（「合計」「Total」）
  `^(?:${TOTAL_WORD})$` +
    // 対象名が前に付く（「第一営業部 計」「Vertrieb Nord Zwischensumme」）。
    // 区切りの空白を必須にして「設計」「統計」のような普通の語を弾く
    `|^.{1,56}[\\s\\u3000](?:${TOTAL_WORD})$` +
    // 見出し語が先頭に来て補足が続く（「Total (consolidated subsidiaries only)」）
    `|^(?:total|totals|grand\\s+total|合計|小計|総計|総合計|合计|小计|总计)\\b.{0,40}$`,
  'i',
);

/** 注記・フッター行 */
const NOTE_LABEL =
  /^(?:※|＊|\*|注\)|注[:：]|注記|備考[:：]|以上$|note\s*[:：]|hinweis\s*[:：]|remarque\s*[:：]|end of report|total records|record count|レコード件数|出力件数|件数[:：]|datens[äa]tze\s*[:：]|nombre d'enregistrements|记录数|page\s*\d+|\d+\s*\/\s*\d+\s*ページ|次頁へ|continued)/i;

/**
 * 集計行と判定してよい最大ラベル長。長文の中の「合計」を拾わないためのガード。
 * EEO-1 の「Executive/Senior Level Officials and Managers Totals」のように
 * 見出し語自体が長いことがあるため広めに取り、代わりに TOTAL_LABEL 側で
 * 「見出し語が末尾にあること」を要求して誤検知を抑える。
 */
const MAX_LABEL_LENGTH = 60;

/** 表全体のうち、これを超える割合が集計行に見えたら判定が壊れているとみなす */
const MAX_TOTAL_RATIO = 0.5;

function stripDecoration(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[＜＞<>【】[\]()（）「」]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 数値として読めるセルか（桁区切り・全角・記号付きを含む） */
function looksNumeric(value: string): boolean {
  const v = value.normalize('NFKC').replace(/[,\s%]/g, '');
  if (v === '') return false;
  return /^[-+]?\d+(\.\d+)?$/.test(v);
}

/**
 * 「ラベルらしいセル」だけを集計判定の対象にする。
 *
 * 列名に「支給合計」がある給与明細のように、**値**として合計額を持つ行は明細である。
 * ラベル列（短い・数値でない）だけを見ることで、この誤検知を避ける。
 */
function labelCells(raw: Record<string, string>): string[] {
  return Object.values(raw)
    .map((v) => stripDecoration(v ?? ''))
    .filter((v) => v !== '' && !looksNumeric(v) && v.length <= MAX_LABEL_LENGTH);
}

/** 1 行の種別を判定する（表全体の文脈を使わない単独判定） */
export function classifyRowRole(raw: Record<string, string>): RowRole {
  const values = Object.values(raw).map((v) => (v ?? '').trim());
  // 注記の判定は装飾を残したまま行う（「注)」の閉じ括弧が手掛かりになる）
  const head = (values.find((v) => v !== '') ?? '').normalize('NFKC').trim();

  if (head !== '' && NOTE_LABEL.test(head)) return 'note';

  const labels = labelCells(raw);
  // 数値がまったく無い行を「合計」と呼んでも意味がない（見出しの再掲・空の合計行）
  const hasNumber = values.some((v) => looksNumeric(v));
  if (!hasNumber) return labels.some((l) => TOTAL_LABEL.test(l)) ? 'note' : 'detail';

  return labels.some((l) => TOTAL_LABEL.test(l)) ? 'total' : 'detail';
}

/**
 * 表全体を見て種別を確定する。
 *
 * 単独判定だけだと、たまたま全行が「合計」に見える表（合計だけを並べたサマリー）で
 * 全行が確定不能になってしまう。集計行の割合が高すぎるときは判定を諦めて
 * 明細として扱う（取り込めないより、人が確認して確定できる方がよい）。
 */
export function classifyRowRoles(rows: Array<Record<string, string>>): RowRole[] {
  const roles = rows.map((r) => classifyRowRole(r));
  const totals = roles.filter((r) => r === 'total').length;
  const candidates = roles.filter((r) => r !== 'note').length;
  if (candidates > 0 && totals / candidates > MAX_TOTAL_RATIO) {
    return roles.map((r) => (r === 'total' ? 'detail' : r));
  }
  return roles;
}

/** 集計行に付ける警告文。二重計上の理由を具体的に書く */
export const TOTAL_ROW_WARNING =
  '集計行（小計・合計）の可能性があります。明細行と一緒に確定すると二重計上になります。どちらか一方を選んでください。';

/** 注記・フッター行に付ける警告文 */
export const NOTE_ROW_WARNING =
  '注記・フッター行の可能性があります（※・以上・件数など）。データ行でなければ確定しないでください。';
