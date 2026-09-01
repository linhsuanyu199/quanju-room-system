-- ═══════════════════════════════════════════════════════════
-- 全平台成交行情庫（跨公司共享行情，但不揭露是誰成交的）
-- 原則：
--   1. 不存門牌號、不存房客任何資料、不存館別名稱
--   2. market_deals 開 RLS 但「不建任何 policy」→ 前端永遠讀不到原始列
--   3. 唯一出入口是兩個 security definer 函數：
--        submit_market_deal()  寫入（company_id 由伺服器蓋章，前端偽造不了）
--        market_stats()        讀取（只回傳匿名統計值）
--   4. 沒有貢獻資料的公司（share_market=false）查不到行情
-- ═══════════════════════════════════════════════════════════

-- ── 1. 表 ────────────────────────────────────────────────
create table if not exists public.market_deals (
  id           uuid primary key default gen_random_uuid(),
  city         text not null,
  district     text not null,
  road         text,                 -- 只到路名，不含門牌
  building     text,                 -- 社區／大樓名，可空
  rtype        text not null,
  monthly_rent int  not null check (monthly_rent > 0 and monthly_rent < 1000000),
  deal_month   date not null check (date_part('day', deal_month) = 1),  -- 只記到月
  company_id   uuid not null references public.companies(id) on delete cascade,
  booking_id   text,                 -- 去重用，不對外回傳
  created_at   timestamptz not null default now()
);

-- ── 2. 索引 ──────────────────────────────────────────────
create index if not exists market_deals_area_idx
  on public.market_deals (city, district, rtype, deal_month desc);
create index if not exists market_deals_road_idx
  on public.market_deals (city, district, rtype, road, deal_month desc)
  where road is not null;
create index if not exists market_deals_bldg_idx
  on public.market_deals (city, district, rtype, building, deal_month desc)
  where building is not null;
create unique index if not exists market_deals_dedupe_idx
  on public.market_deals (company_id, booking_id)
  where booking_id is not null;

-- ── 3. RLS：開啟但刻意不建 policy ─────────────────────────
alter table public.market_deals enable row level security;
revoke all on public.market_deals from anon, authenticated;

-- ── 4. 公司層級的行情共享開關 ─────────────────────────────
alter table public.companies
  add column if not exists share_market boolean not null default true;

-- ── 5. 文字正規化（比對用：去空白、空字串當 null）─────────
create or replace function public.market_norm(t text)
returns text language sql immutable as $$
  select nullif(regexp_replace(trim(coalesce(t, '')), '\s+', '', 'g'), '')
$$;

-- ── 6. 內部聚合（近 24 個月）──────────────────────────────
create or replace function public._market_agg(
  p_city text, p_district text, p_rtype text,
  p_road text, p_building text
) returns table (n int, median int, p25 int, p75 int)
language sql stable security definer set search_path = public as $$
  select count(*)::int,
         percentile_cont(0.5)  within group (order by monthly_rent)::int,
         percentile_cont(0.25) within group (order by monthly_rent)::int,
         percentile_cont(0.75) within group (order by monthly_rent)::int
  from public.market_deals d
  where d.city = p_city
    and d.district = p_district
    and d.rtype = p_rtype
    and d.deal_month >= (date_trunc('month', now()) - interval '24 months')::date
    and (p_road is null or public.market_norm(d.road) = p_road)
    and (p_building is null or public.market_norm(d.building) = p_building)
$$;

-- ── 7. 對外唯一讀取入口 ───────────────────────────────────
-- 樣本門檻：同大樓 >= 3；同路名 >= 5；同行政區 >= 5；再不夠就回 level='none'
create or replace function public.market_stats(
  p_city text, p_district text, p_rtype text,
  p_road text default null, p_building text default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_company uuid;
  v_share   boolean;
  r         record;
  road_n    text := public.market_norm(p_road);
  bldg_n    text := public.market_norm(p_building);
begin
  v_company := public.get_my_company_id();
  if v_company is null then
    return jsonb_build_object('level', 'none', 'n', 0, 'reason', 'not_in_company');
  end if;

  select c.share_market into v_share from public.companies c where c.id = v_company;
  if coalesce(v_share, true) = false then
    return jsonb_build_object('level', 'none', 'n', 0, 'reason', 'opted_out');
  end if;

  if bldg_n is not null then
    select * into r from public._market_agg(p_city, p_district, p_rtype, null, bldg_n);
    if r.n >= 3 then
      return jsonb_build_object('level','building','scope',p_building,
        'n',r.n,'median',r.median,'p25',r.p25,'p75',r.p75);
    end if;
  end if;

  if road_n is not null then
    select * into r from public._market_agg(p_city, p_district, p_rtype, road_n, null);
    if r.n >= 5 then
      return jsonb_build_object('level','road','scope',p_road,
        'n',r.n,'median',r.median,'p25',r.p25,'p75',r.p75);
    end if;
  end if;

  select * into r from public._market_agg(p_city, p_district, p_rtype, null, null);
  if r.n >= 5 then
    return jsonb_build_object('level','district','scope',p_city || p_district,
      'n',r.n,'median',r.median,'p25',r.p25,'p75',r.p75);
  end if;

  return jsonb_build_object('level','none','n',coalesce(r.n,0),'reason','not_enough_samples');
end;
$$;

-- ── 8. 對外唯一寫入入口 ───────────────────────────────────
create or replace function public.submit_market_deal(
  p_city text, p_district text, p_rtype text,
  p_monthly_rent int, p_deal_month date,
  p_road text default null, p_building text default null,
  p_booking_id text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_company uuid;
  v_share   boolean;
  v_month   date := date_trunc('month', coalesce(p_deal_month, current_date))::date;
begin
  v_company := public.get_my_company_id();
  if v_company is null then
    return jsonb_build_object('ok', false, 'reason', 'not_in_company');
  end if;

  select c.share_market into v_share from public.companies c where c.id = v_company;
  if coalesce(v_share, true) = false then
    return jsonb_build_object('ok', false, 'reason', 'opted_out');
  end if;

  if p_monthly_rent is null or p_monthly_rent <= 0 or p_monthly_rent >= 1000000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_rent');
  end if;
  if coalesce(trim(p_city),'') = '' or coalesce(trim(p_district),'') = ''
     or coalesce(trim(p_rtype),'') = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_area');
  end if;

  insert into public.market_deals
    (city, district, road, building, rtype, monthly_rent, deal_month, company_id, booking_id)
  values
    (trim(p_city), trim(p_district),
     nullif(trim(coalesce(p_road, '')), ''),
     nullif(trim(coalesce(p_building, '')), ''),
     trim(p_rtype), p_monthly_rent, v_month, v_company,
     nullif(trim(coalesce(p_booking_id, '')), ''))
  on conflict (company_id, booking_id) where booking_id is not null
  do update set city = excluded.city, district = excluded.district,
                road = excluded.road, building = excluded.building,
                rtype = excluded.rtype, monthly_rent = excluded.monthly_rent,
                deal_month = excluded.deal_month;

  return jsonb_build_object('ok', true);
end;
$$;

-- ── 9. 權限 ──────────────────────────────────────────────
-- Supabase 的 default privileges 會把 public schema 的函數 execute 發給 anon/authenticated，
-- 光 revoke from public 不夠，必須對這兩個角色明確 revoke。
-- _market_agg 若沒收回，前端可繞過 market_stats 的樣本門檻直接查 n=1 的單筆成交。
revoke all on function public._market_agg(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.market_stats(text,text,text,text,text) from public, anon;
revoke all on function public.submit_market_deal(text,text,text,int,date,text,text,text) from public, anon;
grant execute on function public.market_stats(text,text,text,text,text) to authenticated;
grant execute on function public.submit_market_deal(text,text,text,int,date,text,text,text) to authenticated;

-- ── 10. 企業管理者切換是否參與行情共享 ────────────────────
-- 走 RPC 而非直接 update companies，避免相依於 companies 的 update policy
create or replace function public.set_share_market(p_on boolean)
returns boolean language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_company uuid;
  v_role    text;
begin
  select p.company_id, p.role into v_company, v_role
  from public.profiles p where p.id = auth.uid();
  if v_company is null then raise exception 'not in company'; end if;
  if v_role is distinct from 'admin' then raise exception 'admin only'; end if;
  update public.companies set share_market = coalesce(p_on, true) where id = v_company;
  return coalesce(p_on, true);
end;
$fn$;

revoke all on function public.set_share_market(boolean) from public, anon;
grant execute on function public.set_share_market(boolean) to authenticated;
