# テナントの終了（返却と削除）の手順書

トライアルの終了・契約の終了のときに、合意した扱い（継続移行／返却／削除）に従って行う。
削除は**取り消せない**。返却の受け取りの確認と、保証側の記録の扱いの合意が済むまで行わない。

## 1. 返却（企業の管理者が行う）

1. 企業の管理者が、設定の「データの取扱い」→ 見出しの「その他」→「全データを書き出す（返却用）」で書き出す。
   - 「データ」: 表ごとの CSV（UTF-8 BOM）＋ `manifest.json`（表・行数・sha256・生成者・アプリの版）＋ `README.md`
   - 「資料の実体」: アップロードした資料のファイル（実体の無い資料は manifest の `missingFiles`）
   - 監査法人の調書・案件の記録・全テナント共通のマスター・利用者ごとの通知は含まない（理由は manifest の `excluded`）
2. 受け取った側が各ファイルの sha256 を計算し、manifest の値と一致することを確かめる（README に方法）。
3. 受け取りの確認（日時・確認者・manifest の sha256）を運営の作業記録に残す。

## 2. 削除の前の確認（運営）

- 保証側の案件が残っていないこと。残っている場合は、保証人と合意した扱い（保証側の記録の保存期間など）に従う。
  削除の関数は案件が残っていると止まる。
- 監査ログ・アクセスの記録の扱い（既定は残す。判断事項 D17）が合意どおりか。
- 事前確認のスクリプトで、表ごとの件数を確かめる（**何も削除しない**）:

```bash
pnpm exec tsx scripts/offboard-tenant.ts --org-code <組織コード> \
  --manifest-sha256 <返却 manifest の sha256> --executed-by "<実行者の表示名>" --confirm-project <ref>
```

## 3. 削除（運営・DB の所有者のロール）

事前確認のスクリプトが表示した SQL を、DB の所有者のロールで実行する（Supabase の SQL エディタなど）。

- `t4d.offboard_organization(org_id, confirm_code, manifest_sha256, executed_by_label)` は所有者だけが実行できる
  （0058。`authenticated`・`anon`・`service_role` から EXECUTE を剥奪）。
- 確認コード（組織コード）が一致しないと止まる。企業テナントだけが対象。
- 関数の中でだけ、追記専用の表（監査の記録など）の削除を許す。利用者が同じ設定を立てても越えられない。
- 組織の行は削除日時を入れて残し、`tenant_lifecycle_records` に削除の記録（組織コードのハッシュ・表ごとの件数・
  返却 manifest の sha256・実行者・日時。顧客の内容は持たない）を 1 件残す。
- `storage_access_events`（資料へのアクセスの記録）は監査の記録として残す。

## 4. 削除の後（運営）

1. Storage の実体を消す: `evidence-private`・`enterprise-originals-private`・`exports-private`・`tenant-exports-private` の
   `<…>/<組織 ID>/…` のパス（バケットごとのパスの形は `docs/storage-model.md`）。
2. その組織にしか属していない Auth ユーザーを消す（他の組織にも属する人は消さない）。
3. 削除の記録の ID・実行日時・件数を運営の作業記録に残し、顧客へ完了を報告する。

## 5. ロールバック

削除は取り消せない。誤りに気付いたら、返却した書き出し（manifest で整合を確かめたもの）から別のプロジェクトへ戻す
（`docs/operations/backup-restore.md` の復旧手順）。関数そのものの戻し方は `docs/known-limitations.md` §6。
