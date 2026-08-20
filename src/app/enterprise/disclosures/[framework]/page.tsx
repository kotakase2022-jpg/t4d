import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Construction } from 'lucide-react';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { Card } from '@/components/ui/card';

export const metadata = { title: '評価機関対応' };

/**
 * MSCI / FTSE は Phase 1 実装対象外（指示書 7.3）。
 * 動かないボタンは置かず、実装範囲と代替手段だけを明示する。
 */
const FRAMEWORKS: Record<string, { name: string; description: string; plan: string[] }> = {
  msci: {
    name: 'MSCI',
    description:
      'MSCI ESG Ratings 対応（評価項目、企業確認事項、回答案、開示根拠、ギャップ、照会履歴の管理）',
    plan: [
      'データモデル（disclosure_frameworks / disclosure_items / disclosure_responses）は MSCI を格納できる構造になっています。',
      'Phase 1 では正式な評価項目マスターが未入手のため、画面は用意していません。',
      '承認済みデータの再利用は CDP ワークスペースと同じマッピング機構で行えます。',
    ],
  },
  ftse: {
    name: 'FTSE',
    description: 'FTSE Russell ESG Ratings 対応（評価項目・回答案・開示根拠・進捗の管理）',
    plan: [
      'データモデルは FTSE を格納できる構造になっています。',
      'Phase 1 では正式な評価項目マスターが未入手のため、画面は用意していません。',
      '直接 API 連携は各機関が許可する仕様の範囲で将来対応（P3）です。',
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
        description="Phase 1 実装対象外の領域です。"
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: config.name },
        ]}
      />
      <div className="p-4">
        <Card>
          <SectionTitle title="実装状況" />
          <div className="space-y-2 px-3 pb-3">
            <p className="flex items-start gap-2 rounded-t4d bg-warning-soft p-2 text-[12px] text-[#8a5d00]">
              <Construction className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {config.description}は Phase 1
                の実装対象外です。動作しないボタンを置かない方針のため、操作は用意していません。
              </span>
            </p>
            <ul className="list-inside list-disc space-y-1 text-[12px] text-ink">
              {config.plan.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="text-[12px] text-ink-muted">
              全体の未実装一覧は{' '}
              <Link href="/enterprise/roadmap" className="text-brand-700 hover:underline">
                今後対応
              </Link>{' '}
              を参照してください。
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
