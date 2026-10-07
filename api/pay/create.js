// POST /api/pay/create  { plan: 'advanced', period: 'yearly' }
//
// 建立一筆付款單，回傳要送去金流商的表單參數。
//
// 這支端點最重要的一件事是「不接受前端傳金額」。
// 金額由 pay_quote() 從 plans 表算出來，前端連參數都沒有可以放金額的地方。
// 這不是多一道檢查，而是讓竄改金額這件事在結構上不存在。
//
// 授權鏈（順序不能顛倒）：
//   1. 有 Bearer token
//   2. get_my_company_id()  ← 用「使用者自己的 JWT」問，受 RLS 限制。
//                              token 是假的就拿不到 company_id。
//   3. is_company_admin()   ← 付錢是管理者的事，成員不能幫公司下單
//   4. 才用 service_role 去建單

const { rpcAsUser, rpcAsAdmin, uidFromToken, bearerOf, hasServiceKey } = require('../_lib/db');
const { buildCheckoutForm } = require('../_lib/ecpay');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

// pay_quote 用 raise exception 回報錯誤，PostgREST 會把訊息原封不動帶回來。
// 這裡翻成人看得懂的話；對不上的就回原文，不要吞掉。
const QUOTE_ERR = {
  PAY_BAD_PERIOD: '付款週期只能是月繳或年繳',
  PAY_NO_COMPANY: '找不到公司資料',
  PAY_UNKNOWN_PLAN: '方案不存在或已停售',
  PAY_CONTACT_ONLY: '旗艦版為個別報價，請直接與我們聯繫',
  PAY_NOT_SELLABLE: '這個方案沒有可線上付款的金額'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: '只接受 POST' });

  const token = bearerOf(req);
  if (!token) return json(res, 401, { error: '未登入' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const plan = String(body.plan || '');
  const period = body.period === 'yearly' ? 'yearly' : 'monthly';
  if (!/^[a-z_]{1,32}$/.test(plan)) return json(res, 400, { error: '方案代碼不正確' });

  if (!hasServiceKey()) return json(res, 503, { error: '伺服器未設定 SUPABASE_SERVICE_ROLE_KEY' });

  // 2+3：身分與角色都用使用者自己的 token 問，不是用 service_role 問。
  let companyId, isAdmin;
  try {
    companyId = await rpcAsUser(token, 'get_my_company_id', {});
    isAdmin = await rpcAsUser(token, 'is_company_admin', {});
  } catch (e) {
    return json(res, 401, { error: '登入狀態已失效，請重新登入' });
  }
  if (!companyId) return json(res, 403, { error: '這個帳號沒有歸屬公司，或已被停用' });
  if (isAdmin !== true) return json(res, 403, { error: '只有管理者可以辦理付款' });

  // 選金流。綠界金鑰三個都齊才算有設定，缺一個就當沒設定——
  // 設一半比完全沒設更危險，會在付款頁才爆 CheckMacValue Error。
  const ec = {
    merchantId: process.env.ECPAY_MERCHANT_ID || '',
    hashKey: process.env.ECPAY_HASH_KEY || '',
    hashIV: process.env.ECPAY_HASH_IV || '',
    env: process.env.ECPAY_ENV === 'prod' ? 'prod' : 'stage'
  };
  const hasEcpay = !!(ec.merchantId && ec.hashKey && ec.hashIV);

  let gateway = null;
  if (hasEcpay) {
    gateway = 'ecpay';
  } else if (process.env.PAY_ALLOW_MOCK === '1') {
    // 假金流會直接開通訂閱，等於免費升級。所以除了環境變數之外，
    // 還要求呼叫者是平台管理者——兩道鎖，環境變數被誤設也不會漏。
    let isPlat = false;
    try { isPlat = await rpcAsUser(token, 'is_platform_admin', {}); } catch (_) { isPlat = false; }
    if (isPlat === true) gateway = 'mock';
  }
  if (!gateway) {
    return json(res, 503, {
      error: '尚未設定金流金鑰，線上付款暫時無法使用。請改用匯款或與我們聯繫。'
    });
  }

  // 4：建單。這是唯一用 service_role 的地方。
  let q;
  try {
    q = await rpcAsAdmin('pay_quote', {
      p_company_id: companyId,
      p_plan: plan,
      p_period: period,
      p_gateway: gateway,
      p_user_id: uidFromToken(token)
    });
  } catch (e) {
    const msg = String(e.message || '');
    const hit = Object.keys(QUOTE_ERR).find(k => msg.indexOf(k) >= 0);
    return json(res, 400, { error: hit ? QUOTE_ERR[hit] : ('建立付款單失敗：' + msg) });
  }

  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const done = base + '/pay-done.html?no=' + encodeURIComponent(q.trade_no);

  if (gateway === 'mock') {
    // 假金流：直接走和真實 callback 一樣的那支函數，確保測到的是真流程。
    const r = await rpcAsAdmin('pay_mark_paid', {
      p_trade_no: q.trade_no,
      p_gateway_trade_no: 'MOCK' + Date.now(),
      p_amount: q.amount,
      p_method: 'mock',
      p_raw: { mock: true, by: uidFromToken(token) }
    });
    return json(res, 200, { mode: 'mock', trade_no: q.trade_no, amount: q.amount, result: r, redirect: done });
  }

  if (!base) return json(res, 503, { error: '伺服器未設定 PUBLIC_BASE_URL' });

  const form = buildCheckoutForm({
    merchantId: ec.merchantId,
    hashKey: ec.hashKey,
    hashIV: ec.hashIV,
    env: ec.env,
    tradeNo: q.trade_no,
    amount: q.amount,
    desc: q.company + ' 訂閱',
    itemName: q.item_name,
    returnUrl: base + '/api/pay/callback',
    clientBackUrl: done,
    choosePayment: body.method === 'ATM' ? 'ATM' : 'Credit'
  });

  return json(res, 200, {
    mode: 'form',
    trade_no: q.trade_no,
    amount: q.amount,
    plan_name: q.plan_name,
    action: form.action,
    params: form.params
  });
};
