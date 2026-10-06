-- ════════════════════════════════════════════════════════════════════
-- 房客自助入口（轉傳連結）
-- 在 Supabase Dashboard → SQL Editor 執行一次即可。
-- 全部都是新建物件，不修改任何既有資料表或既有函數。
--
-- 這支和契約／點交的差別：
--   契約與點交是「一次性的單據」，內容簽完就凍結，所以各自存一份 snapshot。
--   房客入口是「一直在變的現況」——這個月繳了沒、押金退了沒、報修處理到哪，
--   存快照就會讓房客看到過期的數字，而房客拿到的數字如果和後台不一樣，
--   就會變成對帳爭議。所以這裡**不存快照**，tenant_links 只記「這個 token
--   對應哪一筆訂單」，每次開啟都從 company_kv 現撈現算。
--
-- 為什麼不是讓房客登入：
--   房客平均住幾個月，為了看三個數字去註冊帳號、記一組密碼不合理，
--   而且帳號本身又是一份要保管的個資。沿用契約／點交已經驗證過的
--   「長亂數 token ＋ security definer RPC」模式，anon 完全沒有
--   任何資料表的 policy，只能走這兩支函數，而函數只認得單一 token。
--
-- 轉傳風險的處理：
--   連結本質上可轉傳，所以頁面上一律不出現完整手機、Email、身分證字號、
--   內部備註、業務姓名與黑名單紀錄（見 tenant_get 的白名單）。
--   業者隨時可以停用連結（status='revoked'）再發一條新的。
-- ════════════════════════════════════════════════════════════════════

-- ── 1. 房客連結 ────────────────────────────────────────────────────
create table if not exists public.tenant_links (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  token        text not null unique,
  booking_id   text not null,              -- 訂單 id（qj_bks）
  guest_name   text,                       -- 只為了後台清單好認，不影響權限
  status       text not null default 'active' check (status in ('active','revoked')),
  opened_at    timestamptz,                -- 房客第一次開啟
  last_seen_at timestamptz,                -- 最後一次開啟
  open_count   integer not null default 0,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);

create index if not exists tenant_links_company_idx on public.tenant_links (company_id, created_at desc);

-- 一筆訂單同時間只有一條有效連結。
-- 沒有這條的話，重複按「產生連結」會發出好幾條都能用的網址，
-- 要停用時業者不知道房客手上拿的是哪一條，等於停不掉。
create unique index if not exists tenant_links_one_live
  on public.tenant_links (company_id, booking_id)
  where status = 'active';

alter table public.tenant_links enable row level security;

drop policy if exists tenant_links_own on public.tenant_links;
create policy tenant_links_own on public.tenant_links
  for all to authenticated
  using      (company_id = public.get_my_company_id())
  with check (company_id = public.get_my_company_id());

-- ── 2. 房客報修 ────────────────────────────────────────────────────
-- 刻意「不」直接寫進 qj_tasks：維修單會影響房況、可售期與退房結算金額，
-- 讓房客能無上限地直接建立正式單據，等於把營運排程的寫入權交給外部人。
-- 這裡只收「申請」，由業者確認後才轉成維修單。
create table if not exists public.tenant_reports (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  link_id     uuid not null references public.tenant_links(id) on delete cascade,
  booking_id  text not null,
  prop_id     text,
  room        text,
  category    text not null,
  detail      text not null,
  contact     text,                        -- 房客自填的方便聯絡時段／方式
  status      text not null default 'new'
              check (status in ('new','accepted','rejected')),
  reply       text,                        -- 業者的回覆，會顯示給房客看
  task_id     text,                        -- 轉成的維修單 id（qj_tasks）
  handled_at  timestamptz,
  handled_by  text,
  created_at  timestamptz not null default now()
);

create index if not exists tenant_reports_company_idx on public.tenant_reports (company_id, created_at desc);
create index if not exists tenant_reports_link_idx    on public.tenant_reports (link_id, created_at desc);

alter table public.tenant_reports enable row level security;

drop policy if exists tenant_reports_own on public.tenant_reports;
create policy tenant_reports_own on public.tenant_reports
  for all to authenticated
  using      (company_id = public.get_my_company_id())
  with check (company_id = public.get_my_company_id());

-- ── 3. 房客端讀取 ──────────────────────────────────────────────────
-- 回傳的每一塊都是「只屬於這一筆訂單」的切片。
-- 欄位一律白名單，不用黑名單：日後訂單上多一個內部欄位（例如風險註記），
-- 黑名單會自動把它洩出去，白名單則是預設不給。
create or replace function public.tenant_get(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v      public.tenant_links;
  v_kv   jsonb;
  v_bk   jsonb;
  v_pids text[];
  v_segs jsonb;
  v_props  jsonb := '{}'::jsonb;
  v_rent   jsonb := '{}'::jsonb;
  v_meter  jsonb := '{}'::jsonb;
  v_util   jsonb := '{}'::jsonb;
  v_ucfg   jsonb;
  v_pinfo  jsonb;
  v_settle jsonb;
  v_phone  text;
begin
  select * into v from public.tenant_links where token = p_token;
  if not found then return null; end if;
  if v.status = 'revoked' then
    return jsonb_build_object('revoked', true);
  end if;

  -- 訂單本體
  select value into v_kv from public.company_kv
   where company_id = v.company_id and key = 'qj_bks';
  select b into v_bk
    from jsonb_array_elements(coalesce(v_kv, '[]'::jsonb)) b
   where b->>'id' = v.booking_id
   limit 1;
  -- 訂單被刪掉時連結就沒有意義了。不自動停用連結：那是業者的決定，
  -- 而且訂單也可能只是被誤刪、等一下就還原。
  if v_bk is null then
    return jsonb_build_object('gone', true);
  end if;

  update public.tenant_links
     set opened_at    = coalesce(opened_at, now()),
         last_seen_at = now(),
         open_count   = open_count + 1
   where id = v.id;

  -- 租期段落：逐欄白名單。已取消的段落不給房客看（那是內部作業痕跡）。
  select coalesce(jsonb_agg(jsonb_build_object(
           'seg_id',       s->>'seg_id',
           'prop_id',      s->>'prop_id',
           'room',         s->>'room',
           'checkin',      s->>'checkin',
           'checkout',     s->>'checkout',
           'monthlyPrice', coalesce((s->>'monthlyPrice')::numeric, 0),
           'totalRent',    coalesce((s->>'totalRent')::numeric, 0),
           'status',       coalesce(s->>'status', 'reserved'))), '[]'::jsonb)
    into v_segs
    from jsonb_array_elements(coalesce(v_bk->'segments', '[]'::jsonb)) s
   where coalesce(s->>'status', 'reserved') <> 'cancelled';

  select coalesce(array_agg(distinct s->>'prop_id'), '{}'::text[]) into v_pids
    from jsonb_array_elements(v_segs) s
   where coalesce(s->>'prop_id', '') <> '';

  -- 館別：只給這筆訂單住到的館，而且只給名稱與地址。
  -- qj_propinfo 的覆寫要在這裡套用，否則房客看到的房號會和後台、
  -- 和他門上貼的號碼不一樣。
  v_pinfo := coalesce((select value from public.company_kv
               where company_id = v.company_id and key = 'qj_propinfo'), '{}'::jsonb);

  select coalesce(jsonb_object_agg(p->>'id', jsonb_build_object(
           'name',      coalesce(p->>'name', ''),
           'address',   coalesce(v_pinfo->(p->>'id')->>'address',  p->>'address',  ''),
           'city',      coalesce(v_pinfo->(p->>'id')->>'city',     p->>'city',     ''),
           'district',  coalesce(v_pinfo->(p->>'id')->>'district', p->>'district', ''),
           'roomNames', coalesce(v_pinfo->(p->>'id')->'roomNames', '{}'::jsonb))), '{}'::jsonb)
    into v_props
    from jsonb_array_elements(coalesce(
           (select value from public.company_kv
             where company_id = v.company_id and key = 'qj_cps'), '[]'::jsonb)) p
   where p->>'id' = any(v_pids);

  -- 收款紀錄：key 是「訂單|館別|房號|起日」，所以用訂單 id 當前綴就切得乾淨。
  -- by（經手人）與 at（寫入時間）是內部稽核欄位，不給房客。
  select coalesce(jsonb_object_agg(k, jsonb_build_object(
           'amt',    coalesce((e->>'amt')::numeric, 0),
           'on',     coalesce(e->>'on', ''),
           'method', coalesce(e->>'method', ''),
           'note',   coalesce(e->>'note', ''))), '{}'::jsonb)
    into v_rent
    from jsonb_each(coalesce((select value from public.company_kv
           where company_id = v.company_id and key = 'qj_rent'), '{}'::jsonb)) t(k, e)
   where k like v.booking_id || '|%';

  select coalesce(jsonb_object_agg(k, e - 'by' - 'at'), '{}'::jsonb)
    into v_meter
    from jsonb_each(coalesce((select value from public.company_kv
           where company_id = v.company_id and key = 'qj_meters'), '{}'::jsonb)) t(k, e)
   where k like v.booking_id || '|%';

  -- 水電費率：只給這筆訂單住到的館的單價，房客才驗算得出自己的電費。
  -- byProp 整包回傳會把其他館的計價方式一併洩出去。
  v_ucfg := coalesce((select value from public.company_kv
              where company_id = v.company_id and key = 'qj_util_cfg'), '{}'::jsonb);
  select coalesce(jsonb_object_agg(k, e), '{}'::jsonb) into v_util
    from jsonb_each(coalesce(v_ucfg->'byProp', '{}'::jsonb)) t(k, e)
   where k = any(v_pids);
  v_util := (v_ucfg - 'byProp') || jsonb_build_object('byProp', v_util);

  select (coalesce((select value from public.company_kv
            where company_id = v.company_id and key = 'qj_settle'), '{}'::jsonb)
          -> v.booking_id) - 'by' - 'at'
    into v_settle;

  v_phone := regexp_replace(coalesce(v_bk->>'phone', ''), '[^0-9]', '', 'g');

  return jsonb_build_object(
    'company', (select name from public.companies where id = v.company_id),
    'booking', jsonb_build_object(
       'id',        v_bk->>'id',
       'guest',     coalesce(v_bk->>'guest', ''),
       -- 只給末四碼：這串是給房客自己確認「這確實是我的單」，
       -- 不是聯絡資訊；連結被轉傳出去時也不該附贈一組完整電話。
       'phone4',    case when length(v_phone) > 4 then right(v_phone, 4) else '' end,
       'deposit',   coalesce((v_bk->>'deposit')::numeric, 0),
       'payment',   coalesce(v_bk->>'payment', ''),
       'segments',  v_segs),
    'props',   v_props,
    'rent',    v_rent,
    'rentCfg', coalesce((select value from public.company_kv
                 where company_id = v.company_id and key = 'qj_rent_cfg'), '{}'::jsonb),
    'meters',  v_meter,
    'utilCfg', v_util,
    'settle',  v_settle,
    -- 契約與點交只回「摘要＋token」，內容不在這裡重做一份：
    -- 房客點進去看到的就是 contract.html／handover.html 那份有簽名、
    -- 有指紋的正本，不會有「入口頁寫的和正本不一樣」的風險。
    'docs', coalesce((
      select jsonb_agg(d order by d->>'createdAt' desc) from (
        select jsonb_build_object('type','contract','kind',c.kind,'no',c.no,
                 'status',c.status,'token',c.token,'propId',c.prop_id,'room',c.room,
                 'signedAt', to_char(c.signed_at at time zone 'Asia/Taipei','YYYY-MM-DD'),
                 'createdAt', to_char(c.created_at at time zone 'Asia/Taipei','YYYY-MM-DD')) d
          from public.contracts c
         where c.company_id = v.company_id and c.booking_id = v.booking_id
           and c.status <> 'void'
        union all
        select jsonb_build_object('type','handover','kind',h.kind,'no',h.no,
                 'status',h.status,'token',h.token,'propId',h.prop_id,'room',h.room,
                 'signedAt', to_char(h.signed_at at time zone 'Asia/Taipei','YYYY-MM-DD'),
                 'createdAt', to_char(h.created_at at time zone 'Asia/Taipei','YYYY-MM-DD'))
          from public.handovers h
         where h.company_id = v.company_id and h.booking_id = v.booking_id
           and h.status <> 'void') q), '[]'::jsonb),
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'cat', r.category, 'detail', r.detail,
               'status', r.status, 'reply', r.reply,
               'at', to_char(r.created_at at time zone 'Asia/Taipei','YYYY-MM-DD HH24:MI'))
             order by r.created_at desc)
        from public.tenant_reports r where r.link_id = v.id), '[]'::jsonb),
    'contact', coalesce((select value from public.company_kv
                 where company_id = v.company_id and key = 'qj_pub_info'), '{}'::jsonb));
end;
$fn$;

-- ── 4. 房客報修 ────────────────────────────────────────────────────
-- 節流放在資料庫端：前端的按鈕 disabled 繞過即無效，而這支函數對 anon 開放。
create or replace function public.tenant_report(
  p_token   text,
  p_prop_id text,
  p_room    text,
  p_cat     text,
  p_detail  text,
  p_contact text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v   public.tenant_links;
  n   integer;
  rid uuid;
begin
  select * into v from public.tenant_links where token = p_token;
  if not found or v.status <> 'active' then
    return jsonb_build_object('ok', false, 'msg', '連結已失效，請向承辦人索取新的連結。');
  end if;
  if coalesce(btrim(p_detail), '') = '' then
    return jsonb_build_object('ok', false, 'msg', '請描述損壞的狀況。');
  end if;
  if coalesce(btrim(p_cat), '') = '' then
    return jsonb_build_object('ok', false, 'msg', '請選擇報修類別。');
  end if;

  select count(*) into n from public.tenant_reports
   where link_id = v.id and created_at > now() - interval '24 hours';
  if n >= 5 then
    return jsonb_build_object('ok', false,
      'msg', '今日的報修已達 5 件上限。如為緊急狀況（漏水、停電、瓦斯外洩），請直接電話聯繫承辦人。');
  end if;

  insert into public.tenant_reports
    (company_id, link_id, booking_id, prop_id, room, category, detail, contact)
  values (v.company_id, v.id, v.booking_id,
          nullif(btrim(coalesce(p_prop_id, '')), ''),
          nullif(btrim(coalesce(p_room, '')), ''),
          left(btrim(p_cat), 40), left(btrim(p_detail), 1000),
          left(btrim(coalesce(p_contact, '')), 200))
  returning id into rid;

  return jsonb_build_object('ok', true, 'id', rid);
end;
$fn$;

revoke all on function public.tenant_get(text) from public;
revoke all on function public.tenant_report(text, text, text, text, text, text) from public;
grant execute on function public.tenant_get(text) to anon, authenticated;
grant execute on function public.tenant_report(text, text, text, text, text, text) to anon, authenticated;
