import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';

export const metadata = { title: '今後対応' };

/**
 * Phase 1 実装対象外の機能（指示書 7.3）。
 *
 * 動かないボタンを画面に置かない代わりに、
 * 「何が未実装で、なぜか、いつ検討するか」をここに明示する。
 */
const ROADMAP: Array<{
  area: string;
  item: string;
  reason: string;
  phase: string;
}> = [
  {
    area: 'CDP',
    item: 'CDP Portal への直接 API 提出',
    reason: '正式 API 仕様・契約条件が未確定のため。承認済み回答の Export（CSV/XLSX/DOCX）で代替。',
    phase: 'P3',
  },
  {
    area: 'CDP',
    item: 'CDP Portal 双方向 Sync（差分・競合・送信失敗管理）',
    reason: '直接提出 API の前提が未確定のため。',
    phase: 'P3',
  },
  {
    area: '評価機関',
    item: 'MSCI / FTSE 直接 API 連携',
    reason: '各機関の許可仕様・契約が未確定のため。',
    phase: 'P3',
  },
  {
    area: 'マスター',
    item: '全 SSBJ / 全 CDP 正式マスター',
    reason: '著作物のため同梱不可。現在は架空の縮小版（CDP 12 問 / SSBJ 10 項目）で構造を検証。',
    phase: 'P1',
  },
  {
    area: 'GHG',
    item: '全 Scope3 Category（Cat.2〜15）',
    reason: 'Phase 1 は Category 1 のみ完成。データモデルは Category 追加に対応済み。',
    phase: 'P1',
  },
  {
    area: '開示',
    item: 'XBRL / iXBRL 提出 Package',
    reason: 'タクソノミー版の確定と検証環境が必要なため。',
    phase: 'P2〜P3',
  },
  {
    area: '保証',
    item: '監査法人既存調書システムとの Sync',
    reason: '接続先システムと境界が未確定のため。',
    phase: 'P3',
  },
  {
    area: 'セキュリティ',
    item: '本番 SSO（SAML / OIDC）',
    reason: 'IdP 種別と契約が未確定のため。Supabase Auth の接続点は実装済み。',
    phase: 'P1',
  },
  {
    area: '通知',
    item: '本番メール通知',
    reason: '外部メール送信は Phase 1 の禁止事項。アプリ内通知（notifications）で代替。',
    phase: 'P1',
  },
  {
    area: 'AI',
    item: '自律 AI Agent（年次対応の自動実行）',
    reason: 'Human in the Loop を崩さない設計を優先したため。',
    phase: 'P3',
  },
  {
    area: 'CDP',
    item: '正式 CDP Score 算定',
    reason: '公式スコアリングロジックを保証できないため。Readiness（準備度）の提示に留める。',
    phase: 'P1〜P2',
  },
  {
    area: '保証',
    item: '保証意見の自動生成・自動確定',
    reason: '製品原則として禁止。AI は要約・差分・候補提示までに限定する。',
    phase: '実装しない',
  },
];

export default function EnterpriseRoadmapPage() {
  return (
    <>
      <PageHeader
        title="今後対応"
        description="Phase 1 では実装対象外の機能です。動作しないボタンを画面に置かない方針のため、ここに明示しています。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '今後対応' }]}
      />
      <div className="p-4">
        <Card className="overflow-hidden">
          <SectionTitle title={`Phase 1 実装対象外（${ROADMAP.length}）`} />
          <Table>
            <THead>
              <TR>
                <TH>領域</TH>
                <TH>機能</TH>
                <TH>Phase 1 で実装しない理由</TH>
                <TH>想定フェーズ</TH>
              </TR>
            </THead>
            <TBody>
              {ROADMAP.map((row) => (
                <TR key={row.item}>
                  <TD>
                    <Badge tone="neutral">{row.area}</Badge>
                  </TD>
                  <TD className="font-medium">{row.item}</TD>
                  <TD className="text-[12px] text-ink-muted">{row.reason}</TD>
                  <TD>
                    <Badge tone={row.phase === '実装しない' ? 'danger' : 'brand'}>
                      {row.phase}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
