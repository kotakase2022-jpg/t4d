import * as React from 'react';
import {
  Bot,
  Calculator,
  CalendarClock,
  FileWarning,
  FlaskConical,
  Hourglass,
  Lock,
  Sparkles,
  Stamp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * 誠実さの注記のバッジ（plan §0.1-15・§3.1）。デモ・架空・Mock・AI は候補・未発効・試算などを、
 * 画面ごとに違う語で書かないよう 1 か所で固定する。
 *
 * 規則:
 *  - 文言は固定（呼び出し側で変えない）。B のスライスが既存の注記をここへ寄せるときも語は変えない
 *  - 折りたたみ（Collapsible・その他・行の操作）の中に置かない。常に見える場所に置く
 *  - 補足は title= ではなく sr-only＋Hint（キーボード・読み上げでも届く）
 */

export const HONESTY_KINDS = [
  'demo-data',
  'mock-ai',
  'ai-candidate',
  'sample-master',
  'provisional',
  'read-only',
  'fictional',
  'estimate',
  'not-effective',
  // トライアル対応（2026-10。付録 C）
  'not-filing-ready',
  'internal-approval',
] as const;
export type HonestyKind = (typeof HONESTY_KINDS)[number];

export const HONESTY_TEXT: Record<
  HonestyKind,
  { label: string; detail: string; tone: 'warning' | 'brand' | 'neutral' }
> = {
  'demo-data': {
    label: 'デモデータ',
    detail: 'Supabase へ接続していません。表示は架空の Fixture です。',
    tone: 'warning',
  },
  'mock-ai': {
    label: 'デモ生成（Mock）',
    detail: 'OpenAI API に接続していません。決定論的な Mock AI の出力です。',
    tone: 'warning',
  },
  'ai-candidate': {
    label: 'AI の候補',
    detail: 'AI が作成した候補です。採用・確定は人が行います。',
    tone: 'brand',
  },
  'sample-master': {
    label: 'サンプル（架空）',
    detail: '架空の縮小マスターです。正式な基準・質問書ではありません。',
    tone: 'warning',
  },
  provisional: {
    label: '暫定',
    detail: '確定前の値・判断です。確定すると変わることがあります。',
    tone: 'warning',
  },
  'read-only': {
    label: '閲覧のみ',
    detail: 'この画面から原本は変更できません。',
    tone: 'neutral',
  },
  fictional: {
    label: '架空',
    detail: '実在する企業・人物・数値ではありません。',
    tone: 'warning',
  },
  estimate: {
    label: '試算',
    detail: '画面に示した仮定に基づく試算です。予測・保証ではありません。',
    tone: 'warning',
  },
  'not-effective': {
    label: '未発効',
    detail: '採択・公表済みでも、まだ発効していない基準です。',
    tone: 'warning',
  },
  'not-filing-ready': {
    label: '提出用ではない',
    detail:
      'XBRL の構造を確かめるための出力です。公式タクソノミ・公式の検証を通していないため、提出には使えません。',
    tone: 'warning',
  },
  'internal-approval': {
    label: '社内承認版',
    detail: '社内の承認を経た版です。第三者保証ではありません。',
    tone: 'neutral',
  },
};

const ICONS: Record<HonestyKind, typeof Bot> = {
  'demo-data': FlaskConical,
  'mock-ai': Bot,
  'ai-candidate': Sparkles,
  'sample-master': FlaskConical,
  provisional: Hourglass,
  'read-only': Lock,
  fictional: FlaskConical,
  estimate: Calculator,
  'not-effective': CalendarClock,
  'not-filing-ready': FileWarning,
  'internal-approval': Stamp,
};

export function HonestyBadge({ kind, className }: { kind: HonestyKind; className?: string }) {
  const text = HONESTY_TEXT[kind];
  const Icon = ICONS[kind];
  return (
    <Hint label={text.detail}>
      <Badge tone={text.tone} data-honesty={kind} className={cn(className)}>
        <Icon className="size-3" aria-hidden="true" />
        <span>{text.label}</span>
        <span className="sr-only">（{text.detail}）</span>
      </Badge>
    </Hint>
  );
}
