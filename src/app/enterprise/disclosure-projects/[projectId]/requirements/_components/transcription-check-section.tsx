import Link from 'next/link';
import { Section } from '@/components/shared/section';
import type { TranscriptionCheck } from '@/lib/domain/transcription';

/** 一覧に並べる上限（残りは件数で示す） */
const MAX_ITEMS = 8;

function excerpt(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 開示プロジェクト概要の「転記・再利用の点検」（トライアル対応 NF-18。L2 なので既定で閉じる）。
 * 分母付きの件数だけを示し、総合点は作らない。作業時間の比較（転記の作業）の説明材料にする。
 */
export function TranscriptionCheckSection({
  check,
  base,
}: {
  check: TranscriptionCheck;
  base: string;
}) {
  const numbers = check.handwritten.length + check.referencedNumbers;
  const summary = `手書き数値 ${check.handwritten.length} / ${numbers} 件・再利用 ${check.reusedNarratives.length} 件・同じ文の重複 ${check.duplicateSentences.length} 件`;
  return (
    <Section id="transcription-check" title="転記・再利用の点検" collapsible summary={summary}>
      <div className="space-y-3 text-small">
        <p className="text-caption text-ink-muted">
          原稿の現在の版（{check.blocksCounted} 節・本文の段落 {check.paragraphsCounted}{' '}
          段落）を数えた件数です。総合点は出しません。翻訳版の節と見出しは数えません。
        </p>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-ink-muted">参照でない手書き数値（転記）</dt>
            <dd className="font-medium text-ink">
              {check.handwritten.length} 件（本文の数値 {numbers} 件中）
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">参照で埋め込んだ数値（転記なし）</dt>
            <dd className="font-medium text-ink">
              {check.referencedNumbers} 件（本文の数値 {numbers} 件中）
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">複数の節で再利用した定性情報（確定 1 回）</dt>
            <dd className="font-medium text-ink">
              {check.reusedNarratives.length} 件（引用した定性情報 {check.narrativesCited} 件中）
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">
              定性情報を経由せず同じ文が複数の節にある箇所（二重管理）
            </dt>
            <dd className="font-medium text-ink">{check.duplicateSentences.length} 件</dd>
          </div>
        </dl>

        {check.handwritten.length > 0 && (
          <div>
            <h3 className="mb-1 font-semibold text-ink">手書き数値の箇所</h3>
            <ul className="space-y-0.5">
              {check.handwritten.slice(0, MAX_ITEMS).map((item, index) => (
                <li key={`${item.blockId}-${item.paragraphId}-${index}`}>
                  <Link
                    href={`${base}/blocks/${item.blockId}`}
                    className="text-brand-800 hover:underline"
                  >
                    {item.blockTitle}
                  </Link>
                  ：「{item.text}」
                </li>
              ))}
            </ul>
            {check.handwritten.length > MAX_ITEMS && (
              <p className="text-caption text-ink-muted">
                ほか {check.handwritten.length - MAX_ITEMS} 件
              </p>
            )}
          </div>
        )}

        {check.reusedNarratives.length > 0 && (
          <div>
            <h3 className="mb-1 font-semibold text-ink">再利用した定性情報</h3>
            <ul className="space-y-0.5">
              {check.reusedNarratives.slice(0, MAX_ITEMS).map((n) => (
                <li key={n.versionId}>
                  {n.title} — {n.blocks.length} 節で引用
                  {n.frameworkCount > 1 ? `（${n.frameworkCount} つの基準をまたぐ）` : ''}：
                  {n.blocks.map((b) => b.title).join('、')}
                </li>
              ))}
            </ul>
          </div>
        )}

        {check.duplicateSentences.length > 0 && (
          <div>
            <h3 className="mb-1 font-semibold text-ink">同じ文が複数の節にある箇所</h3>
            <ul className="space-y-0.5">
              {check.duplicateSentences.slice(0, MAX_ITEMS).map((d) => (
                <li key={d.text}>
                  「{excerpt(d.text)}」— {d.blocks.map((b) => b.title).join('、')}
                </li>
              ))}
            </ul>
            <p className="text-caption text-ink-muted">
              定性情報として登録して引用すると、1 回の確認で複数の節に反映できます。
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}
