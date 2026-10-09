import { describe, expect, it } from 'vitest';
import { routePatternOf } from '@/lib/errors/access-denied';

/**
 * 権限で断った操作の記録（トライアル対応 NF-27）。ルートのパターンだけを残し、ID・クエリ・名前を入れない。
 */
describe('routePatternOf', () => {
  it('UUID・数字・長いトークンを [id] にし、クエリとハッシュを落とす', () => {
    expect(
      routePatternOf(
        '/enterprise/disclosure-projects/7f1c2a3b-1d2e-4f5a-8b6c-7d8e9f0a1b2c/blocks/12?tab=x#y',
      ),
    ).toBe('/enterprise/disclosure-projects/[id]/blocks/[id]');
    expect(routePatternOf('https://example.invalid/api/exports/cdp?format=csv&period=1')).toBe(
      '/api/exports/cdp',
    );
    expect(routePatternOf('/x/abcdefghijklmnopqrstuvwxyz0123')).toBe('/x/[id]');
  });

  it('日本語・記号を含む区切り（名前など）は伏せる', () => {
    expect(routePatternOf('/enterprise/files/%E8%AD%B0%E4%BA%8B%E9%8C%B2.pdf')).toBe(
      '/enterprise/files/[id]',
    );
  });

  it('アプリ内のパスでなければ「(不明)」', () => {
    expect(routePatternOf('javascript:alert(1)')).toBe('(不明)');
    expect(routePatternOf('relative/path')).toBe('(不明)');
  });
});
