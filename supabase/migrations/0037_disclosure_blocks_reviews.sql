-- ----------------------------------------------------------------------
-- 開示本文（節）とレビュー・承認（docs/disclosure-first.md §3 0037）
--
-- 既存の SSBJ 開示ドラフト（0030）は節ごとに 1 行の可変な本文で、
--   - 作り直すと人の修正が消える
--   - どの版を誰が確認・承認したかが残らない
--   - 作成者が自分で確定できる（職務分離が無い）
-- という問題があった。本文を版（追記専用）として持ち、レビュー依頼は
-- 「どの版を」「どの規則で」見るのかを依頼時点で固定する。
--
--   disclosure_blocks         … 節（状態と版へのポインタ・自動保存中の作業本文）
--   disclosure_block_versions … 本文の版（追記専用。本文は BlockBody AST）
--   review_requests           … レビュー依頼（依頼時点の規則・参照版の写しを持つ）
--   review_events             … 依頼・差戻し・レビュー完了・承認・取下げ（追記専用）
--   review_comments           … 版・段落に紐付くコメント（解決の記録のみ更新できる）
--   recheck_decisions         … 引用した数値・定性情報が更新されたときの判断（追記専用）
--
-- 職務分離（§2）は DB でも強制する（review_events のトリガ）。
-- アプリ層（src/lib/domain/disclosure-status.ts）と同じ規則で、片方だけに頼らない。
--   レビュー完了 … 依頼者でも対象版の作成者でもない
--   最終承認     … 依頼者でも対象版の作成者でも、同じ依頼のレビュー完了者でもない
--   差戻し       … 理由と対象段落が必須
--
-- テナント整合: 子の organization_id は親と一致させる（0035 と同じ複合外部キー方式）。
-- 加えて、版・依頼・コメントが指す版は「同じ節の版」に限る（(版 ID, 節 ID) の複合外部キー）。
-- ----------------------------------------------------------------------

create table disclosure_blocks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id uuid not null,
  framework_version_id uuid not null,
  section_key text not null check (btrim(section_key) <> ''),
  title text not null,
  sort_order integer not null default 0,
  language text not null default 'ja' check (language in ('ja', 'en')),
  translation_of_block_id uuid,
  requirement_item_ids uuid[] not null default '{}',
  owner_user_id uuid references profiles (id),
  due_date date,
  status text not null default 'draft'
    check (status in ('draft', 'review_requested', 'returned', 'approval_pending', 'approved')),
  current_version_id uuid,
  /** レビュー依頼で固定した版 */
  submitted_version_id uuid,
  /** 承認された版。承認後に修正しても、承認済みの版はここに残る */
  approved_version_id uuid,
  /** 自動保存中の作業本文。業務上の版ではない（レビュー・承認・出力の対象にしない） */
  working_body jsonb check (working_body is null or jsonb_typeof(working_body) = 'object'),
  working_base_version_id uuid,
  working_saved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,

  constraint disclosure_blocks_approved_requires_version
    check (status <> 'approved' or approved_version_id is not null),
  constraint disclosure_blocks_in_review_requires_submitted
    check (status not in ('review_requested', 'approval_pending') or submitted_version_id is not null),
  constraint disclosure_blocks_translation_not_self
    check (translation_of_block_id is null or translation_of_block_id <> id),
  constraint disclosure_blocks_project_matches
    foreign key (project_id, organization_id)
    references disclosure_projects (id, organization_id) on delete cascade,
  -- 節の基準の版は、プロジェクトが扱うと決めた版に限る
  constraint disclosure_blocks_framework_in_project
    foreign key (project_id, framework_version_id)
    references project_frameworks (project_id, framework_version_id),
  constraint disclosure_blocks_id_org_unique unique (id, organization_id),
  constraint disclosure_blocks_id_project_unique unique (id, project_id)
);

create index disclosure_blocks_project_idx on disclosure_blocks (project_id, sort_order);

comment on table disclosure_blocks is
  '開示本文の節。本文そのものは disclosure_block_versions に版として追記する。';

-- 翻訳元の節は同じプロジェクトの節に限る
alter table disclosure_blocks
  add constraint disclosure_blocks_translation_matches
    foreign key (translation_of_block_id, project_id)
    references disclosure_blocks (id, project_id);

create table disclosure_block_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  block_id uuid not null,
  version_no integer not null check (version_no > 0),
  /** 編集を始めた時点の版（競合検出に使う） */
  base_version_id uuid,
  /** 本文 AST（src/types/domain.ts の BlockBody） */
  body jsonb not null
    check (jsonb_typeof(body) = 'object' and jsonb_typeof(body -> 'paragraphs') = 'array'),
  plain_text text not null default '',
  /** 引用した data_point_versions.id */
  metric_refs uuid[] not null default '{}',
  /** 引用した narrative_versions.id */
  narrative_refs uuid[] not null default '{}',
  /** 出典印の source_anchors.id */
  anchor_refs uuid[] not null default '{}',
  change_reason text,
  /** human_adopted_ai は「AI の候補を人が段落単位で採用して保存した版」。AI が版を作ることはない */
  origin text not null default 'human' check (origin in ('human', 'human_adopted_ai')),
  originated_from_ai_run_id uuid,
  content_hash text not null,
  created_at timestamptz not null default now(),
  /** 版は必ず人が保存する（AI は確定しない） */
  created_by uuid not null references profiles (id),

  constraint disclosure_block_versions_ai_origin
    check (origin = 'human_adopted_ai' or originated_from_ai_run_id is null),
  constraint disclosure_block_versions_block_matches
    foreign key (block_id, organization_id)
    references disclosure_blocks (id, organization_id) on delete cascade,
  constraint disclosure_block_versions_ai_run_matches
    foreign key (originated_from_ai_run_id, organization_id)
    references ai_runs (id, organization_id),
  constraint disclosure_block_versions_unique unique (block_id, version_no),
  constraint disclosure_block_versions_id_block_unique unique (id, block_id),
  constraint disclosure_block_versions_id_org_unique unique (id, organization_id)
);

create index disclosure_block_versions_block_idx
  on disclosure_block_versions (block_id, version_no desc);

comment on table disclosure_block_versions is
  '開示本文の版（追記専用）。承認済みの版は書き換えず、修正は新しい版として追記する。';

-- 元にした版は同じ節の版に限る
alter table disclosure_block_versions
  add constraint disclosure_block_versions_base_matches
    foreign key (base_version_id, block_id)
    references disclosure_block_versions (id, block_id);

-- 節のポインタは「自分の」版しか指せない。版を追記してから指し直すため遅延可能にする
alter table disclosure_blocks
  add constraint disclosure_blocks_current_version_fk
    foreign key (current_version_id, id)
    references disclosure_block_versions (id, block_id)
    deferrable initially deferred,
  add constraint disclosure_blocks_submitted_version_fk
    foreign key (submitted_version_id, id)
    references disclosure_block_versions (id, block_id)
    deferrable initially deferred,
  add constraint disclosure_blocks_approved_version_fk
    foreign key (approved_version_id, id)
    references disclosure_block_versions (id, block_id)
    deferrable initially deferred,
  add constraint disclosure_blocks_working_base_version_fk
    foreign key (working_base_version_id, id)
    references disclosure_block_versions (id, block_id)
    deferrable initially deferred;

-- ----------------------------------------------------------------------
-- レビュー依頼
-- ----------------------------------------------------------------------

create table review_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id uuid not null,
  target_type text not null default 'disclosure_block' check (target_type in ('disclosure_block')),
  target_id uuid not null,
  /** 依頼で固定した版。以後の判断はすべてこの版に対して行う */
  target_version_id uuid not null,
  requested_by uuid not null references profiles (id),
  reviewer_user_id uuid references profiles (id),
  approver_user_id uuid references profiles (id),
  /** 依頼時点の規則の版（例: sod-3role-v1） */
  policy_version text not null check (btrim(policy_version) <> ''),
  /** 依頼時点の規則の写し（後から規則を変えても、この依頼の判断基準は変わらない） */
  policy jsonb not null check (jsonb_typeof(policy) = 'object'),
  /** 依頼時点の適用判断の版（project_framework_decisions.id） */
  decision_ids uuid[] not null default '{}',
  /** 依頼時点の数値・定性情報・引用位置の参照 */
  referenced_versions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(referenced_versions) = 'object'),
  status text not null default 'open'
    check (status in ('open', 'returned', 'reviewed', 'approved', 'withdrawn')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  -- 指名の時点で職務分離を満たさない組み合わせは作らせない（判断時にも再検査する）
  constraint review_requests_reviewer_not_requester
    check (reviewer_user_id is null or reviewer_user_id <> requested_by),
  constraint review_requests_approver_distinct
    check (
      approver_user_id is null
      or (approver_user_id <> requested_by and approver_user_id is distinct from reviewer_user_id)
    ),
  constraint review_requests_project_matches
    foreign key (project_id, organization_id)
    references disclosure_projects (id, organization_id) on delete cascade,
  constraint review_requests_target_matches
    foreign key (target_id, project_id)
    references disclosure_blocks (id, project_id),
  constraint review_requests_target_version_matches
    foreign key (target_version_id, target_id)
    references disclosure_block_versions (id, block_id),
  constraint review_requests_id_org_unique unique (id, organization_id)
);

-- 同じ節に進行中の依頼は 1 件まで（二重依頼で判断が分岐しないように）
create unique index review_requests_one_active_per_target
  on review_requests (target_type, target_id)
  where status in ('open', 'reviewed');
create index review_requests_project_idx on review_requests (project_id, status);

comment on table review_requests is
  'レビュー依頼。対象の版・規則・参照版を依頼時点で固定する。差戻し後の再提出は新しい依頼になる。';

-- 依頼時点で固定した内容（対象の版・依頼者・規則の写し）は変更させない。
-- 変更できると、職務分離のトリガが見る依頼者や対象版を後からすり替えられてしまう。
create or replace function t4d.review_request_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.project_id is distinct from old.project_id
     or new.target_type is distinct from old.target_type
     or new.target_id is distinct from old.target_id
     or new.target_version_id is distinct from old.target_version_id
     or new.requested_by is distinct from old.requested_by
     or new.policy_version is distinct from old.policy_version
     or new.policy is distinct from old.policy
     or new.decision_ids is distinct from old.decision_ids
     or new.referenced_versions is distinct from old.referenced_versions
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'T4D_IMMUTABLE: レビュー依頼の依頼時点の内容（対象の版・依頼者・規則）は変更できません'
      using errcode = '42501';
  end if;

  -- 差戻し・承認・取下げで終わった依頼は再開しない（再提出は新しい依頼として作る）
  if old.status in ('returned', 'approved', 'withdrawn') and new.status is distinct from old.status then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 完了したレビュー依頼の状態は変更できません'
      using errcode = '42501';
  end if;

  if auth.uid() is not null
     and new.status is distinct from old.status
     and new.status = 'approved'
     and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.approve') then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 最終承認には承認権限が必要です'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger review_requests_guard
  before update on review_requests
  for each row execute function t4d.review_request_guard();

-- ----------------------------------------------------------------------
-- レビューの記録（追記専用）と職務分離
-- ----------------------------------------------------------------------

create table review_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  review_request_id uuid not null,
  event_type text not null
    check (event_type in ('requested', 'returned', 'review_completed', 'approved', 'withdrawn')),
  stage text not null check (stage in ('request', 'review', 'final')),
  actor_user_id uuid not null references profiles (id),
  target_version_id uuid not null,
  reason text,
  /** 差戻しの対象段落（BlockParagraph.id） */
  paragraph_id text,
  /** 依頼 ID＋段階＋対象版。二重押下で同じ判断を 2 回記録しない */
  idempotency_key text unique,
  created_at timestamptz not null default now(),

  -- 記録の種類と段階の組み合わせを固定する（例: 第 1 段で「最終承認」は記録できない）
  constraint review_events_stage_matches_type
    check (
      (event_type in ('requested', 'withdrawn') and stage = 'request')
      or (event_type = 'review_completed' and stage = 'review')
      or (event_type = 'approved' and stage = 'final')
      or (event_type = 'returned' and stage in ('review', 'final'))
    ),
  constraint review_events_request_matches
    foreign key (review_request_id, organization_id)
    references review_requests (id, organization_id) on delete cascade,
  constraint review_events_version_matches
    foreign key (target_version_id, organization_id)
    references disclosure_block_versions (id, organization_id)
);

create index review_events_request_idx on review_events (review_request_id, created_at);

comment on table review_events is
  'レビューの記録（追記専用）。職務分離と差戻しの必須項目はトリガ t4d.enforce_review_event で強制する。';

-- 職務分離（§2）。RLS は「その権限を持つか」までしか見られないため、
-- 「同じ人が依頼・作成・レビュー・承認を兼ねていないか」はトリガで判定する。
-- Service Role（RLS バイパス）の書き込みにも効かせるため、auth.uid() では分岐しない。
-- security definer にしているのは、判定に必要な依頼・版・過去の記録を
-- 呼び出し元の RLS に左右されずに読むため（読むだけで書かない）。
create or replace function t4d.enforce_review_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested_by uuid;
  v_request_version uuid;
  v_version_author uuid;
begin
  select r.requested_by, r.target_version_id
    into v_requested_by, v_request_version
    from review_requests r
   where r.id = new.review_request_id;
  if not found then
    raise exception 'T4D_REVIEW_REQUEST_NOT_FOUND: レビュー依頼が見つかりません'
      using errcode = '23503';
  end if;

  -- 判断は依頼で固定した版に対してだけ記録できる（別の版を名乗って作成者の判定をすり抜けさせない）
  if new.target_version_id is distinct from v_request_version then
    raise exception 'T4D_REVIEW_TARGET_MISMATCH: 依頼で固定した版以外への判断は記録できません'
      using errcode = '23514';
  end if;

  if new.event_type = 'returned'
     and (coalesce(btrim(new.reason), '') = '' or coalesce(btrim(new.paragraph_id), '') = '') then
    raise exception 'T4D_RETURN_REASON_REQUIRED: 差戻しには理由と対象段落が必要です'
      using errcode = '23514';
  end if;

  if new.event_type in ('review_completed', 'approved') then
    select v.created_by into v_version_author
      from disclosure_block_versions v
     where v.id = v_request_version;

    if new.actor_user_id = v_requested_by then
      raise exception 'T4D_SOD: 依頼者本人はレビュー完了・最終承認できません'
        using errcode = '42501';
    end if;
    if new.actor_user_id = v_version_author then
      raise exception 'T4D_SOD: 対象版の作成者はレビュー完了・最終承認できません'
        using errcode = '42501';
    end if;
  end if;

  if new.event_type = 'approved'
     and exists (
       select 1
         from review_events e
        where e.review_request_id = new.review_request_id
          and e.event_type = 'review_completed'
          and e.actor_user_id = new.actor_user_id
     ) then
    raise exception 'T4D_SOD: 同じ依頼のレビューを完了した人は最終承認できません'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger review_events_enforce_sod
  before insert on review_events
  for each row execute function t4d.enforce_review_event();

create trigger review_events_immutable
  before update or delete on review_events
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- コメント（解決の記録だけ更新できる）
-- ----------------------------------------------------------------------

create table review_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  block_id uuid not null,
  block_version_id uuid not null,
  paragraph_id text,
  body text not null check (btrim(body) <> ''),
  /** major の未解決コメントはレビュー完了・承認の阻害条件になる */
  severity text not null default 'info' check (severity in ('info', 'major')),
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),
  resolved_at timestamptz,
  resolved_by uuid references profiles (id),
  resolution_note text,

  constraint review_comments_resolved_actor
    check ((resolved_at is null) = (resolved_by is null)),
  constraint review_comments_block_matches
    foreign key (block_id, organization_id)
    references disclosure_blocks (id, organization_id) on delete cascade,
  constraint review_comments_version_matches
    foreign key (block_version_id, block_id)
    references disclosure_block_versions (id, block_id)
);

create index review_comments_block_idx on review_comments (block_id, resolved_at);

comment on table review_comments is
  '開示本文の版・段落に紐付くレビューコメント。本文・重要度は後から変えず、解決の記録だけを更新する。';

-- 指摘の本文や重要度を後から書き換えると「何を指摘され、どう解決したか」が追えなくなる
create or replace function t4d.review_comment_guard()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - array['resolved_at', 'resolved_by', 'resolution_note'])
     is distinct from (to_jsonb(old) - array['resolved_at', 'resolved_by', 'resolution_note']) then
    raise exception 'T4D_IMMUTABLE: コメントは解決の記録（resolved_*）だけを更新できます'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger review_comments_guard
  before update on review_comments
  for each row execute function t4d.review_comment_guard();

-- ----------------------------------------------------------------------
-- 再確認の判断（追記専用）
-- ----------------------------------------------------------------------

create table recheck_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  block_id uuid not null,
  block_version_id uuid not null,
  ref_kind text not null check (ref_kind in ('metric', 'narrative')),
  /** ref_kind に応じて data_point_versions.id / narrative_versions.id */
  old_ref_id uuid not null,
  new_ref_id uuid not null,
  decision text not null check (decision in ('adopt_new', 'keep_old', 'return_to_owner')),
  reason text not null check (btrim(reason) <> ''),
  decided_by uuid not null references profiles (id),
  decided_at timestamptz not null default now(),

  constraint recheck_decisions_block_matches
    foreign key (block_id, organization_id)
    references disclosure_blocks (id, organization_id) on delete cascade,
  constraint recheck_decisions_version_matches
    foreign key (block_version_id, block_id)
    references disclosure_block_versions (id, block_id)
);

create index recheck_decisions_block_idx on recheck_decisions (block_id, decided_at);

comment on table recheck_decisions is
  '引用した数値・定性情報が更新されたときの判断（追記専用）。承認済みの版は書き換えず、判断だけを残す。';

create trigger recheck_decisions_immutable
  before update or delete on recheck_decisions
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- 節の状態遷移（0014 の data_points と同じ考え方）
--
-- 最終承認者は enterprise.disclosure.approve だけを持ち、write を持たないことがある
-- （approver ロール）。承認・差戻しのために節の UPDATE を許すが、
-- その人が本文や担当まで書き換えられないよう、変えられる列を
-- 状態・提出版・承認版（と更新記録）に限る。
-- ----------------------------------------------------------------------

create or replace function t4d.enforce_disclosure_block_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Service Role（auth.uid() が null）はワーカー処理のため対象外
  if auth.uid() is null then
    return new;
  end if;

  if new.status is distinct from old.status
     and new.status = 'approved'
     and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.approve') then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 最終承認には承認権限が必要です'
      using errcode = '42501';
  end if;

  if new.approved_version_id is distinct from old.approved_version_id
     and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.approve') then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 承認済みの版を変更するには承認権限が必要です'
      using errcode = '42501';
  end if;

  if not t4d.has_permission(new.organization_id, 'enterprise.disclosure.write')
     and (to_jsonb(new) - array[
           'status', 'submitted_version_id', 'approved_version_id', 'updated_at', 'updated_by'
         ])
         is distinct from
         (to_jsonb(old) - array[
           'status', 'submitted_version_id', 'approved_version_id', 'updated_at', 'updated_by'
         ]) then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 承認権限だけでは本文や担当は変更できません'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger disclosure_blocks_enforce_update
  before update on disclosure_blocks
  for each row execute function t4d.enforce_disclosure_block_update();

create trigger disclosure_block_versions_immutable
  before update or delete on disclosure_block_versions
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------

alter table disclosure_blocks enable row level security;
alter table disclosure_block_versions enable row level security;
alter table review_requests enable row level security;
alter table review_events enable row level security;
alter table review_comments enable row level security;
alter table recheck_decisions enable row level security;

create policy disclosure_blocks_select on disclosure_blocks for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy disclosure_blocks_insert on disclosure_blocks for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
-- 承認者（approve のみ）も状態の更新は行う。変えられる列はトリガで絞る
create policy disclosure_blocks_update on disclosure_blocks for update to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.disclosure.write')
    or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  )
  with check (
    t4d.has_permission(organization_id, 'enterprise.disclosure.write')
    or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  );

create policy disclosure_block_versions_select on disclosure_block_versions
  for select to authenticated
  using (t4d.is_org_member(organization_id));
-- 追記専用: UPDATE / DELETE ポリシーは作らない（トリガでも禁止）
create policy disclosure_block_versions_insert on disclosure_block_versions
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );

create policy review_requests_select on review_requests for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy review_requests_insert on review_requests for insert to authenticated
  with check (
    requested_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );
create policy review_requests_update on review_requests for update to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.disclosure.write')
    or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  )
  with check (
    t4d.has_permission(organization_id, 'enterprise.disclosure.write')
    or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  );

create policy review_events_select on review_events for select to authenticated
  using (t4d.is_org_member(organization_id));
-- 本人名義のみ。種類ごとに必要な権限を分ける（最終承認は approve、差戻しは write か approve）
create policy review_events_insert on review_events for insert to authenticated
  with check (
    actor_user_id = auth.uid()
    and (
      (event_type in ('requested', 'withdrawn', 'review_completed')
        and t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
      or (event_type = 'returned'
        and (t4d.has_permission(organization_id, 'enterprise.disclosure.write')
             or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')))
      or (event_type = 'approved'
        and t4d.has_permission(organization_id, 'enterprise.disclosure.approve'))
    )
  );

create policy review_comments_select on review_comments for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy review_comments_insert on review_comments for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      t4d.has_permission(organization_id, 'enterprise.disclosure.write')
      or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
    )
  );
create policy review_comments_update on review_comments for update to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.disclosure.write')
    or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  )
  with check (
    t4d.has_permission(organization_id, 'enterprise.disclosure.write')
    or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  );

create policy recheck_decisions_select on recheck_decisions for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy recheck_decisions_insert on recheck_decisions for insert to authenticated
  with check (
    decided_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );
