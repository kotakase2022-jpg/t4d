-- 「行が自己申告した組織」で判定していた残り 2 か所を、親から導く形へ直す。
--
-- 0021 / 0022 で案件配下の assurance_firm_id / client_organization_id は
-- 複合外部キーで親に固定した。ここでは判定式そのものを直す。

-- ----------------------------------------------------------------------
-- 1. 許諾の付与: 案件のクライアントであることを親から確かめる
--
-- 従来は行の client_organization_id に対する権限だけを見ていた。
-- 0022 の複合外部キーで組み合わせは固定されたが、判定式が行の列を見ている限り
-- 「なぜ安全か」が外部キー任せになる。判定の根拠を親の案件へ移す。
drop policy if exists client_access_grants_insert on client_access_grants;
create policy client_access_grants_insert on client_access_grants for insert to authenticated
  with check (
    granted_by = auth.uid()
    and exists (
      select 1
      from engagements e
      where e.id = client_access_grants.engagement_id
        and e.client_organization_id = client_access_grants.client_organization_id
        and t4d.has_permission(e.client_organization_id, 'enterprise.grant.manage')
    )
  );

drop policy if exists client_access_grants_update on client_access_grants;
create policy client_access_grants_update on client_access_grants for update to authenticated
  using (
    exists (
      select 1
      from engagements e
      where e.id = client_access_grants.engagement_id
        and t4d.has_permission(e.client_organization_id, 'enterprise.grant.manage')
    )
  )
  with check (
    exists (
      select 1
      from engagements e
      where e.id = client_access_grants.engagement_id
        and t4d.has_permission(e.client_organization_id, 'enterprise.grant.manage')
    )
  );

-- ----------------------------------------------------------------------
-- 2. AI 出力の採否: 生成と同じ権限を要求する
--
-- 採否は「誰がいつ AI 下書きを採用しなかったか」という監査証跡になる。
-- 従来は「組織のメンバーなら誰でも」更新できたため、閲覧しかできないロールでも
-- 証跡を確定できた（CLAUDE.md §6 の「人の操作で確定する」の "人" が未定義だった）。
drop policy if exists ai_runs_update on ai_runs;
create policy ai_runs_update on ai_runs for update to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.ai.run')
    or t4d.has_permission(organization_id, 'assurance.ai.run')
  )
  with check (
    t4d.has_permission(organization_id, 'enterprise.ai.run')
    or t4d.has_permission(organization_id, 'assurance.ai.run')
  );
