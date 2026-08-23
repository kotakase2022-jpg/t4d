import type { NextConfig } from 'next';

/**
 * Secure headers.
 *
 * Content-Security-Policy はリクエストごとの nonce が必要なため、
 * ここではなく `src/middleware.ts` で設定している。
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: {
    // 型エラーはビルドを止める（`pnpm typecheck` と併用）
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  serverExternalPackages: ['exceljs', 'unpdf', 'docx'],
  experimental: {
    // 取込は Server Action でファイルを受け取る。Next.js の既定は 1MB で、
    // 画面表示とサーバー側検証（MAX_UPLOAD_BYTES = 25MB）より先に弾かれてしまう。
    // 「1 ファイル 25MB まで」という案内と実際の受け入れ量を一致させる。
    serverActions: { bodySizeLimit: '25mb' },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
