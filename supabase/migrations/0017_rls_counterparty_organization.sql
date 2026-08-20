-- ======================================================================
-- 0017 保証契約の相手方組織を参照できるようにする
-- ----------------------------------------------------------------------
-- 0012 の `organizations_select` は自組織のみを許可していた。
-- しかし保証契約は 2 つのテナントをまたぐため、
--   ・監査法人は、アサインされた案件の「クライアント企業名」を表示する必要がある
--   ・企業は、自社が結んだ保証契約の「監査法人名」を表示する必要がある
-- が満たせず、案件ホーム／設定画面で相手方名が空になっていた
-- （実 Supabase に対する E2E で検出）。
--
-- 開示するのは organizations 行のメタデータ（名称・コード・国）のみで、
-- 相手方テナントの業務データへのアクセスは一切増えない。
-- 接続の根拠は engagements（＋ engagement_members）に限定する。
-- ======================================================================

-- 監査法人 → アサイン済み案件のクライアント企業
create policy organizations_select_engagement_client on organizations
  for select to authenticated
  using (
    exists (
      select 1
      from engagements e
      join engagement_members em
        on em.engagement_id = e.id
       and em.user_id = auth.uid()
       and em.removed_at is null
      where e.client_organization_id = organizations.id
    )
  );

-- 企業 → 自社がクライアントである案件の監査法人
create policy organizations_select_engagement_firm on organizations
  for select to authenticated
  using (
    exists (
      select 1
      from engagements e
      where e.assurance_firm_id = organizations.id
        and t4d.is_org_member(e.client_organization_id)
    )
  );

comment on policy organizations_select_engagement_client on organizations is
  '保証契約でつながった相手方（クライアント企業）の組織メタデータのみを開示する。';
comment on policy organizations_select_engagement_firm on organizations is
  '保証契約でつながった相手方（監査法人）の組織メタデータのみを開示する。';
