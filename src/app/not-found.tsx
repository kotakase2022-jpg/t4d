import Link from 'next/link';
import { BrandLogo } from '@/components/shared/brand-logo';
import { EmptyState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-muted">
      <BrandLogo href={null} height={32} />
      <EmptyState
        title="ページが見つかりません"
        description="URL が変更されたか、閲覧権限がない可能性があります。権限のない対象は存在を秘匿するため 404 を返します。"
        action={
          <Button asChild variant="outline">
            <Link href="/workspace">ワークスペース選択へ戻る</Link>
          </Button>
        }
      />
    </div>
  );
}
