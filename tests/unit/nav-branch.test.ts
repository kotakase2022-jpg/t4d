import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NAV_BRANCH_STORAGE_KEY,
  readNavBranch,
  rememberNavBranch,
  useNavBranch,
} from '@/components/shared/nav-branch';

/**
 * 左メニューの優先枝の保存（docs/disclosure-first.md §10.1）。
 * タブ内の sessionStorage（`t4d.sidebar.branch`）に枝の経路を置き、同じタブの購読者へすぐ知らせる。
 * 使えない環境では null（既定の SSBJ 側）に従い、例外を外へ出さない。SSR は常に null。
 */

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readNavBranch・rememberNavBranch', () => {
  it('書いた枝を読め、null で消える（空文字も無いものとして扱う）', () => {
    expect(readNavBranch()).toBeNull();
    rememberNavBranch('開示対応 / CSRD');
    expect(window.sessionStorage.getItem(NAV_BRANCH_STORAGE_KEY)).toBe('開示対応 / CSRD');
    expect(readNavBranch()).toBe('開示対応 / CSRD');
    rememberNavBranch(null);
    expect(window.sessionStorage.getItem(NAV_BRANCH_STORAGE_KEY)).toBeNull();
    expect(readNavBranch()).toBeNull();
    window.sessionStorage.setItem(NAV_BRANCH_STORAGE_KEY, '');
    expect(readNavBranch()).toBeNull();
  });

  it('保存先は localStorage ではなく sessionStorage（タブ内だけの表示の便宜）', () => {
    rememberNavBranch('開示対応 / CSRD');
    expect(window.localStorage.getItem(NAV_BRANCH_STORAGE_KEY)).toBeNull();
  });

  it('sessionStorage が使えない環境では読み書きとも null 扱いで、例外を出さない', () => {
    // happy-dom の Storage はメソッドを実体ごとに束ねるため、prototype ではなく実体を差し替える
    const denied = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue(denied);
    expect(readNavBranch()).toBeNull();
    expect(() => rememberNavBranch('開示対応 / CSRD')).not.toThrow();
    expect(() => rememberNavBranch(null)).not.toThrow();
    expect(readNavBranch()).toBeNull();
  });

  it('window.sessionStorage そのものに触れられない環境でも null', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readNavBranch()).toBeNull();
    expect(() => rememberNavBranch('開示対応 / CSRD')).not.toThrow();
  });
});

describe('useNavBranch', () => {
  it('書いた値が購読者に届く（同じタブ内。storage イベントを待たない）', () => {
    const { result } = renderHook(() => useNavBranch());
    expect(result.current).toBeNull();
    act(() => rememberNavBranch('開示対応 / CSRD'));
    expect(result.current).toBe('開示対応 / CSRD');
    act(() => rememberNavBranch('開示対応 / SSBJ'));
    expect(result.current).toBe('開示対応 / SSBJ');
    act(() => rememberNavBranch(null));
    expect(result.current).toBeNull();
  });

  it('保存済みの値はクライアントの描画で最初から読める', () => {
    window.sessionStorage.setItem(NAV_BRANCH_STORAGE_KEY, '開示対応 / CSRD');
    const { result } = renderHook(() => useNavBranch());
    expect(result.current).toBe('開示対応 / CSRD');
  });

  it('サーバーの描画（SSR）は保存値に関わらず null（初回描画を決定的にする）', () => {
    window.sessionStorage.setItem(NAV_BRANCH_STORAGE_KEY, '開示対応 / CSRD');
    function Probe() {
      return createElement('span', null, `branch=${useNavBranch() ?? 'null'}`);
    }
    expect(renderToString(createElement(Probe))).toContain('branch=null');
  });

  it('購読を外したコンポーネントには知らせない（外した後に書いても例外が出ない）', () => {
    const { result, unmount } = renderHook(() => useNavBranch());
    unmount();
    expect(() => rememberNavBranch('開示対応 / CSRD')).not.toThrow();
    expect(result.current).toBeNull();
  });
});
