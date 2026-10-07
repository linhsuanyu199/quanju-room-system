// POST /api/pay/callback  ← 綠界的 ReturnURL（伺服器對伺服器）
//
// 這支是整個金流唯一有權力說「這筆付了」的地方。
// 使用者的瀏覽器永遠不會走到這裡；走到這裡的只有金流商的伺服器。
//
// 三件必須做對的事：
//   1. 驗簽。沒驗過簽的請求一律當成偽造，連 pay_mark_failed 都不要呼叫，
//      否則任何人都可以亂發 trade_no 把別人的單打成 failed。
//   2. 回 "1|OK"。綠界看不到這五個字就會持續重送。
//   3. 冪等。重送是常態，所以銷帳邏輯（pay_mark_paid）自己要能被重複呼叫。
//
// 這支刻意不檢查 RLS、不看使用者身分——因為根本沒有使用者。
// 它的身分證明就是 CheckMacValue。

const { rpcAsAdmin, hasServiceKey } = require('../_lib/db');
const { verify } = require('../_lib/ecpay');

// 綠界只看回應內容前綴，HTTP 狀態一律 200。
// 回非 200 會讓它重送，而重送在這裡是安全的（冪等），所以失敗時也不急著
// 回 200 假裝成功——真的出錯就讓它重送，比靜默吞掉好。
function ok(res) { res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); res.end('1|OK'); }
function bad(res, code, msg) { res.statusCode = code; res.setHeader('Content-Type', 'text/plain'); res.end('0|' + msg); }

// Vercel 對 application/x-www-form-urlencoded 會自動解析成物件，
// 但不同 runtime 行為不一致，所以兩種都接。
function formOf(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  const s = Buffer.isBuffer(b) ? b.toString('utf8') : String(b || '');
  const out = {};
  new URLSearchParams(s).forEach((v, k) => { out[k] = v; });
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'method');
  if (!hasServiceKey()) return bad(res, 503, 'no service key');

  const hashKey = process.env.ECPAY_HASH_KEY || '';
  const hashIV = process.env.ECPAY_HASH_IV || '';
  const merchantId = process.env.ECPAY_MERCHANT_ID || '';
  if (!hashKey || !hashIV || !merchantId) return bad(res, 503, 'not configured');

  const p = formOf(req);

  // 先驗簽，再看內容。順序相反就等於沒驗。
  if (!verify(p, hashKey, hashIV)) {
    console.error('[pay/callback] 驗簽失敗', { trade: p.MerchantTradeNo, mid: p.MerchantID });
    return bad(res, 400, 'bad mac');
  }

  // 簽對了但商店代號不是我們的 → 設定搞錯了（例如測試金鑰配正式商店）。
  // 這種情況不該銷帳。
  if (String(p.MerchantID || '') !== merchantId) {
    console.error('[pay/callback] MerchantID 不符', p.MerchantID);
    return bad(res, 400, 'bad merchant');
  }

  const tradeNo = String(p.MerchantTradeNo || '');
  if (!tradeNo) return bad(res, 400, 'no trade no');

  // RtnCode 1 = 付款成功。其餘都是失敗或取號（ATM 取號是 2，還沒付錢）。
  const rtn = String(p.RtnCode || '');
  const amount = parseInt(p.TradeAmt, 10);

  try {
    if (rtn === '1') {
      const r = await rpcAsAdmin('pay_mark_paid', {
        p_trade_no: tradeNo,
        p_gateway_trade_no: String(p.TradeNo || ''),
        p_amount: Number.isFinite(amount) ? amount : null,
        p_method: String(p.PaymentType || ''),
        p_raw: p
      });
      // 金額不符：單子已被標成 mismatch，訂閱沒有開通，等人工處理。
      // 這裡仍然回 1|OK，因為重送只會得到同樣的結果，讓它停止重試。
      if (r && r.ok === false) console.error('[pay/callback] 銷帳未完成', tradeNo, r);
      return ok(res);
    }

    // ATM / 超商取號成功（RtnCode 2）不是失敗，不要標成 failed，
    // 使用者可能三天後才去繳。留在 pending 由 pay_expire_stale() 收尾。
    if (rtn === '2') return ok(res);

    await rpcAsAdmin('pay_mark_failed', {
      p_trade_no: tradeNo,
      p_gateway_trade_no: String(p.TradeNo || ''),
      p_raw: p
    });
    return ok(res);
  } catch (e) {
    // 資料庫出錯時回非 200，讓綠界重送——這比回 OK 然後永遠漏掉這筆好。
    console.error('[pay/callback] 寫入失敗', tradeNo, e.message);
    return bad(res, 500, 'db error');
  }
};
