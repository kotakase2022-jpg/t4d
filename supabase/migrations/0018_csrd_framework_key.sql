-- 0018: 開示フレームワークに CSRD を追加（機能追加要望 ②）
--
-- disclosure_frameworks.key の check 制約は 0007 で ('cdp','ssbj','msci','ftse') に
-- 固定されていた。CSRD / ESRS ワークスペースの追加に伴い 'csrd' を許可する。
-- 既存ファイルは書き換えず、制約の付け替えだけを行う（破壊的変更なし）。

alter table disclosure_frameworks
  drop constraint disclosure_frameworks_key_check;

alter table disclosure_frameworks
  add constraint disclosure_frameworks_key_check
    check (key in ('cdp', 'ssbj', 'csrd', 'msci', 'ftse'));
