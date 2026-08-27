-- ----------------------------------------------------------------------
-- 取込行に「取り込み対象外」の状態を足す
--
-- 実際の社内ファイルには、非財務データと無関係な行がいくらでも混ざる。
-- 社員名簿、勘定科目、部門一覧、住所録、改版履歴。これらに 1 行ずつ
-- 「指標を特定できませんでした」と警告を出していたため、本当に確認が要る行
-- （指標に近いのに特定できなかった行）が警告の山に埋もれていた。
--
-- 指標マスターと語彙がまったく重ならない行は警告を出さずに外す。
-- 外したこと自体は記録が要るので、needs_review でも rejected でもない
-- 独立した状態として残す。
--   - needs_review … 人が見て直せば取り込める行
--   - rejected     … 人が見たうえで取り込まないと決めた行
--   - ignored      … 機械が「指標と無関係」と判断して最初から対象外にした行
-- 監査法人へ「なぜこの行を取り込まなかったか」を再現して説明できるようにするため、
-- 行そのものは消さずに残す。
--
-- 既存行の状態は変わらない非破壊の制約差し替え。
-- ロールバックは制約を元へ戻すだけでよい（docs/known-limitations.md）。
-- RLS は ingestion_rows の既存ポリシーがそのまま適用される。
-- ----------------------------------------------------------------------

alter table ingestion_rows
  drop constraint ingestion_rows_status_check;

alter table ingestion_rows
  add constraint ingestion_rows_status_check
  check (
    status in ('pending', 'mapped', 'needs_review', 'duplicate', 'rejected', 'confirmed', 'ignored')
  );

comment on column ingestion_rows.status is
  '取込行の状態。ignored は指標マスターと無関係と判断して自動で対象外にした行（警告は出さない）。';
