-- ════════════════════════════════════════════════════════════════════
-- 房源照片 Storage 設定
-- 在 Supabase Dashboard → SQL Editor 執行一次即可。
--
-- 設計重點：
--   1. 檔案路徑第一段固定是 company_id（前端 Cloud.uploadPhoto 產生），
--      寫入／刪除的 policy 就比對這一段，達成跟 company_kv 相同的企業隔離。
--   2. bucket 設為 public：官網 public.html 的訪客沒有登入，必須能直接讀圖。
--      公開的只有「圖片本身」，路徑是隨機檔名，不含門牌或房客資料。
--   3. 限制 5MB 與影像 MIME，避免被當成免費檔案空間。
-- ════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('prop-photos', 'prop-photos', true, 5242880,
        array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 任何人都可以讀（官網訪客未登入）
drop policy if exists prop_photos_public_read on storage.objects;
create policy prop_photos_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'prop-photos');

-- 只能上傳到自己公司的資料夾
drop policy if exists prop_photos_own_insert on storage.objects;
create policy prop_photos_own_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'prop-photos'
    and (storage.foldername(name))[1] = get_my_company_id()::text
  );

-- 只能刪自己公司的照片
drop policy if exists prop_photos_own_delete on storage.objects;
create policy prop_photos_own_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'prop-photos'
    and (storage.foldername(name))[1] = get_my_company_id()::text
  );

-- 覆寫同名檔（upsert）也一併限制在自己公司資料夾內
drop policy if exists prop_photos_own_update on storage.objects;
create policy prop_photos_own_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'prop-photos'
    and (storage.foldername(name))[1] = get_my_company_id()::text
  );
