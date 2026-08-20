import { describe, expect, it } from 'vitest';
import { isSafeAppLink, safeAppLinkOrNull } from '@/lib/security/safe-link';

/**
 * AI 出力・通知の href に使う検証。
 * 独立レビューで `..` による /enterprise/ 外への遡上が通ることが判明したため、
 * 抜けやすい形を網羅して固定する。
 */
describe('isSafeAppLink', () => {
  it.each([
    '/enterprise/data',
    '/enterprise/data/abc-123',
    '/enterprise/ghg?period=FY2026&flag=1',
    '/enterprise/disclosures/cdp/C1.1',
    // クエリに日本語（パーセントエンコード）を含む正当なリンクも通す
    '/enterprise/data?unit=%E6%9C%AC%E7%A4%BE&page=0',
    '/enterprise/data?q=%E6%9D%B1%E6%97%A5%E6%9C%AC',
  ])('アプリ内パスを許可する: %s', (link) => {
    expect(isSafeAppLink(link)).toBe(true);
  });

  it.each([
    '/enterprise/../auditor/engagements',
    '/enterprise/../../etc/passwd',
    '/enterprise/%2e%2e/assurance/dashboard',
    '/enterprise/a/../../assurance/dashboard',
    '/assurance/dashboard',
    '//evil.example.com/path',
    'https://evil.example.com/enterprise/data',
    'javascript:alert(1)',
    '/enterprise/data" onmouseover="alert(1)',
    '/enterprise/%5c..%5c..%5cwindows',
    '/enterprise/x%00y',
    '',
  ])('危険なリンクを拒否する: %s', (link) => {
    expect(isSafeAppLink(link)).toBe(false);
  });

  it('safeAppLinkOrNull は危険なリンクを null にする', () => {
    expect(safeAppLinkOrNull('/enterprise/data')).toBe('/enterprise/data');
    expect(safeAppLinkOrNull('/enterprise/../auditor/x')).toBeNull();
    expect(safeAppLinkOrNull(null)).toBeNull();
    expect(safeAppLinkOrNull(undefined)).toBeNull();
  });
});
