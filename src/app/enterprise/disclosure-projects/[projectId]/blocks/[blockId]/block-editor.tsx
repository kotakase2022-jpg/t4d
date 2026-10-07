'use client';

import * as React from 'react';
import Link from 'next/link';
import { LinkPending } from '@/components/shared/link-pending';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDot,
  CloudOff,
  Heading,
  ListTree,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Pilcrow,
  Plus,
  Save,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Collapsible } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/input';
import { canonicalJson, detectHandwrittenNumbers } from '@/lib/domain/disclosure-block';
import { formatJst } from '@/lib/format/datetime';
import type { DraftRunView, SelectableSourceKind } from '@/lib/services/disclosure-ai-draft';
import type { BlockConflictKind, BlockEditorData } from '@/lib/services/disclosure-block';
import type { BlockBody } from '@/types/domain';
import {
  autosaveBlockAction,
  requestReviewWithBodyAction,
  saveBlockVersionAction,
} from '../actions';
import { AiPanel } from './editor-ai-panel';
import {
  bodyFromEditable,
  displayText,
  editableFromBody,
  insertRef,
  newParagraphId,
  paragraphFromEditable,
  paragraphLabelOf,
  refsInParagraph,
  type EditableBody,
  type RefInline,
} from './editor-model';
import { RightPane, type PaneTab } from './editor-right-pane';
import { RefChip, type RefLookup } from './ref-chip';

export interface BlockEditorProps {
  projectId: string;
  data: BlockEditorData;
  runs: DraftRunView[];
  aiMode: 'mock' | 'openai';
  /** 表示している利用者（このタブに残す作業本文の控えを、利用者ごとに分けるため） */
  viewerId: string;
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict' | 'offline';

const AUTOSAVE_DELAY_MS = 1500;

/** 通信そのものが失敗したとき（サーバーに届かない・5xx）の説明。入力は画面に残る */
const NETWORK_ERROR_MESSAGE =
  'サーバーに接続できませんでした。入力内容は画面に残っています。通信を確認して再試行してください。';

/** 根拠パネルを本文の横に並べる幅（これより狭い幅ではドロワー） */
const WIDE_QUERY = '(min-width: 1366px)';

/**
 * 画面内のリンクで離れる前に、保存できていない入力があるときの確認（window.confirm の置き換え。plan §1.16）。
 * ブラウザを閉じる・再読み込みは beforeunload（ブラウザの既定の確認）のまま
 */
const LEAVE_CONFIRM = {
  tier: 'irreversible',
  title: '保存できていない入力があります',
  scope: 'この節の本文のうち、まだ保存できていない入力',
  consequences: [
    'このまま移動すると、その入力は失われます。',
    '残す場合は「キャンセル」で戻り、保存の状態を確かめてから移動してください。',
  ],
  confirmLabel: '保存せずに移動する',
  destructive: true,
} as const;

/** 「保存済み HH:mm」の時刻部分（日時は formatJst を通す） */
function timeOf(iso: string | null): string {
  if (!iso) return '';
  const formatted = formatJst(iso);
  return formatted.length >= 16 ? formatted.slice(11, 16) : formatted;
}

/**
 * 自動保存した作業本文の控え（このタブの sessionStorage）。
 *
 * デモ環境（Vercel）では作業本文（working_body）をサーバーのメモリにしか置かず、Cookie でも持ち回さない
 * （本文は大きく、1 回の自動保存でほかの操作を押し出すため）。画面を離れて戻ったときに別のサーバーへ届くと、
 * 自動保存した本文が見えず、利用者の入力が消えたように見える。自動保存に成功した本文（AI 候補の採用で
 * サーバーが保存した本文を含む）をこのタブにも控え、サーバーに作業本文が無く、最後に自動保存したのが
 * この利用者だとサーバーが示すときだけ、同じ節・同じ土台の版・同じ利用者の控えを画面へ戻す（戻した本文は
 * 改めて自動保存する）。版として保存・レビュー依頼で控えを消し、サーバーが示さない控え（開示デモの
 * リセット前の入力など）は戻さずに消す。控えは補助で、業務上の保存ではない。
 * 読み書きできない環境（プライベートモード・容量不足）でも編集は続けられる
 */
interface DraftBackup {
  body: BlockBody;
  savedAt: string;
}

function draftKeyOf(blockId: string, baseVersionId: string | null, viewerId: string): string {
  return `t4d.block-draft:${blockId}:${baseVersionId ?? 'none'}:${viewerId}`;
}

function readDraft(key: string): DraftBackup | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftBackup>;
    if (
      !parsed.body ||
      !Array.isArray(parsed.body.paragraphs) ||
      typeof parsed.savedAt !== 'string'
    ) {
      return null;
    }
    return { body: parsed.body, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: DraftBackup): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // 控えを残せなくても編集は続けられる（サーバーの自動保存は成功している）
  }
}

function removeDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // 読み書きできない環境では控えも無い
  }
}

function rowsFor(text: string): number {
  const lines = text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 48)), 0);
  return Math.min(14, Math.max(2, lines));
}

export function BlockEditor({ projectId, data, runs, aiMode, viewerId }: BlockEditorProps) {
  const router = useRouter();
  const blockId = data.block.id;
  const baseVersionId = data.block.currentVersionId;
  const draftKey = draftKeyOf(blockId, baseVersionId, viewerId);
  const { permissions } = data;
  /** 入力できるか（承認済みの節は「版として保存」で新しい版になる。自動保存はしない） */
  const canType = permissions.editable || permissions.reviseAfterApproval;
  const canAutosave = permissions.editable;

  const [editable, setEditable] = React.useState<EditableBody>(() => editableFromBody(data.body));
  const editableRef = React.useRef(editable);
  editableRef.current = editable;

  const [saveState, setSaveState] = React.useState<SaveState>(
    data.bodyFromWorking ? 'saved' : 'idle',
  );
  const [savedAt, setSavedAt] = React.useState<string | null>(data.block.workingSavedAt);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [conflictBody, setConflictBody] = React.useState<BlockBody | null>(
    data.workingConflict ? data.currentVersionBody : null,
  );
  const [conflictKind, setConflictKind] = React.useState<BlockConflictKind>('version');
  /**
   * 画面が読み込んだ・最後に保存した作業本文の保存時刻。保存のたびに送り返し、
   * 別の人がその後に自動保存していれば、サーバーは上書きせず競合として返す
   */
  const workingToken = React.useRef<string | null>(data.block.workingSavedAt);
  const [announcement, setAnnouncement] = React.useState('');
  const [tocOpen, setTocOpen] = React.useState(false);
  /** 狭い幅: ドロワーとして開いているか */
  const [paneOpen, setPaneOpen] = React.useState(false);
  /** 広い幅（1366px 以上）: 本文の横に並べているか。閉じると本文の幅を広げて編集できる（A38） */
  const [paneDocked, setPaneDocked] = React.useState(true);
  const [wide, setWide] = React.useState(false);
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const [paneTab, setPaneTab] = React.useState<PaneTab>('evidence');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [versionFormOpen, setVersionFormOpen] = React.useState(false);
  const [changeReason, setChangeReason] = React.useState('');
  const [versionPending, setVersionPending] = React.useState(false);
  const [versionError, setVersionError] = React.useState<string | null>(null);
  const [requestPending, setRequestPending] = React.useState(false);
  /** このタブの控えから作業本文を戻した（サーバーに作業本文が無かった） */
  const [restoredDraftAt, setRestoredDraftAt] = React.useState<string | null>(null);
  /** 未保存の入力を残したまま移動しようとした行き先（確認ダイアログを開いている間だけ） */
  const [leaveHref, setLeaveHref] = React.useState<string | null>(null);

  const revision = React.useRef(0);
  const savedRevision = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = React.useRef<Promise<boolean> | null>(null);
  const active = React.useRef<{ id: string | null; caret: number | null }>({
    id: null,
    caret: null,
  });
  const statusCursor = React.useRef<Record<string, number>>({});
  const paneRef = React.useRef<HTMLDivElement>(null);
  const paneTriggerRef = React.useRef<HTMLButtonElement>(null);
  const asideRef = React.useRef<HTMLElement>(null);
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  const versionToggleRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    const media = window.matchMedia(WIDE_QUERY);
    const sync = () => setWide(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const announce = React.useCallback((message: string) => {
    // 同じ文言でも読み上げ直すよう、一度空にしてから入れる
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(message));
  }, []);

  // ------------------------------------------------------------------
  // 自動保存（作業中の本文だけ。業務上の版は作らない）
  // ------------------------------------------------------------------

  const save = React.useCallback(async (): Promise<boolean> => {
    if (!canAutosave) return true;
    if (inflight.current) await inflight.current;
    if (savedRevision.current === revision.current) return true;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setSaveState('offline');
      return false;
    }
    const target = revision.current;
    setSaveState('saving');
    const run = (async () => {
      let result: Awaited<ReturnType<typeof autosaveBlockAction>>;
      try {
        result = await autosaveBlockAction({
          projectId,
          blockId,
          baseVersionId,
          body: bodyFromEditable(editableRef.current),
          knownWorkingSavedAt: workingToken.current,
        });
      } catch {
        // 通信そのものの失敗（接続断・5xx）。「保存中」のまま止めず、失敗と再試行を示す
        setSaveError(NETWORK_ERROR_MESSAGE);
        setSaveState('error');
        announce(`保存に失敗しました: ${NETWORK_ERROR_MESSAGE}`);
        return false;
      }
      if (result.status === 'saved') {
        savedRevision.current = target;
        workingToken.current = result.savedAt;
        writeDraft(draftKey, {
          body: bodyFromEditable(editableRef.current),
          savedAt: result.savedAt,
        });
        setSavedAt(result.savedAt);
        setSaveError(null);
        setSaveState(revision.current === target ? 'saved' : 'pending');
        return true;
      }
      if (result.status === 'conflict') {
        setConflictBody(result.currentBody);
        setConflictKind(result.kind);
        setSaveState('conflict');
        announce(`${result.message} 入力内容は画面に残っています。`);
        return false;
      }
      setSaveError(result.message);
      setSaveState('error');
      announce(`保存に失敗しました: ${result.message}`);
      return false;
    })();
    inflight.current = run;
    try {
      return await run;
    } finally {
      inflight.current = null;
    }
  }, [announce, baseVersionId, blockId, canAutosave, draftKey, projectId]);

  const flush = React.useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    return save();
  }, [save]);

  const markChanged = React.useCallback(() => {
    revision.current += 1;
    if (!canAutosave) return;
    setSaveState((s) => (s === 'conflict' ? s : 'pending'));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, AUTOSAVE_DELAY_MS);
  }, [canAutosave, save]);

  // サーバーに作業本文が無い（デモ環境で別のサーバーに届いた）ときは、このタブに控えた自動保存の本文を戻す。
  // 戻した本文はこのサーバーへ自動保存し直す（以後の AI 下書き・版の保存も、画面の本文を送る）。
  // 戻すのは、作業本文を最後に自動保存したのがこの利用者だとサーバーが示すときだけ（その記録は Cookie でも
  // 持ち回し、版の保存・レビュー依頼・開示デモのリセットで消える）。示さないなら控えは古い
  // （リセット前のリハーサルの入力・別の人の後の自動保存）ので、戻さずに消す
  React.useEffect(() => {
    if (!canAutosave || data.bodyFromWorking) return;
    if (!data.block.workingSavedByViewer) {
      removeDraft(draftKey);
      return;
    }
    const draft = readDraft(draftKey);
    if (!draft) return;
    const restored = editableFromBody(draft.body);
    if (canonicalJson(bodyFromEditable(restored)) === canonicalJson(data.body)) {
      removeDraft(draftKey);
      return;
    }
    setEditable(restored);
    editableRef.current = restored;
    setRestoredDraftAt(draft.savedAt);
    // 戻したことは画面の知らせ（role=status）で読み上げる
    markChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 画面を開いたときに 1 回だけ戻す（以後の編集は画面の状態が正）
  }, []);

  // オンラインに戻ったら保存し直す／未保存のまま離れようとしたら止める
  React.useEffect(() => {
    const online = () => {
      if (saveState === 'offline') void save();
    };
    const beforeUnload = (event: Event) => {
      if (savedRevision.current !== revision.current && canType) event.preventDefault();
    };
    window.addEventListener('online', online);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [canType, save, saveState]);

  // 画面を離れるとき（クライアント内の移動を含む）: 待ち時間中の自動保存を捨てずに送る。
  // beforeunload はリンクによる画面内の移動では働かないため、ここで送る（結果は待てない）
  React.useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (canAutosave && savedRevision.current !== revision.current) {
        void autosaveBlockAction({
          projectId,
          blockId,
          baseVersionId,
          body: bodyFromEditable(editableRef.current),
          knownWorkingSavedAt: workingToken.current,
        }).catch(() => undefined);
      }
    },
    [baseVersionId, blockId, canAutosave, projectId],
  );

  // 画面内のリンク（目次・パンくず・根拠パネル・再確認など）で離れる前に、未保存の入力を保存する。
  // 保存できない（失敗・オフライン・競合・承認済みの節の未保存の入力）ときは、移動してよいか確かめる
  const saveStateRef = React.useRef<SaveState>(saveState);
  saveStateRef.current = saveState;
  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      const state = saveStateRef.current;
      const unsaved =
        savedRevision.current !== revision.current ||
        state === 'error' ||
        state === 'offline' ||
        state === 'conflict';
      if (!canType || !unsaved) return;
      event.preventDefault();
      const href = `${url.pathname}${url.search}${url.hash}`;
      void (async () => {
        const saved = canAutosave && state !== 'conflict' ? await flush() : false;
        if (saved) router.push(href);
        else setLeaveHref(href);
      })();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [canAutosave, canType, flush, router]);

  // ------------------------------------------------------------------
  // 段落の編集
  // ------------------------------------------------------------------

  const update = (next: EditableBody) => {
    setEditable(next);
    editableRef.current = next;
    markChanged();
  };

  const setText = (id: string, text: string) => {
    update({
      ...editableRef.current,
      paragraphs: editableRef.current.paragraphs.map((p) => (p.id === id ? { ...p, text } : p)),
    });
  };

  const addParagraph = (afterId: string | null, kind: 'paragraph' | 'heading' = 'paragraph') => {
    const current = editableRef.current;
    const id = newParagraphId(
      current.paragraphs.map((p) => p.id),
      Date.now().toString(36),
    );
    const paragraphs = [...current.paragraphs];
    const at = afterId ? paragraphs.findIndex((p) => p.id === afterId) + 1 : paragraphs.length;
    paragraphs.splice(at, 0, { id, kind, text: '' });
    update({ ...current, paragraphs });
    requestAnimationFrame(() => document.getElementById(`para-input-${id}`)?.focus());
  };

  const removeParagraph = (id: string) => {
    const current = editableRef.current;
    const index = current.paragraphs.findIndex((p) => p.id === id);
    const label = paragraphLabelOf(current.paragraphs, id);
    update({ ...current, paragraphs: current.paragraphs.filter((p) => p.id !== id) });
    announce(`${label} を削除しました。`);
    const next = current.paragraphs[index + 1] ?? current.paragraphs[index - 1];
    if (next)
      requestAnimationFrame(() => document.getElementById(`para-input-${next.id}`)?.focus());
  };

  const toggleKind = (id: string) => {
    update({
      ...editableRef.current,
      paragraphs: editableRef.current.paragraphs.map((p) =>
        p.id === id ? { ...p, kind: p.kind === 'heading' ? 'paragraph' : 'heading' } : p,
      ),
    });
  };

  const insert = (inline: RefInline, label: string) => {
    const current = editableRef.current;
    let targetId = active.current.id;
    if (!targetId || !current.paragraphs.some((p) => p.id === targetId)) {
      targetId = current.paragraphs.filter((p) => p.kind === 'paragraph').at(-1)?.id ?? null;
    }
    if (!targetId) {
      addParagraph(null);
      announce('挿入先の段落を作りました。もう一度「挿入」を押してください。');
      return;
    }
    const result = insertRef(current, targetId, inline, active.current.caret);
    if (!result) return;
    update(result.body);
    active.current = { id: targetId, caret: result.caret };
    announce(
      `${label} を${paragraphLabelOf(result.body.paragraphs, targetId)}に ${result.token} として挿入しました。`,
    );
    setPaneOpen(false);
    requestAnimationFrame(() => {
      const input = document.getElementById(`para-input-${targetId}`) as HTMLTextAreaElement | null;
      if (!input) return;
      input.focus();
      input.setSelectionRange(result.caret, result.caret);
    });
  };

  const jumpTo = React.useCallback(
    (paragraphId: string) => {
      const input = document.getElementById(`para-input-${paragraphId}`);
      const wrapper = document.getElementById(`para-${paragraphId}`);
      if (!wrapper) {
        announce('指定の段落は現在の本文にありません（削除されたか、別の版の段落です）。');
        return;
      }
      wrapper.scrollIntoView({ block: 'center' });
      (input ?? wrapper).focus();
      setPaneOpen(false);
    },
    [announce],
  );

  // ------------------------------------------------------------------
  // 参照の詳細（数値・定性情報・出典）
  // ------------------------------------------------------------------

  const lookup = React.useMemo<RefLookup>(() => {
    const cited = new Map(data.metricRefs.map((m) => [m.dataPointVersionId, m]));
    const candidates = new Map(data.metricCandidates.map((c) => [c.inline.dataPointVersionId, c]));
    const narratives = new Map(data.narratives.map((n) => [n.versionId, n]));
    const anchors = new Map(data.anchors.map((a) => [a.id, a]));
    return {
      canReadEvidence: data.canReadEvidence,
      metric: (id) => {
        const m = cited.get(id);
        if (m && m.referenced) {
          return {
            metricName: m.metricName,
            unitName: m.unitName,
            boundary: m.boundary,
            periodLabel: m.periodLabel,
            unitOfMeasure: m.unitOfMeasure,
            versionNo: m.referenced.versionNo,
            display: m.referenced.display,
            approved: m.referenced.approved,
            methodology: m.methodology,
            evidenceCount: m.evidenceCount,
            sourceReference: m.referenced.sourceReference,
            newer:
              m.stale && m.current
                ? {
                    versionNo: m.current.versionNo,
                    display: m.current.display,
                    changeReason: m.current.changeReason,
                  }
                : null,
          };
        }
        const c = candidates.get(id);
        if (!c) return null;
        return {
          metricName: c.metricName,
          unitName: c.unitName,
          boundary: c.boundary,
          periodLabel: c.periodLabel,
          unitOfMeasure: c.unitOfMeasure,
          versionNo: c.versionNo,
          display: c.display,
          approved: c.approved,
          methodology: null,
          evidenceCount: null,
          sourceReference: null,
          newer: null,
        };
      },
      narrative: (id) => {
        const n = narratives.get(id);
        if (!n) return null;
        return {
          title: n.title,
          versionNo: n.versionNo,
          periodLabel: n.periodLabel,
          confirmed: n.confirmed,
          stale: n.currentVersionId !== null && n.currentVersionId !== n.versionId,
          statusLabel: n.statusLabel,
        };
      },
      anchor: (id) => {
        const a = anchors.get(id);
        if (!a) return null;
        return {
          fileName: a.fileName,
          usageLabel: a.usageLabel,
          locator: a.locator,
          quoteText: a.quoteText,
          fileDeleted: a.fileDeleted,
          fileId: a.fileId,
        };
      },
    };
  }, [data]);

  // 手書き数値の警告（入力に合わせてその場で判定。比べる候補はサーバーが渡した数値）
  const handwritten = React.useMemo(() => {
    const body = bodyFromEditable(editable);
    const units = new Map<
      string,
      Array<{ label: string; display: string; value: number | null }>
    >();
    for (const c of data.metricCandidates) {
      const unit = c.unitOfMeasure.replace(/CO₂/g, 'CO2').replace(/％/g, '%').replace(/^名$/, '人');
      const list = units.get(unit) ?? [];
      list.push({ label: `${c.metricName}（${c.unitName}）`, display: c.display, value: c.value });
      units.set(unit, list);
    }
    const byParagraph = new Map<
      string,
      Array<{ text: string; candidates: string[]; same: boolean }>
    >();
    for (const found of detectHandwrittenNumbers(body)) {
      const candidates = units.get(found.unit) ?? [];
      if (candidates.length === 0) continue;
      const list = byParagraph.get(found.paragraphId) ?? [];
      list.push({
        text: found.text,
        candidates: candidates.slice(0, 3).map((c) => `${c.label} ${c.display}`),
        same: candidates.some((c) => c.value === found.value),
      });
      byParagraph.set(found.paragraphId, list);
    }
    return byParagraph;
  }, [editable, data.metricCandidates]);

  const commentsByParagraph = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const c of data.comments) {
      if (c.resolved || !c.paragraphId) continue;
      map.set(c.paragraphId, (map.get(c.paragraphId) ?? 0) + 1);
    }
    return map;
  }, [data.comments]);

  // ------------------------------------------------------------------
  // 版として保存・レビュー依頼
  // ------------------------------------------------------------------

  const saveVersion = async (event: React.FormEvent) => {
    event.preventDefault();
    setVersionPending(true);
    setVersionError(null);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    let result: Awaited<ReturnType<typeof saveBlockVersionAction>>;
    try {
      result = await saveBlockVersionAction({
        projectId,
        blockId,
        baseVersionId,
        body: bodyFromEditable(editableRef.current),
        changeReason,
        knownWorkingSavedAt: workingToken.current,
      });
    } catch {
      setVersionError(NETWORK_ERROR_MESSAGE);
      announce(NETWORK_ERROR_MESSAGE);
      return;
    } finally {
      setVersionPending(false);
    }
    if (result.status === 'saved') {
      savedRevision.current = revision.current;
      removeDraft(draftKey);
      announce(`版 ${result.versionNo} として保存しました。`);
      // 版が変わると画面を作り直す（ページ側の key が現在の版なので、再描画で編集状態も新しい版から始まる）
      router.replace(
        `/enterprise/disclosure-projects/${projectId}/blocks/${blockId}?flash=blockVersionSaved&version=${result.versionNo}`,
      );
      router.refresh();
      return;
    }
    if (result.status === 'conflict') {
      setConflictBody(result.currentBody);
      setConflictKind(result.kind);
      setSaveState('conflict');
      setVersionError(result.message);
      return;
    }
    const issues = result.issues
      ?.map(
        (i) => `${paragraphLabelOf(editableRef.current.paragraphs, i.paragraphId)}: ${i.message}`,
      )
      .join(' ／ ');
    setVersionError(issues ? `${result.message}（${issues}）` : result.message);
  };

  /** 版として保存のフォームを閉じ、開いたボタンへフォーカスを戻す（キーボードで続けて操作できるように） */
  const closeVersionForm = () => {
    setVersionFormOpen(false);
    requestAnimationFrame(() => versionToggleRef.current?.focus());
  };

  /**
   * レビュー依頼。画面で見ている本文を送り、その本文を提出する版にする
   * （Demo Mode では自動保存の作業本文が別のサーバーに無いことがあり、サーバーの作業本文に頼ると
   * 利用者の見ていない古い版を提出してしまう）
   */
  const submitReviewRequest = async () => {
    setRequestPending(true);
    setRequestError(null);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      if (inflight.current) await inflight.current;
      const result = await requestReviewWithBodyAction({
        projectId,
        blockId,
        baseVersionId,
        body: bodyFromEditable(editableRef.current),
        knownWorkingSavedAt: workingToken.current,
      });
      if (result.status === 'requested') {
        savedRevision.current = revision.current;
        removeDraft(draftKey);
        router.replace(result.href);
        router.refresh();
        return;
      }
      if (result.status === 'conflict') {
        setConflictBody(result.currentBody);
        setConflictKind(result.kind);
        setSaveState('conflict');
      }
      setRequestError(result.message);
      announce(`レビュー依頼を止めました: ${result.message}`);
    } catch {
      setRequestError(NETWORK_ERROR_MESSAGE);
      announce(`レビュー依頼を止めました: ${NETWORK_ERROR_MESSAGE}`);
    } finally {
      setRequestPending(false);
    }
  };

  // ------------------------------------------------------------------
  // 右ペイン（狭い画面ではドロワー）
  // ------------------------------------------------------------------

  /**
   * 根拠パネルを閉じる（狭い幅はドロワーを閉じ、広い幅は本文の横から外して本文を広げる）。
   * 閉じるボタン・Esc・背景で閉じたときは、開いたボタンへフォーカスを戻す（A37・A38）
   */
  const closePane = React.useCallback(() => {
    setPaneOpen(false);
    if (window.matchMedia(WIDE_QUERY).matches) setPaneDocked(false);
    requestAnimationFrame(() => paneTriggerRef.current?.focus());
  }, []);

  /** 開閉ボタン。広い幅では横並びの表示を切り替え、狭い幅ではドロワーを開く */
  const togglePane = () => {
    if (wide) {
      if (paneDocked) {
        closePane();
      } else {
        setPaneDocked(true);
        requestAnimationFrame(() => paneRef.current?.focus());
      }
      return;
    }
    setPaneOpen(true);
  };
  const paneExpanded = wide ? paneDocked : paneOpen;
  /** 狭い幅で根拠パネルをドロワーとして開いている（背面は操作させない） */
  const drawerOpen = paneOpen && !wide;

  // 広い幅でも、パネル内で Esc を押すと閉じて開いたボタンへ戻る（狭い幅のドロワーは下の処理で扱う）
  React.useEffect(() => {
    if (!wide || !paneDocked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!asideRef.current?.contains(document.activeElement)) return;
      closePane();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePane, paneDocked, wide]);

  // 狭い幅のドロワーはモーダル: 開いている間は Tab・Shift+Tab をドロワーの中で回し、
  // 背面（暗くした本文・状態の帯）へフォーカスを抜けさせない（A37・A38・UX-R3-08）
  React.useEffect(() => {
    if (!paneOpen) return;
    paneRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePane();
        return;
      }
      if (event.key !== 'Tab' || wide) return;
      const aside = asideRef.current;
      if (!aside) return;
      const focusable = [
        ...aside.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && aside.contains(active);
      if (event.shiftKey && (!inside || active === first || active === paneRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePane, paneOpen, wide]);

  React.useEffect(() => {
    if (versionFormOpen) reasonRef.current?.focus();
  }, [versionFormOpen]);

  const selectedSources = React.useMemo(
    () =>
      [...selected].map((key) => {
        const [kind, ...rest] = key.split(':');
        return { kind: kind as SelectableSourceKind, id: rest.join(':') };
      }),
    [selected],
  );

  const paragraphOptions = editable.paragraphs.map((p) => ({
    id: p.id,
    label: `${paragraphLabelOf(editable.paragraphs, p.id)}: ${displayText(p, editable.refs).slice(0, 24)}`,
  }));

  const statusItems: Array<{ key: keyof BlockEditorData['statusBar']; label: string }> = [
    { key: 'unresolvedComments', label: '未解決指摘' },
    { key: 'staleRefs', label: '古い参照' },
    { key: 'unapprovedMetrics', label: '未承認数値' },
    { key: 'unverifiedClaims', label: '未確認の主張' },
  ];

  const cycleStatus = (key: keyof BlockEditorData['statusBar']) => {
    const ids = data.statusBar[key].paragraphIds;
    if (ids.length === 0) return;
    const next = (statusCursor.current[key] ?? -1) + 1;
    statusCursor.current[key] = next % ids.length;
    const id = ids[next % ids.length];
    if (id) jumpTo(id);
  };

  const saveIndicator = (() => {
    if (!canType) return null;
    if (!canAutosave) {
      return (
        <span className="inline-flex items-center gap-1 text-ink-muted">
          <CircleDot className="size-3.5" aria-hidden="true" />
          承認済み: 変更は「版として保存」で新しい版になります（承認済みの版は残ります）
        </span>
      );
    }
    switch (saveState) {
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1 text-ink-muted">
            <CircleDot className="size-3.5" aria-hidden="true" />
            未保存の変更あり
          </span>
        );
      case 'saving':
        return (
          <span className="inline-flex items-center gap-1 text-ink">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            保存中
          </span>
        );
      case 'saved':
        return (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            保存済み {timeOf(savedAt)}
          </span>
        );
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 text-danger">
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            保存失敗
            <button
              type="button"
              onClick={() => void flush()}
              className="ml-1 rounded-t4d px-1 text-brand-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              再試行
            </button>
          </span>
        );
      case 'conflict':
        return (
          <span className="inline-flex items-center gap-1 text-danger">
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            競合（自動保存を停止）
          </span>
        );
      case 'offline':
        return (
          <span className="inline-flex items-center gap-1 text-warning-ink">
            <CloudOff className="size-3.5" aria-hidden="true" />
            オフライン（入力は保持しています）
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 text-ink-muted">
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            変更なし
          </span>
        );
    }
  })();

  const canRequestReview =
    permissions.editable && (data.block.status === 'draft' || data.block.status === 'returned');

  return (
    <div className="flex min-w-0 flex-col">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <ConfirmDialog
        {...LEAVE_CONFIRM}
        consequences={[...LEAVE_CONFIRM.consequences]}
        open={leaveHref !== null}
        onOpenChange={(open) => {
          if (!open) setLeaveHref(null);
        }}
        action={() => {
          const href = leaveHref;
          setLeaveHref(null);
          if (href) router.push(href);
        }}
      />

      {/* 上部の操作列: 保存状態・版として保存・レビュー依頼（主要な操作は 1 つ。plan §1.15 原稿の作成中:
          primary「レビュー依頼」・secondary「版として保存」。版の入力欄を開いている間は「この内容で版を作る」が主操作） */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="wide:hidden"
          aria-expanded={tocOpen}
          aria-controls="block-toc"
          onClick={() => setTocOpen((v) => !v)}
        >
          <ListTree aria-hidden="true" />
          目次
        </Button>
        <div className="text-small" aria-live="polite">
          {saveIndicator}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {canType && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              ref={versionToggleRef}
              aria-expanded={versionFormOpen}
              aria-controls="version-form"
              onClick={() => setVersionFormOpen((v) => !v)}
            >
              <Save aria-hidden="true" />
              版として保存
            </Button>
          )}
          {canRequestReview && (
            <Button
              variant={versionFormOpen && canType ? 'secondary' : 'primary'}
              type="button"
              size="sm"
              disabled={requestPending}
              onClick={() => void submitReviewRequest()}
            >
              {requestPending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Send aria-hidden="true" />
              )}
              レビュー依頼
            </Button>
          )}
          {/* 1366px 以上でも閉じられる（閉じると本文の幅が広がる）。狭い幅ではドロワーを開く */}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-expanded={paneExpanded}
            aria-controls="block-right-pane"
            ref={paneTriggerRef}
            onClick={togglePane}
          >
            {paneExpanded ? (
              <PanelRightClose aria-hidden="true" />
            ) : (
              <PanelRightOpen aria-hidden="true" />
            )}
            根拠パネル
          </Button>
        </div>
      </div>

      {restoredDraftAt && (
        <p
          role="status"
          className="border-b border-line bg-brand-50 px-3 py-1.5 text-small text-brand-900"
        >
          このタブに残っていた自動保存の本文（{formatJst(restoredDraftAt)}）を戻しました。
          作業中の本文はサーバーをまたいで持ち回さないため、この画面の本文を正として保存し直します。
        </p>
      )}

      {requestError && (
        <p
          role="alert"
          className="border-b border-line bg-danger-soft px-3 py-1.5 text-small text-ink"
        >
          レビューを依頼できませんでした: {requestError}
        </p>
      )}
      {data.block.scopeRecheckNeeded && (
        <p className="flex items-start gap-1 border-b border-line bg-warning-soft/50 px-3 py-1.5 text-small text-ink">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
          報告範囲（報告主体・期間・対象範囲）の変更より前に承認された節です。変更後の範囲で本文を確認し、「版として保存」してから再承認を受けてください（本文を変えなくても版を作れます）。
        </p>
      )}
      {data.block.applicabilityRecheckNeeded && (
        <p
          className="flex items-start gap-1 border-b border-line bg-warning-soft/50 px-3 py-1.5 text-small text-ink"
          data-testid="applicability-recheck-banner"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
          最終承認の後に、この節の基準の適用判断が確定し直されました。更新後の判断で本文を確認し、「版として保存」してから再承認を受けてください（本文を変えなくても版を作れます）。
        </p>
      )}
      {data.block.translationNeedsCheck && data.block.currentVersionId && (
        <p
          className="flex items-start gap-1 border-b border-line bg-warning-soft/50 px-3 py-1.5 text-small text-ink"
          data-testid="translation-recheck-banner"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
          翻訳元が、この翻訳の版より後に更新されています。翻訳元と照らして翻訳を確認し、「版として保存」してからレビューを受けてください（翻訳を直す必要が無ければ、本文を変えずに版を作れます）。
        </p>
      )}
      {data.block.workingUpdatedByOtherName && (
        <p className="flex items-start gap-1 border-b border-line bg-surface-muted px-3 py-1.5 text-small text-ink">
          <CircleDot className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          {data.block.workingUpdatedByOtherName}
          さんが自動保存した作業中の本文を表示しています。この本文を編集・提出すると、
          {data.block.workingUpdatedByOtherName}
          さんも本文を書いた人として記録され、この節のレビュー・最終承認はできなくなります。
        </p>
      )}
      {canRequestReview && data.blockers.length > 0 && (
        <div className="border-b border-line bg-warning-soft/50 px-3 py-1.5 text-small text-ink">
          <span className="font-medium">レビュー依頼の前に解消が必要: </span>
          {data.blockers.map((b) => b.message).join(' ／ ')}
        </div>
      )}

      {versionFormOpen && canType && (
        <form
          id="version-form"
          onSubmit={saveVersion}
          className="space-y-1.5 border-b border-line bg-surface-muted px-3 py-2"
        >
          <label htmlFor="change-reason" className="text-small font-medium text-ink">
            変更理由{baseVersionId ? '（必須）' : '（任意。初版）'}
          </label>
          <Textarea
            id="change-reason"
            ref={reasonRef}
            rows={2}
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeVersionForm();
            }}
            required={Boolean(baseVersionId)}
            placeholder="例: 委員会資料に基づき開催頻度を更新"
          />
          {permissions.reviseAfterApproval && (
            <p className="text-caption text-ink-muted">
              承認済みの節です。保存すると新しい版になり、節は下書きへ戻ります（承認済みの版はそのまま残ります）。
            </p>
          )}
          {versionError && (
            <p role="alert" className="text-small text-danger">
              {versionError}
            </p>
          )}
          <div className="flex gap-1.5">
            <SubmitButton variant="primary" size="sm" disabled={versionPending}>
              {versionPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              この内容で版を作る
            </SubmitButton>
            <Button type="button" size="sm" variant="ghost" onClick={closeVersionForm}>
              閉じる
            </Button>
          </div>
        </form>
      )}

      {!canType && permissions.readOnlyReason && (
        <p className="border-b border-line bg-surface-muted px-3 py-1.5 text-small text-ink-muted">
          {permissions.readOnlyReason}
        </p>
      )}
      {saveError && saveState === 'error' && (
        <p
          role="alert"
          className="border-b border-line bg-danger-soft px-3 py-1.5 text-small text-ink"
        >
          保存に失敗しました: {saveError}（入力内容は画面に残っています）
        </p>
      )}
      {conflictBody && (
        <div
          role="alert"
          className="border-b border-danger/40 bg-danger-soft px-3 py-2 text-small text-ink"
        >
          <p className="font-medium">
            {conflictKind === 'working'
              ? 'ほかの人が自動保存した作業中の本文があります。上書き・破棄せずに止めました。'
              : 'ほかの操作で新しい版が保存されています。上書きせずに止めました。'}
          </p>
          <p className="mt-0.5">
            この画面の入力内容はそのまま残っています。必要な文をコピーしてから、最新の版を開いて取り込み直してください。
          </p>
          <Collapsible
            variant="plain"
            className="mt-1"
            summary={
              conflictKind === 'working' ? 'ほかの人の作業中の本文を表示' : '最新の版の本文を表示'
            }
          >
            <div className="space-y-1 rounded-t4d border border-line bg-surface p-2">
              {editableFromBody(conflictBody).paragraphs.map((p, _index, all) => (
                <p key={p.id} className="whitespace-pre-wrap">
                  <span className="mr-1 text-caption text-ink-muted">
                    {paragraphLabelOf(all, p.id)}
                  </span>
                  {displayText(p, editableFromBody(conflictBody).refs)}
                </p>
              ))}
            </div>
          </Collapsible>
          <a
            href={`/enterprise/disclosure-projects/${projectId}/blocks/${blockId}`}
            className="mt-1 inline-block text-brand-700 underline-offset-2 hover:underline"
          >
            最新の版を開く（この画面の入力は破棄されます）
          </a>
        </div>
      )}

      <div
        className={`grid min-w-0 grid-cols-1 ${
          paneDocked
            ? 'wide:grid-cols-[220px_minmax(0,1fr)_380px]'
            : 'wide:grid-cols-[220px_minmax(0,1fr)]'
        }`}
      >
        {/* 左: 目次 */}
        <nav
          id="block-toc"
          aria-label="節の目次"
          className={`${tocOpen ? 'block' : 'hidden'} border-b border-line bg-surface wide:block wide:border-b-0 wide:border-r`}
        >
          <ol className="p-2 text-small">
            {data.siblings.map((s) => {
              const current = s.id === blockId;
              return (
                <li key={s.id}>
                  <Link
                    href={`/enterprise/disclosure-projects/${projectId}/blocks/${s.id}`}
                    aria-current={current ? 'page' : undefined}
                    className={`block rounded-t4d px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                      current
                        ? 'bg-brand-100 font-medium text-brand-900'
                        : 'text-ink hover:bg-brand-50'
                    }`}
                  >
                    <span className="block truncate">
                      {s.title}
                      {s.language === 'en' ? '（英語）' : ''}
                      <LinkPending />
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-1 text-caption text-ink-muted">
                      <span>{s.statusLabel}</span>
                      {s.freshness !== 'current' && (
                        <span className="inline-flex items-center gap-0.5 text-warning-ink">
                          <AlertTriangle className="size-2.5" aria-hidden="true" />
                          {s.freshness === 'evidence_invalid'
                            ? '根拠失効'
                            : s.freshness === 'rechecked'
                              ? '再確認済み'
                              : s.freshness === 'version_unavailable'
                                ? '版を読み込めません'
                                : '再確認が必要'}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* 中央: 本文。AppShell が既に <main id="t4d-main"> を持つため、ここは名前付きの領域にする（main を入れ子にしない） */}
        <section aria-label="本文" className="min-w-0 space-y-3 p-3" inert={drawerOpen}>
          <AiPanel
            projectId={projectId}
            blockId={blockId}
            runs={runs}
            aiMode={aiMode}
            canRunAi={permissions.canRunAi}
            editable={permissions.editable}
            selectedSources={selectedSources}
            getBody={() => bodyFromEditable(editableRef.current)}
            getWorkingToken={() => workingToken.current}
            baseVersionId={baseVersionId}
            onBodyReplaced={(body, at) => {
              const next = editableFromBody(body);
              setEditable(next);
              editableRef.current = next;
              revision.current += 1;
              savedRevision.current = revision.current;
              // 採用はサーバーで作業本文として保存済み。以後の自動保存はこの保存を土台にする
              workingToken.current = at;
              // タブの控えも採用後の本文にする（自動保存と同じ）。控えが採用前のままだと、作業本文の無い
              // サーバーで開き直したときに採用前の本文を戻して自動保存し、採用した段落が消える
              // （採用で実行は閉じ、同じ候補をもう一度採用できない）
              writeDraft(draftKey, { body, savedAt: at });
              setSavedAt(at);
              setSaveState('saved');
            }}
            onWorkingConflict={(body, message) => {
              setConflictBody(body);
              setConflictKind('working');
              setSaveState('conflict');
              announce(message);
            }}
            onAnnounce={announce}
            paragraphLabel={(id) => paragraphLabelOf(editableRef.current.paragraphs, id)}
            paragraphText={(id) => {
              const p = editableRef.current.paragraphs.find((x) => x.id === id);
              return p ? displayText(p, editableRef.current.refs) : null;
            }}
          />

          {editable.paragraphs.length === 0 && (
            <div className="rounded-t4d-lg border border-dashed border-line p-4 text-center text-small text-ink-muted">
              本文がまだありません。
              {canType && (
                <div className="mt-2 flex justify-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => addParagraph(null, 'heading')}
                  >
                    <Heading aria-hidden="true" />
                    見出しを追加
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => addParagraph(null)}
                  >
                    <Plus aria-hidden="true" />
                    段落を追加
                  </Button>
                </div>
              )}
            </div>
          )}

          <ol className="space-y-2">
            {editable.paragraphs.map((p) => {
              // 内部の段落 ID は出さず、本文の中の位置で呼ぶ（UX-R3-05）
              const label = paragraphLabelOf(editable.paragraphs, p.id);
              const refs = refsInParagraph(p, editable.refs);
              const warnings = handwritten.get(p.id) ?? [];
              const commentCount = commentsByParagraph.get(p.id) ?? 0;
              const inputId = `para-input-${p.id}`;
              const paragraph = paragraphFromEditable(p, editable.refs);
              return (
                <li
                  key={p.id}
                  id={`para-${p.id}`}
                  tabIndex={-1}
                  className="rounded-t4d-lg border border-line bg-surface p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
                    <label htmlFor={inputId} className="inline-flex items-center gap-1">
                      {p.kind === 'heading' ? (
                        <Heading className="size-3" aria-hidden="true" />
                      ) : (
                        <Pilcrow className="size-3" aria-hidden="true" />
                      )}
                      {label}
                    </label>
                    {p.aiRunId && (
                      <Badge tone="brand">
                        <Bot className="size-3" aria-hidden="true" />
                        AI 候補を採用
                      </Badge>
                    )}
                    {commentCount > 0 && (
                      <Badge tone="warning">
                        <AlertTriangle className="size-3" aria-hidden="true" />
                        未解決の指摘 {commentCount}
                      </Badge>
                    )}
                    {canType && (
                      <span className="ml-auto inline-flex items-center gap-0.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleKind(p.id)}
                          aria-label={`${label} を${p.kind === 'heading' ? '本文' : '見出し'}にする`}
                        >
                          {p.kind === 'heading' ? (
                            <Pilcrow aria-hidden="true" />
                          ) : (
                            <Heading aria-hidden="true" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => addParagraph(p.id)}
                          aria-label={`${label} の後に段落を追加`}
                        >
                          <Plus aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => removeParagraph(p.id)}
                          aria-label={`${label} を削除`}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </span>
                    )}
                  </div>
                  <Textarea
                    id={inputId}
                    value={p.text}
                    readOnly={!canType}
                    rows={rowsFor(p.text)}
                    aria-describedby={refs.length > 0 ? `para-refs-${p.id}` : undefined}
                    className={p.kind === 'heading' ? 'font-semibold' : ''}
                    onChange={(e) => {
                      active.current = { id: p.id, caret: e.target.selectionStart };
                      setText(p.id, e.target.value);
                    }}
                    onSelect={(e) => {
                      active.current = { id: p.id, caret: e.currentTarget.selectionStart };
                    }}
                    onFocus={(e) => {
                      active.current = { id: p.id, caret: e.currentTarget.selectionStart };
                    }}
                  />
                  {refs.length > 0 && (
                    <div
                      id={`para-refs-${p.id}`}
                      className="mt-1 flex flex-wrap items-center gap-1"
                    >
                      <span className="sr-only">この段落の参照:</span>
                      {refs.map(({ token, ref }) => (
                        <RefChip key={token} token={token} inline={ref} lookup={lookup} />
                      ))}
                    </div>
                  )}
                  {refs.length > 0 && (
                    <p className="mt-1 whitespace-pre-wrap text-small text-ink-muted">
                      <span className="sr-only">表示: </span>
                      {paragraph.children
                        .map((c) =>
                          c.t === 'text'
                            ? c.text
                            : c.t === 'metric'
                              ? c.display
                              : c.t === 'narrative'
                                ? c.quote
                                : '',
                        )
                        .join('')}
                    </p>
                  )}
                  {warnings.map((w) => (
                    <p
                      key={w.text}
                      className="mt-1 flex items-start gap-1 rounded-t4d border border-warning/40 bg-warning-soft p-1.5 text-small text-ink"
                    >
                      <AlertTriangle
                        className="mt-0.5 size-3.5 shrink-0 text-warning-ink"
                        aria-hidden="true"
                      />
                      <span>
                        手書きの数値「{w.text}」があります。
                        {w.same
                          ? '同じ値の数値を参照に置き換えられます'
                          : '値が異なる参照可能な数値があります'}
                        （{w.candidates.join('、')}
                        ）。関連数値タブから参照を挿入するか、参照しない理由を本文に書いてください。
                      </span>
                    </p>
                  ))}
                </li>
              );
            })}
          </ol>
          {canType && editable.paragraphs.length > 0 && (
            <Button type="button" size="sm" variant="secondary" onClick={() => addParagraph(null)}>
              <Plus aria-hidden="true" />
              末尾に段落を追加
            </Button>
          )}
        </section>

        {/* 右: 根拠（狭い画面ではドロワー） */}
        <aside
          id="block-right-pane"
          // 狭い幅で開いたドロワーはモーダルのダイアログとして読み上げる（背面は操作できない）
          {...(drawerOpen
            ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'block-right-pane-title' }
            : { 'aria-label': '根拠パネル' })}
          className={`${paneOpen ? 'fixed inset-y-0 right-0 z-(--z-overlay) flex w-[min(420px,100vw)] shadow-overlay' : 'hidden'} flex-col border-l border-line bg-surface ${
            paneDocked
              ? // 高さはスクロール領域（画面 − ヘッダー 48px）から、下に固定した「本文の状態」の帯（約 44px）を除いた分。
                // 画面の高さ（100vh）にすると、下端が帯の裏とスクロール領域の外に隠れていた
                'wide:sticky wide:top-0 wide:z-auto wide:flex wide:max-h-[calc(100vh-48px-2.75rem)] wide:self-start wide:w-auto wide:shadow-none'
              : 'wide:hidden'
          }`}
          ref={asideRef}
        >
          <div
            ref={paneRef}
            tabIndex={-1}
            className="flex items-center justify-between border-b border-line px-3 py-1.5 focus-visible:outline-none"
          >
            <span id="block-right-pane-title" className="text-body font-semibold text-ink">
              根拠パネル
            </span>
            <button
              type="button"
              onClick={closePane}
              aria-label="根拠パネルを閉じる"
              className="rounded-t4d p-1 text-ink-muted hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <RightPane
            data={data}
            projectId={projectId}
            canEdit={canType}
            selected={selected}
            onToggleSelect={(key) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            canSelectForAi={permissions.canRunAi && permissions.editable}
            onInsert={insert}
            onJump={jumpTo}
            paragraphLabel={(id) => paragraphLabelOf(editable.paragraphs, id)}
            paragraphOptions={paragraphOptions}
            tab={paneTab}
            onTabChange={setPaneTab}
            onAnnounce={announce}
          />
        </aside>
        {paneOpen && (
          <button
            type="button"
            aria-label="根拠パネルを閉じる"
            className="fixed inset-0 z-(--z-pane-overlay) bg-overlay/25 wide:hidden"
            onClick={closePane}
          />
        )}
      </div>

      {/* 下部: 状態（該当箇所へ移動） */}
      <div
        role="toolbar"
        aria-label="本文の状態"
        inert={drawerOpen}
        className="sticky bottom-0 z-(--z-pane) flex min-h-[2.75rem] flex-wrap items-center gap-1.5 border-t border-line bg-surface px-3 py-1.5 text-small"
      >
        {statusItems.map(({ key, label }) => {
          const item = data.statusBar[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => cycleStatus(key)}
              disabled={item.count === 0}
              aria-label={`${label} ${item.count} 件${item.count > 0 ? '。押すと該当する段落へ移動します' : ''}`}
              className={`inline-flex items-center gap-1 rounded-t4d border px-2 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-default ${
                item.count > 0
                  ? 'border-warning/40 bg-warning-soft text-ink hover:bg-warning-soft/70'
                  : 'border-line text-ink-muted'
              }`}
            >
              {item.count > 0 ? (
                <AlertTriangle className="size-3 text-warning-ink" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="size-3 text-success" aria-hidden="true" />
              )}
              {label} {item.count}
            </button>
          );
        })}
        {data.freshness.status !== 'current' && (
          <Link
            href={`/enterprise/disclosure-projects/${projectId}/blocks/${blockId}/recheck`}
            className="ml-auto text-brand-700 underline-offset-2 hover:underline"
          >
            引用先の変更を再確認する（{data.freshness.label}）
          </Link>
        )}
      </div>
    </div>
  );
}
