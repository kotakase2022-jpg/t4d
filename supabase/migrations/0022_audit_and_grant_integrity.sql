-- 追記専用テーブルへ「他テナントの名義で書けてしまう」経路を塞ぐ。
--
-- 0021 は案件配下の assurance_firm_id を親の案件に固定した。
-- ここでは残りの 2 つを閉じる。
--   1. audit_events    … actor_organization_id / engagement_id が検証されていなかった
--   2. client_access_grants … client_organization_id が案件のクライアントと一致していなかった
--   3. storage_access_events … organization_id が検証されていなかった
--
-- いずれも「読める」わけではないが、他テナントの証跡へ偽の行を混ぜられると
-- 監査証跡としての価値が失われる（追記専用なので後から消せない）。

-- ----------------------------------------------------------------------
-- 1. 監査ログ: 自分が所属する組織・自分が参加している案件の名義でしか書けない
--
-- アプリは Service Role で書くため（src/lib/audit/logger.ts）、
-- この制限は「利用者の JWT で PostgREST を直接叩く経路」だけに効く。
drop policy if exists audit_events_insert on audit_events;
create policy audit_events_insert on audit_events for insert to authenticated
  with check (
    (actor_user_id is null or actor_user_id = auth.uid())
    and (actor_organization_id is null or t4d.is_org_member(actor_organization_id))
    and (engagement_id is null or t4d.is_engagement_member(engagement_id))
  );

-- ----------------------------------------------------------------------
-- 2. Evidence アクセス証跡: 本人名義かつ、自組織か「案件を通じて読める相手」の分だけ
drop policy if exists storage_access_events_insert on storage_access_events;
create policy storage_access_events_insert on storage_access_events for insert to authenticated
  with check (
    actor_user_id = auth.uid()
    and (
      t4d.is_org_member(organization_id)
      -- 監査法人は許諾されたクライアントの Evidence を読む。その証跡も残す必要がある。
      or exists (
        select 1
        from engagements e
        join engagement_members em
          on em.engagement_id = e.id
         and em.user_id = auth.uid()
         and em.removed_at is null
        where e.client_organization_id = storage_access_events.organization_id
      )
    )
  );

-- ----------------------------------------------------------------------
-- 3. 許諾: 案件のクライアントと、許諾行の client_organization_id を一致させる
alter table engagements
  add constraint engagements_id_client_unique unique (id, client_organization_id);

alter table client_access_grants
  add constraint client_access_grants_client_matches
  foreign key (engagement_id, client_organization_id)
  references engagements (id, client_organization_id) on delete cascade;

alter table data_room_items
  add constraint data_room_items_client_matches
  foreign key (engagement_id, client_organization_id)
  references engagements (id, client_organization_id) on delete cascade;

alter table pbc_request_responses
  add constraint pbc_request_responses_client_matches
  foreign key (engagement_id, client_organization_id)
  references engagements (id, client_organization_id) on delete cascade;

alter table management_responses
  add constraint management_responses_client_matches
  foreign key (engagement_id, client_organization_id)
  references engagements (id, client_organization_id) on delete cascade;
