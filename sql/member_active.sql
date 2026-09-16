-- ═══════════════════════════════════════════════════════════
-- 成員停用（業務離職註銷）
--
-- 需求：
--   1. 業務離職後，管理者要能「註銷」其帳號，讓他再也讀不到公司資料
--   2. 離職者名下的客戶要能一次轉給接手的業務（這部分在前端改 qj_customers，
--      因為客戶資料存在 company_kv 的 JSON 內，不是獨立資料表）
--   3. 歷史訂單的「負責業務」永遠不改寫——獎金已依當時紀錄結算過
--
-- 設計原則：
--   * 不刪 profiles 列。刪掉的話 auth.users 還在、而且所有稽核欄位
--     （blacklist.by / blOverride.by / tk.hist[].by）都會變成查無此人
--   * 停用＝把 get_my_company_id() 對他變成 null，公司所有資料的 RLS 一次失效
--   * 但仍允許他讀自己的 profiles 列，前端才能明確告訴他「帳號已停用」
--     而不是掉進「建立企業／加入企業」的新用戶畫面
-- ═══════════════════════════════════════════════════════════

-- ── 0. 執行前先確認 get_my_company_id() 目前的定義 ────────
-- 預期應為「select company_id from profiles where id = auth.uid()」。
-- 若不是，請先停下來，不要直接套用下面第 2 段。
--   select pg_get_functiondef('public.get_my_company_id()'::regprocedure);

-- ── 1. profiles 新增停用欄位 ──────────────────────────────
alter table public.profiles
  add column if not exists active  boolean not null default true,
  add column if not exists left_at timestamptz,
  add column if not exists left_by text;

create index if not exists profiles_company_active_idx
  on public.profiles (company_id, active);

-- ── 2. get_my_company_id()：停用者一律回 null ─────────────
-- 這是全系統 RLS 的樞紐（company_kv、inquiries、market_deals、
-- storage prop-photos 全都靠它），改這一個函數就等於一次收回所有權限。
create or replace function public.get_my_company_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from public.profiles
  where id = auth.uid() and coalesce(active, true)
$$;

-- ── 3. 鎖住 profiles 的可更新欄位（修補既有權限漏洞）──────
-- 現況：authenticated 對 profiles 全部欄位都有 UPDATE 權限，
-- 而 policy profiles_update_self 只檢查 id = auth.uid()。
-- 因此任何一般成員都能直接打 REST API 做到：
--   {"role":"admin"}                → 自己升級成管理者
--   {"company_id":"<別家公司 uuid>"} → 跳進別家公司讀全部資料
-- 而 company_id 就印在 public.html?co=... 的公開房源連結上，並非機密。
-- 不補這個洞的話，第 1 段新增的 active 欄位同樣會被停用者自己改回 true。
--
-- RLS 沒有欄位層級的概念，要靠 column-level grant 限制。
-- 前端唯一合法的自助更新是「修改顯示名稱」（display_name + name_change_count），
-- 其餘欄位一律只能透過 security definer 函數變動。
revoke update on public.profiles from authenticated, anon;
grant  update (display_name, name_change_count) on public.profiles to authenticated;

-- 註：profiles 已有 profiles_select_self (id = auth.uid()) policy，
-- 所以第 2 段讓停用者的 get_my_company_id() 變 null 之後，
-- 他仍讀得到自己那一列，前端才能明確顯示「帳號已停用」，
-- 而不是因為讀不到 profile 被誤判成新用戶、掉進「建立企業」畫面。

-- ── 4. 管理者停用／復職成員 ───────────────────────────────
-- 一般成員在 RLS 下不能改別人的 profiles 列，所以走 security definer。
-- 三道防線：只有 admin、只能改同公司的人、不能停用自己或最後一位在職管理者
-- （停用最後一位管理者會讓整間公司再也沒有人能發邀請碼或改設定）。
create or replace function public.set_member_active(p_user_id uuid, p_on boolean)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_company     uuid;
  v_role        text;
  v_me          uuid := auth.uid();
  v_my_name     text;
  v_t_company   uuid;
  v_t_role      text;
  v_t_name      text;
  v_admin_left  int;
begin
  -- 呼叫者本人也必須是在職狀態：已被停用的管理者不該還能停用別人
  select p.company_id, p.role, p.display_name
    into v_company, v_role, v_my_name
  from public.profiles p where p.id = v_me and coalesce(p.active, true);

  if v_company is null then raise exception 'not in company'; end if;
  if v_role is distinct from 'admin' then raise exception 'admin only'; end if;
  if p_user_id = v_me then raise exception 'cannot change your own status'; end if;

  select p.company_id, p.role, p.display_name
    into v_t_company, v_t_role, v_t_name
  from public.profiles p where p.id = p_user_id;

  if v_t_company is null or v_t_company <> v_company then
    raise exception 'member not found in your company';
  end if;

  if p_on = false and v_t_role = 'admin' then
    select count(*) into v_admin_left
    from public.profiles p
    where p.company_id = v_company and p.role = 'admin'
      and coalesce(p.active, true) and p.id <> p_user_id;
    if v_admin_left = 0 then
      raise exception 'cannot deactivate the last active admin';
    end if;
  end if;

  update public.profiles
  set active  = coalesce(p_on, true),
      left_at = case when p_on = false then now() else null end,
      left_by = case when p_on = false then v_my_name else null end
  where id = p_user_id;

  return jsonb_build_object('ok', true, 'display_name', v_t_name, 'active', coalesce(p_on, true));
end;
$fn$;

revoke all on function public.set_member_active(uuid, boolean) from public, anon;
grant execute on function public.set_member_active(uuid, boolean) to authenticated;

-- ── 5. 管理者調整成員角色 ─────────────────────────────────
-- 沒有這個函數的話，「不能停用最後一位管理者」會變成死路：
-- 唯一的管理者要離職時，公司裡沒有任何人有辦法接手管理權限。
create or replace function public.set_member_role(p_user_id uuid, p_role text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_company    uuid;
  v_role       text;
  v_me         uuid := auth.uid();
  v_t_company  uuid;
  v_t_role     text;
  v_t_name     text;
  v_t_active   boolean;
  v_admin_left int;
begin
  if p_role not in ('admin', 'member') then raise exception 'bad role'; end if;

  select p.company_id, p.role into v_company, v_role
  from public.profiles p where p.id = v_me and coalesce(p.active, true);

  if v_company is null then raise exception 'not in company'; end if;
  if v_role is distinct from 'admin' then raise exception 'admin only'; end if;
  -- 不能改自己：避免管理者手滑把自己降級後，公司裡再也沒人是管理者
  if p_user_id = v_me then raise exception 'cannot change your own role'; end if;

  select p.company_id, p.role, p.display_name, coalesce(p.active, true)
    into v_t_company, v_t_role, v_t_name, v_t_active
  from public.profiles p where p.id = p_user_id;

  if v_t_company is null or v_t_company <> v_company then
    raise exception 'member not found in your company';
  end if;
  -- 已停用的人不該被升為管理者：他的 get_my_company_id() 是 null，
  -- 升了也做不了任何事，只會讓成員清單看起來有兩個管理者而誤判
  if p_role = 'admin' and not v_t_active then
    raise exception 'cannot promote a deactivated member';
  end if;

  if p_role = 'member' and v_t_role = 'admin' then
    select count(*) into v_admin_left
    from public.profiles p
    where p.company_id = v_company and p.role = 'admin'
      and coalesce(p.active, true) and p.id <> p_user_id;
    if v_admin_left = 0 then
      raise exception 'cannot demote the last active admin';
    end if;
  end if;

  update public.profiles set role = p_role where id = p_user_id;
  return jsonb_build_object('ok', true, 'display_name', v_t_name, 'role', p_role);
end;
$fn$;

revoke all on function public.set_member_role(uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, text) to authenticated;

-- ── 6. 重設邀請碼 ─────────────────────────────────────────
-- 離職者可能還記得舊邀請碼。前端在停用成功後會提示管理者「建議重設」，
-- 但刻意不自動重設：在職同事手上那張舊邀請碼可能正要拿去給新人用。
create or replace function public.reset_invite_code()
returns text
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_company uuid;
  v_role    text;
  v_code    text;
  -- 排除 0/O/1/I/L 這類人眼難分的字元，邀請碼常靠口述或手抄傳遞
  v_alpha   text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  i         int;
begin
  select p.company_id, p.role into v_company, v_role
  from public.profiles p where p.id = auth.uid() and coalesce(p.active, true);
  if v_company is null then raise exception 'not in company'; end if;
  if v_role is distinct from 'admin' then raise exception 'admin only'; end if;

  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from public.companies c where c.invite_code = v_code);
  end loop;

  update public.companies set invite_code = v_code where id = v_company;
  return v_code;
end;
$fn$;

revoke all on function public.reset_invite_code() from public, anon;
grant execute on function public.reset_invite_code() to authenticated;
