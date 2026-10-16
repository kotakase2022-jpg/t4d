'use client';

import * as React from 'react';
import Link from 'next/link';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getBuildInfo } from '@/lib/build-info';
import type { PermissionKey } from '@/types/domain';
import { goShortcutTargets } from './record-shortcuts';
import { useShell } from './viewer-context';

/**
 * ヘルプ（plan §1.11 Beginner／Expert）。ショートカットの一覧と用語集。
 * `?` でも開ける（入力中・他のダイアログを開いている間は無効）。
 */

export const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: 'Ctrl / Cmd + K', description: 'コマンドパレット（画面・操作・データの検索）を開く' },
  { keys: '?', description: 'このヘルプを開く' },
  { keys: '/', description: '一覧の検索ボックスへフォーカス' },
  { keys: 'g → h', description: 'ホームへ移動' },
  { keys: 'g → d', description: '非財務データへ移動' },
  { keys: 'g → w', description: 'ワークフローへ移動' },
  { keys: 'g → i', description: 'データ取込へ移動' },
  { keys: 'g → s', description: 'SSBJ 対応状況へ移動' },
  { keys: 'g → c', description: 'CSRD 対応状況へ移動' },
  { keys: 'j / k', description: '一覧の次 / 前のレコードへ移動' },
  { keys: 'x', description: '一覧で選んでいる行の選択を切り替える（一括操作）' },
  { keys: 'Enter', description: '一覧で選んでいる行を開く' },
  { keys: 'n', description: 'その画面の新規作成を開く' },
  { keys: 'e', description: 'Evidence セクションへ移動' },
  { keys: 'c', description: 'コメント入力へフォーカス' },
  { keys: 's', description: '下書きを保存（提出・承認には割り当てていません）' },
  { keys: 'Esc', description: 'Drawer / ダイアログを閉じる' },
];

/**
 * 用語集（CLAUDE.md §8 の用語を業務の言葉で）。画面に出る英語の用語（Data Room・Snapshot・
 * PBC・Sign-off）は、意味を知らなくても読めるようにここで説明する
 */
export const GLOSSARY: Array<{ term: string; meaning: string }> = [
  {
    term: 'Data Point（データ）',
    meaning:
      '組織 × 期間 × 指標 × 境界で 1 件に決まる非財務データ。入力 → 提出 → レビュー → 承認と進みます。',
  },
  {
    term: '保証契約（Engagement）・案件',
    meaning: '監査法人が持つ保証の契約。クライアント企業と紐付きます。',
  },
  {
    term: 'アクセス許諾（Grant）',
    meaning: '企業が監査法人へ与える閲覧の許可（指標・組織・期間・資料の範囲）。',
  },
  {
    term: 'Data Room',
    meaning:
      '許諾済みで承認済みのクライアントデータを、監査法人が読むだけの画面。原本は変更できません。',
  },
  {
    term: 'Snapshot',
    meaning: '保証の対象を固定した変更できないコピー。以後の変更は差分として検知されます。',
  },
  { term: '母集団（Population）', meaning: 'Snapshot から作る、サンプリングの元になる集合。' },
  {
    term: '資料依頼（PBC）',
    meaning: 'Prepared By Client。監査法人から企業への資料の依頼です。企業は回答を提出します。',
  },
  {
    term: 'Sign-off',
    meaning:
      '作成（Prepared）→ レビュー（Reviewed）→ 契約責任者承認（Partner Approved）の 3 段階。代理はできません。',
  },
  {
    term: 'AI の候補',
    meaning: 'AI の出力は候補です。採用・確定・承認は必ず人が行います。',
  },
  {
    term: 'デモデータ・デモ生成（Mock）',
    meaning:
      'デモ環境の表示は架空のデータです。AI 未接続のときは決定論的な Mock の出力を出します。',
  },
  // ---- トライアル対応（2026-10）
  {
    term: '区分（5 区分）',
    meaning:
      '要求事項ごとの状況。充足確認済み・追加確認が必要・未対応・未判定・対象外。公開草案・サンプルの基準は「充足確認済み」にしません。',
  },
  {
    term: '対象外の承認',
    meaning:
      '対象外・非重要は理由を付けて申請し、別の人（最終承認者）が承認します。理由を変えると承認し直しです。承認待ちは未判定として数えます。',
  },
  {
    term: '横断対応表',
    meaning:
      'SSBJ の要求事項と ESRS・ESRS-40a の要求事項の対応（同等・一部・関連・対応なし）。デモの対応はサンプルです。',
  },
  {
    term: '基準別の対応状況',
    meaning: '定性情報 1 件を引用している原稿の節を通して、基準ごとの区分の件数を示したもの。',
  },
  {
    term: 'インパクト・リスク・機会の台帳',
    meaning:
      'SSBJ の「企業への影響」と CSRD・ESRS-40a の「人・環境へのインパクト」を列で分けて並べた一覧。40a の列は参考表示です。',
  },
  {
    term: '対象年度×基準版・公開草案（未収録）',
    meaning:
      'どの年度をどの版の基準で評価したかの表示。公開草案は要求事項を収録していない版で、充足の判定には使いません。',
  },
  {
    term: '追跡率・追跡番号',
    meaning:
      '出力した本文の段落・数値のうち、要求事項・承認版・根拠まで遡れるものの割合（n / N）。追跡番号「T-節-段落」で出力物と画面を対応させます。',
  },
  {
    term: '選定ケース',
    meaning:
      'トライアルで追跡率を測る要求事項の集まり。トライアルの評価の計画で選びます（無ければ全件）。',
  },
  {
    term: '突合',
    meaning:
      'T4D が作った DOCX・XLSX・CSV を読み戻し、承認版の本文・数値と照合すること。不一致が 1 件でもあればファイルを渡しません。社内承認であり第三者保証ではありません。',
  },
  {
    term: '転記・再利用の点検',
    meaning:
      '参照でない手書きの数値・同じ文の重複・定性情報の再利用を数えたもの（分母付き。総合点は出しません）。',
  },
  {
    term: 'SAMPLE タクソノミ・XBRL の簡易検査',
    meaning:
      'XBRL の構造を確かめるための架空の概念リストと、T4D の簡易検査（公式の検証ではありません）。出力は社内確認用で、提出用ではありません。',
  },
  // ---- Scope1・2 の算定と照合（2026-10-16）。算定・照合に AI は使いません
  {
    term: '改良トンキロ法',
    meaning:
      '輸送量（t·km）に、積載率と最大積載量から求めた燃料使用原単位を掛けて燃料の量を求め、CO2 にする国内のトラック輸送の算定方法。式の係数は係数セットのデータで、海外拠点への適用は組織の判断です。',
  },
  {
    term: '見なし積載率',
    meaning:
      '積載率が分からない輸送の行に、係数セットの「見なし積載率の原単位表」の値を使う扱い。使った行は算定行に印を残し、件数を画面に出します。',
  },
  {
    term: '積載率の下限',
    meaning:
      '積載率が下限（算定ルールの組織の設定）より小さい行は、下限の値で算定します。下限を当てた行は算定行に印を残します。',
  },
  {
    term: '公的参照プリセット',
    meaning:
      '告示・算定省令の値を出典と確認日を付けて収録したもの。既定では算定に使わず、組織が採用を決めたときだけ係数セット（下書き）へ取り込みます。',
  },
  {
    term: '報告区分と既定区分',
    meaning:
      '既定区分は GHG プロトコルの標準の区分、報告区分は組織が承認した区分規則で決めた区分です。画面と出力では両方を並べます。再分類は移動だけで Scope1＋Scope3 の合計は変わらず、Scope2 の 2 基準は足しません。',
  },
  {
    term: '整合性の確認',
    meaning:
      '設定した排出係数・算定ルールで算定した結果と既存の算定結果の差を、利用者が入れた許容差と比べ、差の原因を示すこと。結果の一致を保証するものではありません。',
  },
  {
    term: '原因別の寄与',
    meaning:
      '前提（区分→対象範囲→活動量→単位換算→排出係数→算定方法→丸め）を順に既存の算定に揃えて再計算したときの差の変化。順序を変えると配分が変わることがあります。',
  },
  {
    term: '単独差・残差',
    meaning:
      '単独差はその原因だけを揃えたときの差（合計は総差と等しくならないことがあります）。残差は揃えても説明できない差で、「原因不明（残差）」と表示します。',
  },
  {
    term: '仮説の再計算',
    meaning:
      '別の係数セット・丸めなし・区分規則なしなどの前提で計算し直す試算。保存せず、差が閉じても原因の確定にはなりません（原因は確認者が記録します）。',
  },
  {
    term: '無償の範囲と別途協議',
    meaning:
      'トライアルで合意した無償の範囲と、別途協議になりうる 4 区分（拠点の大幅な追加・大量の一次データの処理・外部システムとの個別連携・新規機能の個別開発）の目安。目安を超えても操作は止めず、金額は扱いません。',
  },
  {
    term: '処理を委ねる先',
    meaning:
      'データを扱わせる業務委託先・クラウドサービス提供者・AI サービス提供者。区分・役割・秘密保持の根拠を記録し、この環境が使う外部の処理先と突き合わせます。',
  },
  {
    term: 'バックアップの残存期間・消去の見込み日',
    meaning:
      '削除の後もバックアップに残る日数（合意した値）と、削除の日から求めたバックアップから消える見込みの日。それまで秘密情報として管理します。',
  },
];

/**
 * ヘルプから開く画面（企業のワークスペースだけ）。トライアルの評価はメニュー木に無い（plan K2・§5 D22）
 */
const ENTERPRISE_HELP_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'トライアルの評価（検証シナリオ・改善管理表）', href: '/enterprise/trial' },
];

/** 「g → x」の行で、その利用者が移れないもの（権限なしの画面）を外す */
export function visibleShortcuts(goTargets: Record<string, string>): typeof SHORTCUTS {
  return SHORTCUTS.filter((s) => {
    const go = /^g → (\w)$/.exec(s.keys);
    return !go || Object.prototype.hasOwnProperty.call(goTargets, go[1]!);
  });
}

export function HelpDialog() {
  const [open, setOpen] = React.useState(false);
  const shell = useShell();
  const build = React.useMemo(() => getBuildInfo(), []);
  const shortcuts = React.useMemo(
    () =>
      visibleShortcuts(
        goShortcutTargets(
          shell?.workspace === 'assurance' ? '/assurance/dashboard' : '/enterprise/dashboard',
          shell ? (permission: PermissionKey) => shell.permissions.includes(permission) : null,
        ),
      ),
    [shell],
  );

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true;
      if (typing || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="ヘルプとキーボードショートカット"
          aria-keyshortcuts="Shift+?"
        >
          <HelpCircle aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>ヘルプ</DialogTitle>
          <DialogDescription>
            キーボードショートカットと用語の説明です。ショートカットは入力欄にフォーカスがある間は無効になります。
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="shortcuts" className="p-4 pt-2">
          <TabsList>
            <TabsTrigger value="shortcuts">キーボードショートカット</TabsTrigger>
            <TabsTrigger value="glossary">用語集</TabsTrigger>
          </TabsList>
          <TabsContent value="shortcuts">
            <dl className="divide-y divide-line">
              {shortcuts.map((s) => (
                <div key={s.keys} className="flex items-center justify-between gap-4 py-1.5">
                  <dt className="text-body text-ink">{s.description}</dt>
                  <dd>
                    <kbd className="rounded border border-line bg-surface-muted px-1.5 py-0.5 text-caption text-ink-muted">
                      {s.keys}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </TabsContent>
          <TabsContent value="glossary">
            <dl className="divide-y divide-line">
              {GLOSSARY.map((g) => (
                <div key={g.term} className="py-1.5">
                  <dt className="text-body font-medium text-ink">{g.term}</dt>
                  <dd className="text-small text-ink-muted">{g.meaning}</dd>
                </div>
              ))}
            </dl>
          </TabsContent>
        </Tabs>
        <div className="space-y-1 border-t border-line px-4 py-2 text-small text-ink-muted">
          {shell?.workspace === 'enterprise' && (
            <ul aria-label="ヘルプから開く画面">
              {ENTERPRISE_HELP_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-brand-700 underline underline-offset-2"
                    onClick={() => setOpen(false)}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {/* 改善の記録（ご意見・評価）にも同じ版を自動で添える（NF-31） */}
          <p data-testid="build-info">この環境の版: {build.label}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
