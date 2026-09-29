import { Download, FileText } from 'lucide-react';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { buildReportExportCards } from '@/lib/exports';
import { loadEnterpriseShell } from '@/lib/services/shell';

export const metadata = { title: 'レポート' };

export default async function ReportsPage() {
  const shell = await loadEnterpriseShell();
  const period = shell.currentPeriod;

  // 出力カードの一覧は 1 か所（src/lib/exports）で組み立てる。以前は CDP のカードが
  // SSBJ カードの links に入れ子になっており、CDP の出力が画面に出ていなかった（W0 棚卸し）
  const exports = buildReportExportCards(period.id);

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
