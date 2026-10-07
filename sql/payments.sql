-- ═══════════════════════════════════════════════════════════
-- 訂閱費線上收款（payments）
--
-- 收款對象是「使用本系統的業者」，不是房客。房客的租金收款走
-- js/rent-ledger.js 的人工台帳，和這張表完全無關。
--
-- 設計原則：
--   1. 金額一律由後端從 plans 表重算。前端傳來的金額一個字都不信，
--      否則可以被改成 1 元。所以沒有任何地方接受「金額」這個參數。
--   2. 前端完全不能寫 payments。所有寫入只能由 Vercel Function 帶
--      service_role 呼叫下面兩支函數，前端連 insert 權限都沒有。
--   3. 「付款成功」只認金流商的伺服器對伺服器通知（callback），
--      而且一定要驗簽。使用者瀏覽器導回來的那一頁只負責顯示，
--      不改任何狀態——網址參數是使用者自己就能編的。
--   4. callback 會重送。pay_mark_paid() 必須可以被呼叫一百次而只生效一次，
--      否則客戶會被多加好幾個月，或是退款時對不上帳。
--
-- 執行順序：本檔可重複執行（idempotent）。需先有 subscriptions.sql。
-- ═══════════════════════════════════════════════════════════


-- ── 1. 付款單 ─────────────────────────────────────────────
-- status 語意：
--   pending   已建單，還沒收到付款通知（使用者可能根本沒付）
--   paid      已驗簽確認收款，訂閱已延長
--   failed    金流商回報交易失敗
--   mismatch  收到的金額與我方建單金額不符 → 不開通，等人工處理
--   expired   建單後太久沒有下文，掃描排程關掉
create table if not exists public.payments (
  id               uuid        primary key default gen_random_uuid(),
  company_id       uuid        not null references public.companies(id) on delete cascade,
  -- 我方交易編號，就是送給金流商的 MerchantTradeNo。
  -- 綠界限制：純英數、最長 20 碼，且同一商店不可重複。
  trade_no         text        not null unique,
  gateway          text        not null,
  method           text,
  plan             text        not null references public.plans(code),
  period           text        not null,
  months           int         not null,
  amount           int         not null,
  status           text        not null default 'pending',
  gateway_trade_no text,
  paid_at          timestamptz,
  raw              jsonb,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint payments_status_chk
    check (status in ('pending','paid','failed','mismatch','expired')),
  constraint payments_period_chk check (period in ('monthly','yearly')),
  constraint payments_trade_no_chk check (trade_no ~ '^[A-Za-z0-9]{1,20}$'),
  constraint payments_amount_chk check (amount > 0)
);

create index if not exists payments_company_idx on public.payments (company_id, created_at desc);
create index if not exists payments_pending_idx on public.payments (status, created_at);

alter table public.payments enable row level security;


-- ── 2. 誰看得到付款紀錄 ───────────────────────────────────
-- 帳務是企業管理者的事。一般成員看得到自己公司有沒有繳費沒有意義，
-- 而且發票抬頭、金額這些東西沒必要全公司都看得到。
create or replace function public.is_company_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and coalesce(p.active, true)
  )
$$;

revoke all on function public.is_company_admin() from public, anon;
grant execute on function public.is_company_admin() to authenticated;

drop policy if exists payments_read_own on public.payments;
create policy payments_read_own on public.payments
  for select to authenticated
  using (company_id = public.get_my_company_id() and public.is_company_admin());

-- 前端一律不能寫。建單與銷帳都只走下面兩支函數（由後端帶 service_role 呼叫）。
revoke insert, update, delete on public.payments from authenticated, anon;


-- ── 3. 建單：金額在這裡算，不接受外部傳入 ─────────────────
-- 回傳的 trade_no 會原封不動送給金流商當 MerchantTradeNo。
-- 格式：Q + yyMMddHHmmss + 6 碼亂數 = 19 碼，剛好塞得進綠界的 20 碼上限。
-- 用亂數而不是流水號，是為了不讓外部從交易編號推算出我們一天成交幾筆。
create or replace function public.pay_quote(
  p_company_id uuid,
  p_plan       text,
  p_period     text,
  p_gateway    text,
  p_user_id    uuid default null
)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_plan   record;
  v_amount int;
  v_months int;
  v_no     text;
  v_co     text;
begin
  if p_period not in ('monthly','yearly') then
    raise exception 'PAY_BAD_PERIOD';
  end if;

  select name into v_co from public.companies where id = p_company_id;
  if v_co is null then raise exception 'PAY_NO_COMPANY'; end if;

  select * into v_plan from public.plans where code = p_plan and active;
  if v_plan is null then raise exception 'PAY_UNKNOWN_PLAN'; end if;

  -- 旗艦版是個別報價，沒有公定價可以收；免費版沒有東西可以賣。
  -- 這兩種情況讓它在這裡就失敗，不要讓使用者走到金流商的頁面才發現。
  if coalesce(v_plan.contact_only, false) then raise exception 'PAY_CONTACT_ONLY'; end if;

  if p_period = 'yearly' then
    v_amount := v_plan.price_yearly;
    v_months := 12;
  else
    v_amount := v_plan.price_monthly;
    v_months := 1;
  end if;

  if v_amount is null or v_amount <= 0 then raise exception 'PAY_NOT_SELLABLE'; end if;

  -- 同一家公司不該同時掛著一堆未付款的單。使用者反覆點「立即付款」
  -- 會每次都開新單，舊的留著只會讓對帳變難，所以先把舊的收掉。
  update public.payments
  set status = 'expired', updated_at = now()
  where company_id = p_company_id and status = 'pending';

  v_no := 'Q' || to_char(now() at time zone 'Asia/Taipei', 'YYMMDDHH24MISS')
               || upper(substr(md5(gen_random_uuid()::text), 1, 6));

  insert into public.payments
    (company_id, trade_no, gateway, plan, period, months, amount, created_by)
  values
    (p_company_id, v_no, p_gateway, p_plan, p_period, v_months, v_amount, p_user_id);

  return jsonb_build_object(
    'ok', true,
    'trade_no', v_no,
    'amount', v_amount,
    'months', v_months,
    'plan', p_plan,
    'plan_name', v_plan.name,
    'company', v_co,
    -- 綠界的 ItemName 會印在付款頁與信用卡帳單上，寫清楚買的是什麼
    'item_name', '全居短租系統 ' || v_plan.name || '方案 ' ||
                 case when p_period = 'yearly' then '年繳（12 個月）' else '月繳（1 個月）' end
  );
end;
$fn$;

revoke all on function public.pay_quote(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.pay_quote(uuid, text, text, text, uuid) to service_role;


-- ── 4. 銷帳：整個金流串接最關鍵的一支 ─────────────────────
-- 呼叫前必須已經驗過簽。這支函數假設「呼叫者已經確認這是金流商發出的」，
-- 它負責的是另外兩件事：原子性與冪等性。
--
-- 為什麼驗簽不寫在這裡：HashKey/HashIV 是金鑰，放進資料庫函數等於
-- 讓每個能讀 pg_proc 的人都看得到。金鑰只存在後端的環境變數裡。
create or replace function public.pay_mark_paid(
  p_trade_no         text,
  p_gateway_trade_no text,
  p_amount           int,
  p_method           text,
  p_raw              jsonb
)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_pay record;
  v_end timestamptz;
begin
  -- for update：金流商會在很短的時間內重送通知，兩個請求可能同時進來。
  -- 沒有這個鎖，兩邊都會讀到 pending 然後各加一次月份。
  select * into v_pay from public.payments where trade_no = p_trade_no for update;

  if v_pay is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_trade_no');
  end if;

  -- 已經銷過帳。這不是錯誤，是正常的重送，回 ok 讓對方停止重試。
  if v_pay.status = 'paid' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'company_id', v_pay.company_id);
  end if;

  -- 收到的金額和我方建單金額不符。可能是竄改，也可能是我們自己改了價目表
  -- 而使用者停在舊頁面。不論哪一種都不該自動開通——錢的事情對不上，
  -- 寧可讓人工介入，也不要讓系統自己猜。
  if p_amount is not null and p_amount <> v_pay.amount then
    update public.payments
    set status = 'mismatch', gateway_trade_no = p_gateway_trade_no,
        method = coalesce(p_method, method), raw = p_raw, updated_at = now()
    where id = v_pay.id;
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch',
                              'expected', v_pay.amount, 'got', p_amount);
  end if;

  update public.payments
  set status = 'paid', gateway_trade_no = p_gateway_trade_no,
      method = coalesce(p_method, method), raw = p_raw,
      paid_at = now(), updated_at = now()
  where id = v_pay.id;

  -- 續約從「原到期日」起算而不是從今天，和 admin_set_subscription() 一致：
  -- 客戶提早繳費不該被吃掉剩下的天數。
  -- 副作用是中途升級時，便宜方案剩下的天數會按原值折到貴的方案上。
  -- 這是刻意的——為了幾天的差額去做按比例換算，會換來一堆看不懂帳單的客訴。
  select greatest(coalesce(current_period_end, now()), now()) into v_end
  from public.subscriptions where company_id = v_pay.company_id;
  v_end := coalesce(v_end, now()) + make_interval(months => v_pay.months);

  insert into public.subscriptions
    (company_id, plan, status, current_period_end, gateway, updated_at)
  values
    (v_pay.company_id, v_pay.plan, 'active', v_end, v_pay.gateway, now())
  on conflict (company_id) do update set
    plan = excluded.plan,
    status = 'active',
    current_period_end = excluded.current_period_end,
    gateway = excluded.gateway,
    updated_at = now();

  return jsonb_build_object('ok', true, 'duplicate', false,
                            'company_id', v_pay.company_id,
                            'plan', v_pay.plan, 'until', v_end);
end;
$fn$;

revoke all on function public.pay_mark_paid(text, text, int, text, jsonb) from public, anon, authenticated;
grant execute on function public.pay_mark_paid(text, text, int, text, jsonb) to service_role;


-- ── 5. 交易失敗 ───────────────────────────────────────────
-- 和銷帳分開兩支，是為了讓「會動到訂閱的那一支」盡量短、盡量好讀。
create or replace function public.pay_mark_failed(
  p_trade_no         text,
  p_gateway_trade_no text,
  p_raw              jsonb
)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_pay record;
begin
  select * into v_pay from public.payments where trade_no = p_trade_no for update;
  if v_pay is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_trade_no');
  end if;
  -- 已經付款成功的單不能被「失敗」通知蓋掉。順序顛倒的重送是存在的。
  if v_pay.status = 'paid' then
    return jsonb_build_object('ok', true, 'ignored', 'already_paid');
  end if;
  update public.payments
  set status = 'failed', gateway_trade_no = p_gateway_trade_no,
      raw = p_raw, updated_at = now()
  where id = v_pay.id;
  return jsonb_build_object('ok', true);
end;
$fn$;

revoke all on function public.pay_mark_failed(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.pay_mark_failed(text, text, jsonb) to service_role;


-- ── 6. 清掉沒有下文的建單 ─────────────────────────────────
-- 使用者按了付款又關掉視窗，單子會一直掛在 pending。
-- 三天是給 ATM／超商代碼留的——那兩種付款方式本來就是隔幾天才去繳。
--
-- ⚠️ 這支只是打掃，不是對帳。真正的「幽靈交易」（使用者付了錢但
-- callback 沒送到）要靠主動查詢金流商的交易查詢 API 才能補正，
-- 那支需要金鑰，所以寫在後端而不是這裡。拿到金鑰前這個缺口是存在的。
create or replace function public.pay_expire_stale()
returns int
language plpgsql volatile security definer set search_path = public as $fn$
declare v_n int;
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    raise exception 'platform admin only';
  end if;
  update public.payments
  set status = 'expired', updated_at = now()
  where status = 'pending' and created_at < now() - interval '3 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

revoke all on function public.pay_expire_stale() from public, anon;
grant execute on function public.pay_expire_stale() to authenticated, service_role;

select cron.unschedule('expire-stale-payments')
where exists (select 1 from cron.job where jobname = 'expire-stale-payments');

-- 每天台北時間 02:20（cron 走 UTC）
select cron.schedule('expire-stale-payments', '20 18 * * *',
  'select public.pay_expire_stale()');
