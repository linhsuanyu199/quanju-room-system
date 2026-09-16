#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# 站外資料備份（本機執行，不進 CI）
#
# 為什麼不放 GitHub Actions：這支需要 service_role 金鑰，那把鑰匙會繞過
# 所有 RLS、可讀寫全部租戶的資料。它不該長期存放在任何 CI 平台上。
# 需要備份時，臨時從 Supabase Dashboard 複製金鑰、跑完就關掉終端機。
#
# 金鑰位置：Dashboard → Project Settings → API → service_role（secret）
#
# 用法：
#   ROOM_SERVICE_KEY='...' YIJING_SERVICE_KEY='...' bash scripts/backup.sh
#   只想備其中一個就只給那一把。
#
# 輸出：backups/YYYY-MM-DD_HHMM/<專案>/<資料表>.json
# ──────────────────────────────────────────────────────────────
set -uo pipefail

ROOM_REF=cvryjcdcrebdnlemgabs
YIJING_REF=nplhrijsnkyfiourjdcm

ROOM_SERVICE_KEY=${ROOM_SERVICE_KEY:-}
YIJING_SERVICE_KEY=${YIJING_SERVICE_KEY:-}

ROOM_TABLES="companies profiles company_kv inquiries market_deals complaints"
YIJING_TABLES="profiles readings bazi_readings astro_readings astro_synastry"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/backups/$(date '+%Y-%m-%d_%H%M')"

dump_table() {
  local ref=$1 table=$2 key=$3 dir=$4
  local resp code
  resp=$(curl -s -w $'\n%{http_code}' -m 120 \
    "https://$ref.supabase.co/rest/v1/$table?select=*" \
    -H "apikey: $key" -H "Authorization: Bearer $key")
  code=$(printf '%s' "$resp" | tail -n1)
  if [ "$code" != "200" ]; then
    printf '  ⚠️  %-18s HTTP %s（略過）\n' "$table" "$code"
    return
  fi
  printf '%s' "$resp" | sed '$d' > "$dir/$table.json"
  printf '  ✅ %-18s %s 筆  %s\n' "$table" \
    "$(grep -o '"id"' "$dir/$table.json" 2>/dev/null | wc -l | tr -d ' ')" \
    "$(du -h "$dir/$table.json" | cut -f1)"
}

dump_auth_users() {
  local ref=$1 key=$2 dir=$3
  local resp code
  resp=$(curl -s -w $'\n%{http_code}' -m 120 \
    "https://$ref.supabase.co/auth/v1/admin/users?per_page=1000" \
    -H "apikey: $key" -H "Authorization: Bearer $key")
  code=$(printf '%s' "$resp" | tail -n1)
  if [ "$code" != "200" ]; then
    printf '  ⚠️  %-18s HTTP %s（略過）\n' "auth_users" "$code"
    return
  fi
  # 密碼是單向雜湊、API 不會回傳，備份不含密碼；還原時使用者需重設密碼。
  printf '%s' "$resp" | sed '$d' > "$dir/auth_users.json"
  printf '  ✅ %-18s %s\n' "auth_users" "$(du -h "$dir/auth_users.json" | cut -f1)"
}

backup_project() {
  local label=$1 ref=$2 key=$3 tables=$4
  if [ -z "$key" ]; then
    echo "═══ $label ═══"; echo "  （未提供金鑰，略過）"; echo; return
  fi
  local dir="$OUT/$label"
  mkdir -p "$dir"
  echo "═══ $label（$ref）═══"
  for t in $tables; do dump_table "$ref" "$t" "$key" "$dir"; done
  dump_auth_users "$ref" "$key" "$dir"
  echo
}

mkdir -p "$OUT"
backup_project "room-system" "$ROOM_REF"   "$ROOM_SERVICE_KEY"   "$ROOM_TABLES"
backup_project "yijing"      "$YIJING_REF" "$YIJING_SERVICE_KEY" "$YIJING_TABLES"

if [ -z "$(ls -A "$OUT" 2>/dev/null)" ]; then
  rmdir "$OUT" 2>/dev/null
  echo "沒有備份到任何東西：請確認已設定 ROOM_SERVICE_KEY / YIJING_SERVICE_KEY。"
  exit 1
fi

echo "備份完成：$OUT"
echo "總大小：$(du -sh "$OUT" | cut -f1)"
echo
echo "提醒：backups/ 已在 .gitignore 內，不會被 commit。"
echo "這份檔案含全部客戶個資，請存到加密磁碟或有密碼保護的雲端硬碟，不要放桌面。"
