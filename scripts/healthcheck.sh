#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# 全站健康檢查
# 檢查六個前端站點 + 兩個 Supabase 專案的 Auth / REST 是否存活。
#
# 本機執行：
#   ROOM_ANON_KEY=xxx YIJING_ANON_KEY=xxx bash scripts/healthcheck.sh
#
# 任何一項失敗即以 exit 1 結束，供 CI 判定並發出告警。
# ──────────────────────────────────────────────────────────────
set -uo pipefail

ROOM_REF=cvryjcdcrebdnlemgabs      # 排房系統
YIJING_REF=nplhrijsnkyfiourjdcm    # 易經 + 八字 + 星座 共用

ROOM_ANON_KEY=${ROOM_ANON_KEY:-}
YIJING_ANON_KEY=${YIJING_ANON_KEY:-}

FAILED=()

ok()  { printf '  ✅ %-46s %s\n' "$1" "$2"; }
bad() { printf '  ❌ %-46s %s\n' "$1" "$2"; FAILED+=("$1 → $2"); }

# 前端站點：預期 200
check_site() {
  local name=$1 url=$2 code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 --retry 2 --retry-delay 3 "$url")
  if [ "$code" = "200" ]; then ok "$name" "HTTP 200"; else bad "$name" "HTTP $code（預期 200）"; fi
}

# Supabase REST：必須打真實資料表。anon key 打 /rest/v1/ 根路徑只收 service_role，會回 401
check_rest() {
  local name=$1 ref=$2 table=$3 key=$4 code
  if [ -z "$key" ]; then bad "$name" "缺少 anon key（secret 未設定）"; return; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
    "https://$ref.supabase.co/rest/v1/$table?select=*&limit=1" -H "apikey: $key")
  if [ "$code" = "200" ]; then ok "$name" "HTTP 200"; else bad "$name" "HTTP $code（專案可能已暫停或金鑰失效）"; fi
}

# Supabase Auth：/auth/v1/settings 需帶 apikey。專案暫停時網域會解析不到（HTTP 000）
check_auth() {
  local name=$1 ref=$2 key=$3 code
  if [ -z "$key" ]; then bad "$name" "缺少 anon key（secret 未設定）"; return; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
    "https://$ref.supabase.co/auth/v1/settings" -H "apikey: $key")
  if [ "$code" = "200" ]; then ok "$name" "HTTP 200"; else bad "$name" "HTTP $code（000 代表網域解析失敗＝專案已暫停）"; fi
}

echo "═══ 前端站點 ═══"
check_site "排房系統 · 後台"      "https://quanju-room-system.vercel.app/"
check_site "排房系統 · 官網"      "https://quanju-room-system.vercel.app/public.html"
check_site "估價問卷"             "https://quanju-pricing.netlify.app/"
check_site "易經學習系統"         "https://yijing-wisdom.vercel.app/"
check_site "八字命理系統"         "https://bazi-mingli.netlify.app/"
check_site "星座命盤系統"         "https://astro-natal-chart.netlify.app/"
check_site "不動產經紀人衝刺班"   "https://broker-exam-app.vercel.app/"

echo
echo "═══ Supabase：排房系統（$ROOM_REF）═══"
check_auth "排房 Auth"  "$ROOM_REF" "$ROOM_ANON_KEY"
check_rest "排房 REST"  "$ROOM_REF" "companies" "$ROOM_ANON_KEY"

echo
echo "═══ Supabase：易經／八字／星座（$YIJING_REF）═══"
check_auth "術數 Auth"  "$YIJING_REF" "$YIJING_ANON_KEY"
check_rest "術數 REST"  "$YIJING_REF" "profiles" "$YIJING_ANON_KEY"

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "全部正常（$(date '+%Y-%m-%d %H:%M') UTC）"
  exit 0
fi

echo "以下 ${#FAILED[@]} 項異常："
printf '  - %s\n' "${FAILED[@]}"
exit 1
