import { CalendarClock } from 'lucide-react';
import { DetailBadge } from './detail-badge';

/**
 * デモ基準日（src/lib/clock.ts の describeReferenceDate）。
 *
 * デモでは期限・超過の判定に固定の基準日を使う。閲覧日と「あと何日」が食い違って見える理由を
 * 画面上で分かるように、「デモデータ」の隣に常に出す（指示書 §2.3・§14.3）。
 * 実時計で動く Supabase Mode では出さない（label が null）。
 */
export function ReferenceDateBadge({ label }: { label: string }) {
  return (
    <DetailBadge
      tone="outline"
      detail="デモでは、期限・超過の判定をこの日を「今日」として計算しています（閲覧日とは異なります）。"
    >
      <CalendarClock className="size-3" aria-hidden="true" />
      {/* 1600px 未満では「デモ」を読み上げだけにして幅を詰める（ヘッダーの開示プロジェクトの表示を潰さない） */}
      {label.startsWith('デモ') ? (
        <>
          <span className="max-[1599px]:sr-only">デモ</span>
          {label.slice(2)}
        </>
      ) : (
        label
      )}
    </DetailBadge>
  );
}
