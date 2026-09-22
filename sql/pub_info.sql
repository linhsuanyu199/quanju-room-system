-- ════════════════════════════════════════════════════════════════════
-- 官網頁尾聯絡資訊（qj_pub_info）
-- 在 Supabase Dashboard → SQL Editor 執行一次即可。
--
-- 為什麼另開一支 RPC 而不是改 public_company_listings：
--   後者是官網房源的命脈，改動失敗會讓整個地圖空白。聯絡資訊是獨立且
--   低頻的資料，拆成小函數就算出錯也只影響頁尾，房源照常顯示。
--
-- 回傳的欄位由後台「官網設定」寫入，只會有 intro/email/phone/line/hours，
-- 全是企業自己願意公開的對外聯絡方式，沒有房客或內部資料。
-- ════════════════════════════════════════════════════════════════════

create or replace function public.public_company_info(p_company_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select value
       from public.company_kv
      where company_id = p_company_id
        and key = 'qj_pub_info'),
    '{}'::jsonb)
  where exists (select 1 from public.companies where id = p_company_id);
$$;

revoke all on function public.public_company_info(uuid) from public;
grant execute on function public.public_company_info(uuid) to anon, authenticated;
