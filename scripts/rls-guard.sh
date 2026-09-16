#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# RLS 迴歸檢查
# 用「未登入的 anon 金鑰」去打每一張含機敏資料的表，確認：
#   讀取 → 只能拿到 0 筆（RLS 過濾掉）或直接被拒
#   寫入 → 一律被拒
#
# 這支的用途是「防止哪天改 schema 或加新表時，不小心把資料打開」。
# 只要有任何一張表回傳到實際資料，就是外洩，立刻 exit 1。
#
# 本機執行：
#   ROOM_ANON_KEY=xxx YIJING_ANON_KEY=xxx bash scripts/rls-guard.sh
# ──────────────────────────────────────────────────────────────
set -uo pipefail

ROOM_REF=cvryjcdcrebdnlemgabs
YIJING_REF=nplhrijsnkyfiourjdcm

ROOM_ANON_KEY=${ROOM_ANON_KEY:-}
YIJING_ANON_KEY=${YIJING_ANON_KEY:-}

FAILED=()
ok()  { printf '  ✅ %-40s %s\n' "$1" "$2"; }
bad() { printf '  ❌ %-40s %s\n' "$1" "$2"; FAILED+=("$1 → $2"); }

# 未登入讀取：合格 = 200 但空陣列（RLS 濾光）或 401/403（連 GRANT 都沒有）
check_read_blocked() {
  local ref=$1 table=$2 key=$3
  local body code resp
  resp=$(curl -s -w $'\n%{http_code}' -m 20 \
    "https://$ref.supabase.co/rest/v1/$table?select=*&limit=3" -H "apikey: $key")
  code=$(printf '%s' "$resp" | tail -n1)
  body=$(printf '%s' "$resp" | sed '$d')

  case "$code" in
    401|403) ok "$table 讀取" "HTTP $code 直接拒絕" ;;
    200)
      if [ "$(printf '%s' "$body" | tr -d '[:space:]')" = "[]" ]; then
        ok "$table 讀取" "HTTP 200 但 0 筆（RLS 生效）"
      else
        bad "$table 讀取" "⚠️ 未登入竟讀到資料：$(printf '%s' "$body" | head -c 160)"
      fi ;;
    404) ok "$table 讀取" "HTTP 404 表不存在（略過）" ;;
    *)   bad "$table 讀取" "非預期 HTTP $code" ;;
  esac
}

# 未登入寫入：合格 = 401/403/404，或 400 但錯誤碼為 42501（違反 RLS）
check_write_blocked() {
  local ref=$1 table=$2 key=$3 payload=$4
  local body code resp
  resp=$(curl -s -w $'\n%{http_code}' -m 20 -X POST \
    "https://$ref.supabase.co/rest/v1/$table" \
    -H "apikey: $key" -H "Content-Type: application/json" -d "$payload")
  code=$(printf '%s' "$resp" | tail -n1)
  body=$(printf '%s' "$resp" | sed '$d')

  case "$code" in
    401|403|404) ok "$table 寫入" "HTTP $code 被拒" ;;
    400|409|422)
      if printf '%s' "$body" | grep -q '42501'; then
        ok "$table 寫入" "HTTP $code / 42501 違反 RLS"
      else
        ok "$table 寫入" "HTTP $code 被拒（$(printf '%s' "$body" | head -c 80)）"
      fi ;;
    200|201)
      bad "$table 寫入" "🚨 未登入竟寫入成功！" ;;
    *)   bad "$table 寫入" "非預期 HTTP $code：$(printf '%s' "$body" | head -c 120)" ;;
  esac
}

echo "═══ 排房系統（$ROOM_REF）═══"
if [ -z "$ROOM_ANON_KEY" ]; then
  bad "排房" "缺少 ROOM_ANON_KEY"
else
  for t in companies profiles company_kv inquiries market_deals; do
    check_read_blocked "$ROOM_REF" "$t" "$ROOM_ANON_KEY"
  done
  check_write_blocked "$ROOM_REF" companies  "$ROOM_ANON_KEY" '{"name":"RLS_GUARD_PROBE","invite_code":"GUARD00"}'
  check_write_blocked "$ROOM_REF" company_kv "$ROOM_ANON_KEY" '{"company_id":"00000000-0000-0000-0000-000000000000","key":"probe","value":[]}'
fi

echo
echo "═══ 易經／八字／星座（$YIJING_REF）═══"
if [ -z "$YIJING_ANON_KEY" ]; then
  bad "術數" "缺少 YIJING_ANON_KEY"
else
  for t in profiles readings bazi_readings astro_readings astro_synastry; do
    check_read_blocked "$YIJING_REF" "$t" "$YIJING_ANON_KEY"
  done
  check_write_blocked "$YIJING_REF" readings "$YIJING_ANON_KEY" '{"user_id":"00000000-0000-0000-0000-000000000000","type":"RLS_GUARD_PROBE"}'
fi

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "RLS 全部把關正常（$(date '+%Y-%m-%d %H:%M') UTC）"
  exit 0
fi

echo "以下 ${#FAILED[@]} 項需要處理："
printf '  - %s\n' "${FAILED[@]}"
exit 1
