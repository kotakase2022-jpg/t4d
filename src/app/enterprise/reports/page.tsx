import { Download, FileText } from 'lucide-react';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { loadEnterpriseShell } from '@/lib/services/shell';

export const metadata = { title: 'レポート' };

export default async function ReportsPage() {
  const shell = await loadEnterpriseShell();
  const period = shell.currentPeriod;

  const exports = [
    {
      title: '非財務データ台帳',
      description: '組織 × 期間 × 指標 × 値 × 単位 × 状態 × 検証結果 × Evidence 件数を出力します。',
      links: [
        { label: 'CSV', href: `/api/exports/data-points?period=${period.id}&format=csv` },
        { label: 'XLSX', href: `/api/exports/data-points?period=${period.id}&format=xlsx` },
      ],
    },
    {
      title: 'SSBJ 開示ドラフト',
      description:
        'SSBJ の開示要求ごとに、回答本文・マッピング指標・当年値／前年値を出力します（開示原稿の下書き用）。',
      links: [
        {
          label: 'CSV',
          href: `/api/exports/cdp?framework=ssbj&period=${period.id}&format=csv`,
        },
        {
          label: 'XLSX',
          href: `/api/exports/cdp?framework=ssbj&period=${period.id}&format=xlsx`,
        },
        {
          label: 'DOCX（開示ドラフト）',
          href: `/api/exports/cdp?framework=ssbj&period=${period.id}&format=docx`,
        },
        {
          title: 'CDP 回答一覧',
          description:
            '質問コード・質問文・前年差分区分・状態・回答本文・マッピング指標を出力します（一問一答転記用）。',
          links: [
            { label: 'CSV', href: `/api/exports/cdp?period=${period.id}&format=csv` },
            { label: 'XLSX', href: `/api/exports/cdp?period=${period.id}&format=xlsx` },
            {
              label: 'DOCX（開示ドラフト）',
              href: `/api/exports/cdp?period=${period.id}&format=docx`,
            },
          ],
        },
      ],
    },
    {
      title: 'CSRD 開示ドラフト',
      description: 'CSRD（ESRS）の開示要求ごとに、回答本文とマッピング指標を出力します。',
      links: [
        {
          label: 'CSV',
          href: `/api/exports/cdp?framework=csrd&period=${period.id}&format=csv`,
        },
        {
          label: 'XLSX',
          href: `/api/exports/cdp?framework=csrd&period=${period.id}&format=xlsx`,
        },
      ],
    },
  ];

  return (
    <>
      <PageHeader
        title="レポート"
        description={`${period.label} のデータを CSV / XLSX / DOCX へ出力します。Export の実行は監査ログへ記録されます。`}
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'レポート' }]}
      />

      <div className="grid grid-cols-2 gap-3 p-4">
        {exports.map((item) => (
          <Card key={item.title}>
            <SectionTitle title={item.title} />
            <div className="space-y-2 px-3 pb-3">
              <p className="flex items-start gap-1.5 text-[12px] text-ink-muted">
                <FileText className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {item.description}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {item.links.map((link) => (
                  <Button key={link.label} variant="outline" size="sm" asChild>
                    <a href={link.href} download>
                      <Download aria-hidden="true" />
                      {link.label}
                    </a>
                  </Button>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
