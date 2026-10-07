import type { PermissionKey } from '@/types/domain';
import type { HomeProfile } from './home-profile';
import { resolveTaskVerb, taskVerb, type TaskVerbContext, type TaskVerbId } from './task-verbs';

/**
 * ホームの「はじめに」（plan §1.11 Beginner）。HomeProfile ごとに、最初に行う 3 つの作業を順に示す。
 *
 * 行き先はタスク動詞（既存の画面＋絞り込み）を使い、新しい画面は作らない。権限の無い手順は出さない
 * （閲覧だけの人に「入力する」を勧めない）。閉じた印は端末ごと（localStorage）に残す。
 */

type Step =
  | { kind: 'verb'; id: TaskVerbId; note: string }
  | {
      kind: 'route';
      href: string;
      label: string;
      note: string;
      requires?: readonly PermissionKey[];
    };

export const GETTING_STARTED_STEPS: Record<HomeProfile, readonly Step[]> = {
  contributor: [
    { kind: 'verb', id: 'enter-data', note: '担当拠点の未入力の値を入れて保存する' },
    { kind: 'verb', id: 'register-evidence', note: '値の根拠になる請求書・計測記録を登録する' },
    { kind: 'verb', id: 'fix-returned-data', note: '差し戻された値を直して、もう一度提出する' },
  ],
  preparer: [
    { kind: 'verb', id: 'start-import', note: '手元の Excel・CSV を取り込んでデータを揃える' },
    { kind: 'verb', id: 'write-manuscript', note: '開示プロジェクトで自分の担当の原稿を書く' },
    { kind: 'verb', id: 'see-disclosure-status', note: '要求事項ごとの対応状況を確かめる' },
  ],
  reviewer: [
    { kind: 'verb', id: 'review-data', note: '提出されたデータを確かめてレビューを始める' },
    { kind: 'verb', id: 'review-manuscript', note: '依頼された原稿を読んでレビューを完了する' },
    { kind: 'verb', id: 'see-totals', note: '集計で全体の傾向と前年との差を確かめる' },
  ],
  approver: [
    { kind: 'verb', id: 'approve-data', note: 'レビューの済んだデータを承認する' },
    { kind: 'verb', id: 'review-manuscript', note: '最終承認を待っている原稿を確かめる' },
    { kind: 'verb', id: 'make-report', note: '承認済みのデータでレポートを作る' },
  ],
  admin: [
    { kind: 'verb', id: 'add-period', note: 'データを集める報告年度を用意する' },
    { kind: 'verb', id: 'add-unit', note: 'データを集める拠点を登録する' },
    { kind: 'verb', id: 'invite-member', note: '担当者を招待して役割を割り当てる' },
  ],
  viewer: [
    { kind: 'verb', id: 'see-totals', note: '指標ごとの集計を見る' },
    {
      kind: 'route',
      href: '/enterprise/analysis/diagnosis',
      label: '現状診断を見る',
      note: '自社の取り組みの現状を確かめる',
      requires: ['enterprise.data.read'],
    },
    { kind: 'verb', id: 'see-disclosure-status', note: '開示の対応状況を見る' },
  ],
};

export interface GettingStartedStep {
  key: string;
  label: string;
  note: string;
  href: string;
}

export const GETTING_STARTED_MAX = 3;

export function gettingStartedSteps(
  profile: HomeProfile,
  can: (permission: PermissionKey) => boolean,
  c: TaskVerbContext,
): GettingStartedStep[] {
  const out: GettingStartedStep[] = [];
  for (const step of GETTING_STARTED_STEPS[profile]) {
    if (step.kind === 'verb') {
      const verb = resolveTaskVerb(taskVerb(step.id), can, c);
      if (verb) out.push({ key: verb.id, label: verb.label, note: step.note, href: verb.href });
    } else if ((step.requires ?? []).every((permission) => can(permission))) {
      out.push({ key: step.href, label: step.label, note: step.note, href: step.href });
    }
  }
  return out.slice(0, GETTING_STARTED_MAX);
}
