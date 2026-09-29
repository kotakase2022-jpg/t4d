import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AvailabilityBadge, ValueKindBadge } from '@/components/shared/badges';
import { FlashMessage } from '@/components/shared/flash';
import { kpiTargetLabel, reviewPolicyLabel } from '@/lib/domain/disclosure-status';

/**
 * 自己監査（2026-09-29）で直した画面の小さな規則の回帰テスト。
 */

describe('REG-F1 値の区分・有無の列が無い行（以前のデプロイの Cookie に残った行）でも画面を落とさない', () => {
  it('状態の無い行は 0039 の backfill と同じ既定（値あり・実績）で示す', () => {
    render(
      <>
        <AvailabilityBadge status={undefined} />
        <ValueKindBadge kind={undefined} />
      </>,
    );
    expect(screen.getByText('値あり')).toBeTruthy();
    expect(screen.getByText('実績')).toBeTruthy();
  });
});

describe('UX-F10 通知していないのに「通知しました」と言わない', () => {
  it('レビュー担当が未定の依頼は、通知していないと示す', () => {
    render(<FlashMessage searchParams={{ flash: 'reviewRequested', notified: '0' }} />);
    expect(screen.getByRole('status').textContent).toContain('通知はしていません');
    expect(screen.getByRole('status').textContent).not.toContain('通知しました');
  });

  it('通知したときは従来どおり', () => {
    render(<FlashMessage searchParams={{ flash: 'reviewCompleted', notified: '1' }} />);
    expect(screen.getByRole('status').textContent).toContain('最終承認者へ通知しました');
  });

  it('最終承認者が未定のレビュー完了は、通知していないと示す', () => {
    render(<FlashMessage searchParams={{ flash: 'reviewCompleted', notified: '0' }} />);
    expect(screen.getByRole('status').textContent).toContain('通知はしていません');
  });
});

describe('UX-F12 内部の識別子を画面に出さない', () => {
  it('規則の版は日本語の説明で示す', () => {
    expect(reviewPolicyLabel('sod-3role-v1')).toContain('3 段階');
    expect(reviewPolicyLabel('sod-3role-v1')).not.toContain('sod-3role');
    expect(reviewPolicyLabel('unknown-v9')).not.toContain('unknown-v9');
  });

  it('KPI 目標は指標名・年・向きのラベルで示す（target_key・列挙値を出さない）', () => {
    const label = kpiTargetLabel({
      metricName: 'Scope1 排出量',
      targetYear: 2030,
      direction: 'reduce',
    });
    expect(label).toBe('Scope1 排出量 2030年 削減目標');
    expect(label).not.toContain('reduce');
  });
});
