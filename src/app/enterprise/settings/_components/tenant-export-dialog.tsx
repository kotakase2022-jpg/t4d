'use client';

import * as React from 'react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

/**
 * 全データの返却書き出し（トライアル対応 NF-29）の確認。書き出しはファイルの取得（GET）で、
 * Server Action ではないため、ダイアログの確定ボタンが画面の GET のフォームを送る。
 * 送ったらダイアログを閉じる（ダウンロードはそのまま続く。画面は移らない）。
 *
 * 範囲（表 n・行 n・資料 n）はサーバーが数えた値を受け取って出す（plan §1.16 区分 2）。
 */
const FORM_ID = 'tenant-export-form';

export function TenantExportDialog({
  plan,
  defaultOpen = false,
}: {
  plan: { tables: number; rows: number; files: number };
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <>
      <form
        id={FORM_ID}
        method="get"
        action="/api/exports/tenant"
        hidden
        onSubmit={() => {
          // 送信（ダウンロードの開始）を止めずに、次の描画でダイアログを閉じる
          window.setTimeout(() => setOpen(false), 0);
        }}
      />
      <ConfirmDialog
        tier="bulk"
        destructive={false}
        title="全データを書き出しますか（返却用）"
        scope={`この組織の表 ${plan.tables}・行 ${plan.rows.toLocaleString('ja-JP')}・資料 ${plan.files.toLocaleString('ja-JP')} 件`}
        consequences={[
          '自社のデータを表ごとの CSV と manifest.json（行数・sha256）にまとめた ZIP を作ります。監査法人の調書・案件の記録・共通のマスターは含みません。',
          '資料の実体は別の ZIP です（下で選びます）。書き出しは監査ログに記録します。データは削除しません。',
        ]}
        extraFields={
          <fieldset className="space-y-1">
            <legend className="font-medium">書き出す内容</legend>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="part"
                value="data"
                form={FORM_ID}
                defaultChecked
                className="size-3.5 accent-brand-700"
              />
              データ（表の CSV・manifest.json・README）
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="part"
                value="files"
                form={FORM_ID}
                className="size-3.5 accent-brand-700"
              />
              資料の実体（アップロードした資料のファイル）
            </label>
          </fieldset>
        }
        confirmLabel="書き出す"
        formId={FORM_ID}
        open={open}
        onOpenChange={setOpen}
        trigger={{ label: '全データを書き出す（返却用）…', size: 'sm', variant: 'secondary' }}
      />
    </>
  );
}
