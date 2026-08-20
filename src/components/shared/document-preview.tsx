import { FileText } from 'lucide-react';

/**
 * 抽出テキストを「紙面」として見せるプレビュー。
 *
 * Demo Mode の Fixture ファイルは実体（PDF/Excel のバイト列）を持たないため、
 * Evidence Viewer に出せるのは取込時に抽出したテキストだけになる。
 * それを箇条書きで並べると、実運用の資料確認とはかけ離れた見た目になってしまう。
 * ここでは A4 相当の用紙・余白・等幅の明細行で、原本を読んでいる状態に近づける。
 *
 * 行の種類は字面から判定する（抽出テキストに構造情報が無いため）。
 * 判定を外しても本文が読めなくなるわけではない、安全側の装飾に留める。
 */

type LineKind = 'title' | 'meta' | 'header' | 'row' | 'total' | 'note';

function classify(line: string, index: number): LineKind {
  const t = line.trim();
  if (index === 0) return 'title';
  if (t.startsWith('※')) return 'note';
  if (
    /^(合計|年間合計|ご請求金額|購買金額合計|再生利用量|Scope1 排出量|Scope3|女性管理職比率)/.test(
      t,
    )
  ) {
    return 'total';
  }
  if (
    /^(発行|請求番号|需要場所|契約種別|検針期間|作成|対象期間|対象設備|交付番号|排出事業者|収集運搬業者|処分業者|基準日|定義|出力日)/.test(
      t,
    )
  ) {
    return 'meta';
  }
  // 見出し行は「項目名が 2 語以上、数字をほとんど含まない」行
  if (/^[^\d]{6,}$/.test(t) && /\s{2,}/.test(t)) return 'header';
  return 'row';
}

export interface DocumentPreviewProps {
  /** 用紙に流し込む本文（改行区切り） */
  text: string;
  /** 用紙のヘッダーに出す情報 */
  title: string;
  page?: number | null;
  totalPages?: number;
  /** ハイライトする語句（Evidence リンクが参照している箇所） */
  highlight?: string[];
  /** この紙面が Evidence リンクの参照先か */
  linked?: boolean;
}

/** 語句ハイライト。指定語を含む行だけ <mark> で囲む */
function renderLine(text: string, highlight: string[]) {
  const hit = highlight.find((h) => h && text.includes(h));
  if (!hit) return text;
  const at = text.indexOf(hit);
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-brand-100 px-0.5 text-brand-900">{hit}</mark>
      {text.slice(at + hit.length)}
    </>
  );
}

export function DocumentPreview({
  text,
  title,
  page,
  totalPages,
  highlight = [],
  linked = false,
}: DocumentPreviewProps) {
  const lines = text.split('\n');

  return (
    <div className="bg-surface-muted p-4">
      {/* 用紙 */}
      <div className="mx-auto max-w-[760px] rounded-t4d border border-line bg-white shadow-sm">
        {/* 用紙のヘッダー（原本の版面を模したもの） */}
        <div className="flex items-center justify-between border-b border-line px-6 pt-5 pb-2">
          <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <FileText className="size-3.5" aria-hidden="true" />
            <span className="truncate">{title}</span>
          </div>
          {page != null && (
            <span className="shrink-0 text-[11px] text-ink-muted">
              {totalPages && totalPages > 1 ? `${page} / ${totalPages} ページ` : `${page} ページ`}
            </span>
          )}
        </div>

        {/* 本文 */}
        <div className="px-6 py-5">
          {lines.map((line, i) => {
            const kind = classify(line, i);
            const content = renderLine(line, highlight);
            if (line.trim() === '') return <div key={i} className="h-2" />;
            switch (kind) {
              case 'title':
                return (
                  <h3
                    key={i}
                    className="mb-3 border-b-2 border-ink pb-1.5 text-center text-[15px] font-semibold tracking-wide text-ink"
                  >
                    {content}
                  </h3>
                );
              case 'meta':
                return (
                  <p key={i} className="text-[12px] leading-6 text-ink">
                    {content}
                  </p>
                );
              case 'header':
                return (
                  <p
                    key={i}
                    className="mt-3 border-b border-ink/40 pb-1 font-mono text-[11.5px] font-semibold whitespace-pre text-ink"
                  >
                    {content}
                  </p>
                );
              case 'total':
                return (
                  <p
                    key={i}
                    className="mt-1 border-t border-line pt-1 text-right font-mono text-[12px] font-semibold whitespace-pre text-ink"
                  >
                    {content}
                  </p>
                );
              case 'note':
                return (
                  <p key={i} className="mt-3 text-[11px] leading-5 text-ink-muted">
                    {content}
                  </p>
                );
              default:
                return (
                  <p
                    key={i}
                    className="font-mono text-[11.5px] leading-6 whitespace-pre text-ink odd:bg-surface-muted/40"
                  >
                    {content}
                  </p>
                );
            }
          })}
        </div>

        {/* 用紙のフッター */}
        <div className="flex items-center justify-between border-t border-line px-6 py-2 text-[10px] text-ink-muted">
          <span>架空のサンプル資料（実在の企業・取引とは関係ありません）</span>
          {linked && (
            <span className="text-brand-900">この紙面が Evidence として参照されています</span>
          )}
        </div>
      </div>
    </div>
  );
}
