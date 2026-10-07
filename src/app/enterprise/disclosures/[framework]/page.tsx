import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Construction } from 'lucide-react';
import { Notice } from '@/components/shared/notice';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';

export const metadata = { title: '評価機関対応' };

/**
 * MSCI / FTSE は Phase 1 実装対象外（指示書 7.3）。
 * 動かないボタンは置かず、実装範囲と代替手段だけを明示する（plan §2.26 E36）。
 * 画面には DB の表名・内部の構造名を出さない（業務の言葉で「何ができて、何ができないか」だけを書く）。
 */
const FRAMEWORKS: Record<string, { name: string; description: string; plan: string[] }> = {
  msci: {
    name: 'MSCI',
    description:
      'MSCI ESG Ratings 対応（評価項目、企業確認事項、回答案、開示根拠、ギャップ、照会履歴の管理）',
    plan: [
      '評価項目・回答・根拠を CDP と同じ形で保存できるよう、データの持ち方は用意してあります。',
      '正式な評価項目の一覧をまだ入手していないため、回答の画面は用意していません。',
      '承認済みデータの再利用は、CDP 開示対応と同じ「質問マッピング」の仕組みで行う予定です。',
    ],
  },
  ftse: {
    name: 'FTSE',
    description: 'FTSE Russell ESG Ratings 対応（評価項目・回答案・開示根拠・進捗の管理）',
    plan: [
      '評価項目・回答・根拠を CDP と同じ形で保存できるよう、データの持ち方は用意してあります。',
      '正式な評価項目の一覧をまだ入手していないため、回答の画面は用意していません。',
      '評価機関との直接の連携は、各機関が許可する範囲で今後対応します。',
    ],
  },
};

export default async function FrameworkPlaceholderPage({
  params,
}: {
  params: Promise<{ framework: string }>;
}) {
  const { framework } = await params;
  const config = FRAMEWORKS[framework];
  if (!config) notFound();

  return (
    <>
      <PageHeader
        title={`${config.name} 対応`}
        description="対応予定の評価機関です（現在の版では未対応）。"
        autoBreadcrumbs
      />
      <div className="space-y-3 p-4">
        {/* 未対応であることは常に見せる（動くように見せない） */}
        <Notice tone="warning" title="この評価機関にはまだ対応していません">
          <span className="flex items-start gap-1.5">
            <Construction className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {config.description}
              は、現在の版の対象外です。動作しないボタンを置かない方針のため、操作は用意していません。
            </span>
          </span>
        </Notice>
        <Section title="対応予定" divider="none">
          <ul className="list-inside list-disc space-y-1 text-small text-ink">
            {config.plan.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-2 text-small text-ink-muted">
            対応予定の機能は{' '}
            <Link href="/enterprise/roadmap" className="text-brand-700 hover:underline">
              今後対応の一覧
            </Link>{' '}
            にまとめています。
          </p>
        </Section>
      </div>
    </>
  );
}
