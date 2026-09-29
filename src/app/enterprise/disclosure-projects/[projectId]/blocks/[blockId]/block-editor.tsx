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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { detectHandwrittenNumbers } from '@/lib/domain/disclosure-block';
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
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict' | 'offline';

const AUTOSAVE_DELAY_MS = 1500;

/** 通信そのものが失敗したとき（サーバーに届かない・5xx）の説明。入力は画面に残る */
const NETWORK_ERROR_MESSAGE =
  'サーバーに接続できませんでした。入力内容は画面に残っています。通信を確認して再試行してください。';

/** 根拠パネルを本文の横に並べる幅（これより狭い幅ではドロワー） */
const WIDE_QUERY = '(min-width: 1366px)';

/** 移動の前に確認する（保存できていない入力がある）ときの文面 */
const LEAVE_CONFIRM_MESSAGE =
  '保存できていない入力があります。このまま移動すると、その入力は失われます。移動しますか？';

/** 「保存済み HH:mm」の時刻部分（日時は formatJst を通す） */
function timeOf(iso: string | null): string {
  if (!iso) return '';
  const formatted = formatJst(iso);
  return formatted.length >= 16 ? formatted.slice(11, 16) : formatted;
}

function rowsFor(text: string): number {
  const lines = text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 48)), 0);
  return Math.min(14, Math.max(2, lines));
}

export function BlockEditor({ projectId, data, runs, aiMode }: BlockEditorProps) {
  const router = useRouter();
  const blockId = data.block.id;
  const baseVersionId = data.block.currentVersionId;
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
  }, [announce, baseVersionId, blockId, canAutosave, projectId]);

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
        if (saved || window.confirm(LEAVE_CONFIRM_MESSAGE)) router.push(href);
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
    update({ ...current, paragraphs: current.paragraphs.filter((p) => p.id !== id) });
    announce(`段落 ${id} を削除しました。`);
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
    announce(`${label} を段落 ${targetId} に ${result.token} として挿入しました。`);
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
        announce(`段落 ${paragraphId} は現在の本文にありません。`);
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
    const issues = result.issues?.map((i) => `段落 ${i.paragraphId}: ${i.message}`).join(' ／ ');
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

  React.useEffect(() => {
    if (!paneOpen) return;
    paneRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePane();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePane, paneOpen]);

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
    label: `段落 ${p.id}${p.kind === 'heading' ? '（見出し）' : ''}: ${displayText(p, editable.refs).slice(0, 24)}`,
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
          <span className="inline-flex items-center gap-1 text-[#8a5d00]">
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

      {/* 上部の操作列: 保存状態・版として保存・レビュー依頼（主要な操作は 1 つ） */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-[1366px]:hidden"
          aria-expanded={tocOpen}
          aria-controls="block-toc"
          onClick={() => setTocOpen((v) => !v)}
        >
          <ListTree aria-hidden="true" />
          目次
        </Button>
        <div className="text-[12px]" aria-live="polite">
          {saveIndicator}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {canType && (
            <Button
              type="button"
              size="sm"
              variant="outline"
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
            variant="outline"
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

      {requestError && (
        <p
          role="alert"
          className="border-b border-line bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
        >
          レビューを依頼できませんでした: {requestError}
        </p>
      )}
      {data.block.scopeRecheckNeeded && (
        <p className="flex items-start gap-1 border-b border-line bg-warning-soft/50 px-3 py-1.5 text-[12px] text-ink">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#8a5d00]" aria-hidden="true" />
          報告範囲（報告主体・期間・対象範囲）の変更より前に承認された節です。変更後の範囲で本文を確認し、「版として保存」してから再承認を受けてください（本文を変えなくても版を作れます）。
        </p>
      )}
      {data.block.workingUpdatedByOtherName && (
        <p className="flex items-start gap-1 border-b border-line bg-surface-muted px-3 py-1.5 text-[12px] text-ink">
          <CircleDot className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          {data.block.workingUpdatedByOtherName}
          さんが自動保存した作業中の本文を表示しています。この本文を編集・提出すると、
          {data.block.workingUpdatedByOtherName}
          さんも本文を書いた人として記録され、この節のレビュー・最終承認はできなくなります。
        </p>
      )}
      {canRequestReview && data.blockers.length > 0 && (
        <div className="border-b border-line bg-warning-soft/50 px-3 py-1.5 text-[12px] text-ink">
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
          <label htmlFor="change-reason" className="text-[12px] font-medium text-ink">
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
            <p className="text-[11px] text-ink-muted">
              承認済みの節です。保存すると新しい版になり、節は下書きへ戻ります（承認済みの版はそのまま残ります）。
            </p>
          )}
          {versionError && (
            <p role="alert" className="text-[12px] text-danger">
              {versionError}
            </p>
          )}
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" disabled={versionPending}>
              {versionPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              この内容で版を作る
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={closeVersionForm}>
              閉じる
            </Button>
          </div>
        </form>
      )}

      {!canType && permissions.readOnlyReason && (
        <p className="border-b border-line bg-surface-muted px-3 py-1.5 text-[12px] text-ink-muted">
          {permissions.readOnlyReason}
        </p>
      )}
      {saveError && saveState === 'error' && (
        <p
          role="alert"
          className="border-b border-line bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
        >
          保存に失敗しました: {saveError}（入力内容は画面に残っています）
        </p>
      )}
      {conflictBody && (
        <div
          role="alert"
          className="border-b border-danger/40 bg-danger-soft px-3 py-2 text-[12px] text-ink"
        >
          <p className="font-medium">
            {conflictKind === 'working'
              ? 'ほかの人が自動保存した作業中の本文があります。上書き・破棄せずに止めました。'
              : 'ほかの操作で新しい版が保存されています。上書きせずに止めました。'}
          </p>
          <p className="mt-0.5">
            この画面の入力内容はそのまま残っています。必要な文をコピーしてから、最新の版を開いて取り込み直してください。
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer">
              {conflictKind === 'working' ? 'ほかの人の作業中の本文を表示' : '最新の版の本文を表示'}
            </summary>
            <div className="mt-1 space-y-1 rounded-t4d border border-line bg-surface p-2">
              {editableFromBody(conflictBody).paragraphs.map((p) => (
                <p key={p.id} className="whitespace-pre-wrap">
                  <span className="mr-1 font-mono text-[10px] text-ink-muted">{p.id}</span>
                  {displayText(p, editableFromBody(conflictBody).refs)}
                </p>
              ))}
            </div>
          </details>
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
            ? 'min-[1366px]:grid-cols-[220px_minmax(0,1fr)_380px]'
            : 'min-[1366px]:grid-cols-[220px_minmax(0,1fr)]'
        }`}
      >
        {/* 左: 目次 */}
        <nav
          id="block-toc"
          aria-label="節の目次"
          className={`${tocOpen ? 'block' : 'hidden'} border-b border-line bg-surface min-[1366px]:block min-[1366px]:border-b-0 min-[1366px]:border-r`}
        >
          <ol className="p-2 text-[12px]">
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
                    <span className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-ink-muted">
                      <span>{s.statusLabel}</span>
                      {s.freshness !== 'current' && (
                        <span className="inline-flex items-center gap-0.5 text-[#8a5d00]">
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
        <section aria-label="本文" className="min-w-0 space-y-3 p-3">
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
            paragraphText={(id) => {
              const p = editableRef.current.paragraphs.find((x) => x.id === id);
              return p ? displayText(p, editableRef.current.refs) : null;
            }}
          />

          {editable.paragraphs.length === 0 && (
            <div className="rounded-t4d-lg border border-dashed border-line p-4 text-center text-[12px] text-ink-muted">
              本文がまだありません。
              {canType && (
                <div className="mt-2 flex justify-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => addParagraph(null, 'heading')}
                  >
                    <Heading aria-hidden="true" />
                    見出しを追加
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
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
                  <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
                    <label htmlFor={inputId} className="inline-flex items-center gap-1">
                      {p.kind === 'heading' ? (
                        <Heading className="size-3" aria-hidden="true" />
                      ) : (
                        <Pilcrow className="size-3" aria-hidden="true" />
                      )}
                      {p.kind === 'heading' ? '見出し' : '段落'} {p.id}
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
                          aria-label={`段落 ${p.id} を${p.kind === 'heading' ? '本文' : '見出し'}にする`}
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
                          aria-label={`段落 ${p.id} の後に段落を追加`}
                        >
                          <Plus aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => removeParagraph(p.id)}
                          aria-label={`段落 ${p.id} を削除`}
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
                    <p className="mt-1 whitespace-pre-wrap text-[12px] text-ink-muted">
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
                      className="mt-1 flex items-start gap-1 rounded-t4d border border-warning/40 bg-warning-soft p-1.5 text-[12px] text-ink"
                    >
                      <AlertTriangle
                        className="mt-0.5 size-3.5 shrink-0 text-[#8a5d00]"
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
            <Button type="button" size="sm" variant="outline" onClick={() => addParagraph(null)}>
              <Plus aria-hidden="true" />
              末尾に段落を追加
            </Button>
          )}
        </section>

        {/* 右: 根拠（狭い画面ではドロワー） */}
        <aside
          id="block-right-pane"
          aria-label="根拠パネル"
          className={`${paneOpen ? 'fixed inset-y-0 right-0 z-40 flex w-[min(420px,100vw)] shadow-xl' : 'hidden'} flex-col border-l border-line bg-surface ${
            paneDocked
              ? // 高さはスクロール領域（画面 − ヘッダー 48px）から、下に固定した「本文の状態」の帯（約 44px）を除いた分。
                // 画面の高さ（100vh）にすると、下端が帯の裏とスクロール領域の外に隠れていた
                'min-[1366px]:sticky min-[1366px]:top-0 min-[1366px]:z-auto min-[1366px]:flex min-[1366px]:max-h-[calc(100vh-48px-2.75rem)] min-[1366px]:self-start min-[1366px]:w-auto min-[1366px]:shadow-none'
              : 'min-[1366px]:hidden'
          }`}
          ref={asideRef}
        >
          <div
            ref={paneRef}
            tabIndex={-1}
            className="flex items-center justify-between border-b border-line px-3 py-1.5 focus-visible:outline-none"
          >
            <span className="text-[13px] font-semibold text-ink">根拠パネル</span>
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
            className="fixed inset-0 z-30 bg-[#0b1b34]/25 min-[1366px]:hidden"
            onClick={closePane}
          />
        )}
      </div>

      {/* 下部: 状態（該当箇所へ移動） */}
      <div
        role="toolbar"
        aria-label="本文の状態"
        className="sticky bottom-0 z-20 flex min-h-[2.75rem] flex-wrap items-center gap-1.5 border-t border-line bg-surface px-3 py-1.5 text-[12px]"
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
                <AlertTriangle className="size-3 text-[#8a5d00]" aria-hidden="true" />
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
