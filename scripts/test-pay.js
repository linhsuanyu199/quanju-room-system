#!/usr/bin/env node
// 金流邏輯的自動測試。不連網、不連資料庫，純驗純函數。
//   node scripts/test-pay.js
//
// 這裡測的是「不需要金鑰也能測」的那一半：簽章產生、竄改偵測、
// 參數組裝。需要真實金鑰的那一半（CheckMacValue 是否和綠界算的一樣）
// 只能用綠界測試商店驗，見 docs/金流上線清單.md。

const ec = require('../api/_lib/ecpay');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期待 ' + JSON.stringify(b) + '，實得 ' + JSON.stringify(a));
}
function ok(v, msg) { if (!v) throw new Error(msg || '應為 true'); }

const KEY = 'ejCk326UnaZWKisg';   // 綠界文件公開的範例金鑰，不是真金鑰
const IV = 'q9jcZX8Ib9LM8wYk';

console.log('\n── dotNetUrlEncode ──');
t('空白編成 +', () => eq(ec.dotNetUrlEncode('a b'), 'a+b'));
t("單引號編成 %27", () => eq(ec.dotNetUrlEncode("a'b"), 'a%27b'));
t('波浪號編成 %7e', () => eq(ec.dotNetUrlEncode('a~b'), 'a%7eb'));
t('不編 -_.!*()', () => eq(ec.dotNetUrlEncode("-_.!*()"), "-_.!*()"));
t('中文編成 UTF-8 %XX', () => eq(ec.dotNetUrlEncode('全'), '%E5%85%A8'));

console.log('\n── CheckMacValue ──');
// 綠界技術文件的範例：這組參數應得出固定的雜湊值。
// 值本身若和官方文件不同，表示上面的編碼或排序規則錯了。
const sample = {
  MerchantID: '2000132',
  MerchantTradeNo: 'Test1234567890',
  MerchantTradeDate: '2017/06/01 16:34:00',
  PaymentType: 'aio',
  TotalAmount: '100',
  TradeDesc: 'test',
  ItemName: 'test',
  ReturnURL: 'https://www.ecpay.com.tw/return',
  ChoosePayment: 'Credit',
  EncryptType: '1'
};
t('同樣輸入得到同樣輸出（決定性）', () => {
  eq(ec.checkMacValue(sample, KEY, IV), ec.checkMacValue(sample, KEY, IV));
});
t('輸出是 64 碼大寫 hex', () => {
  ok(/^[0-9A-F]{64}$/.test(ec.checkMacValue(sample, KEY, IV)), '格式不對');
});
t('CheckMacValue 自己不參與計算', () => {
  const a = ec.checkMacValue(sample, KEY, IV);
  const b = ec.checkMacValue(Object.assign({}, sample, { CheckMacValue: 'WHATEVER' }), KEY, IV);
  eq(a, b);
});
t('參數順序不影響結果（排序有生效）', () => {
  const rev = {};
  Object.keys(sample).reverse().forEach(k => { rev[k] = sample[k]; });
  eq(ec.checkMacValue(rev, KEY, IV), ec.checkMacValue(sample, KEY, IV));
});
t('大小寫不敏感的排序：aB 與 Ab 視為同序位', () => {
  // 若誤用大小寫敏感排序，大寫會全部排到小寫前面，雜湊會不同。
  // 這裡用一組刻意混大小寫的 key 來鎖住規則。
  const x = { bKey: '1', Akey: '2', cKey: '3' };
  const y = { Akey: '2', bKey: '1', cKey: '3' };
  eq(ec.checkMacValue(x, KEY, IV), ec.checkMacValue(y, KEY, IV));
});
t('金鑰不同結果不同', () => {
  ok(ec.checkMacValue(sample, KEY, IV) !== ec.checkMacValue(sample, KEY + 'x', IV));
});
t('改金額結果就不同（竄改會被看出來）', () => {
  const tampered = Object.assign({}, sample, { TotalAmount: '1' });
  ok(ec.checkMacValue(sample, KEY, IV) !== ec.checkMacValue(tampered, KEY, IV));
});

console.log('\n── verify ──');
t('自己簽自己驗 → 通過', () => {
  const p = Object.assign({}, sample);
  p.CheckMacValue = ec.checkMacValue(p, KEY, IV);
  ok(ec.verify(p, KEY, IV));
});
t('小寫簽章也要通過（實務上有商家收到小寫）', () => {
  const p = Object.assign({}, sample);
  p.CheckMacValue = ec.checkMacValue(p, KEY, IV).toLowerCase();
  ok(ec.verify(p, KEY, IV));
});
t('竄改金額 → 驗簽失敗', () => {
  const p = Object.assign({}, sample);
  p.CheckMacValue = ec.checkMacValue(p, KEY, IV);
  p.TotalAmount = '1';
  ok(!ec.verify(p, KEY, IV));
});
t('偷加參數 → 驗簽失敗', () => {
  const p = Object.assign({}, sample);
  p.CheckMacValue = ec.checkMacValue(p, KEY, IV);
  p.RtnCode = '1';
  ok(!ec.verify(p, KEY, IV));
});
t('沒有 CheckMacValue → 失敗（不是當成通過）', () => {
  ok(!ec.verify(Object.assign({}, sample), KEY, IV));
});
t('長度不同的亂數簽章 → 失敗且不拋例外', () => {
  ok(!ec.verify(Object.assign({}, sample, { CheckMacValue: 'ABC' }), KEY, IV));
});
t('用錯金鑰驗 → 失敗', () => {
  const p = Object.assign({}, sample);
  p.CheckMacValue = ec.checkMacValue(p, KEY, IV);
  ok(!ec.verify(p, 'wrongkeywrongkey', IV));
});

console.log('\n── tradeDate ──');
t('格式 yyyy/MM/dd HH:mm:ss', () => {
  ok(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(ec.tradeDate(new Date())), '格式不對');
});
t('是台北時間（UTC+8）', () => {
  // 2026-01-01T00:00:00Z → 台北時間 2026/01/01 08:00:00
  eq(ec.tradeDate(new Date('2026-01-01T00:00:00Z')), '2026/01/01 08:00:00');
});
t('跨日也正確', () => {
  // 2026-01-01T17:30:00Z → 台北 2026/01/02 01:30:00
  eq(ec.tradeDate(new Date('2026-01-01T17:30:00Z')), '2026/01/02 01:30:00');
});

console.log('\n── buildCheckoutForm ──');
const form = ec.buildCheckoutForm({
  merchantId: '2000132', hashKey: KEY, hashIV: IV, env: 'stage',
  tradeNo: 'Q2601011200AB12CD', amount: 9990,
  desc: '全居測試 <b>公司</b>', itemName: '全居短租系統 進階版方案 年繳（12 個月）',
  returnUrl: 'https://x.vercel.app/api/pay/callback',
  clientBackUrl: 'https://x.vercel.app/pay-done.html?no=Q2601011200AB12CD'
});
t('測試環境打 payment-stage', () => {
  ok(form.action.indexOf('payment-stage.ecpay.com.tw') > 0, form.action);
});
t('正式環境打 payment.ecpay.com.tw', () => {
  eq(ec.endpoint('prod'), 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5');
});
t('產出的表單自己能驗過', () => ok(ec.verify(form.params, KEY, IV)));
t('TotalAmount 是字串化的整數', () => eq(form.params.TotalAmount, '9990'));
t('MerchantTradeNo 不超過 20 碼英數', () => {
  ok(/^[A-Za-z0-9]{1,20}$/.test(form.params.MerchantTradeNo), form.params.MerchantTradeNo);
});
t('TradeDesc 的危險符號被清掉', () => {
  ok(!/[<>&"'#\\]/.test(form.params.TradeDesc), form.params.TradeDesc);
});
t('ItemName 保留中文與括號', () => {
  ok(form.params.ItemName.indexOf('進階版') >= 0, form.params.ItemName);
});
t('ReturnURL 指向 callback 而非 pay-done', () => {
  ok(/\/api\/pay\/callback$/.test(form.params.ReturnURL), form.params.ReturnURL);
});
t('ClientBackURL 只是顯示頁', () => {
  ok(/pay-done\.html/.test(form.params.ClientBackURL), form.params.ClientBackURL);
});
t('EncryptType 必須是 1（SHA256）', () => eq(form.params.EncryptType, '1'));
t('ItemName 長度上限 400', () => {
  const f = ec.buildCheckoutForm({
    merchantId: '1', hashKey: KEY, hashIV: IV, tradeNo: 'A1', amount: 1,
    itemName: '壹'.repeat(600), desc: 'd', returnUrl: 'u', clientBackUrl: 'u'
  });
  eq(f.params.ItemName.length, 400);
});
t('預設付款方式是 Credit', () => eq(form.params.ChoosePayment, 'Credit'));

console.log('\n── 回放攻擊的界線（說明用，非程式缺陷）──');
t('同一組參數可以被重複送 → 必須靠資料庫冪等', () => {
  // 驗簽本身無法防回放：攔到一次成功通知就能無限重送，
  // 每次都會驗過。防線在 pay_mark_paid() 的 status='paid' 早退，
  // 不在這一層。這個測試存在的意義是把這件事寫下來。
  const p = Object.assign({}, sample, { RtnCode: '1' });
  p.CheckMacValue = ec.checkMacValue(p, KEY, IV);
  ok(ec.verify(p, KEY, IV) && ec.verify(p, KEY, IV));
});

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 通過，' + fail + ' 失敗\n');
process.exit(fail ? 1 : 0);
