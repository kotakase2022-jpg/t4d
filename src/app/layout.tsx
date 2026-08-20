import type { Metadata, Viewport } from 'next';
import { TooltipProvider } from '@/components/ui/tooltip';
import { APP_NAME, APP_SHORT_NAME } from '@/lib/config';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: `${APP_SHORT_NAME} | ${APP_NAME}`,
    template: `%s | ${APP_SHORT_NAME}`,
  },
  description:
    '非財務情報の収集・検証・承認・開示と、第三者保証業務を同一データ基盤上で安全に接続する PC 専用ブラウザアプリ。',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 1280,
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <a
          href="#t4d-main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-100 focus:rounded-t4d focus:bg-brand-700 focus:px-3 focus:py-1.5 focus:text-white"
        >
          本文へスキップ
        </a>
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
