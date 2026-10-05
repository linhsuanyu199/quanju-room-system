-- ════════════════════════════════════════════════════════════════════
-- 入住／退房點交單（線上簽收）
-- 在 Supabase Dashboard → SQL Editor 執行一次即可。
-- 全部都是新建物件，不修改任何既有資料表或既有函數。
--
-- 為什麼另開一張表、不塞進 company_kv：
--   點交單是押金扣抵的唯一依據。company_kv 的每一列對登入成員都是
--   可寫的，房客簽完之後若還能被改金額或改歸責，這份簽名就失去意義。
--   「簽完就不准動」只能靠資料表的 trigger 來保證。
--
-- kind：
--   in  = 入住點交（交屋時共同確認設備狀態，建立「原狀」基準）
--   out = 退房點交（與入住基準比對，認定損壞與歸責）
--
-- 身分核對刻意用「訂單上登記的手機號碼」而不是身分證統一編號：
--   點交單於法令上並非必載身分證統一編號的文件，為了核對而多蒐集
--   一份敏感個資不符最小蒐集原則。手機號碼本來就為了聯絡而持有，
--   搭配只有當事人收得到的簽署連結，已足以證明簽署人身分。
-- ════════════════════════════════════════════════════════════════════

-- ── 1. 點交單 ──────────────────────────────────────────────────────
create table if not exists public.handovers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  kind          text not null check (kind in ('in','out')),
  token         text not null unique,       -- 簽收連結的識別碼
  no            text not null,              -- 點交編號（人看的）
  booking_id    text not null,              -- 訂單 id（qj_bks）
  prop_id       text,                       -- 館別 id（qj_cps）
  room          text,
  signer_name   text,                       -- 預期簽收人，印在單上給雙方核對
  signer_phone  text,                       -- 核對用（只存數字），一律不回傳給前端
  snapshot      jsonb not null,             -- 點交單全部內容，簽收後凍結
  status        text not null default 'pending'
                check (status in ('pending','signed','void')),
  opened_at     timestamptz,                -- 房客首次開啟連結的時間
  signed_at     timestamptz,
  signer_ip     text,
  signer_ua     text,
  sig_img       text,                       -- 手寫簽名 PNG（data URL）
  content_hash  text,                       -- 簽收當下內容的指紋
  void_reason   text,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);

create index if not exists handovers_company_idx on public.handovers (company_id, created_at desc);
create index if not exists handovers_booking_idx on public.handovers (company_id, booking_id);
create index if not exists handovers_prop_idx    on public.handovers (company_id, prop_id);

-- 同一筆訂單的同一個房間、同一種點交只會有一份有效的單。
-- 沒有這條的話，現場人員重複產生連結時會有兩份都能簽、金額還可能不同，
-- 房客簽了哪一份、押金該照哪一份扣，事後無從判斷。
-- 作廢（void）的不算，所以「作廢後重做」這條正常路徑不會被擋。
create unique index if not exists handovers_one_live
  on public.handovers (company_id, booking_id, coalesce(prop_id,''), coalesce(room,''), kind)
  where status <> 'void';

-- ── 2. 簽收後不可修改 ──────────────────────────────────────────────
-- 已簽收的點交單只剩一條合法路徑：整份作廢並記錄理由，重新點交。
-- 項目狀態、歸責、金額、簽名、時間戳、指紋全部不准動。
create or replace function public.handovers_immutable()
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
       and new.booking_id   is not distinct from old.booking_id
       and new.snapshot     is not distinct from old.snapshot
       and new.opened_at    is not distinct from old.opened_at
       and new.signed_at    is not distinct from old.signed_at
       and new.sig_img      is not distinct from old.sig_img
       and new.content_hash is not distinct from old.content_hash
    then
      return new;
    end if;
    raise exception '點交單已由房客簽收，內容不得修改（僅能整份作廢並重新點交）';
  end if;
  return new;
end;
$fn$;

drop trigger if exists handovers_no_edit on public.handovers;
create trigger handovers_no_edit before update on public.handovers
  for each row execute function public.handovers_immutable();

-- 已簽收的點交單是押金扣抵與損害賠償的證據，刪除一律擋掉。
-- 這裡看的是 signed_at 而不是 status：作廢後 status 會變成 'void'，
-- 若只看 status，任何人都能用「先作廢、再刪除」兩步把證據銷毀。
-- signed_at 一旦寫入就被上面的 trigger 鎖死，拿它當判斷才擋得住。
create or replace function public.handovers_no_delete()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if old.signed_at is not null then
    raise exception '已簽收的點交單不得刪除（為押金扣抵之依據），請改用作廢';
  end if;
  return old;
end;
$fn$;

drop trigger if exists handovers_keep on public.handovers;
create trigger handovers_keep before delete on public.handovers
  for each row execute function public.handovers_no_delete();

-- ── 3. RLS：只有同一家企業的在職成員看得到 ────────────────────────
alter table public.handovers enable row level security;

drop policy if exists handovers_own on public.handovers;
create policy handovers_own on public.handovers
  for all to authenticated
  using      (company_id = public.get_my_company_id())
  with check (company_id = public.get_my_company_id());

-- ── 4. 簽收頁用的匿名 RPC ──────────────────────────────────────────
-- 房客不需要帳號，整條路徑只有 token 這一個入口。
-- 上面的 RLS 沒有給 anon 任何 policy，所以 anon 只能走這兩支函數，
-- 而這兩支函數都只認得單一 token、絕對撈不到別份點交單。

-- 開啟點交單。第一次開啟的時間寫死一次，作為「房客確實收到並看過」的紀錄。
-- 刻意不回傳 signer_phone：它是核對用的答案，回傳就等於把答案印在考卷上。
create or replace function public.handover_get(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare r public.handovers;
begin
  select * into r from public.handovers where token = p_token;
  if not found then return null; end if;

  if r.opened_at is null and r.status = 'pending' then
    update public.handovers set opened_at = now() where id = r.id returning * into r;
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
    'voidReason', r.void_reason);
end;
$fn$;

-- 簽收。所有檢查都放在資料庫端，前端的驗證只是提升體驗，繞過也沒用。
create or replace function public.handover_sign(
  p_token   text,
  p_phone   text,
  p_sig_img text,
  p_agree   boolean,
  p_ua      text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r      public.handovers;
  v_ip   text;
  v_now  timestamptz := now();
  v_in   text;
  v_want text;
  v_snap jsonb;
  v_hash text;
begin
  select * into r from public.handovers where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'msg', '連結無效或已失效'); end if;
  if r.status = 'signed' then return jsonb_build_object('ok', false, 'msg', '本點交單已完成簽收'); end if;
  if r.status = 'void'   then return jsonb_build_object('ok', false, 'msg', '本點交單已作廢，請向承辦人索取新的簽收連結'); end if;
  if p_agree is not true then return jsonb_build_object('ok', false, 'msg', '請先勾選確認點交內容'); end if;

  v_in   := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_want := regexp_replace(coalesce(r.signer_phone, ''), '[^0-9]', '', 'g');
  if v_want = '' then
    return jsonb_build_object('ok', false, 'msg', '本單未登記核對用手機號碼，請聯繫承辦人重新產生連結');
  end if;
  if v_in <> v_want then
    return jsonb_build_object('ok', false, 'msg', '手機號碼與訂單紀錄不符，請確認後再試，或聯繫承辦人核對');
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
      'phone',    case when length(v_want) > 4
                       then repeat('*', length(v_want) - 4) || right(v_want, 4)
                       else v_want end,
      'hash',     '',
      'sigImg',   ''), true);

  -- 指紋算在「尚未填入指紋與簽名圖」的內容上，之後任何人想驗證
  -- 只要把這兩欄清空重算就能比對，不需要知道我們怎麼算的。
  v_hash := md5(v_snap::text);
  v_snap := jsonb_set(v_snap, '{sign,hash}', to_jsonb(v_hash));

  update public.handovers
     set status       = 'signed',
         signed_at    = v_now,
         signer_ip    = v_ip,
         signer_ua    = left(coalesce(p_ua, ''), 400),
         sig_img      = p_sig_img,
         content_hash = v_hash,
         snapshot     = v_snap
   where id = r.id;

  return jsonb_build_object('ok', true);
end;
$fn$;

revoke all on function public.handover_get(text) from public;
revoke all on function public.handover_sign(text, text, text, boolean, text) from public;
grant execute on function public.handover_get(text)  to anon, authenticated;
grant execute on function public.handover_sign(text, text, text, boolean, text) to anon, authenticated;
