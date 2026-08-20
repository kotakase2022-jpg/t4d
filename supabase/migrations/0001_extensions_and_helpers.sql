-- ======================================================================
-- 0001 スキーマ・共通トリガ関数
-- ----------------------------------------------------------------------
-- 本ファイル群は Supabase 環境（auth スキーマ / authenticated ロールが存在）を前提とする。
-- ローカル RLS テスト（PGlite）では tests/rls/harness.ts が同等のシムを先に作る。
--
-- 認可ヘルパー関数は参照するテーブルが揃ってから作る必要があるため
-- 0011_authorization_functions.sql に置く。
-- ======================================================================

create schema if not exists t4d;
comment on schema t4d is 'T4D の認可ヘルパー関数。RLS ポリシーから参照する。';

-- ----------------------------------------------------------------------
-- 共通トリガ関数
-- ----------------------------------------------------------------------

create or replace function t4d.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Snapshot / Snapshot Item / Audit Event / Sign-off は追記専用。
-- RLS で UPDATE/DELETE ポリシーを作らないことに加え、トリガでも二重に禁止する。
-- （Service Role は RLS をバイパスするため、トリガ側の防御が実効的な最後の砦になる）
create or replace function t4d.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'T4D_IMMUTABLE: % は追記専用です（% は許可されていません）',
    tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

-- 代理 Sign-off の禁止。user_id は必ず実行者本人でなければならない。
create or replace function t4d.enforce_self_signoff()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'T4D_PROXY_SIGNOFF_FORBIDDEN: 代理 Sign-off は禁止されています'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
