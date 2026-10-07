import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTE_CATALOG, canOpenRoute } from '@/components/shared/route-catalog';
import { permissionsFor } from '@/lib/authorization/can';
import type { Can } from '@/lib/ui/home-profile';
import { availableTaskVerbs } from '@/lib/ui/task-verbs';
import type { RoleKey } from '@/types/domain';

/**
 * 画面の権限ゲート ⊆ サービスの権限（plan §5.2・IF §6.2 の R1〜R5）。
 * 「押せるが必ず失敗する」「権限があるのに届かない」を、明示のケースで固定する。
 *
 *  - Stage A が持つ入口（タスク動詞・Command Palette）は、ここで振る舞いを検査する
 *  - 画面の出し分け（Stage B の各スライス）は、直したかどうかをソースで判定する表。直したら status を
 *    done にする（直したのに pending のまま・done なのに戻っている、はどちらも失敗）
 */

function canOf(...roles: RoleKey[]): Can {
  const set = permissionsFor(roles);
  return (permission) => set.has(permission);
}

describe('Stage A の入口（タスク動詞・パレット）は権限とサービスの条件を揃える', () => {
  it('R2: 「報告年度を追加する」は組織の管理のときだけ（期間の管理だけでは出さない）', () => {
    const ids = (role: RoleKey) =>
      availableTaskVerbs(canOf(role), { unitScopeIds: [] }).map((v) => v.id);
    expect(ids('sustainability_manager')).not.toContain('add-period');
    expect(ids('enterprise_admin')).toContain('add-period');
  });

  it('R3: 「レポートを作る」は出力の権限があるときだけ', () => {
    const ids = (role: RoleKey) =>
      availableTaskVerbs(canOf(role), { unitScopeIds: [] }).map((v) => v.id);
    for (const role of [
      'reviewer',
      'site_contributor',
      'supplier_contributor',
      'viewer',
    ] as RoleKey[]) {
      expect(ids(role), role).not.toContain('make-report');
    }
    expect(ids('approver')).toContain('make-report');
  });

  it('R4: 「データを承認する」は承認の権限があるときだけ（レビューの権限では出さない）', () => {
    const ids = (role: RoleKey) =>
      availableTaskVerbs(canOf(role), { unitScopeIds: [] }).map((v) => v.id);
    expect(ids('reviewer')).not.toContain('approve-data');
    expect(ids('sustainability_manager')).not.toContain('approve-data');
    expect(ids('approver')).toContain('approve-data');
  });

  it('R5: 資料の画面はサプライヤー担当（登録だけ）も開ける。詳細は資料の閲覧が要る', () => {
    const evidence = ROUTE_CATALOG.find((e) => e.pattern === '/enterprise/evidence')!;
    const detail = ROUTE_CATALOG.find((e) => e.pattern === '/enterprise/evidence/[fileId]')!;
    expect(canOpenRoute(evidence, canOf('supplier_contributor'))).toBe(true);
    expect(canOpenRoute(detail, canOf('supplier_contributor'))).toBe(false);
  });
});

interface GateCase {
  id: string;
  owner: 'B1' | 'B2' | 'B5' | 'B6';
  description: string;
  file: string;
  /** 直した状態か（ソースで判定） */
  fixed: (source: string) => boolean;
  status: 'pending' | 'done';
}

/** 画面の出し分け（Stage B が直す）。plan §6.2 の「権限の不一致」の列 */
const PAGE_CASES: GateCase[] = [
  {
    id: 'R1',
    owner: 'B6',
    // 見送り（2026-10-07 統括）: 権限の挙動を変えないため設定の入口は企業管理者のまま。
    // 作成担当を許諾の節に入れるかは発注者の判断（plan Q6）。直す場合は status を done にする
    description:
      '設定のゲートを「組織・メンバー・許諾の管理のどれか」にし、節ごとに出し分ける（作成担当が許諾の節に入れる）',
    file: 'src/app/enterprise/settings/page.tsx',
    fixed: (s) => !s.includes("if (!can(ctx, 'enterprise.org.manage'))"),
    status: 'pending',
  },
  {
    id: 'R2',
    owner: 'B5',
    description: '「報告年度を追加」は組織の管理のときだけ（サービスは org.manage を要求する）',
    file: 'src/app/enterprise/organizations/page.tsx',
    fixed: (s) => !s.includes('canManagePeriod ? <AddReportingPeriodButton'),
    status: 'done',
  },
  {
    id: 'R3-data',
    owner: 'B1',
    description: '非財務データの CSV・XLSX 出力は出力の権限のときだけ',
    file: 'src/app/enterprise/data/page.tsx',
    fixed: (s) => s.includes("'enterprise.export.run'"),
    status: 'done',
  },
  {
    id: 'R3-reports',
    owner: 'B5',
    description: 'レポートの出力は出力の権限のときだけ（無い役割には誰に頼むかを出す）',
    file: 'src/app/enterprise/reports/page.tsx',
    fixed: (s) => s.includes("'enterprise.export.run'"),
    status: 'done',
  },
  {
    id: 'R3-cdp',
    owner: 'B2',
    description: 'CDP の XLSX 出力は出力の権限のときだけ',
    file: 'src/app/enterprise/disclosures/cdp/page.tsx',
    fixed: (s) => s.includes("'enterprise.export.run'"),
    status: 'done',
  },
  {
    id: 'R4',
    owner: 'B1',
    description: '一括承認はデータの承認の権限のときだけ（レビューの権限では出さない）',
    file: 'src/app/enterprise/data/page.tsx',
    fixed: (s) =>
      !s.includes(
        "can(shell.ctx, 'enterprise.data.review') || can(shell.ctx, 'enterprise.data.approve')",
      ),
    status: 'done',
  },
];

describe('画面の権限ゲート（Stage B が直す表）', () => {
  it.each(PAGE_CASES.map((c) => [`${c.id}（${c.owner}）`, c] as const))(
    '%s: 表の状態とソースが一致する',
    (_label, gate) => {
      const source = readFileSync(gate.file, 'utf8');
      expect(
        gate.fixed(source),
        gate.status === 'done'
          ? `${gate.id} は done だが直っていない: ${gate.description}`
          : `${gate.id} は直っている。表の status を done にする: ${gate.description}`,
      ).toBe(gate.status === 'done');
    },
  );
});
