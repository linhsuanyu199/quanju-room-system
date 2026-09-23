-- ════════════════════════════════════════════════════════════════════
-- 官網的輔助資料：頁尾聯絡資訊（qj_pub_info）＋ 房間上架/降價紀錄（qj_roomlog）
-- 在 Supabase Dashboard → SQL Editor 執行一次即可。
--
-- 為什麼另開一支 RPC 而不是改 public_company_listings：
--   後者是官網房源的命脈，改動失敗會讓整個地圖空白。這兩包都是加值資訊，
--   拆成小函數就算出錯也只影響標籤與頁尾，房源照常顯示。
--
-- info    ← 後台「官網設定」寫入，只有 intro/email/phone/line/hours，
--           全是企業自己願意公開的對外聯絡方式。
-- roomlog ← 後台自動維護的 { pid: { 房號: {first, prev, at} } }，
--           first＝第一次出現的日期（判斷「新上架」），
--           prev/at＝上一次調價前的金額與日期（判斷「降價」）。
--           純數字與日期，不含房客或內部備註。
-- ════════════════════════════════════════════════════════════════════

create or replace function public.public_company_info(p_company_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'info', coalesce(
      (select value from public.company_kv
        where company_id = p_company_id and key = 'qj_pub_info'), '{}'::jsonb),
    'roomlog', coalesce(
      (select value from public.company_kv
        where company_id = p_company_id and key = 'qj_roomlog'), '{}'::jsonb))
  where exists (select 1 from public.companies where id = p_company_id);
$$;

revoke all on function public.public_company_info(uuid) from public;
grant execute on function public.public_company_info(uuid) to anon, authenticated;
