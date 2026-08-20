-- ======================================================================
-- 0015 Storage（指示書 12 章）
-- ----------------------------------------------------------------------
-- Evidence は Private Bucket + 短時間 Signed URL。Public Bucket は brand-public のみ。
-- Object Path と DB Grant の両方で制御する（指示書 11-13）。
--
-- storage スキーマは Supabase 固有のため、存在しない環境（PGlite での RLS テスト等）
-- では安全にスキップする。
-- ======================================================================

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'T4D: storage スキーマが存在しないため Storage ポリシーをスキップしました。';
    return;
  end if;

  -- ------------------------------------------------------------------
  -- Bucket
  -- ------------------------------------------------------------------
  insert into storage.buckets (id, name, public)
  values
    ('brand-public', 'brand-public', true),
    ('enterprise-originals-private', 'enterprise-originals-private', false),
    ('evidence-private', 'evidence-private', false),
    ('assurance-workpapers-private', 'assurance-workpapers-private', false),
    ('exports-private', 'exports-private', false)
  on conflict (id) do update set public = excluded.public;

  -- ------------------------------------------------------------------
  -- Object Path 規約
  --   enterprise/{organization_id}/originals/{reporting_period_id}/{uuid}/{filename}
  --   enterprise/{organization_id}/evidence/{uuid}/{filename}
  --   assurance/{assurance_firm_id}/engagements/{engagement_id}/workpapers/{uuid}/{filename}
  --   exports/{organization_id_or_firm_id}/{uuid}/{filename}
  --
  -- 2 番目のパスセグメント（= 所有組織 ID）が、ユーザーの所属組織と一致することを要求する。
  -- さらに DB 側（file_versions.storage_key）にも同じ制約を課し、二重で検証する。
  -- ------------------------------------------------------------------

  execute $pol$
    create policy "t4d_brand_public_read" on storage.objects
      for select to public
      using (bucket_id = 'brand-public');
  $pol$;

  execute $pol$
    create policy "t4d_private_read_own_org" on storage.objects
      for select to authenticated
      using (
        bucket_id in (
          'enterprise-originals-private',
          'evidence-private',
          'assurance-workpapers-private',
          'exports-private'
        )
        and array_length(string_to_array(name, '/'), 1) >= 3
        and t4d.is_org_member((string_to_array(name, '/'))[2]::uuid)
      );
  $pol$;

  execute $pol$
    create policy "t4d_private_write_own_org" on storage.objects
      for insert to authenticated
      with check (
        bucket_id in (
          'enterprise-originals-private',
          'evidence-private',
          'assurance-workpapers-private',
          'exports-private'
        )
        and array_length(string_to_array(name, '/'), 1) >= 3
        and t4d.is_org_member((string_to_array(name, '/'))[2]::uuid)
        -- ファイル名の Path Traversal を禁止
        and name !~ '\.\.'
        and name !~ '^/'
      );
  $pol$;

  execute $pol$
    create policy "t4d_private_update_own_org" on storage.objects
      for update to authenticated
      using (
        bucket_id in (
          'enterprise-originals-private',
          'evidence-private',
          'assurance-workpapers-private',
          'exports-private'
        )
        and t4d.is_org_member((string_to_array(name, '/'))[2]::uuid)
      )
      with check (
        t4d.is_org_member((string_to_array(name, '/'))[2]::uuid)
        and name !~ '\.\.'
      );
  $pol$;

  raise notice 'T4D: Storage バケットとポリシーを設定しました。';
end
$$;

-- ----------------------------------------------------------------------
-- Storage Key の形式検証（Path Traversal 防止を DB 側でも担保）
-- ----------------------------------------------------------------------

alter table file_versions
  add constraint file_versions_storage_key_safe
  check (
    storage_key !~ '\.\.'
    and storage_key !~ '^/'
    and storage_key ~ '^(enterprise|assurance|exports)/'
  );
