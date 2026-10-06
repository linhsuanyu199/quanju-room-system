-- ═══════════════════════════════════════════════════════════
-- 成員角色權限：管理者專屬的資料不讓一般成員寫入
--
-- 為什麼需要這一份：
--   全系統的業務資料都存在單一的 company_kv 表（company_id + key + jsonb），
--   RLS 只檢查「是不是同一間公司」。所以在這份 SQL 之前，前端那些
--   isAdmin() 判斷全部都只是「把按鈕藏起來」——任何一般成員打開
--   DevTools 輸入一行 Cloud.set('qj_cdata', {...}) 就能改掉房東契約、
--   保證租金、撥款帳戶、官網對外資訊、所有排程設定。
--   同樣的手法也能直接打 REST API，連畫面都不用開。
--
--   真正的攔阻只能放在資料庫。前端的 adminOnly() 留著，但它的作用
--   只是「讓人在填完整張表單之前就知道自己沒有權限」，不是防線。
--
-- 設計決定：
--   1. 用「一般成員可寫的白名單」，不是「管理者專屬的黑名單」。
--      黑名單的失敗方式是：日後新增功能、新增一個 key、忘記登記，
--      那個 key 就無聲地對所有成員開放——沒有人會發現。
--      白名單的失敗方式是：忘記登記的 key 對一般成員報錯，
--      錯誤訊息會直接印出 key 名稱，當天就會被回報。
--      權限的設計要讓「忘記」往安全的那一邊倒。
--   2. 查不到 profiles 列就放行（auth.uid() 為 null 的情況：
--      service_role、pg_cron、還原備份的後台路徑）。這不是漏洞——
--      company_kv 的 RLS 要求 company_id = get_my_company_id()，
--      匿名使用者的 get_my_company_id() 是 null，本來就一列都寫不到。
--   3. role 為 null 視為一般成員，與前端 isAdmin()（role === 'admin'）
--      和 set_member_role() 的 `is distinct from 'admin'` 一致。
--   4. 一般成員完全不能 DELETE company_kv 的任何一列。
--      Cloud.set() 只會 upsert，前端從來不刪列，所以沒有任何正常功能
--      會被擋到；而直接打 REST API 刪掉 qj_bks 那一列，等於一次清空
--      全公司的訂單。這種操作不該存在，不是「限制在某幾個 key」。
--
-- ⚠️ 這份 SQL 不處理「讀取」。限制寫在第 5 段，請一併讀完再上線。
-- ⚠️ 執行順序：第 1、2 段（只建函數，零風險）→ 第 3 段空跑測試 → 第 4 段掛 trigger。
-- ═══════════════════════════════════════════════════════════


-- ── 1. 一般成員可以寫入的 key ─────────────────────────────
-- 判斷標準：這是「同仁每天的現場作業」，還是「老闆的主檔與設定」？
--
-- 一般成員可寫（日常作業）：
--   qj_bks        訂單
--   qj_tasks      維修／清潔任務（含費用歸屬）
--   qj_customers  客戶（黑名單與歸屬業務另由前端限制，見第 4 段）
--   qj_complaints 客訴紀錄
--   qj_estimates  估價紀錄
--   qj_checklists 入住／退房檢查表勾選
--   qj_greetlog   祝福寄送紀錄
--   qj_lease_ack  「已確認退租」標記
--   qj_roomlog    新上架／調降紀錄（登入時 syncRoomLog() 會自動寫，
--                 擋掉的話每個成員一登入就吃一個錯誤訊息）
--   qj_rent       租金收款登錄
--   qj_meters     水電抄表
--   qj_settle     退房結算（押金退還）
--   qj_hodraft    點交現場草稿
--   qj_hotask     點交對帳去重紀錄
--   qj_landlords  房東的生日／email／祝福意願／備註
--                 ← 刻意放在可寫：ldSaveProfile() 本來就設計成「同仁可以維護
--                   自己負責的房東的聯絡資料，只有管理者能改歸屬業務」。
--                   房東真正敏感的東西（身分證字號、戶籍地址、撥款帳戶、
--                   保證租金）不在這個 key，在管理者專屬的 qj_cdata。
--
-- 管理者專屬（主檔與設定）＝以上以外的全部，目前包含：
--   qj_cps / qj_ext / qj_ovr / qj_propinfo   館別與房間主檔、額外房間、覆寫租金、館別詳細資料
--   qj_cdata / qj_payout                     房東契約（身分證、帳戶、保證租金）、已撥款紀錄
--   qj_signer                                簽約主體（影響每一張電子契約）
--   qj_pub_info / qj_pub_vis                 官網對外資訊、官網上架房間
--   qj_todo_cfg / qj_rent_cfg /
--   qj_clean_cfg / qj_util_cfg               待辦門檻、租金寬限、清潔排程、水電費率
--   qj_equip                                 房間設備主檔（點交的比對基準）
--   qj_cleaners / qj_vendors                 清潔人員、維修廠商主檔
--   qj_backup_log                            備份紀錄
--
-- 這個切法有一條刻意的規律：
--   同仁可以「做那件事」，但不能改「算那件事用的數字」。
--   可以做退房結算，不能改水電費率；可以登租金收款，不能改寬限天數；
--   可以點交，不能改設備主檔；可以派清潔，不能改清潔排程與人員主檔。
create or replace function public.kv_member_writable(p_key text)
returns boolean
language sql immutable set search_path = public as $$
  select p_key in (
    'qj_bks', 'qj_tasks', 'qj_customers', 'qj_complaints', 'qj_estimates',
    'qj_checklists', 'qj_greetlog', 'qj_lease_ack', 'qj_roomlog',
    'qj_rent', 'qj_meters', 'qj_settle', 'qj_hodraft', 'qj_hotask',
    'qj_landlords'
  )
$$;

-- key 對應的中文名稱。錯誤訊息印「qj_cdata」沒有人看得懂，
-- 印「房東契約資料」同仁才知道自己按到了什麼、該找誰。
create or replace function public.kv_key_label(p_key text)
returns text
language sql immutable set search_path = public as $$
  select case p_key
    when 'qj_cps'        then '館別與房間主檔'
    when 'qj_ext'        then '額外房間'
    when 'qj_ovr'        then '房間租金設定'
    when 'qj_propinfo'   then '館別詳細資料與照片'
    when 'qj_cdata'      then '房東契約資料'
    when 'qj_payout'     then '房東撥款紀錄'
    when 'qj_signer'     then '簽約主體設定'
    when 'qj_pub_info'   then '官網設定'
    when 'qj_pub_vis'    then '官網房間上架'
    when 'qj_todo_cfg'   then '待辦提醒設定'
    when 'qj_rent_cfg'   then '租金寬限設定'
    when 'qj_clean_cfg'  then '清潔排程設定'
    when 'qj_util_cfg'   then '水電費率設定'
    when 'qj_equip'      then '房間設備主檔'
    when 'qj_cleaners'   then '清潔人員主檔'
    when 'qj_vendors'    then '維修廠商主檔'
    when 'qj_backup_log' then '備份紀錄'
    else '「' || p_key || '」'   -- 日後新增而還沒登記的 key，直接把名字印出來
  end
$$;


-- ── 2. 真正的鎖：company_kv 寫入前檢查角色 ────────────────
-- 註：OLD／NEW 在 PL/pgSQL 裡只有對應的操作才會被賦值。
-- INSERT 時碰 OLD.key 會直接拋 record "old" is not assigned yet，
-- 所以 key 必須分 TG_OP 取，不能寫成 coalesce(NEW.key, OLD.key)。
create or replace function public.tg_enforce_kv_role()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_role text;
  v_key  text;
begin
  -- 查不到 profiles 列＝不是以登入使用者的身分在寫（service_role／pg_cron）。
  -- 放行。這些路徑本來就繞過 RLS，不是這支 trigger 的守備範圍。
  select p.role into v_role from public.profiles p where p.id = auth.uid();
  if not found then
    if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
  end if;

  if v_role is not distinct from 'admin' then
    if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
  end if;

  -- 一般成員一律不得刪列。前端的 Cloud.set() 只會 upsert，
  -- 沒有任何正常功能會走到這裡；真走到了就是有人在打 API。
  if TG_OP = 'DELETE' then
    raise exception 'ROLE_ADMIN_ONLY'
      using hint = '只有企業管理者可以刪除「' || public.kv_key_label(OLD.key) ||
                   '」。您的變更沒有存上去。';
  end if;

  v_key := NEW.key;
  if not public.kv_member_writable(v_key) then
    raise exception 'ROLE_ADMIN_ONLY'
      using hint = '只有企業管理者可以修改「' || public.kv_key_label(v_key) ||
                   '」。您的變更沒有存上去，資料仍是原本的內容。';
  end if;

  -- UPDATE 不得把一列的 key 改掉：否則一般成員可以拿一列可寫的 qj_bks，
  -- 把 key 改成 qj_cdata，整包覆蓋掉房東契約（上面的白名單檢查看的是 NEW.key，
  -- 擋不住這一手，因為 NEW.key 可寫不代表 OLD.key 可寫）。
  if TG_OP = 'UPDATE' and NEW.key is distinct from OLD.key then
    raise exception 'ROLE_ADMIN_ONLY'
      using hint = '只有企業管理者可以搬動資料項目。您的變更沒有存上去。';
  end if;

  return NEW;
end;
$fn$;

-- 這一段只建函數，還沒掛上 trigger。掛上去在第 4 段，
-- 先跑第 3 段的空跑測試確認過再掛。


-- ── 3. 空跑測試：先驗證再上線，全程不留痕跡 ────────────────
-- 把下面整段（去掉註解符號）貼進 Supabase SQL editor 執行。
--
-- 原理：Postgres 的 DDL 也在交易內，所以這段自己 create trigger、測完再用
-- raise exception 把整個交易回捲——trigger、測試寫入、暫時改掉的角色，
-- 全部一起消失。結果會印在錯誤訊息裡（SQL editor 的結果表格是虛擬捲動，
-- 用 exception 回報比去讀表格可靠得多）。看到 VERDICT 每一項都 ok 才上線。
--
-- 做法：挑一間真的有資料的公司和它的管理者，在交易內把他暫時降成 member，
-- 用 request.jwt.claims 模擬他的身分去寫幾個 key，看擋不擋。
-- 每個檢查各自包在 exception 區塊內（plpgsql 會自動下 savepoint），
-- 所以被擋下來不會中斷後面的檢查。
/*
begin;

drop trigger if exists enforce_kv_role on public.company_kv;
create trigger enforce_kv_role
  before insert or update or delete on public.company_kv
  for each row execute function public.tg_enforce_kv_role();

do $t$
declare
  o        text := '';
  v_co     uuid;
  v_uid    uuid;
  v_orig   text;
begin
  select p.company_id, p.id, p.role into v_co, v_uid, v_orig
  from public.profiles p
  join public.company_kv k on k.company_id = p.company_id
  where p.role = 'admin' and coalesce(p.active, true)
  limit 1;

  if v_uid is null then
    raise exception 'VERDICT ==>找不到任何有資料的公司管理者，無法測試<==';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

  -- (A) 管理者寫管理者專屬 key → 應該成功
  update public.profiles set role = 'admin' where id = v_uid;
  begin
    insert into public.company_kv (company_id, key, value)
    values (v_co, 'qj_cdata', '{"_t":1}'::jsonb)
    on conflict (company_id, key) do update set value = excluded.value;
    o := o || ' [A admin寫qj_cdata=ok]';
  exception when others then
    o := o || ' [A admin寫qj_cdata=FAIL ' || coalesce(SQLERRM, '?') || ']';
  end;

  update public.profiles set role = 'member' where id = v_uid;

  -- (B) 一般成員寫管理者專屬 key → 應該被擋
  begin
    insert into public.company_kv (company_id, key, value)
    values (v_co, 'qj_cdata', '{"_t":2}'::jsonb)
    on conflict (company_id, key) do update set value = excluded.value;
    o := o || ' [B member寫qj_cdata=FAIL 竟然成功]';
  exception when others then
    o := o || ' [B member寫qj_cdata=' ||
      case when coalesce(SQLERRM,'') = 'ROLE_ADMIN_ONLY' then 'ok擋下'
           else 'FAIL 其他錯誤 ' || coalesce(SQLERRM,'?') end || ']';
  end;

  -- (C) 一般成員寫日常作業 key → 應該成功
  begin
    insert into public.company_kv (company_id, key, value)
    values (v_co, 'qj_roomlog', coalesce(
      (select value from public.company_kv where company_id = v_co and key = 'qj_roomlog'),
      '{}'::jsonb))
    on conflict (company_id, key) do update set value = excluded.value;
    o := o || ' [C member寫qj_roomlog=ok]';
  exception when others then
    o := o || ' [C member寫qj_roomlog=FAIL ' || coalesce(SQLERRM,'?') || ']';
  end;

  -- (D) 一般成員刪列 → 應該被擋
  begin
    delete from public.company_kv where company_id = v_co and key = 'qj_roomlog';
    o := o || ' [D member刪列=FAIL 竟然成功]';
  exception when others then
    o := o || ' [D member刪列=' ||
      case when coalesce(SQLERRM,'') = 'ROLE_ADMIN_ONLY' then 'ok擋下'
           else 'FAIL 其他錯誤 ' || coalesce(SQLERRM,'?') end || ']';
  end;

  -- (E) 沒有登入身分（service_role 路徑）→ 應該放行
  perform set_config('request.jwt.claims', '', true);
  begin
    insert into public.company_kv (company_id, key, value)
    values (v_co, 'qj_cdata', '{"_t":3}'::jsonb)
    on conflict (company_id, key) do update set value = excluded.value;
    o := o || ' [E 無身分寫qj_cdata=ok放行]';
  exception when others then
    o := o || ' [E 無身分寫qj_cdata=FAIL ' || coalesce(SQLERRM,'?') || ']';
  end;

  -- (F) 一般成員把可寫的列改名成管理者專屬的 key → 應該被擋
  --     （只檢查 NEW.key 的話這一手會過，等於用訂單那一列覆蓋掉房東契約）
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  begin
    update public.company_kv set key = 'qj_cdata'
    where company_id = v_co and key = 'qj_roomlog';
    o := o || ' [F member改key=' ||
      case when found then 'FAIL 竟然成功' else 'ok沒有列可改（略過）' end || ']';
  exception when others then
    o := o || ' [F member改key=' ||
      case when coalesce(SQLERRM,'') = 'ROLE_ADMIN_ONLY' then 'ok擋下'
           else 'FAIL 其他錯誤 ' || coalesce(SQLERRM,'?') end || ']';
  end;

  -- (G) 中文標籤有出來（錯誤訊息要看得懂），未登記的新 key 會印出名字
  o := o || ' [G 標籤=' || coalesce(public.kv_key_label('qj_cdata'), '?') ||
       '/' || coalesce(public.kv_key_label('qj_zzz_new'), '?') || ']';

  -- exception 會把整個交易回捲：上面所有寫入、暫時改掉的角色、
  -- 以及這段自己建的 trigger，全部不留痕跡
  raise exception 'VERDICT ==>%<==', o;
end $t$;

rollback;
*/


-- ── 4. 正式掛上 trigger（第 3 段 VERDICT 全部 ok 之後才執行）──
-- 與 enforce_subscription 同為 company_kv 的 before 觸發器。
-- 同一時機的 trigger 依名稱字母序執行，enforce_kv_role < enforce_subscription，
-- 所以角色檢查會先跑。誰先都不影響結果：任一支擋下來就整筆寫入失敗。
drop trigger if exists enforce_kv_role on public.company_kv;
create trigger enforce_kv_role
  before insert or update or delete on public.company_kv
  for each row execute function public.tg_enforce_kv_role();


-- ── 5. ⚠️ 這份 SQL 沒有處理的事：讀取權限 ──────────────────
-- 一般成員仍然「讀得到」全公司的 company_kv，包含：
--   qj_cdata     房東的身分證字號、戶籍地址、撥款銀行帳戶、保證租金金額
--   qj_landlords 全部房東的電話、生日、備註（不只他自己負責的那些）
--   qj_payout    每個館別每個月撥了多少錢給房東
--   qj_cps       全部館別的服務類型與房間租金
--
-- 前端的 ldVisible()、visibleCustomers() 只是把別人的資料從畫面上過濾掉；
-- 整包 JSON 早就在瀏覽器裡了，F12 看 KV_CACHE 就全部看得到。
--
-- 為什麼不在這一輪一起修：
--   RLS 的單位是「列」。qj_cdata 是「一列裡的一個 JSON」，
--   所有房東都在同一列。RLS 做不到「同一列裡只讓你看到某幾個 key」。
--   要真正做到讀取隔離，只有一條路：把房東資料從 company_kv 搬出來，
--   變成一張自己的表（一個房東一列，加上 owner 欄位），
--   像 contracts / handovers / tenant_links 那樣。那是結構遷移，
--   要一併改掉 landlords.js / payout.js / pnl.js / contracts-admin.js
--   以及備份匯出／還原的格式，不是加一支 trigger 能解決的。
--
-- 同一個理由也讓「JSON 內的欄位層級限制」做不到。例如：
--   qj_customers 的黑名單標記與歸屬業務、qj_landlords 的歸屬業務，
--   前端只讓管理者改，但那三個欄位和一般成員本來就能改的欄位
--   （生日、備註）同在一包 JSON 裡。trigger 只看得到「這包 JSON 可不可以寫」，
--   看不到「這包裡的哪一個欄位被動到了」。真要擋就得逐欄位比對新舊 JSON，
--   那等於把業務規則複製一份到資料庫，兩邊日後一定會長歪。
--   所以這兩項維持前端限制，一併列在下面的「不能防刻意」裡。
--
-- 現階段的真實保護範圍，要對業者講清楚：
--   ✅ 一般成員改不動主檔與設定（這份 SQL，資料庫層，改不掉）
--   ✅ 一般成員看不到月損益總表（openPnl 擋在函數內）
--   ✅ 一般成員畫面上只看到自己負責的房東與客戶
--   ❌ 一般成員若懂得開 DevTools，看得到全部房東與客戶的原始資料
--   ❌ 一般成員若懂得開 DevTools，能改掉客戶黑名單與歸屬業務（同一包 JSON）
--
-- 也就是說：目前的成員權限能防「誤改」與「越權操作」，
-- 但不能防「刻意翻看」。會接觸房東個資的人，還是要靠聘僱合約與保密條款。
-- 真正要擋住的話，請排一輪「房東資料獨立成表」的遷移。
