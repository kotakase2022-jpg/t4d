import { Download, FileSpreadsheet } from 'lucide-react';
import { PageActions } from '@/components/shared/page-actions';
import { Section } from '@/components/shared/section';
import { PermissionDeniedState } from '@/components/shared/states';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404 } from '@/lib/services/assurance';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '出力' };

export default async function ExportsPage({
  params,
}: {
  params: Promise<{ engagementId: string }>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const allowed = can(ctx, 'assurance.export.run');

  const sheets = [
    'スコープ（組織 × 指標 × 対象区分 × リスク）',
    'Snapshot 項目（固定値・hash・固定日時）',
    'Snapshot 後変更（固定値 / 現在値 / 影響評価）',
    '母集団（件数・合計・欠損・除外・完全性メモ）',
    'サンプル（方法・Seed・件数・選定理由）',
    'サンプル項目（抽出理由・層）',
    '保証手続（コード・必須区分）',
    'テスト（サンプルごとの状態・調書番号）',
    'テスト結果（手続別の結果・再計算・差異）',
    'PBC 依頼と回答（内部メモは含めない）',
    '指摘と経営者回答',
    'レビュー Note（クライアント共有分の区別付き）',
    'Sign-off（段階・実行者・日時・対象 Snapshot）',
    '監査ログ（案件に関するイベント）',
  ];

  return (
    <>
      <EngagementHeader
        context={context}
        page="出力"
        actions={
          allowed && (
            <PageActions
              primary={{
                kind: 'link',
                id: 'export-xlsx',
                label: 'XLSX でダウンロード',
                icon: <Download aria-hidden="true" />,
                href: `/api/exports/engagement?engagementId=${engagementId}&format=xlsx`,
                download: true,
              }}
              secondary={[
                {
                  kind: 'link',
                  id: 'export-csv',
                  label: 'CSV（サマリ）',
                  icon: <Download aria-hidden="true" />,
                  href: `/api/exports/engagement?engagementId=${engagementId}&format=csv`,
                  download: true,
                },
              ]}
            />
          )
        }
      />

      <div className="space-y-3 p-4">
        {!allowed && (
          // 権限が無い役割には、出力のリンクを出さずに「誰に頼むか」を示す（plan §1.18）
          <PermissionDeniedState
            permission="assurance.export.run"
            description="案件パッケージの出力には、出力の権限が必要です。"
          />
        )}
        <Section title="案件パッケージの出力" divider="none">
          <p className="text-small text-ink-muted">
            スコープ、Snapshot、サンプル、手続、Evidence 参照、依頼、指摘、Sign-off、変更履歴を 1
            つのブックへまとめて出力します。出力の実行は監査ログへ記録されます。
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-1">
            {sheets.map((sheet) => (
              <li key={sheet} className="flex items-center gap-1.5 text-small text-ink">
                <FileSpreadsheet className="size-3.5 shrink-0 text-brand-600" aria-hidden="true" />
                {sheet}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}
