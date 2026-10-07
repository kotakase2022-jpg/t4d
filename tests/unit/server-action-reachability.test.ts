import { describe, expect, it } from 'vitest';
import {
  exportedValueNames,
  identifierUses,
  importsOf,
  isUseServer,
  listFiles,
  parse,
  rel,
} from '../support/static-analysis';

/**
 * すべての Server Action が UI から使われている（plan §5.2・IF §7.1）。
 *
 * UI を L2（その他・行の操作・折りたたみ）へ移す再設計で、操作のボタンを消してしまい
 * 「Action は残ったが押す手段が無い」状態を作らないための検査。
 *  - 'use server' モジュールの export は、'use server' でないモジュールのどこかで import され、
 *    import 文の外でも使われている（action={X}・formAction・useActionState(X)・X(…) など）
 *  - 'use server' モジュールの export 名は …Action で終わる（読み取りの関数を置かない。IF §6.1）
 * 例外は理由付きの表だけ（下の 2 つ）。
 */

/** 旧版（フォーム版へ移行済み。互換のため残す。IF §3.13）。UI から呼ばないことが正しい */
const LEGACY_ALLOWLIST: Record<string, string> = {
  'src/app/enterprise/disclosure-projects/actions.ts#saveProjectFrameworkAction':
    'F136: フォーム版（F084）へ移行済み',
  'src/app/enterprise/disclosure-projects/actions.ts#confirmApplicabilityAction':
    'F137: フォーム版（F085）へ移行済み',
  'src/app/enterprise/disclosure-projects/[projectId]/blocks/actions.ts#requestReviewAction':
    'F138: フォーム版（F090）へ移行済み',
  'src/app/enterprise/disclosure-projects/[projectId]/blocks/actions.ts#returnReviewAction':
    'F139: フォーム版（F096）へ移行済み',
  'src/app/enterprise/disclosure-projects/[projectId]/blocks/actions.ts#withdrawReviewAction':
    'F140: フォーム版（F097）へ移行済み',
  'src/app/enterprise/disclosure-projects/[projectId]/blocks/actions.ts#decideRecheckAction':
    'F141: フォーム版（F100）へ移行済み',
  'src/app/enterprise/disclosure-projects/[projectId]/blocks/actions.ts#createBlockAction':
    'F142: フォーム版（F087）へ移行済み',
  'src/app/enterprise/evidence/actions.ts#uploadEvidenceDocumentAction':
    'F143: フォーム版（F024）へ移行済み',
  'src/app/enterprise/evidence/actions.ts#addManualExcerptAction':
    'F144: フォーム版（F025）へ移行済み',
};

/**
 * 業務機能なのに UI が無いもの（IF §6.1）。Stage B が UI を付けたらここから消す（付けたのに残すと失敗する）。
 * 件数を固定して検査する（増やさない）
 */
const DECISION_PENDING: Record<string, string> = {};

interface ActionExport {
  key: string;
  file: string;
  name: string;
}

function serverActions(): ActionExport[] {
  const out: ActionExport[] = [];
  for (const file of listFiles('src')) {
    const sf = parse(file);
    if (!isUseServer(sf)) continue;
    for (const { name } of exportedValueNames(sf)) {
      out.push({ key: `${rel(file)}#${name}`, file, name });
    }
  }
  return out;
}

/** 'use server' でないモジュールでの参照（import して、import の外で使っている） */
function referencedKeys(): Set<string> {
  const used = new Set<string>();
  for (const file of listFiles('src')) {
    const sf = parse(file);
    if (isUseServer(sf)) continue;
    for (const info of importsOf(sf)) {
      if (!info.resolved || info.typeOnly) continue;
      const target = parse(info.resolved);
      if (!isUseServer(target)) continue;
      for (const { imported, local } of info.names) {
        if (identifierUses(sf, local) > 0) used.add(`${rel(info.resolved)}#${imported}`);
      }
    }
  }
  return used;
}

describe('Server Action の到達性', () => {
  const actions = serverActions();
  const used = referencedKeys();

  it('Server Action を見つけられている（検査そのものが空回りしていない）', () => {
    expect(actions.length).toBeGreaterThan(140);
    expect(used.size).toBeGreaterThan(120);
  });

  it("'use server' モジュールの export 名は …Action で終わる（読み取りの関数を置かない）", () => {
    const bad = actions.filter((a) => !a.name.endsWith('Action')).map((a) => a.key);
    expect(bad).toEqual([]);
  });

  it('すべての Server Action が UI のどこかから使われている（理由付きの例外を除く）', () => {
    const unreachable = actions
      .map((a) => a.key)
      .filter((key) => !used.has(key))
      .filter((key) => !(key in LEGACY_ALLOWLIST) && !(key in DECISION_PENDING));
    expect(unreachable).toEqual([]);
  });

  it('例外の表は実在する Action だけを指し、UI を付けたら表から外す（古い例外を残さない）', () => {
    const keys = new Set(actions.map((a) => a.key));
    for (const key of [...Object.keys(LEGACY_ALLOWLIST), ...Object.keys(DECISION_PENDING)]) {
      expect(keys.has(key), `${key} は存在しない`).toBe(true);
      expect(used.has(key), `${key} は UI から使われている。例外の表から外す`).toBe(false);
    }
    expect(Object.keys(DECISION_PENDING)).toHaveLength(0);
  });
});
