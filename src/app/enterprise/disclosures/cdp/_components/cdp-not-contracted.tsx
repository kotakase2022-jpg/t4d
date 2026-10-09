import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { OPTION_NOT_CONTRACTED_MESSAGES } from '@/lib/services/organization-options';

/**
 * CDP 対応オプションの契約が無い組織で CDP の画面を開いたとき（トライアル対応 NF-38）。
 *
 * 404 にせず、理由と「顧客の管理者が自分で開けない」ことを示す（有償のオプションで、運営が設定する）。
 * 操作は置かない（押しても使えない操作を並べない）。primary も無い
 */
export function CdpNotContracted({ title }: { title: string }) {
  return (
    <>
      <PageHeader
        title={title}
        description={<StatusBadge domain="cdpOption" value="not_contracted" />}
        autoBreadcrumbs
      />
      <div className="p-4" data-cdp-option="not_contracted">
        <EmptyState
          kind="not-applicable"
          title={OPTION_NOT_CONTRACTED_MESSAGES.cdp.replace(/。$/, '')}
          description="CDP の回答管理・回答草案の支援は、組織ごとに契約するオプションです。契約の追加・変更は運営が行います（組織の管理者の画面からは有効にできません）。SSBJ・CSRD・データ・開示プロジェクトなどの基本の機能はそのまま使えます。"
        />
      </div>
    </>
  );
}
