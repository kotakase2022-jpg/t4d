-- ======================================================================
-- 0016 storage.buckets の読み取りポリシー
-- ----------------------------------------------------------------------
-- 0015 でバケットを作成したが、`storage.buckets` に SELECT ポリシーが無いため
-- 認証済みユーザーがバケット一覧（メタデータ）を取得できなかった。
--
-- バケット名と public フラグは秘匿情報ではなく、これを読めても
-- オブジェクトへのアクセス権は増えない（アクセス制御は storage.objects 側のポリシー）。
-- 運用時に「Evidence バケットが Private であること」をクライアントから
-- 確認できるようにするため、読み取りのみ許可する。
--
-- 既存 migration は書き換えず、新しい番号で追記する（AGENTS.md 4 節）。
-- ======================================================================

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'T4D: storage スキーマが存在しないためスキップしました。';
    return;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'buckets' and policyname = 't4d_buckets_read'
  ) then
    return;
  end if;

  execute $pol$
    create policy "t4d_buckets_read" on storage.buckets
      for select to authenticated
      using (true);
  $pol$;

  raise notice 'T4D: storage.buckets の読み取りポリシーを追加しました。';
end
$$;
