// Supabase REST 呼叫。api/ 底下以 _ 開頭的資料夾不會被 Vercel 當成路由。
//
// 兩種身分嚴格分開，不要混用：
//   sbUser  帶使用者自己的 JWT，受 RLS 限制。用來「確認你是誰」。
//   sbAdmin 帶 service_role，繞過 RLS。用來「寫錢的那幾筆」。
// 任何一支端點如果用 sbAdmin 去做本來該由 sbUser 做的判斷，
// 就等於自己把權限檢查拿掉了。

// URL 與 anon key 本來就公開在前端（js/cloud-config.js），放預設值方便部署；
// service_role 則一定要從環境變數來，沒有預設值。
const SUPA_URL = process.env.SUPABASE_URL || 'https://cvryjcdcrebdnlemgabs.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_Y-ptHYqCOr2NmG6pvFNCpg_h2PfSQ3y';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function hasServiceKey() { return !!SERVICE_KEY; }

async function call(path, key, bearer, body) {
  const res = await fetch(SUPA_URL + path, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + bearer,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// 以呼叫者的身分執行 RPC。token 來自前端的 Authorization header。
function rpcAsUser(token, fn, args) {
  return call('/rest/v1/rpc/' + fn, ANON_KEY, token, args);
}

// 以 service_role 執行 RPC。只有 pay_quote / pay_mark_paid / pay_mark_failed
// 這三支會走這裡，而且它們都已經 revoke 掉 authenticated 的執行權限。
function rpcAsAdmin(fn, args) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY 未設定');
  return call('/rest/v1/rpc/' + fn, SERVICE_KEY, SERVICE_KEY, args);
}

// JWT 的 sub 欄位（使用者 id）。
// 這裡刻意不驗簽：授權判斷完全靠上面的 rpcAsUser——token 是假的，
// Supabase 那邊就會回 401，根本拿不到 company_id。這支只是為了把
// created_by 記正確，拿不到就留空，不影響任何權限決策。
function uidFromToken(token) {
  try {
    const p = token.split('.')[1];
    const json = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json).sub || null;
  } catch (_) { return null; }
}

function bearerOf(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1] : null;
}

module.exports = { rpcAsUser, rpcAsAdmin, uidFromToken, bearerOf, hasServiceKey };
