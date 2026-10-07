import { Download } from 'lucide-react';
import { Notice } from '@/components/shared/notice';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { PERMISSION_LABELS } from '@/lib/authorization/permission-labels';
import { buildReportExportCards } from '@/lib/exports';
import { loadEnterpriseShell } from '@/lib/services/shell';

export const metadata = { title: 'レポート' };

/**
 * レポート（出力）。plan §2.26 E04。
 *
 * - 出力のリンクは出力の権限（enterprise.export.run）があるときだけ出す。権限が無い役割にもリンクを
 *   見せると、押したときに 403 の JSON が開くだけだった（IF §6.2 R3）。権限が無い役割には、何が出力できるかは
 *   見せたまま、誰に頼めばよいかを先頭に示す（API の権限検査はそのまま）
 * - カードの格子をやめ、出力物 1 つを 1 行にした表にする（何を・どの形式で出せるかを一覧で比べられる）
 */
export default async function ReportsPage() {
  const shell = await loadEnterpriseShell();
  const period = shell.currentPeriod;
  const canExport = can(shell.ctx, 'enterprise.export.run');
  const exportPermission = PERMISSION_LABELS['enterprise.export.run'];

  // 出力物の一覧は 1 か所（src/lib/exports）で組み立てる。以前は CDP のカードが
  // SSBJ カードの links に入れ子になっており、CDP の出力が画面に出ていなかった（W0 棚卸し）
  const exports = buildReportExportCards(period.id);

  return (
    <>
      <PageHeader
        title="レポート"
        description={`${period.label} のデータを CSV / XLSX / DOCX で出力します`}
        help={<p>出力すると、誰がいつ何を出力したかが監査ログに記録されます。</p>}
        autoBreadcrumbs
      />

      <div className="space-y-3 p-4">
        {!canExport && (
          <Notice tone="info" title="出力の権限がありません">
            出力には「{exportPermission.label}」の権限が必要です。{exportPermission.holders}
            に依頼してください。何を出力できるかは下の表で確かめられます。
          </Notice>
        )}

        <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
          <Table>
            <caption className="sr-only">出力できるレポート</caption>
            <THead>
              <TR>
                <TH>レポート</TH>
                <TH>内容</TH>
                <TH>{canExport ? '出力' : '形式'}</TH>
              </TR>
            </THead>
            <TBody>
              {exports.map((item) => (
                <TR key={item.title} className="align-top">
                  <TD className="whitespace-nowrap font-medium text-ink">{item.title}</TD>
                  <TD className="max-w-xl text-small text-ink-muted">{item.description}</TD>
                  <TD>
                    {canExport ? (
                      <div className="flex flex-wrap gap-1.5">
                        {item.links.map((link) => (
                          <Button key={link.label} variant="secondary" size="xs" asChild>
                            {/* a 要素にするのは Next の Link だと RSC フェッチになりダウンロードにならないため */}
                            <a href={link.href} download>
                              <Download aria-hidden="true" />
                              {link.label}
                            </a>
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-small text-ink-muted">
                        {item.links.map((link) => link.label).join('・')}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </div>
    </>
  );
}
