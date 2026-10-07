// 綠界 ECPay AIO 全方位金流：產生 CheckMacValue 與驗簽。
//
// ⚠️ 上線前一定要用綠界的「測試商店」跑一次真實流程。
// CheckMacValue 的演算法有兩個地方是靠文件描述還原的，不是靠執行驗證的：
//   (1) 參數排序規則（不分大小寫的字母序）
//   (2) URL encode 要模仿 .NET 的 HttpUtility.UrlEncode，
//       它不編碼 -_.!*() ，但會把 ' 編成 %27、~ 編成 %7e、空白編成 +
// 這兩點只要有一個對不上，綠界就會回「CheckMacValue Error」。
// 測試商店是免費的，不要省這一步。

const crypto = require('crypto');

// 模仿 .NET HttpUtility.UrlEncode。
// encodeURIComponent 不編碼 -_.!~*'() ，其中 ~ 和 ' 的處理和 .NET 不同，
// 所以要手動補上；空白在 .NET 是 + 不是 %20。
function dotNetUrlEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/'/g, '%27')
    .replace(/~/g, '%7e')
    .replace(/%20/g, '+');
}

// 綠界規定：CheckMacValue 自己不參與計算，EncryptType 要一起算。
function checkMacValue(params, hashKey, hashIV) {
  const keys = Object.keys(params)
    .filter(k => k !== 'CheckMacValue' && params[k] !== undefined && params[k] !== null)
    .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : (a.toLowerCase() > b.toLowerCase() ? 1 : 0));

  const raw = 'HashKey=' + hashKey + '&' +
              keys.map(k => k + '=' + params[k]).join('&') +
              '&HashIV=' + hashIV;

  const encoded = dotNetUrlEncode(raw).toLowerCase();
  return crypto.createHash('sha256').update(encoded, 'utf8').digest('hex').toUpperCase();
}

// 驗簽。用 timingSafeEqual 不是因為真的有人會做時序攻擊，
// 而是因為「比較密鑰衍生值時用常數時間比較」是不需要理由的預設習慣。
function verify(params, hashKey, hashIV) {
  const got = String(params.CheckMacValue || '');
  const want = checkMacValue(params, hashKey, hashIV);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got.toUpperCase()), Buffer.from(want));
}

function endpoint(env) {
  return env === 'prod'
    ? 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5'
    : 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5';
}

// MerchantTradeDate 的格式是 yyyy/MM/dd HH:mm:ss，而且是台北時間。
function tradeDate(d) {
  const t = new Date((d || new Date()).getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return t.getUTCFullYear() + '/' + p(t.getUTCMonth() + 1) + '/' + p(t.getUTCDate()) + ' ' +
         p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds());
}

// 綠界的 ItemName / TradeDesc 不接受某些符號，太長也會被退。
// 與其讓它在付款頁才爆掉，不如在這裡先修乾淨。
function clean(s, max) {
  return String(s || '').replace(/[&<>"'#\\]/g, ' ').slice(0, max);
}

function buildCheckoutForm(opt) {
  const params = {
    MerchantID: opt.merchantId,
    MerchantTradeNo: opt.tradeNo,
    MerchantTradeDate: tradeDate(),
    PaymentType: 'aio',
    TotalAmount: String(opt.amount),
    TradeDesc: clean(opt.desc, 200),
    ItemName: clean(opt.itemName, 400),
    ReturnURL: opt.returnUrl,          // 伺服器對伺服器的付款結果通知（唯一可信來源）
    ClientBackURL: opt.clientBackUrl,  // 使用者按「返回商店」導回的畫面，只做顯示
    ChoosePayment: opt.choosePayment || 'Credit',
    EncryptType: '1',
    NeedExtraPaidInfo: 'N'
  };
  params.CheckMacValue = checkMacValue(params, opt.hashKey, opt.hashIV);
  return { action: endpoint(opt.env), params };
}

module.exports = { checkMacValue, verify, buildCheckoutForm, dotNetUrlEncode, endpoint, tradeDate };
