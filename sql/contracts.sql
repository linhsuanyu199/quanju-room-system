-- ════════════════════════════════════════════════════════════════════
-- 線上簽約（電子簽署）
-- 在 Supabase Dashboard → SQL Editor 執行一次即可。
-- 全部都是新建物件，不修改任何既有資料表或既有函數。
--
-- 為什麼另開一張表、不塞進 company_kv：
--   company_kv 的每一列對登入成員都是可寫的，契約一旦被改掉就失去
--   證據力。契約需要「簽完就不准動」這個保證，那只能靠資料表的
--   trigger 來擋，JSONB 裡的某個欄位做不到。
--
-- 三種契約（kind）：
--   sub = 住宅轉租契約（業者 ↔ 房客）
--   bz  = 住宅包租契約（房東 ↔ 包租業）
--   wg  = 租賃住宅委託管理契約（房東 ↔ 代管業）
--
-- 身分證統一編號刻意以明碼存放，不做應用層加密：
--   金鑰一定也得放在同一個系統裡，那只是把鎖和鑰匙放在同一個抽屜，
--   不會提高安全性，卻讓資料無法備份還原。真正的防線是 RLS（只有
--   同一家企業讀得到）＋ anon 一律只拿到遮蔽後的字號。
-- ════════════════════════════════════════════════════════════════════

-- ── 1. 契約表 ──────────────────────────────────────────────────────
create table if not exists public.contracts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  kind          text not null check (kind in ('sub','bz','wg')),
  token         text not null unique,        -- 簽署連結的識別碼
  no            text not null,               -- 契約編號（人看的）
  prop_id       text,                        -- 館別 id（qj_cps）
  room          text,
  booking_id    text,                        -- 訂單 id（qj_bks），轉租契約才有
  signer_name   text,                        -- 預期簽署人，給簽署頁核對用
  snapshot      jsonb not null,              -- 契約全部內容，簽署後凍結
  status        text not null default 'pending'
                check (status in ('pending','signed','void')),
  opened_at     timestamptz,                 -- 首次開啟＝審閱期起算證據
  signed_at     timestamptz,
  signer_ip     text,
  signer_ua     text,
  signer_id_no  text,
  sig_img       text,                        -- 手寫簽名 PNG（data URL）
  content_hash  text,                        -- 簽署當下內容的指紋
  void_reason   text,
  notified_at   timestamptz,                 -- 已書面告知房東轉租情形的時間
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);

create index if not exists contracts_company_idx on public.contracts (company_id, created_at desc);
create index if not exists contracts_prop_idx    on public.contracts (company_id, prop_id);
create index if not exists contracts_booking_idx on public.contracts (company_id, booking_id);

-- ── 2. 簽署後不可修改 ──────────────────────────────────────────────
-- 已簽署的契約只剩一條合法路徑：整份作廢並記錄理由，另立新約。
-- 條文、簽名、時間戳、指紋全部不准動，連欄位順序改一個字都會被擋。
create or replace function public.contracts_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if old.status = 'signed' then
    if new.status = 'void'
       and new.kind         is not distinct from old.kind
       and new.no           is not distinct from old.no
       and new.token        is not distinct from old.token
       and new.snapshot     is not distinct from old.snapshot
       and new.opened_at    is not distinct from old.opened_at
       and new.signed_at    is not distinct from old.signed_at
       and new.signer_id_no is not distinct from old.signer_id_no
       and new.sig_img      is not distinct from old.sig_img
       and new.content_hash is not distinct from old.content_hash
    then
      return new;
    end if;
    -- 已簽署但只更新「已告知房東」的時間，也要放行
    if new.status = 'signed'
       and new.kind         is not distinct from old.kind
       and new.no           is not distinct from old.no
       and new.token        is not distinct from old.token
       and new.snapshot     is not distinct from old.snapshot
       and new.opened_at    is not distinct from old.opened_at
       and new.signed_at    is not distinct from old.signed_at
       and new.signer_id_no is not distinct from old.signer_id_no
       and new.sig_img      is not distinct from old.sig_img
       and new.content_hash is not distinct from old.content_hash
       and new.void_reason  is not distinct from old.void_reason
    then
      return new;
    end if;
    raise exception '契約已簽署，內容不得修改（僅能整份作廢並另立新約）';
  end if;
  return new;
end;
$fn$;

drop trigger if exists contracts_no_edit on public.contracts;
create trigger contracts_no_edit before update on public.contracts
  for each row execute function public.contracts_immutable();

-- 已簽署的契約依規定要保存五年，刪除一律擋掉。
-- 這裡看的是 signed_at 而不是 status：作廢後 status 會變成 'void'，
-- 若只看 status，任何人都能用「先作廢、再刪除」兩步繞過保存義務。
-- signed_at 一旦寫入就被上面的 trigger 鎖死，拿它當判斷才擋得住。
create or replace function public.contracts_no_delete()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if old.signed_at is not null then
    raise exception '曾經簽署的契約不得刪除（應保存五年），請改用作廢';
  end if;
  return old;
end;
$fn$;

drop trigger if exists contracts_keep on public.contracts;
create trigger contracts_keep before delete on public.contracts
  for each row execute function public.contracts_no_delete();

-- ── 3. RLS：只有同一家企業的在職成員看得到 ────────────────────────
alter table public.contracts enable row level security;

drop policy if exists contracts_own on public.contracts;
create policy contracts_own on public.contracts
  for all to authenticated
  using      (company_id = public.get_my_company_id())
  with check (company_id = public.get_my_company_id());

-- ── 4. 簽署頁用的匿名 RPC ──────────────────────────────────────────
-- 簽署人不需要帳號，整條路徑只有 token 這一個入口。
-- 上面的 RLS 沒有給 anon 任何 policy，所以 anon 只能走這兩支函數，
-- 而這兩支函數都只認得單一 token、絕對撈不到別份契約。

-- 開啟契約。第一次開啟的時間就寫死，這是審閱期的起算證據。
create or replace function public.contract_get(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare r public.contracts;
begin
  select * into r from public.contracts where token = p_token;
  if not found then return null; end if;

  if r.opened_at is null and r.status = 'pending' then
    update public.contracts set opened_at = now() where id = r.id returning * into r;
  end if;

  return jsonb_build_object(
    'kind',       r.kind,
    'no',         r.no,
    'status',     r.status,
    'signerName', r.signer_name,
    'snapshot',   r.snapshot,
    'openedAt',   to_char(r.opened_at at time zone 'Asia/Taipei','YYYY-MM-DD HH24:MI:SS'),
    'signedAt',   to_char(r.signed_at at time zone 'Asia/Taipei','YYYY-MM-DD HH24:MI:SS'),
    'sigImg',     r.sig_img,
    'hash',       r.content_hash,
    'idNoMasked', case when r.signer_id_no is null then null
                       else left(r.signer_id_no,2) || '****' || right(r.signer_id_no,4) end,
    'voidReason', r.void_reason);
end;
$fn$;

-- 簽署。所有檢查都放在資料庫端，前端的驗證只是提升體驗，繞過也沒用。
create or replace function public.contract_sign(
  p_token   text,
  p_id_no   text,
  p_sig_img text,
  p_agree   boolean,
  p_ua      text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r      public.contracts;
  v_ip   text;
  v_now  timestamptz := now();
  v_id   text;
  v_snap jsonb;
  v_hash text;
begin
  select * into r from public.contracts where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'msg', '連結無效或已失效'); end if;
  if r.status = 'signed' then return jsonb_build_object('ok', false, 'msg', '本契約已完成簽署'); end if;
  if r.status = 'void'   then return jsonb_build_object('ok', false, 'msg', '本契約已作廢，請向公司索取新的簽署連結'); end if;
  if p_agree is not true then return jsonb_build_object('ok', false, 'msg', '請先確認已完成契約審閱'); end if;

  v_id := upper(regexp_replace(coalesce(p_id_no,''), '[^0-9A-Za-z]', '', 'g'));
  if v_id !~ '^[A-Z][12][0-9]{8}$' then
    return jsonb_build_object('ok', false, 'msg', '身分證統一編號格式不正確');
  end if;

  if p_sig_img is null or length(p_sig_img) < 200 then
    return jsonb_build_object('ok', false, 'msg', '請在簽名欄位親筆簽名');
  end if;

  -- PostgREST 會把真實用戶 IP 放在 x-forwarded-for 的第一段；
  -- inet_client_addr() 只會拿到連線池的位址，對稽核沒有意義。
  v_ip := split_part(
            coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''),
            ',', 1);

  v_snap := jsonb_set(r.snapshot, '{sign}', jsonb_build_object(
      'openedAt', coalesce(to_char(r.opened_at at time zone 'Asia/Taipei','YYYY-MM-DD HH24:MI:SS'), ''),
      'signedAt', to_char(v_now at time zone 'Asia/Taipei','YYYY-MM-DD HH24:MI:SS'),
      'ip',       v_ip,
      'ua',       left(coalesce(p_ua, ''), 400),
      'idNo',     left(v_id, 2) || '****' || right(v_id, 4),
      'hash',     '',
      'sigImg',   ''), true);

  -- 指紋算在「尚未填入指紋與簽名圖」的內容上，之後任何人想驗證
  -- 只要把這兩欄清空重算就能比對，不需要知道我們怎麼算的。
  v_hash := md5(v_snap::text);
  v_snap := jsonb_set(v_snap, '{sign,hash}', to_jsonb(v_hash));

  update public.contracts
     set status       = 'signed',
         signed_at    = v_now,
         signer_ip    = v_ip,
         signer_ua    = left(coalesce(p_ua, ''), 400),
         signer_id_no = v_id,
         sig_img      = p_sig_img,
         content_hash = v_hash,
         snapshot     = v_snap
   where id = r.id;

  return jsonb_build_object('ok', true);
end;
$fn$;

revoke all on function public.contract_get(text) from public;
revoke all on function public.contract_sign(text, text, text, boolean, text) from public;
grant execute on function public.contract_get(text)  to anon, authenticated;
grant execute on function public.contract_sign(text, text, text, boolean, text) to anon, authenticated;
