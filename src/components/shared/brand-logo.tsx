import Image from 'next/image';
import Link from 'next/link';

/**
 * T4D ロゴ（指示書 5.1）。
 * - `public/brand/t4d-logo.png` の実体を next/image で表示（外部 URL 参照は禁止）
 * - 高さ 28px 標準・横幅自動・アスペクト比維持
 * - 変形／切断／再着色をしない
 */
export function BrandLogo({
  href = '/workspace',
  height = 28,
  priority = false,
}: {
  href?: string | null;
  height?: number;
  priority?: boolean;
}) {
  const image = (
    <Image
      src="/brand/t4d-logo.png"
      alt="TERRAST for Disclosure"
      width={Math.round((height * 2172) / 724)}
      height={height}
      priority={priority}
      style={{ height, width: 'auto' }}
      className="select-none"
    />
  );

  if (!href) return <span className="inline-flex items-center">{image}</span>;

  return (
    <Link
      href={href}
      className="inline-flex shrink-0 items-center rounded-t4d px-1 py-0.5 hover:bg-brand-50"
      aria-label="TERRAST for Disclosure ホームへ"
    >
      {image}
    </Link>
  );
}
