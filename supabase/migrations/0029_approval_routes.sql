-- ----------------------------------------------------------------------
-- 最大 5 階層の承認フロー
--
-- これまでのデータ承認は「提出 → 確認中 → 承認」の 1 段階しか無く、
-- 誰が承認したかは approvals に 1 行残るだけだった。
-- 実際の非財務データは、拠点の入力担当 → 拠点長 → 本社の主管部門 →
-- 経理・内部統制 → 役員、のように複数の部署を通って初めて開示に載る。
-- 段階が 1 つしか無いと、
--   - どこまで進んでいるのかが分からない
--   - 誰の承認をもって確定したのかを監査法人へ示せない
--   - 差し戻しが「誰の判断で」起きたのかが残らない
-- という問題が出る。
--
-- 承認の道筋（ルート）を組織ごとに定義し、データごとにその写しを作る。
-- 定義を後から変えても、既に進行中・確定済みのデータの経路は変わらない。
-- 承認・差し戻しはすべて追記で残し、更新も削除もしない。
--
-- 5 階層に制限するのは、業務上これ以上は現実的でなく、
-- 上限を持たない設計は画面と権限の検証が発散するため。
--
-- RLS: 参照は組織メンバー。ルートの定義は enterprise.org.manage、
--      個々の承認は既存のデータ承認権限（アプリ層で判定）に合わせる。
-- ----------------------------------------------------------------------

-- 承認の道筋（テンプレート）
create table approval_routes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  description text not null default '',
  /** 指定が無いデータに使う道筋。組織にひとつだけ true にする */
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint approval_routes_name_unique unique (organization_id, name)
);

comment on table approval_routes is
  '承認の道筋のテンプレート。最大 5 階層の承認段階を持つ。';

create unique index approval_routes_single_default_idx
  on approval_routes (organization_id) where is_default;

-- 道筋の各段階
create table approval_route_stages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  route_id uuid not null references approval_routes (id) on delete cascade,
  /** 1 から 5。順に承認していく */
  stage_no smallint not null check (stage_no between 1 and 5),
  name text not null,
  /** この段階を承認できる役割。空なら承認権限を持つ誰でも */
  approver_role text not null default '',
  /** 承認者を個人まで指定する場合。null なら役割で判定する */
  approver_user_id uuid references profiles (id),
  /** 担当部署（画面表示・通知の宛先に使う） */
  department text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  /**
   * 道筋を組み替えたときに、古い段階を消さずに残すための論理削除。
   * 進行中のデータは自分の写しを持っているので影響しないが、
   * 「その時点の道筋がどうだったか」を後から辿れるようにしておく。
   */
  deleted_at timestamptz
);

-- 生きている段階だけが (道筋, 段数) で一意。論理削除した段階は同じ段数を再利用できる
create unique index approval_route_stages_unique
  on approval_route_stages (route_id, stage_no) where deleted_at is null;

create index approval_route_stages_route_idx on approval_route_stages (route_id, stage_no);

-- データごとの承認段階（テンプレートの写し）。追記のみ更新し、削除しない
create table data_point_approval_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  data_point_id uuid not null references data_points (id) on delete cascade,
  route_id uuid references approval_routes (id) on delete set null,
  stage_no smallint not null check (stage_no between 1 and 5),
  stage_name text not null,
  approver_role text not null default '',
  approver_user_id uuid references profiles (id),
  department text not null default '',
  /**
   * waiting  … 前の段階が終わっていない
   * pending  … この段階の承認待ち
   * approved … 承認済み
   * returned … 差し戻し
   */
  status text not null default 'waiting'
    check (status in ('waiting', 'pending', 'approved', 'returned')),
  decided_at timestamptz,
  decided_by uuid references profiles (id),
  comment text not null default '',
  /** 何回目の申請か。差し戻し後に出し直すと 2 巡目になる */
  round smallint not null default 1 check (round >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint data_point_approval_steps_unique unique (data_point_id, round, stage_no)
);

create index data_point_approval_steps_dp_idx
  on data_point_approval_steps (data_point_id, round, stage_no);
create index data_point_approval_steps_pending_idx
  on data_point_approval_steps (organization_id, status)
  where status = 'pending';

comment on table data_point_approval_steps is
  'データごとの承認段階。いつ誰が承認・差し戻したかを段階ごとに残す。差し戻し後の出し直しは round を増やして別の巡として記録する。';

alter table approval_routes enable row level security;
alter table approval_route_stages enable row level security;
alter table data_point_approval_steps enable row level security;

create policy approval_routes_select on approval_routes for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy approval_routes_write on approval_routes for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.org.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));

create policy approval_route_stages_select on approval_route_stages for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy approval_route_stages_write on approval_route_stages for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.org.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));

create policy data_point_approval_steps_select on data_point_approval_steps
  for select to authenticated
  using (t4d.is_org_member(organization_id));

-- 承認・差し戻しは data.review 権限で行う。誰の段階かはアプリ層で判定する
-- （役割・個人指定の組み合わせは SQL だけでは表現しきれないため）。
create policy data_point_approval_steps_write on data_point_approval_steps
  for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.data.review'))
  with check (t4d.has_permission(organization_id, 'enterprise.data.review'));
