-- ═══════════════════════════════════════════════════════════
-- 訂閱制（SaaS 方案分級 / 額度限制 / 到期處理）
--
-- 設計原則：
--   1. 額度一律在資料庫強制。前端隱藏按鈕只是 UX，任何人打開 DevTools
--      直接呼叫 REST API 就能繞過；真正的鎖必須長在後端。
--   2. 到期＝唯讀，不是鎖死。客戶的資料永遠讀得到、匯得出。
--      把人家的營運資料扣住當作催繳手段，商業上會被客訴、法律上站不住腳。
--   3. 公司管理者不能自己改自己的方案。開通權限屬於「平台方」，
--      是另一個層級的身分，和 profiles.role='admin'（公司管理者）無關。
--   4. 方案內容存在資料表而非程式碼。調整價格或額度不必重新部署前端。
--
-- 執行順序：本檔可重複執行（idempotent）。
-- ═══════════════════════════════════════════════════════════

-- ── 1. 方案定義 ───────────────────────────────────────────
-- 額度為 null 代表不限制。
create table if not exists public.plans (
  code           text primary key,
  name           text        not null,
  price_monthly  int         not null default 0,   -- 新台幣，未稅
  price_yearly   int,                              -- 年繳總額；null 代表不提供年繳
  max_props      int,                              -- 館別數上限
  max_rooms      int,                              -- 總房間數上限
  max_members    int,                              -- 可登入的成員數上限
  features       jsonb       not null default '{}'::jsonb,
  sort           int         not null default 0,
  active         boolean     not null default true
);

-- 方案內容為初版草案，價格與額度請依實際成本與市場回饋調整。
-- 改這張表即時生效，不需要動程式。
insert into public.plans (code, name, price_monthly, price_yearly, max_props, max_rooms, max_members, features, sort) values
  ('trial',    '試用',   0,     null,   1,    10,   2,
     '{"estimate":true,"market":false,"complaint":true,"photo":true,"export":true}'::jsonb, 0),
  ('starter',  '入門',   1200,  12000,  2,    30,   3,
     '{"estimate":true,"market":false,"complaint":true,"photo":true,"export":true}'::jsonb, 1),
  ('pro',      '專業',   2800,  28000,  8,    120,  10,
     '{"estimate":true,"market":true,"complaint":true,"photo":true,"export":true}'::jsonb, 2),
  ('business', '企業',   6000,  60000,  null, null, null,
     '{"estimate":true,"market":true,"complaint":true,"photo":true,"export":true}'::jsonb, 3)
on conflict (code) do update set
  name = excluded.name, price_monthly = excluded.price_monthly,
  price_yearly = excluded.price_yearly, max_props = excluded.max_props,
  max_rooms = excluded.max_rooms, max_members = excluded.max_members,
  features = excluded.features, sort = excluded.sort;

alter table public.plans enable row level security;

-- 方案內容本來就要印在價目表上，登入者都能讀。
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans
  for select to authenticated using (active);

revoke insert, update, delete on public.plans from authenticated, anon;


-- ── 2. 平台管理員 ─────────────────────────────────────────
-- 這是「我們自己人」，不是客戶公司的管理者。
-- 只有這裡面的人能開通、續約、停權別人的訂閱。
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;
-- 刻意不建任何 policy：這張表只給 security definer 函數內部使用，
-- 前端無論用什麼身分都讀不到，避免平台人員名單外流。
revoke all on public.platform_admins from authenticated, anon;

create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;


-- ── 3. 訂閱紀錄 ───────────────────────────────────────────
-- status 語意：
--   trialing  試用中     → 可寫
--   active    正常付費中 → 可寫
--   past_due  逾期未繳   → 可寫（付款重試的寬限期，先別急著鎖客戶）
--   canceled  已取消     → 唯讀
--   expired   已到期     → 唯讀
create table if not exists public.subscriptions (
  company_id          uuid primary key references public.companies(id) on delete cascade,
  plan                text        not null references public.plans(code),
  status              text        not null default 'trialing',
  trial_ends_at       timestamptz,
  current_period_end  timestamptz,
  seats               int,                       -- 覆寫方案的成員上限；null 代表照方案
  -- 金流串接後才會用到，現階段留白
  gateway             text,
  gateway_sub_id      text,
  note                text,
  updated_by          uuid,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  constraint subscriptions_status_chk
    check (status in ('trialing','active','past_due','canceled','expired'))
);

create index if not exists subscriptions_status_idx
  on public.subscriptions (status, current_period_end);

alter table public.subscriptions enable row level security;

-- 公司成員讀得到自己公司的訂閱狀態（前端要顯示「方案：專業，到期日 ...」）
drop policy if exists subscriptions_read_own on public.subscriptions;
create policy subscriptions_read_own on public.subscriptions
  for select to authenticated using (company_id = public.get_my_company_id());

-- 一律不開放前端寫入。升級降級只能透過下方的 security definer 函數。
revoke insert, update, delete on public.subscriptions from authenticated, anon;


-- ── 4. 新公司自動獲得試用 ─────────────────────────────────
-- 註冊完就能直接用，不必等我們手動開通。
create or replace function public.tg_company_start_trial()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.subscriptions (company_id, plan, status, trial_ends_at, current_period_end)
  values (NEW.id, 'trial', 'trialing', now() + interval '14 days', now() + interval '14 days')
  on conflict (company_id) do nothing;
  return NEW;
end;
$fn$;

drop trigger if exists company_start_trial on public.companies;
create trigger company_start_trial
  after insert on public.companies
  for each row execute function public.tg_company_start_trial();

-- 既有公司補上訂閱紀錄。
-- 現有客戶是在沒有訂閱制的前提下進來的，直接給 active 而非 trialing，
-- 避免他們隔天打開系統發現變成唯讀。要轉成付費是商務溝通，不是技術動作。
insert into public.subscriptions (company_id, plan, status, current_period_end, note)
select c.id, 'pro', 'active', now() + interval '10 years', '訂閱制上線前既有客戶，沿用原有權益'
from public.companies c
where not exists (select 1 from public.subscriptions s where s.company_id = c.id);


-- ── 5. 用量統計 ───────────────────────────────────────────
-- 業務資料全部存在 company_kv 的 JSON 內（qj_cps 是館別與房間），
-- 所以算用量要解 JSON，不能用一般的 count(*)。
create or replace function public.company_usage(p_company_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'props', coalesce((
      select case when jsonb_typeof(kv.value) = 'array'
                  then jsonb_array_length(kv.value) else 0 end
      from public.company_kv kv
      where kv.company_id = p_company_id and kv.key = 'qj_cps'
    ), 0),
    'rooms', coalesce((
      select sum(case when jsonb_typeof(e->'rooms') = 'array'
                      then jsonb_array_length(e->'rooms') else 0 end)
      from public.company_kv kv,
           lateral jsonb_array_elements(kv.value) e
      where kv.company_id = p_company_id and kv.key = 'qj_cps'
        and jsonb_typeof(kv.value) = 'array'
    ), 0),
    'members', (
      select count(*) from public.profiles p
      where p.company_id = p_company_id and coalesce(p.active, true)
    )
  )
$$;

revoke all on function public.company_usage(uuid) from public, anon;
grant execute on function public.company_usage(uuid) to authenticated;


-- ── 6. 前端要的一包資料 ───────────────────────────────────
-- 方案 + 狀態 + 目前用量，一次拿齊，前端據此決定要鎖哪些按鈕。
-- 再次強調：前端鎖是體驗，真正的鎖在第 7 段的 trigger。
create or replace function public.my_subscription()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_company uuid := public.get_my_company_id();
  v_sub     record;
  v_plan    record;
begin
  if v_company is null then
    return jsonb_build_object('ok', false, 'reason', 'not_in_company');
  end if;

  select * into v_sub  from public.subscriptions where company_id = v_company;
  if v_sub is null then
    return jsonb_build_object('ok', false, 'reason', 'no_subscription');
  end if;

  select * into v_plan from public.plans where code = v_sub.plan;

  return jsonb_build_object(
    'ok',        true,
    'plan',      v_sub.plan,
    'plan_name', coalesce(v_plan.name, v_sub.plan),
    'status',    v_sub.status,
    'writable',  v_sub.status in ('trialing','active','past_due'),
    'trial_ends_at',      v_sub.trial_ends_at,
    'current_period_end', v_sub.current_period_end,
    'days_left', case
      when v_sub.current_period_end is null then null
      else greatest(0, ceil(extract(epoch from (v_sub.current_period_end - now())) / 86400)::int)
    end,
    'limits', jsonb_build_object(
      'max_props',   v_plan.max_props,
      'max_rooms',   v_plan.max_rooms,
      'max_members', coalesce(v_sub.seats, v_plan.max_members)
    ),
    'features', coalesce(v_plan.features, '{}'::jsonb),
    'usage',    public.company_usage(v_company)
  );
end;
$fn$;

revoke all on function public.my_subscription() from public, anon;
grant execute on function public.my_subscription() to authenticated;


-- ── 7. 真正的鎖：company_kv 寫入時強制檢查 ────────────────
-- 所有業務資料都經過 company_kv，所以守住這一個進出口就等於守住全部。
create or replace function public.tg_enforce_subscription()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_sub   record;
  v_plan  record;
  v_props int;
  v_rooms int;
begin
  select * into v_sub from public.subscriptions where company_id = NEW.company_id;

  -- 查不到訂閱紀錄就放行。寧可少擋，也不要因為資料沒補齊
  -- 就把付過錢的客戶鎖在門外。
  if v_sub is null then return NEW; end if;

  if v_sub.status not in ('trialing','active','past_due') then
    raise exception 'SUBSCRIPTION_INACTIVE'
      using hint = '訂閱已到期，系統目前為唯讀模式。您的資料都還在，續訂後立即恢復編輯。';
  end if;

  -- 只有寫入館別資料時才需要驗額度
  if NEW.key <> 'qj_cps' or jsonb_typeof(NEW.value) <> 'array' then
    return NEW;
  end if;

  select * into v_plan from public.plans where code = v_sub.plan;
  if v_plan is null then return NEW; end if;

  v_props := jsonb_array_length(NEW.value);
  select coalesce(sum(case when jsonb_typeof(e->'rooms') = 'array'
                           then jsonb_array_length(e->'rooms') else 0 end), 0)
    into v_rooms
  from jsonb_array_elements(NEW.value) e;

  -- 只擋「變更後仍然超標」的寫入。已經超標的公司（例如降級後）
  -- 還是要能刪東西把量降下來，否則會卡死在無法自救的狀態。
  if v_plan.max_props is not null and v_props > v_plan.max_props then
    if v_props > coalesce((public.company_usage(NEW.company_id)->>'props')::int, 0) then
      raise exception 'PLAN_LIMIT_PROPS'
        using hint = format('目前方案「%s」最多 %s 個館別，請升級後再新增。',
                            v_plan.name, v_plan.max_props);
    end if;
  end if;

  if v_plan.max_rooms is not null and v_rooms > v_plan.max_rooms then
    if v_rooms > coalesce((public.company_usage(NEW.company_id)->>'rooms')::int, 0) then
      raise exception 'PLAN_LIMIT_ROOMS'
        using hint = format('目前方案「%s」最多 %s 間房，請升級後再新增。',
                            v_plan.name, v_plan.max_rooms);
    end if;
  end if;

  return NEW;
end;
$fn$;

drop trigger if exists enforce_subscription on public.company_kv;
create trigger enforce_subscription
  before insert or update on public.company_kv
  for each row execute function public.tg_enforce_subscription();


-- ── 8. 成員人數上限 ───────────────────────────────────────
-- 直接掛在 profiles 上，不管是走 join_company() 還是日後新增的任何路徑，
-- 只要有人被塞進公司就會被檢查到。
create or replace function public.tg_enforce_seats()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_sub   record;
  v_plan  record;
  v_limit int;
  v_used  int;
begin
  if NEW.company_id is null then return NEW; end if;
  if not coalesce(NEW.active, true) then return NEW; end if;

  -- 只在「新加入」或「從停用復職」時檢查，一般欄位更新不必重算
  if TG_OP = 'UPDATE'
     and NEW.company_id is not distinct from OLD.company_id
     and coalesce(OLD.active, true) then
    return NEW;
  end if;

  select * into v_sub from public.subscriptions where company_id = NEW.company_id;
  if v_sub is null then return NEW; end if;

  select * into v_plan from public.plans where code = v_sub.plan;
  v_limit := coalesce(v_sub.seats, v_plan.max_members);
  if v_limit is null then return NEW; end if;

  select count(*) into v_used from public.profiles p
  where p.company_id = NEW.company_id and coalesce(p.active, true) and p.id <> NEW.id;

  if v_used + 1 > v_limit then
    raise exception 'PLAN_LIMIT_MEMBERS'
      using hint = format('目前方案「%s」最多 %s 位成員，請升級後再邀請。',
                          coalesce(v_plan.name, v_sub.plan), v_limit);
  end if;

  return NEW;
end;
$fn$;

drop trigger if exists enforce_seats on public.profiles;
create trigger enforce_seats
  before insert or update on public.profiles
  for each row execute function public.tg_enforce_seats();


-- ── 9. 平台方開通／續約（金流上線前的人工流程）────────────
-- 這是目前唯一能改訂閱的入口。客戶匯款後由平台人員執行。
-- 金流串接之後，callback 會改用 service_role 直接寫 subscriptions，
-- 這支函數仍保留給退款、客訴補償、業務談定的特殊條件使用。
create or replace function public.admin_set_subscription(
  p_company_id uuid,
  p_plan       text,
  p_months     int  default 1,
  p_status     text default 'active',
  p_seats      int  default null,
  p_note       text default null
)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_end  timestamptz;
  v_name text;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admin only';
  end if;
  if p_status not in ('trialing','active','past_due','canceled','expired') then
    raise exception 'bad status';
  end if;
  if not exists (select 1 from public.plans where code = p_plan) then
    raise exception 'unknown plan: %', p_plan;
  end if;

  select name into v_name from public.companies where id = p_company_id;
  if v_name is null then raise exception 'company not found'; end if;

  -- 續約從「原到期日」起算，不是從今天。否則客戶提早繳費反而被吃掉天數。
  select greatest(coalesce(current_period_end, now()), now()) into v_end
  from public.subscriptions where company_id = p_company_id;
  v_end := coalesce(v_end, now()) + make_interval(months => greatest(coalesce(p_months, 1), 0));

  insert into public.subscriptions
    (company_id, plan, status, current_period_end, seats, note, updated_by, updated_at)
  values
    (p_company_id, p_plan, p_status, v_end, p_seats, p_note, auth.uid(), now())
  on conflict (company_id) do update set
    plan = excluded.plan,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    seats = excluded.seats,
    note = coalesce(excluded.note, public.subscriptions.note),
    updated_by = excluded.updated_by,
    updated_at = now();

  return jsonb_build_object('ok', true, 'company', v_name,
                            'plan', p_plan, 'status', p_status, 'until', v_end);
end;
$fn$;

revoke all on function public.admin_set_subscription(uuid, text, int, text, int, text) from public, anon;
grant execute on function public.admin_set_subscription(uuid, text, int, text, int, text) to authenticated;


-- ── 10. 到期掃描 ──────────────────────────────────────────
-- 由排程每日呼叫。沒有這一支的話，狀態永遠停在 active，
-- 第 7 段的唯讀鎖就一輩子不會觸發。
--
-- 權限：帶著使用者 JWT 呼叫時必須是平台管理員；
-- 由 pg_cron 或 service_role 呼叫時 auth.uid() 為 null，屬於伺服器端排程，放行。
create or replace function public.expire_subscriptions()
returns int
language plpgsql volatile security definer set search_path = public as $fn$
declare v_n int;
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    raise exception 'platform admin only';
  end if;

  update public.subscriptions
  set status = 'expired', updated_at = now()
  where status in ('trialing','active','past_due')
    and current_period_end is not null
    and current_period_end < now();

  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

revoke all on function public.expire_subscriptions() from public, anon;
grant execute on function public.expire_subscriptions() to authenticated;


-- ── 11. 開通平台管理員 + 排程 ─────────────────────────────
-- 這兩段是「部署動作」，不是結構定義，但寫在這裡才不會日後重建資料庫時漏掉。

-- 平台方本人。名單放在 platform_admins，不是靠 email 硬編在函數裡，
-- 日後多一個同事就是多一列，不用改程式。
insert into public.platform_admins (user_id, note)
select id, '平台方／系統擁有者' from auth.users where email = 'linhsuanyu199@gmail.com'
on conflict (user_id) do nothing;

-- 到期掃描排程。放在資料庫內（pg_cron）而不是 GitHub Actions，
-- 因為它只動自己的資料、不需要任何對外金鑰，權限面乾淨得多。
create extension if not exists pg_cron;

select cron.unschedule('expire-subscriptions')
where exists (select 1 from cron.job where jobname = 'expire-subscriptions');

-- 每天台北時間 02:05（cron 走 UTC，所以寫 18:05）
select cron.schedule('expire-subscriptions', '5 18 * * *',
  'select public.expire_subscriptions()');
