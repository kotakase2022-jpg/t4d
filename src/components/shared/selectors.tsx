'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Building2, CalendarRange, ChevronDown, FolderKanban, LogOut, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { roleLabel } from '@/lib/authorization/roles';
import type { RoleKey } from '@/types/domain';

export interface WorkspaceChoice {
  organizationId: string;
  organizationName: string;
  organizationType: 'enterprise' | 'assurance_firm' | 'platform_admin';
}

export function WorkspaceSelector({
  current,
  choices,
  onSelectAction,
}: {
  current: WorkspaceChoice;
  choices: WorkspaceChoice[];
  onSelectAction: (formData: FormData) => Promise<void>;
}) {
  const typeLabel =
    current.organizationType === 'enterprise'
      ? '企業'
      : current.organizationType === 'assurance_firm'
        ? '監査法人'
        : 'プラットフォーム';

  if (choices.length <= 1) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
        <Building2 className="size-3.5 text-ink-muted" aria-hidden="true" />
        {current.organizationName}
        <span className="text-[11px] text-ink-muted">（{typeLabel}）</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-t4d px-2 py-1 text-[13px] font-medium text-ink hover:bg-brand-50">
        <Building2 className="size-3.5 text-ink-muted" aria-hidden="true" />
        {current.organizationName}
        <span className="text-[11px] text-ink-muted">（{typeLabel}）</span>
        <ChevronDown className="size-3.5 text-ink-muted" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>ワークスペース切替</DropdownMenuLabel>
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.organizationId}
            // Menu を閉じると中の form が unmount され、submit が成立しない。
            // preventDefault で閉じるのを止め、Server Action を直接呼ぶ（下の UserMenu と同じ理由）。
            onSelect={(event) => {
              event.preventDefault();
              const formData = new FormData();
              formData.set('organizationId', choice.organizationId);
              React.startTransition(() => {
                void onSelectAction(formData);
              });
            }}
          >
            {choice.organizationName}
            <span className="ml-auto text-[11px] text-ink-muted">
              {choice.organizationType === 'enterprise' ? '企業' : '監査法人'}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface PeriodChoice {
  id: string;
  label: string;
  code: string;
}

/**
 * 報告期間の切替。
 * Layout（searchParams を受け取れない）からも参照できるよう Cookie に保存する。
 */
export function ReportingPeriodSelector({
  periods,
  currentId,
  onSelectAction,
}: {
  periods: PeriodChoice[];
  currentId: string;
  onSelectAction: (formData: FormData) => Promise<void>;
}) {
  const [value, setValue] = React.useState(currentId);

  React.useEffect(() => setValue(currentId), [currentId]);

  /**
   * 選択した期間を Server Action へ直接渡す。
   *
   * 以前は hidden input へ state を書いてから `requestSubmit()` していたが、
   * React の state 反映が DOM へ commit される前に submit が走るため、
   * **1 つ前の期間 ID が送信される**競合があった（＝期間を切り替えても変わらない）。
   * FormData を明示的に組み立てれば、この競合は原理的に起きない。
   */
  const onValueChange = (next: string) => {
    setValue(next);
    const formData = new FormData();
    formData.set('periodId', next);
    React.startTransition(() => {
      void onSelectAction(formData);
    });
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <CalendarRange className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
      <span className="sr-only" id="t4d-period-label">
        報告期間
      </span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          aria-labelledby="t4d-period-label"
          className="h-6 w-[168px] border-transparent bg-transparent hover:border-line"
        >
          <SelectValue placeholder="報告期間" />
        </SelectTrigger>
        <SelectContent>
          {periods.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.code}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export interface EngagementChoice {
  id: string;
  code: string;
  name: string;
}

export function EngagementSelector({ engagements }: { engagements: EngagementChoice[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const currentId = pathname.match(/^\/assurance\/engagements\/([^/]+)/)?.[1] ?? null;

  if (engagements.length === 0) return null;

  const onChange = (value: string) => {
    const rest = pathname.match(/^\/assurance\/engagements\/[^/]+\/(.*)$/)?.[1];
    router.push(`/assurance/engagements/${value}/${rest ?? 'overview'}`);
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <FolderKanban className="size-3.5 text-ink-muted" aria-hidden="true" />
      <span className="sr-only" id="t4d-engagement-label">
        案件
      </span>
      <Select value={currentId ?? undefined} onValueChange={onChange}>
        <SelectTrigger
          aria-labelledby="t4d-engagement-label"
          className="h-6 w-[300px] border-transparent bg-transparent hover:border-line"
        >
          <SelectValue placeholder="案件を選択" />
        </SelectTrigger>
        <SelectContent>
          {engagements.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.code} — {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function UserMenu({
  displayName,
  email,
  roleKeys,
  onLogoutAction,
}: {
  displayName: string;
  email: string;
  roleKeys: RoleKey[];
  onLogoutAction: () => Promise<void>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex items-center gap-1.5 rounded-t4d px-2 py-1 text-[13px] text-ink hover:bg-brand-50"
        aria-label={`ユーザーメニュー: ${displayName}`}
      >
        <User className="size-3.5 text-ink-muted" aria-hidden="true" />
        <span className="max-w-[140px] truncate">{displayName}</span>
        <ChevronDown className="size-3.5 text-ink-muted" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[240px]">
        <DropdownMenuLabel>ログイン中</DropdownMenuLabel>
        <div className="px-2 pb-1.5 text-[12px] text-ink-muted">
          <div className="truncate text-ink">{displayName}</div>
          <div className="truncate">{email}</div>
          <div className="mt-1 truncate">{roleKeys.map(roleLabel).join(' / ')}</div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/profile">プロフィール</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="/workspace">ワークスペース選択へ</a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/*
          Menu 項目を選ぶと Radix が Menu を閉じ、中の form が unmount される。
          submit は React が非同期に処理するため、その時点で form が消えていると
          **Server Action が実行されない**（＝ログアウトを押しても何も起きない）。
          form を使わず、選択時に Server Action を直接呼ぶ。
        */}
        <DropdownMenuItem
          className="text-danger"
          onSelect={(event) => {
            event.preventDefault();
            React.startTransition(() => {
              void onLogoutAction();
            });
          }}
        >
          <LogOut className="size-3.5" aria-hidden="true" />
          ログアウト
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
