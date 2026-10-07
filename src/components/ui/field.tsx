import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 入力欄の 1 項目（plan §1.13・§3.2 Field）。ラベル・「必須」／「任意」の文字・説明・項目のエラーを出す。
 *
 * - 必須か任意かを文字で示す（色や * だけにしない）。required 属性と「必須」の表示は必ず一致させる
 *   （render-prop で子に required を渡すので、ずれない）
 * - 説明とエラーは aria-describedby で入力欄に結び付け、エラーのときは aria-invalid を付ける
 */
export interface FieldControlProps {
  id: string;
  required?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

export interface FieldProps {
  label: string;
  /** 入力欄の id（省略時は name から作る。同じ画面で重ならないようにする） */
  id?: string;
  name?: string;
  required?: boolean;
  /** 説明（1 行） */
  hint?: React.ReactNode;
  /** 項目のエラー */
  error?: string | null;
  className?: string;
  children: (control: FieldControlProps) => React.ReactNode;
}

export function RequirementTag({ required }: { required: boolean }) {
  return (
    <span
      className={cn(
        'rounded-t4d px-1 text-caption font-normal',
        required ? 'bg-danger-soft text-danger' : 'bg-surface-muted text-ink-muted',
      )}
      data-requirement={required ? 'required' : 'optional'}
    >
      {required ? '必須' : '任意'}
    </span>
  );
}

export function Field({
  label,
  id,
  name,
  required = false,
  hint,
  error,
  className,
  children,
}: FieldProps) {
  const controlId = id ?? `field-${(name ?? label).replace(/[^\w-]/g, '_')}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('space-y-1', className)} data-field="">
      <label
        htmlFor={controlId}
        className="flex items-center gap-1.5 text-small font-medium text-ink"
      >
        {label}
        <RequirementTag required={required} />
      </label>
      {children({
        id: controlId,
        required: required || undefined,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {hint && (
        <p id={hintId} className="text-caption text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
