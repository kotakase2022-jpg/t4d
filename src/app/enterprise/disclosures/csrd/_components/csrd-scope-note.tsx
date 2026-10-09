import Link from 'next/link';
import { Globe } from 'lucide-react';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { CSRD_SCOPE_NOTE } from '@/lib/domain/csrd';

/**
 * CSRD の画面の見出しの下の注記（トライアル対応 NF-12・X-14）。EU 法人向け・通常 ESRS の架空サンプルであり、
 * CSRD 域外（ESRS-40a）は開示プロジェクトで扱うことを示す。誠実さの注記なので折りたたまない。
 * 見出しの説明にサンプル（架空）のバッジがある画面は withBadge を付けない（同じバッジを重ねない）
 */
export function CsrdScopeNote({ withBadge = false }: { withBadge?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-csrd-scope-note="">
      {withBadge ? (
        <HonestyBadge kind="sample-master" />
      ) : (
        <Globe className="size-3.5 text-ink-muted" aria-hidden="true" />
      )}
      <span>{CSRD_SCOPE_NOTE}</span>
      <Link href="/enterprise/disclosure-projects" className="text-brand-700 underline">
        開示プロジェクトを開く
      </Link>
    </span>
  );
}
