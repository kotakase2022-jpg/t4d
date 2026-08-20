# Storage 設計

指示書 12 章に対応。

## 1. Bucket

| Bucket                         | public | 用途                                                                              |
| ------------------------------ | ------ | --------------------------------------------------------------------------------- |
| `brand-public`                 | true   | ブランド素材（実際はロゴを `public/brand/` の Static Asset で配信しており未使用） |
| `enterprise-originals-private` | false  | 取込した原本ファイル                                                              |
| `evidence-private`             | false  | Evidence                                                                          |
| `assurance-workpapers-private` | false  | 監査法人の調書添付                                                                |
| `exports-private`              | false  | 生成した Export                                                                   |

**Evidence Bucket を public にしない**ことを `pnpm check:rls` が静的に検査します。

ロゴは `public/brand/t4d-logo.png` に実体を置き、`next/image` で配信しています。
Google Drive 等の外部 URL は参照していません。

## 2. Object Path

```
enterprise/{organization_id}/originals/{reporting_period_id}/{uuid}/data.{ext}
enterprise/{organization_id}/evidence/{uuid}/data.{ext}
assurance/{assurance_firm_id}/engagements/{engagement_id}/workpapers/{uuid}/data.{ext}
exports/{organization_id_or_firm_id}/{uuid}/data.{ext}
```

- **Original Name と Storage Key を分離**します。Key にファイル名を含めず UUID ベースにするため、
  ファイル名由来の Path Traversal が原理的に起きません。
- Storage 側ポリシーは Path の 2 番目のセグメント（所有組織 ID）と所属組織の一致を要求します。
- `file_versions.storage_key` にも CHECK 制約を課しています
  （`..` を含まない / `/` 始まりでない / `enterprise|assurance|exports` で始まる）。

## 3. アップロード検証

`validateUpload()`（`src/lib/imports/parsers.ts`）:

| 検証       | 内容                                                                |
| ---------- | ------------------------------------------------------------------- |
| ファイル名 | ディレクトリ成分を除去し、危険文字を `_` へ置換、200 文字で切り詰め |
| 拡張子     | `.csv` `.tsv` `.xlsx` `.xlsm` `.pdf` のみ                           |
| MIME       | CSV / Excel / PDF / `application/octet-stream` のみ                 |
| サイズ     | 25MB 以下、0 バイト不可                                             |

`tests/unit/parsers-and-schema.test.ts` が `../../etc/passwd.csv` や
`C:\Users\secret\data.csv` を無害化することを検証しています。

## 4. Version 管理

置換ではなく**新しい Version を追加**します。`file_versions` は追記専用
（UPDATE ポリシーなし ＋ `forbid_mutation` トリガ）。
各 Version は `sha256` と `size_bytes` を保持します。

## 5. Signed URL

```
createEvidenceSignedUrl(db, ctx, fileVersionId)
  1. db.findById('fileVersions', id)        ← ここで RLS / アプリ層の認可が効く
     取得できなければ null（= 404。存在を秘匿）
  2. files を引き、削除済みでないことを確認
  3. Storage Adapter が Signed URL を発行（既定 120 秒）
  4. storage_access_events へ signed_url_created を記録
  5. audit_events へ signed_url_created を記録
```

**発行前に必ず DB を引く**ことで、URL 直打ちや ID 推測による取得を防ぎます。
権限外のユーザーは手順 1 で 0 行になり、URL が発行されません
（RLS テスト「9. Evidence は権限外では取得できない」）。

Demo Mode では `/api/files/download` が Signed URL の代替として動作し、
そこでも Storage Key から DB を引き直して再検証します。

## 6. ウイルススキャン

`VirusScanner` インターフェースを用意し、`storeNewFile()` から呼びます。
Phase 1 は `noopVirusScanner`（`skipped` を返す）で、`files.scan_status` に記録します。
実スキャナを差し込む場合はこのインターフェースを実装するだけです。
`infected` が返ると保存を中止します。

## 7. Git への非混入

`.gitignore` で `/local-evidence/`・`/tmp/`・`*.uploaded` を除外しています。
Fixture のファイルはメタデータのみで、実バイナリを持ちません
（Demo Mode で Fixture 由来のファイルを開くと 410 と説明メッセージを返します）。
