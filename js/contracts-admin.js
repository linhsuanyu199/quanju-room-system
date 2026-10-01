/* ════════════════════════════════════════════════════════════════════
   線上簽約（後台）

   三個入口，都掛在右上「更多」選單與館別/訂單上：
     1. 簽約主體設定（qj_signer）── 一家公司填一次
     2. 館別契約設定（qj_cdata）── 每個館別填一次：房東、建物登記、
        房東契約條件、轉租契約預設條件、現況確認書
     3. 契約管理（contracts 資料表）── 產生連結、追蹤、作廢

   為什麼契約條文不在這裡：條文全部在 js/contract-render.js，
   後台預覽、簽署頁、列印 PDF 共用那一份，不可能出現「預覽跟實際
   簽的不一樣」。這個檔案只負責「把系統裡的資料對應到契約欄位」。

   為什麼 modal 的 HTML 是用 JS 插進去的：index.html 已經很長，
   契約功能再塞七百行進去，之後任何人要改排房都得先滑過契約。
   這些 modal 用的是 index.html 既有的 .overlay/.modal 樣式。
   ════════════════════════════════════════════════════════════════════ */
'use strict';

var CT_KV_SIGNER = 'qj_signer';
var CT_KV_DATA   = 'qj_cdata';
var CT_KIND_OF_SVC = { '包租': 'bz', '代租代管': 'wg' };

/* ── 路徑存取（欄位定義用 'bz.rent.monthly' 這種字串）───────────── */
function ctGet(o, path) {
  var ps = path.split('.'), cur = o;
  for (var i = 0; i < ps.length; i++) { if (cur == null) return undefined; cur = cur[ps[i]]; }
  return cur;
}
function ctSet(o, path, val) {
  var ps = path.split('.'), cur = o;
  for (var i = 0; i < ps.length - 1; i++) {
    if (cur[ps[i]] == null || typeof cur[ps[i]] !== 'object') cur[ps[i]] = {};
    cur = cur[ps[i]];
  }
  cur[ps[ps.length - 1]] = val;
}
/* 空字串不覆蓋預設值：使用者沒填的欄位應該留著 blankData 的法定預設
   （例如「不同意公證」），而不是被一個空字串蓋成 undefined。
   false 要能覆蓋 true，所以只排除 undefined / null / ''。 */
function ctMerge(base, over) {
  if (!over) return base;
  Object.keys(over).forEach(function (k) {
    var v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!base[k] || typeof base[k] !== 'object' || Array.isArray(base[k])) base[k] = {};
      ctMerge(base[k], v);
    } else if (v !== undefined && v !== null && v !== '') {
      base[k] = v;
    }
  });
  return base;
}
function ctEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 館別 id 在 qj_cps 裡可能是數字、也可能是字串（自建館別用 genId），
   而從 onclick 傳進來的一定是字串。全系統都用 String() 比較，這裡也一樣，
   不然數字 id 的館別會「找不到館別」。 */
function ctSameId(a, b) { return String(a) === String(b); }
function ctProp(id) {
  return loadCPs().find(function (p) { return ctSameId(p.id, id); }) || null;
}

/* 契約表的時間欄位是 timestamptz，PostgREST 回傳的是 UTC。直接切 ISO 字串
   會把台灣時間凌晨簽的約顯示成前一天，而契約正文裡的簽署時間是資料庫用
   Asia/Taipei 算的——兩邊對不起來，稽核時就會變成爭議。一律換算後再顯示。 */
function ctTW(ts, withTime) {
  if (!ts) return '';
  var dt = new Date(ts);
  if (isNaN(dt.getTime())) return '';
  var p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(dt).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  return p.year + '-' + p.month + '-' + p.day +
         (withTime ? ' ' + p.hour + ':' + p.minute + ':' + p.second : '');
}

/* ── 欄位定義 → 表單 ─────────────────────────────────────────────
   [路徑, 標籤, 型別, 其他]
   型別：text num money date chk sel ta equip csv h(小標題) */
function ctForm(spec, data, pfx) {
  var h = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px 12px">';
  spec.forEach(function (f) {
    if (f[2] === 'h') {
      h += '<div style="grid-column:1/-1;font-size:11.5px;font-weight:700;color:var(--primary);' +
           'border-bottom:1px solid var(--border);padding-bottom:3px;margin-top:6px">' + ctEsc(f[1]) + '</div>';
      if (f[3] && f[3].hint)
        h += '<div style="grid-column:1/-1;font-size:10.5px;color:var(--muted);line-height:1.7">' +
             ctEsc(f[3].hint) + '</div>';
      return;
    }
    h += ctField(f, data, pfx);
  });
  return h + '</div>';
}
function ctField(f, data, pfx) {
  var path = f[0], label = f[1], type = f[2], ex = f[3] || {};
  var id = pfx + '-' + path.replace(/\./g, '_');
  var val = ctGet(data, path);
  var st = 'width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;' +
           'font-size:12px;font-family:inherit';
  var full = ex.w === 'full' ? 'grid-column:1/-1;' : '';

  if (type === 'chk') {
    return '<label style="' + full + 'display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700">' +
      '<input type="checkbox" id="' + id + '" data-ctpath="' + path + '" data-cttype="chk"' +
      (val ? ' checked' : '') + '>' + ctEsc(label) + '</label>';
  }
  var inner;
  if (type === 'sel') {
    inner = '<select id="' + id + '" data-ctpath="' + path + '" data-cttype="sel" style="' + st + '">' +
      (ex.opts || []).map(function (o) {
        return '<option value="' + ctEsc(o[0]) + '"' +
          (String(val == null ? '' : val) === String(o[0]) ? ' selected' : '') + '>' + ctEsc(o[1]) + '</option>';
      }).join('') + '</select>';
  } else if (type === 'ta' || type === 'equip' || type === 'csv') {
    var tv = type === 'equip' ? ctEquipToText(val)
           : type === 'csv' ? (Array.isArray(val) ? val.join('、') : (val || ''))
           : (val == null ? '' : val);
    inner = '<textarea id="' + id + '" data-ctpath="' + path + '" data-cttype="' + type + '" rows="' +
      (ex.rows || 3) + '" placeholder="' + ctEsc(ex.ph || '') + '" style="' + st + ';resize:vertical">' +
      ctEsc(tv) + '</textarea>';
  } else {
    var it = type === 'date' ? 'date' : ((type === 'num' || type === 'money') ? 'number' : 'text');
    inner = '<input type="' + it + '" id="' + id + '" data-ctpath="' + path + '" data-cttype="' + type +
      '" placeholder="' + ctEsc(ex.ph || '') + '" value="' + ctEsc(val == null ? '' : val) +
      '" style="' + st + '">';
  }
  return '<label style="' + full + 'font-size:11.5px;font-weight:700">' + ctEsc(label) +
    (ex.req ? '<span style="color:#c92a2a">＊</span>' : '') +
    '<div style="margin-top:3px">' + inner + '</div>' +
    (ex.hint ? '<div style="font-weight:400;color:var(--muted);font-size:10.5px;margin-top:2px">' +
               ctEsc(ex.hint) + '</div>' : '') + '</label>';
}
function ctReadForm(rootEl, data) {
  Array.prototype.forEach.call(rootEl.querySelectorAll('[data-ctpath]'), function (el) {
    var path = el.getAttribute('data-ctpath'), type = el.getAttribute('data-cttype'), val;
    if (type === 'chk') val = el.checked;
    else if (type === 'equip') val = ctEquipFromText(el.value);
    else if (type === 'csv') val = el.value.split(/[,，、\s]+/).filter(Boolean);
    else if (type === 'num' || type === 'money') val = el.value === '' ? '' : Number(el.value);
    else val = el.value.trim();
    ctSet(data, path, val);
  });
  return data;
}
/* 附屬設備：契約附件一要列「品項＋數量」，表單用一行一項最好填。 */
function ctEquipToText(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map(function (x) { return (x[0] || '') + '，' + (x[1] || ''); }).join('\n');
}
function ctEquipFromText(txt) {
  return String(txt || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean)
    .map(function (l) {
      var parts = l.split(/[,，\t]+/);
      return [parts[0].trim(), (parts[1] || '1').trim()];
    });
}

/* ══════════════════════════════════════════════════════════════════
   欄位清單
   ══════════════════════════════════════════════════════════════════ */
var CT_YN_OBT = { opts: [['owner', '出租人（房東）負擔'], ['biz', '包租業負擔'], ['other', '其他']] };
var CT_YN_BT  = { opts: [['biz', '包租業負擔'], ['tenant', '承租人（房客）負擔'], ['other', '其他']] };

var CT_SIGNER_FIELDS = [
  ['', '公司（商號）資料', 'h', { hint: '這一區會印在三份契約的簽約主體欄位。登記證字號屬法定必載事項，缺漏會影響契約效力。' }],
  ['biz.name',  '公司（商號）名稱', 'text', { req: 1, w: 'full', ph: '例：○○資產管理有限公司' }],
  ['biz.rep',   '負責人', 'text', { req: 1 }],
  ['biz.taxid', '統一編號', 'text', { req: 1 }],
  ['biz.licNo', '租賃住宅服務業登記證字號', 'text', { req: 1, w: 'full', ph: '例：北市租服字第○○○○號' }],
  ['biz.addr',  '公司地址', 'text', { req: 1, w: 'full' }],
  ['biz.tel',   '公司電話', 'text', { req: 1 }],
  ['biz.email', '電子郵件', 'text', {}],
  ['', '租賃住宅管理人員', 'h', { hint: '依租賃住宅市場發展及管理條例，契約應載明管理人員姓名與證書字號。' }],
  ['mgr.name',    '管理人員姓名', 'text', { req: 1 }],
  ['mgr.certNo',  '管理人員證書字號', 'text', { req: 1 }],
  ['mgr.addr',    '管理人員聯絡地址', 'text', { w: 'full' }],
  ['mgr.tel',     '管理人員電話', 'text', {} ],
  ['mgr.email',   '管理人員電子郵件', 'text', {} ]
];

var CT_OWNER_FIELDS = [
  ['', '房東（出租人／委託人）', 'h', { hint: '這是房東端契約的簽約相對人。身分證統一編號只會在契約上顯示前兩碼與後四碼。' }],
  ['owner.name',  '姓名', 'text', { req: 1 }],
  ['owner.idNo',  '身分證統一編號', 'text', { ph: 'A123456789' }],
  ['owner.hukou', '戶籍地址', 'text', { w: 'full' }],
  ['owner.mail',  '通訊地址', 'text', { w: 'full', ph: '與戶籍地相同可留白' }],
  ['owner.tel',   '聯絡電話', 'text', { req: 1 }],
  ['owner.email', '電子郵件', 'text', {} ]
];

var CT_PROP_FIELDS = [
  ['', '門牌（契約上的租賃住宅標示）', 'h', { hint: '縣市與行政區自動帶入館別設定。路街／巷／弄／號分欄填寫，契約才會印成法定格式。' }],
  ['prop.road',     '路／街（含段）', 'text', { req: 1, ph: '例：民生東路二段' }],
  ['prop.lane',     '巷', 'text', {} ],
  ['prop.alley',    '弄', 'text', {} ],
  ['prop.no',       '號', 'text', {} ],
  ['prop.floor',    '樓層', 'text', { ph: '例：6' }],
  ['prop.floorSub', '樓之', 'text', { ph: '例：1（無則留白）' }],
  ['', '建物登記資料（謄本）', 'h', { hint: '代管案件的謄本通常在房東手上。留白不會擋住簽約，契約上會印成空格由房東當場手寫，但系統會把這份契約標示為「登記資料不完整」。' }],
  ['prop.landSec',      '土地坐落 段', 'text', {} ],
  ['prop.landSubSec',   '小段', 'text', {} ],
  ['prop.landNo',       '地號', 'text', {} ],
  ['prop.bldgNo',       '建號', 'text', {} ],
  ['prop.taxNo',        '房屋稅籍編號', 'text', {} ],
  ['prop.right',        '權利範圍', 'text', { ph: '例：全部' }],
  ['prop.areaTotal',    '建物總面積（㎡）', 'text', {} ],
  ['prop.mainTotal',    '主建物面積（㎡）', 'text', {} ],
  ['prop.mainUse',      '主要用途', 'text', { ph: '例：住家用' }],
  ['prop.annexUse',     '附屬建物用途', 'text', { ph: '例：陽台' }],
  ['prop.annexArea',    '附屬建物面積（㎡）', 'text', {} ],
  ['prop.commonBldgNo', '共有部分建號', 'text', {} ],
  ['prop.commonRight',  '共有部分權利範圍', 'text', { ph: '例：24分之1' }],
  ['prop.commonArea',   '共有部分面積（㎡）', 'text', {} ],
  ['', '建物現況', 'h'],
  ['prop.bldgType', '建物型態', 'sel', { w: 'full', opts: [
    ['', '（請選擇）'],
    ['透天厝', '透天厝'],
    ['公寓（五樓含以下無電梯）', '公寓（五樓含以下無電梯）'],
    ['辦公商業大樓', '辦公商業大樓'],
    ['住宅或複合型大樓（十一層含以上有電梯）', '住宅或複合型大樓（十一層含以上有電梯）'],
    ['住宅或複合型大樓（六層至十層有電梯）', '住宅或複合型大樓（六層至十層有電梯）'],
    ['套房（一層有數個套房）', '套房（一層有數個套房）'],
    ['其他', '其他']
  ] }],
  ['prop.layout.room', '房（間）', 'text', {} ],
  ['prop.layout.hall', '廳', 'text', {} ],
  ['prop.layout.bath', '衛浴', 'text', {} ],
  ['prop.layout.partition', '有隔間', 'chk', {} ],
  ['prop.hasParking',   '含停車位', 'chk', {} ],
  ['prop.carPark',      '汽車停車位', 'text', { ph: '例：地下一層第12號' }],
  ['prop.motoPark',     '機車停車位', 'text', {} ],
  ['prop.hasOtherRight', '已設定他項權利', 'chk', {} ],
  ['prop.otherRightType', '他項權利種類', 'text', { ph: '例：抵押權' }],
  ['prop.hasSeizure',   '有查封登記', 'chk', { w: 'full' }]
];

/* 房東↔包租業（住宅包租契約） */
var CT_BZ_FIELDS = [
  ['', '包租範圍與期間', 'h'],
  ['bz.scope.whole',     '整戶（全部）出租', 'chk', {} ],
  ['bz.scope.hasFurniture', '含附屬設備', 'chk', {} ],
  ['bz.scope.floor',     '部分出租：第○層', 'text', {} ],
  ['bz.scope.roomCount', '房間數', 'text', {} ],
  ['bz.scope.roomNo',    '房間編號', 'text', { ph: '例：A6-1、A6-2' }],
  ['bz.scope.area',      '面積（㎡）', 'text', {} ],
  ['bz.term.from',       '包租期間 自', 'date', { req: 1 }],
  ['bz.term.to',         '包租期間 至', 'date', { req: 1, hint: '不得少於三十日' }],
  ['', '租金與押金', 'h'],
  ['bz.rent.monthly',  '每月租金（元）', 'money', { req: 1 }],
  ['bz.rent.payUnit',  '繳租週期', 'sel', { opts: [['月', '按月'], ['期', '按期']] }],
  ['bz.rent.periods',  '每期幾個月', 'text', { ph: '按月繳可留白' }],
  ['bz.rent.payDay',   '應於每月（期）幾日前支付', 'text', {} ],
  ['bz.rent.method',   '租金支付方式', 'sel', { opts: [['transfer', '轉帳繳付'], ['cash', '現金繳付'], ['other', '其他']] }],
  ['bz.rent.bank',     '金融機構', 'text', {} ],
  ['bz.rent.acctName', '戶名', 'text', {} ],
  ['bz.rent.acctNo',   '帳號', 'text', {} ],
  ['bz.deposit.months', '押金月數', 'text', { hint: '最高二個月' }],
  ['bz.deposit.amount', '押金金額（元）', 'money', {} ],
  ['', '費用負擔', 'h', { hint: '包租契約的費用負擔是在房東與包租業之間劃分，和後面轉租契約（包租業與房客之間）是兩回事。' }],
  ['bz.fees.mgmt',     '管理費', 'sel', CT_YN_OBT],
  ['bz.fees.mgmtRoom', '住宅管理費（元／月）', 'text', {} ],
  ['bz.fees.mgmtPark', '車位管理費（元／月）', 'text', {} ],
  ['bz.fees.water',    '水費', 'sel', CT_YN_OBT],
  ['bz.fees.elec',     '電費', 'sel', CT_YN_OBT],
  ['bz.fees.gas',      '瓦斯費', 'sel', CT_YN_OBT],
  ['bz.fees.net',      '網路費', 'sel', CT_YN_OBT],
  ['bz.fees.other',    '其他費用及支付方式', 'text', { w: 'full' }],
  ['bz.taxOther',      '其他稅費及支付方式', 'text', { w: 'full' }],
  ['', '其他約定', 'h'],
  ['bz.notarize',   '雙方同意辦理公證', 'chk', {} ],
  ['bz.otherUse',   '同意以出借或轉租以外方式供他人居住', 'chk', {} ],
  ['bz.decorAllow', '同意包租業進行室內裝修', 'chk', {} ],
  ['bz.decorCostBy', '裝修費用負擔', 'sel', { opts: [['biz', '包租業'], ['owner', '出租人'], ['other', '其他']] }],
  ['bz.decorRestore', '返還時之回復原狀約定', 'text', { w: 'full', ph: '例：現況返還，不須回復原狀' }],
  ['bz.earlyTerm',   '約定得提前終止租約', 'chk', { w: 'full' }],
  ['', '通知送達方式', 'h'],
  ['bz.notice.email', '電子郵件', 'chk', {} ],
  ['bz.notice.sms',   '手機簡訊', 'chk', {} ],
  ['bz.notice.im',    '即時通訊軟體', 'chk', {} ]
];

/* 房東↔代管業（租賃住宅委託管理契約） */
var CT_WG_FIELDS = [
  ['', '委託管理範圍與期間', 'h'],
  ['wg.scope.whole',     '整戶（全部）委託', 'chk', {} ],
  ['wg.scope.hasFurniture', '含附屬設備', 'chk', {} ],
  ['wg.scope.floor',     '部分委託：第○層', 'text', {} ],
  ['wg.scope.roomCount', '房間數', 'text', {} ],
  ['wg.scope.roomNo',    '房間編號', 'text', {} ],
  ['wg.scope.area',      '面積（㎡）', 'text', {} ],
  ['wg.term.from',       '委託管理期間 自', 'date', { req: 1 }],
  ['wg.term.to',         '委託管理期間 至', 'date', { req: 1 }],
  ['', '報酬', 'h'],
  ['wg.fee.mode',     '報酬計算方式', 'sel', { opts: [['pct', '按月租金百分比'], ['fix', '固定金額']] }],
  ['wg.fee.pct',      '月租金百分之', 'text', { ph: '例：10' }],
  ['wg.fee.amount',   '固定金額（元）', 'money', {} ],
  ['wg.fee.payUnit',  '給付週期', 'sel', { opts: [['月', '按月'], ['期', '按期']] }],
  ['wg.fee.periods',  '每期幾個月', 'text', {} ],
  ['wg.fee.payDay',   '應於每月（期）幾日前給付', 'text', {} ],
  ['wg.fee.method',   '報酬給付方式', 'sel', { opts: [['deduct', '於代收租金內扣付'], ['transfer', '轉帳繳付'], ['cash', '現金繳付'], ['other', '其他']] }],
  ['wg.fee.bank',     '金融機構', 'text', {} ],
  ['wg.fee.acctName', '戶名', 'text', {} ],
  ['wg.fee.acctNo',   '帳號', 'text', {} ],
  ['', '受託管理項目', 'h', { hint: '勾選的項目才會出現在契約第五點的受託範圍內；沒勾的視為未受託，日後出事責任不在代管業。' }],
  ['wg.opt.collectRent',    '代為收取租金', 'chk', {} ],
  ['wg.opt.rentDeliver',    '租金交付委託人之期限', 'text', { ph: '例：收取後三日內' }],
  ['wg.opt.collectDeposit', '代為收取押金', 'chk', {} ],
  ['wg.opt.depositDeliver', '押金交付委託人之期限', 'text', {} ],
  ['wg.opt.manageDeposit',  '代為保管押金', 'chk', {} ],
  ['wg.opt.advance',        '代為墊付必要費用', 'chk', {} ],
  ['wg.opt.clean',          '清潔維護', 'chk', {} ],
  ['wg.opt.leftover',       '處理房客遺留物', 'chk', {} ],
  ['wg.opt.furniture',      '附屬設備之維護修繕', 'chk', {} ],
  ['', '其他約定', 'h'],
  ['wg.dunDays',     '租金遲付後幾日內催告', 'text', { ph: '例：3' }],
  ['wg.deliverDays', '契約終止後幾日內返還', 'text', { ph: '例：7' }],
  ['wg.notice.email', '通知方式：電子郵件', 'chk', {} ],
  ['wg.notice.sms',   '通知方式：手機簡訊', 'chk', {} ],
  ['wg.notice.im',    '通知方式：即時通訊軟體', 'chk', {} ]
];

/* 包租業↔房客（住宅轉租契約）的館別層級預設值。
   期間、租金、押金來自訂單本身，不在這裡設定。 */
var CT_SUB_FIELDS = [
  ['', '轉租契約預設值', 'h', { hint: '這些是整個館別共用的條件。產生每一份房客契約時，期間／租金／押金會自動從訂單帶入，不需要在這裡填。' }],
  ['sub.scope.hasFurniture', '出租含附屬設備', 'chk', {} ],
  ['sub.rent.payUnit',  '繳租週期', 'sel', { opts: [['月', '按月'], ['期', '按期']] }],
  ['sub.rent.payDay',   '應於每月（期）幾日前支付', 'text', { ph: '例：5' }],
  ['sub.rent.method',   '租金支付方式', 'sel', { opts: [['transfer', '轉帳繳付'], ['cash', '現金繳付'], ['other', '其他']] }],
  ['sub.rent.bank',     '金融機構', 'text', {} ],
  ['sub.rent.acctName', '戶名', 'text', {} ],
  ['sub.rent.acctNo',   '帳號', 'text', {} ],
  ['', '費用負擔（包租業與房客之間）', 'h'],
  ['sub.fees.mgmt',     '管理費', 'sel', CT_YN_BT],
  ['sub.fees.mgmtRoom', '住宅管理費（元／月）', 'text', {} ],
  ['sub.fees.mgmtPark', '車位管理費（元／月）', 'text', {} ],
  ['sub.fees.water',    '水費', 'sel', CT_YN_BT],
  ['sub.fees.elec',     '電費', 'sel', { opts: [
      ['biz', '由包租業負擔'],
      ['tenant_meter', '由房客負擔（以用電度數計費）'],
      ['tenant_flat', '由房客負擔（非以度數計費）']] }],
  ['sub.fees.gas',      '瓦斯費', 'sel', CT_YN_BT],
  ['sub.fees.net',      '網路費', 'sel', CT_YN_BT],
  ['sub.fees.other',    '其他費用及支付方式', 'text', { w: 'full' }],
  ['sub.tax.other',     '其他稅費及支付方式', 'text', { w: 'full' }],
  ['', '其他約定', 'h'],
  ['sub.notarize',      '雙方同意辦理公證', 'chk', {} ],
  ['sub.earlyTerm',     '約定得提前終止租約', 'chk', {} ],
  ['sub.decor.restore', '返還時之回復原狀約定', 'text', { w: 'full', ph: '例：現況返還' }],
  ['sub.notice.email',  '通知方式：電子郵件', 'chk', {} ],
  ['sub.notice.sms',    '通知方式：手機簡訊', 'chk', {} ],
  ['sub.notice.im',     '通知方式：即時通訊軟體', 'chk', {} ]
];

/* 現況確認書（三份契約的附件一共用同一份事實） */
var CT_A1_FIELDS = [
  ['', '建物狀況', 'h', { hint: '這份是法定附件，內容是「物件現在的事實」，三份契約都會附上同一份。填錯或隱匿會構成瑕疵擔保責任，請照實勾選。' }],
  ['a1.illegal',     '有依法令應拆除之違建或違規隔間', 'chk', {} ],
  ['a1.illegalNote', '違建／違規情形說明', 'text', {} ],
  ['a1.hasParkingDetail', '停車位已另有約定使用方式', 'chk', { w: 'full' }],
  ['', '消防安全設備', 'h'],
  ['a1.fireAlarm',      '有住宅用火災警報器', 'chk', {} ],
  ['a1.fireCheck',      '已依規定檢修申報', 'chk', {} ],
  ['a1.otherFire',      '有其他消防安全設備', 'chk', {} ],
  ['a1.otherFireItems', '其他消防安全設備品項', 'csv', { w: 'full', rows: 2, ph: '滅火器、緊急照明燈（以頓號或逗號分隔）' }],
  ['', '漏水與檢測', 'h'],
  ['a1.leak',      '有漏水情形', 'chk', {} ],
  ['a1.leakWhere', '漏水位置', 'text', {} ],
  ['a1.leakFix',   '漏水修繕約定', 'text', { w: 'full' }],
  ['a1.radiation',       '曾進行輻射檢測', 'chk', {} ],
  ['a1.radiationResult', '輻射檢測結果', 'text', {} ],
  ['a1.radiationFix',    '輻射異常處理約定', 'text', { w: 'full' }],
  ['a1.chloride',       '曾進行混凝土氯離子檢測', 'chk', {} ],
  ['a1.chlorideResult', '檢測結果', 'text', {} ],
  ['a1.chlorideOver',   '是否超過容許值', 'text', {} ],
  ['a1.chlorideFix',    '氯離子超標處理約定', 'text', { w: 'full' }],
  ['', '非自然死亡情事', 'h'],
  ['a1.deathDuringOwn', '持有期間曾發生凶殺、自殺或一氧化碳中毒致死', 'chk', { w: 'full' }],
  ['a1.deathBeforeOwn', '持有前', 'sel', { w: 'full', opts: [
      ['none', '確認無上列情事'],
      ['known', '知道曾發生上列情事'],
      ['unknown', '不知道曾否發生上列情事']] }],
  ['', '供水與管理', 'h'],
  ['a1.waterOk',    '供水及排水系統正常', 'chk', {} ],
  ['a1.waterFixBy', '不正常時之修繕約定', 'text', {} ],
  ['a1.rule',         '本建物有管理規約', 'chk', {} ],
  ['a1.ruleAttached', '管理規約已交付承租人', 'chk', {} ],
  ['a1.hasCommittee', '有管理委員會或管理負責人', 'chk', {} ],
  ['a1.mgmtFeeUnit',  '管理費繳納方式', 'sel', { opts: [['月', '月繳'], ['季', '季繳'], ['年', '年繳'], ['其他', '其他']] }],
  ['a1.mgmtFee',      '管理費金額（元）', 'text', {} ],
  ['a1.parkFee',      '停車位管理費（元）', 'text', {} ],
  ['a1.owedFee',      '有積欠管理費', 'chk', {} ],
  ['a1.owedAmt',      '積欠金額（元）', 'text', {} ],
  ['', '附屬設備', 'h', { hint: '一行一項，格式「品項，數量」。這份清單同時也是退房點交的依據。' }],
  ['a1.equip', '附屬設備清單', 'equip', { w: 'full', rows: 8, ph: '冷氣，1\n床組，1\n衣櫃，1\n熱水器，1' }]
];

/* ══════════════════════════════════════════════════════════════════
   Modal 骨架（第一次用到時才插入 DOM）
   ══════════════════════════════════════════════════════════════════ */
var CT_UI_READY = false;
function ctEnsureUI() {
  if (CT_UI_READY) return;
  CT_UI_READY = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="overlay" id="ctsg-ov" onclick="if(event.target===this)ctCloseSigner()">' +
    '<div class="modal" style="width:640px;max-width:96vw">' +
    '<div class="modal-h"><h2>✍️ 簽約主體設定</h2>' +
    '<button class="close-btn" onclick="ctCloseSigner()">✕</button></div>' +
    '<div class="modal-body" style="max-height:68vh;overflow-y:auto" id="ctsg-body"></div>' +
    '<div class="modal-f"><div id="ctsg-msg" style="font-size:11.5px;font-weight:700;flex:1"></div>' +
    '<button class="btn btn-ghost" onclick="ctCloseSigner()">關閉</button>' +
    '<button class="btn btn-primary" onclick="ctSaveSigner()">💾 儲存</button></div>' +
    '</div></div>' +

    '<div class="overlay" id="ctcd-ov" onclick="if(event.target===this)ctCloseData()">' +
    '<div class="modal" style="width:780px;max-width:98vw">' +
    '<div class="modal-h"><h2 id="ctcd-title">📋 館別契約設定</h2>' +
    '<button class="close-btn" onclick="ctCloseData()">✕</button></div>' +
    '<div style="padding:8px 18px 0;display:flex;gap:6px;flex-wrap:wrap" id="ctcd-tabs"></div>' +
    '<div class="modal-body" style="max-height:62vh;overflow-y:auto" id="ctcd-body"></div>' +
    '<div class="modal-f"><div id="ctcd-msg" style="font-size:11.5px;font-weight:700;flex:1"></div>' +
    '<button class="btn btn-ghost" onclick="ctCloseData()">關閉</button>' +
    '<button class="btn btn-primary" onclick="ctSaveData()">💾 儲存</button></div>' +
    '</div></div>' +

    '<div class="overlay" id="ctl-ov" onclick="if(event.target===this)ctCloseList()">' +
    '<div class="modal" style="width:980px;max-width:98vw">' +
    '<div class="modal-h"><h2>📄 契約管理</h2>' +
    '<button class="close-btn" onclick="ctCloseList()">✕</button></div>' +
    '<div class="modal-body" style="max-height:72vh;overflow-y:auto" id="ctl-body"></div>' +
    '<div class="modal-f">' +
    '<a class="btn btn-ghost" href="contract-template.html" target="_blank" style="text-decoration:none">📑 查看空白模板</a>' +
    '<button class="btn btn-ghost" onclick="ctOpenSigner()">✍️ 簽約主體設定</button>' +
    '<button class="btn btn-primary" onclick="ctCloseList()">關閉</button></div>' +
    '</div></div>' +

    '<div class="overlay" id="ctg-ov" onclick="if(event.target===this)ctCloseGen()">' +
    '<div class="modal" style="width:680px;max-width:96vw">' +
    '<div class="modal-h"><h2 id="ctg-title">產生簽約連結</h2>' +
    '<button class="close-btn" onclick="ctCloseGen()">✕</button></div>' +
    '<div class="modal-body" style="max-height:68vh;overflow-y:auto" id="ctg-body"></div>' +
    '<div class="modal-f"><div id="ctg-msg" style="font-size:11.5px;font-weight:700;flex:1"></div>' +
    '<button class="btn btn-ghost" onclick="ctCloseGen()">取消</button>' +
    '<button class="btn btn-primary" id="ctg-ok" onclick="ctDoCreate()">🔗 產生連結</button></div>' +
    '</div></div>'
  );
}

/* ══════════════════════════════════════════════════════════════════
   1. 簽約主體設定
   ══════════════════════════════════════════════════════════════════ */
function ctOpenSigner() {
  ctEnsureUI();
  var d = Cloud.get(CT_KV_SIGNER, {}) || {};
  document.getElementById('ctsg-body').innerHTML =
    '<div style="font-size:11px;color:var(--muted);line-height:1.8;margin-bottom:10px">' +
    '契約條文是內政部規定的固定格式，不可修改；這裡填的是「貴公司」這一方的資料，' +
    '會自動套進每一份契約。標 <span style="color:#c92a2a">＊</span> 的欄位沒填完就無法產生契約。' +
    '</div>' + ctForm(CT_SIGNER_FIELDS, d, 'ctsg');
  document.getElementById('ctsg-msg').textContent = '';
  document.getElementById('ctsg-ov').classList.add('open');
}
function ctCloseSigner() { document.getElementById('ctsg-ov').classList.remove('open'); ctMaybeBackToGen(); }
function ctSaveSigner() {
  var d = ctReadForm(document.getElementById('ctsg-body'), Cloud.get(CT_KV_SIGNER, {}) || {});
  Cloud.set(CT_KV_SIGNER, d);
  var miss = CT_SIGNER_FIELDS.filter(function (f) {
    return f[3] && f[3].req && !String(ctGet(d, f[0]) || '').trim();
  }).map(function (f) { return f[1]; });
  var m = document.getElementById('ctsg-msg');
  if (miss.length) { m.style.color = '#e67700'; m.textContent = '已儲存，但尚缺：' + miss.join('、'); }
  else { m.style.color = '#16a34a'; m.textContent = '已儲存，可以開始產生契約了。'; }
}

/* ══════════════════════════════════════════════════════════════════
   2. 館別契約設定
   ══════════════════════════════════════════════════════════════════ */
var CT_CUR_PROP = null, CT_CUR_TAB = 'owner', CT_CUR_DATA = null;

function ctOpenData(propId, tab) {
  ctEnsureUI();
  var cp = ctProp(propId);
  if (!cp) { alert('找不到這個館別'); return; }
  CT_CUR_PROP = propId;
  CT_CUR_TAB = tab || 'owner';
  var all = Cloud.get(CT_KV_DATA, {}) || {};
  CT_CUR_DATA = JSON.parse(JSON.stringify(all[propId] || {}));
  document.getElementById('ctcd-title').textContent =
    '📋 契約設定 — ' + cp.name + '（' + (cp.serviceType || '未設服務類型') + '）';
  document.getElementById('ctcd-msg').textContent = '';
  ctRenderDataTabs(cp);
  document.getElementById('ctcd-ov').classList.add('open');
}
function ctCloseData() { document.getElementById('ctcd-ov').classList.remove('open'); ctMaybeBackToGen(); }

function ctRenderDataTabs(cp) {
  var kind = CT_KIND_OF_SVC[cp.serviceType];
  var tabs = [['owner', '房東資料'], ['prop', '建物登記']];
  if (kind === 'bz') tabs.push(['bz', '包租契約條件']);
  if (kind === 'wg') tabs.push(['wg', '委託管理契約條件']);
  if (kind === 'bz') tabs.push(['sub', '轉租契約預設值']);
  tabs.push(['a1', '現況確認書']);
  if (!tabs.some(function (t) { return t[0] === CT_CUR_TAB; })) CT_CUR_TAB = 'owner';

  document.getElementById('ctcd-tabs').innerHTML = tabs.map(function (t) {
    var on = t[0] === CT_CUR_TAB;
    return '<button class="btn ' + (on ? 'btn-primary' : 'btn-ghost') + ' sm" ' +
      'onclick="ctSwitchTab(\'' + t[0] + '\')">' + ctEsc(t[1]) + '</button>';
  }).join('');

  var spec = { owner: CT_OWNER_FIELDS, prop: CT_PROP_FIELDS, bz: CT_BZ_FIELDS,
               wg: CT_WG_FIELDS, sub: CT_SUB_FIELDS, a1: CT_A1_FIELDS }[CT_CUR_TAB];
  var note = '';
  if (CT_CUR_TAB === 'prop')
    note = '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">' +
           '縣市／行政區自動帶入：' + ctEsc((cp.city || '—') + ' ' + (cp.district || '')) +
           '（要改請到「管理房源」改館別設定）</div>';
  if (CT_CUR_TAB === 'sub' && kind !== 'bz')
    note = '<div style="font-size:11px;color:#e67700;margin-bottom:8px">' +
           '這個館別的服務類型不是「包租」，不會與房客簽訂轉租契約。</div>';
  if (!kind)
    note += '<div style="font-size:11px;color:#c92a2a;margin-bottom:8px">' +
            '這個館別還沒設定服務類型（包租／代租代管），系統無法判斷要用哪一份房東契約。</div>';
  document.getElementById('ctcd-body').innerHTML = note + ctForm(spec, CT_CUR_DATA, 'ctcd');
}
function ctSwitchTab(tab) {
  /* 切 tab 前先把目前這一頁填的東西收進暫存，不然切回來就不見了 */
  ctReadForm(document.getElementById('ctcd-body'), CT_CUR_DATA);
  CT_CUR_TAB = tab;
  var cp = ctProp(CT_CUR_PROP);
  ctRenderDataTabs(cp);
}
function ctSaveData() {
  ctReadForm(document.getElementById('ctcd-body'), CT_CUR_DATA);
  var all = Cloud.get(CT_KV_DATA, {}) || {};
  all = JSON.parse(JSON.stringify(all));
  all[CT_CUR_PROP] = CT_CUR_DATA;
  Cloud.set(CT_KV_DATA, all);
  var m = document.getElementById('ctcd-msg');
  m.style.color = '#16a34a';
  m.textContent = '已儲存。';
}

/* ══════════════════════════════════════════════════════════════════
   3. 組出契約內容
   ══════════════════════════════════════════════════════════════════ */
/* 館別地址是一整串字（例「臺北市中山區民生東路二段88號」），
   契約要的是分欄的路／巷／弄／號。沒分欄填的時候，把扣掉縣市與
   行政區之後的剩餘部分塞進「路街」欄，印出來的地址仍然正確完整，
   使用者想拆細再去契約設定裡填。 */
function ctAddrRest(cp) {
  var a = String(cp.address || '');
  if (cp.city) a = a.replace(cp.city, '');
  if (cp.district) a = a.replace(cp.district, '');
  return a.trim();
}

function ctBuild(kind, propId, bookingId, overrides) {
  var CR = window.ContractRender;
  var d = CR.blankData(kind);
  var sg = Cloud.get(CT_KV_SIGNER, {}) || {};
  var cd = (Cloud.get(CT_KV_DATA, {}) || {})[propId] || {};
  var cp = ctProp(propId) || {};

  ctMerge(d, { biz: sg.biz || {}, mgr: sg.mgr || {} });
  ctMerge(d, cd);

  if (!d.prop.city) d.prop.city = cp.city || '';
  if (!d.prop.dist) d.prop.dist = cp.district || '';
  if (!d.prop.road) d.prop.road = ctAddrRest(cp);
  if (!d.a1.date) d.a1.date = todayStr();

  if (kind === 'sub') {
    var bk = loadBks().find(function (b) { return ctSameId(b.id, bookingId); });
    if (!bk) return null;
    var seg = (bk.segments || []).find(function (s) { return ctSameId(s.prop_id, propId); }) ||
              (bk.segments || [])[0] || {};
    d.tenant.name = bk.guest || '';
    d.tenant.tel = bk.phone || '';
    d.tenant.email = bk.email || '';
    d.room = seg.room || '';
    d.sub.scope.roomNo = seg.room || '';
    d.sub.scope.floor = d.prop.floor || '';
    d.sub.scope.roomCount = '1';
    d.sub.term.from = seg.checkin || '';
    d.sub.term.to = seg.checkout || '';
    d.sub.rent.monthly = seg.monthlyPrice || '';
    d.sub.deposit.amount = bk.deposit || '';
    if (seg.monthlyPrice > 0 && bk.deposit > 0)
      d.sub.deposit.months = Math.round(bk.deposit / seg.monthlyPrice * 10) / 10;
    d.sub.review.handedAt = todayStr();
    d.sub.a3.contractDate = todayStr();
  } else {
    d.owner.signDate = todayStr();
    if (kind === 'bz') d.bz.signDate = todayStr();
    if (kind === 'wg') { d.wg.signDate = todayStr(); d.wg.review.handedAt = todayStr(); }
  }
  if (overrides) ctMerge(d, overrides);
  /* 附件一的主建物面積表只有一列，直接用「樓層＋主建物面積」組出來。
     一定要放在所有 merge 之後：面積是從館別契約設定（或 overrides）來的，
     放在前面時面積還沒填進來，這一列就會是空的，印出來變成「主建物面積：，共計…」。 */
  if (d.prop.mainTotal && (!d.prop.mainFloors || !d.prop.mainFloors.length))
    d.prop.mainFloors = [{ f: d.prop.floor || '', a: d.prop.mainTotal }];
  d.kind = kind;
  return d;
}

/* 契約編號：種類＋年份＋當年流水號。人看得懂、排序正確、不會重複。 */
function ctMakeNo(kind, existing) {
  var pfx = { sub: '轉租', bz: '包租', wg: '委管' }[kind];
  var y = new Date().getFullYear();
  var n = existing.filter(function (c) {
    return c.kind === kind && String(c.no || '').indexOf(pfx + '-' + y + '-') === 0;
  }).length + 1;
  return pfx + '-' + y + '-' + String(n).padStart(4, '0');
}

/* ══════════════════════════════════════════════════════════════════
   4. 產生簽約連結
   ══════════════════════════════════════════════════════════════════ */
var CT_GEN = null;

async function ctGenOwner(propId) {
  ctEnsureUI();
  var cp = ctProp(propId);
  if (!cp) { alert('找不到這個館別'); return; }
  var kind = CT_KIND_OF_SVC[cp.serviceType];
  if (!kind) {
    alert('⚠️ 這個館別的服務類型不是「包租」或「代租代管」，系統無法判斷要用哪一份房東契約。\n' +
          '請先到「管理房源」設定服務類型。');
    return;
  }
  await ctOpenGen(kind, propId, null);
}

async function ctGenTenant(bookingId) {
  ctEnsureUI();
  var bk = loadBks().find(function (b) { return ctSameId(b.id, bookingId); });
  if (!bk) { alert('找不到這筆訂單'); return; }
  var seg = (bk.segments || [])[0];
  if (!seg) { alert('這筆訂單沒有住宿區段，無法產生契約'); return; }
  var cp = ctProp(seg.prop_id);
  if (!cp) { alert('找不到訂單對應的館別'); return; }
  if (CT_KIND_OF_SVC[cp.serviceType] !== 'bz') {
    if (!confirm('這個館別的服務類型是「' + (cp.serviceType || '未設定') + '」。\n' +
                 '住宅轉租契約只適用於包租案件（公司先向房東承租、再轉租給房客）。\n\n' +
                 '仍要產生轉租契約嗎？')) return;
  }
  await ctOpenGen('sub', seg.prop_id, bookingId);
}

async function ctOpenGen(kind, propId, bookingId, overrides) {
  var CR = window.ContractRender;
  var d = ctBuild(kind, propId, bookingId, overrides);
  if (!d) { alert('資料不足，無法組出契約'); return; }
  var cp = ctProp(propId) || {};
  var list = await Cloud.listContracts();
  d.no = ctMakeNo(kind, list);

  var vr = CR.validate(kind, d);
  var cross = ctCrossCheck(kind, d, propId, bookingId, list);
  CT_GEN = { kind: kind, propId: propId, bookingId: bookingId, data: d, ok: vr.ok };

  var signer = kind === 'sub' ? (d.tenant.name || '（未填房客姓名）') : (d.owner.name || '（未填房東姓名）');
  var term = kind === 'sub' ? d.sub.term : (kind === 'bz' ? d.bz.term : d.wg.term);
  var nd = CR.days(term.from, term.to);

  var h = '<div style="font-size:12.5px;line-height:1.9;margin-bottom:12px">' +
    '<b>' + ctEsc(CR.KIND_LABEL[kind]) + '</b>　' + ctEsc(d.no) + '<br>' +
    '館別：' + ctEsc(cp.name || '') + (d.room ? '　房號：' + ctEsc(d.room) : '') + '<br>' +
    '簽署人：' + ctEsc(CR.KIND_SIGNER[kind]) + '　' + ctEsc(signer) + '<br>' +
    '契約期間：' + ctEsc(term.from || '—') + ' ～ ' + ctEsc(term.to || '—') +
    (nd ? '（共 ' + nd + ' 日）' : '') + '</div>';

  h += '<div style="font-size:11px;color:var(--muted);line-height:1.8;margin-bottom:8px">' +
       '期間是契約的法定必載事項，且租期不得少於三十日。系統從訂單帶入的退房日' +
       '若與實際約定的租期迄日不同，請在這裡改好再產生連結——契約一旦簽署就不能修改。</div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px 12px;margin-bottom:12px">' +
    ctField([(kind === 'sub' ? 'sub' : kind) + '.term.from', '租期／委託期間 自', 'date', { req: 1 }], d, 'ctg') +
    ctField([(kind === 'sub' ? 'sub' : kind) + '.term.to', '至', 'date', { req: 1 }], d, 'ctg') +
    (kind === 'wg' ? '' :
      ctField([(kind === 'sub' ? 'sub' : kind) + '.rent.monthly', '每月租金（元）', 'money', { req: 1 }], d, 'ctg') +
      ctField([(kind === 'sub' ? 'sub' : kind) + '.deposit.amount', '押金（元）', 'money', {}], d, 'ctg')) +
    '</div>';

  if (!vr.ok) {
    h += '<div style="background:#fff5f5;border:1px solid #ffc9c9;border-radius:8px;padding:10px 12px;' +
         'font-size:12px;line-height:1.9;margin-bottom:10px"><b style="color:#c92a2a">' +
         '必要資料不完整，無法產生契約：</b><br>' +
         vr.errors.map(function (e) { return '• ' + ctEsc(e); }).join('<br>') + '</div>';
  }
  if (vr.warnings.length) {
    h += '<div style="background:#fff9db;border:1px solid #f0d58c;border-radius:8px;padding:10px 12px;' +
         'font-size:12px;line-height:1.9;margin-bottom:10px"><b style="color:#8a6d00">' +
         '以下欄位留白，契約上會印成空格由簽署人當場手寫：</b><br>' +
         vr.warnings.map(function (e) { return '• ' + ctEsc(e); }).join('<br>') + '</div>';
  }
  if (cross.length) {
    h += '<div style="background:#fff4e6;border:1px solid #ffc078;border-radius:8px;padding:10px 12px;' +
         'font-size:12px;line-height:1.9;margin-bottom:10px"><b style="color:#d9480f">' +
         '合法性交叉檢查：</b><br>' +
         cross.map(function (e) { return '• ' + ctEsc(e); }).join('<br>') + '</div>';
  }

  /* 補完資料後必須回到這個視窗重新驗證一次，否則畫面上還是舊的紅字，
     使用者會以為補了沒用。所以這兩顆鈕是「去補、補完自動回來」。 */
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
    '<button class="btn btn-ghost sm" onclick="ctPreviewDraft()">👁 預覽契約全文</button>' +
    '<button class="btn btn-ghost sm" onclick="ctGenGoFix(\'data\')">📋 補填契約設定</button>' +
    '<button class="btn btn-ghost sm" onclick="ctGenGoFix(\'signer\')">✍️ 簽約主體設定</button></div>';

  document.getElementById('ctg-title').textContent = '產生簽約連結';
  document.getElementById('ctg-body').innerHTML = h;
  document.getElementById('ctg-msg').textContent = '';
  /* 上一次產生成功時這顆鈕被藏起來了，重開視窗一定要復原 */
  document.getElementById('ctg-ok').style.display = '';
  document.getElementById('ctg-ok').disabled = !vr.ok;
  document.getElementById('ctg-ov').classList.add('open');
}
function ctCloseGen() { document.getElementById('ctg-ov').classList.remove('open'); CT_BACK_TO_GEN = null; }

/* 去補資料，補完（關掉那個設定視窗）就自動重開產生視窗重新驗證。
   先把目前視窗上編輯過的期間／租金收起來，不然補完回來會被打回原值。 */
var CT_BACK_TO_GEN = null;
function ctGenGoFix(which) {
  ctSyncGenEdits();
  var k = CT_GEN.kind, pid = CT_GEN.propId, bid = CT_GEN.bookingId;
  var ov = k === 'sub'
    ? { sub: { term: CT_GEN.data.sub.term, rent: CT_GEN.data.sub.rent, deposit: CT_GEN.data.sub.deposit } }
    : (k === 'bz'
        ? { bz: { term: CT_GEN.data.bz.term, rent: CT_GEN.data.bz.rent, deposit: CT_GEN.data.bz.deposit } }
        : { wg: { term: CT_GEN.data.wg.term } });
  CT_BACK_TO_GEN = { kind: k, propId: pid, bookingId: bid, overrides: ov };
  document.getElementById('ctg-ov').classList.remove('open');
  if (which === 'signer') ctOpenSigner(); else ctOpenData(pid);
}
async function ctMaybeBackToGen() {
  var b = CT_BACK_TO_GEN;
  if (!b) return;
  CT_BACK_TO_GEN = null;
  await ctOpenGen(b.kind, b.propId, b.bookingId, b.overrides);
}

/* 把這份草稿在新視窗用跟簽署頁完全一樣的樣式印出來，確認無誤再送出 */
function ctPreviewDraft() {
  ctSyncGenEdits();
  var html = window.ContractRender.render(CT_GEN.kind, 'all', CT_GEN.data);
  var w = window.open('', '_blank');
  if (!w) { alert('瀏覽器阻擋了新視窗，請允許彈出視窗後再試'); return; }
  w.document.write('<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">' +
    '<title>契約草稿預覽 — ' + ctEsc(CT_GEN.data.no) + '</title>' +
    '<link rel="stylesheet" href="css/contract.css"></head><body class="plain">' +
    '<div class="warnbar">這是<b>尚未簽署</b>的草稿預覽。要正式簽署請回後台產生簽署連結交給簽署人。' +
    '<button onclick="window.print()" style="margin-left:10px">🖨 列印／儲存 PDF</button></div>' +
    html + '</body></html>');
  w.document.close();
}

/* 使用者在產生視窗裡改過的期間／租金／押金要收回 CT_GEN.data */
function ctSyncGenEdits() {
  ctReadForm(document.getElementById('ctg-body'), CT_GEN.data);
  var k = CT_GEN.kind === 'sub' ? 'sub' : CT_GEN.kind;
  if (k !== 'wg') {
    var rent = Number(ctGet(CT_GEN.data, k + '.rent.monthly') || 0);
    var dep = Number(ctGet(CT_GEN.data, k + '.deposit.amount') || 0);
    ctSet(CT_GEN.data, k + '.deposit.months',
      rent > 0 && dep > 0 ? Math.round(dep / rent * 10) / 10 : '');
  }
}

/* ── 交叉檢查：紙本抓不到、但系統有全部資料所以抓得到的錯 ────────── */
function ctCrossCheck(kind, d, propId, bookingId, list) {
  var out = [];
  var signedBz = list.filter(function (c) {
    return c.kind === 'bz' && ctSameId(c.prop_id, propId) && c.status === 'signed';
  });

  if (kind === 'sub') {
    if (!signedBz.length) {
      out.push('這個館別還沒有已簽署的「住宅包租契約」。包租業要先向房東承租，' +
               '才有權把房子轉租給房客；建議先完成房東端簽約。');
    } else {
      /* 轉租期間不得超出包租期間，否則到期後房客無處可去，是實務上最常見的
         糾紛。契約列表刻意不撈 snapshot（那是整份契約、很大），所以這裡只能
         提醒人工確認，不做自動比對——寧可說實話，也不要給假的安全感。 */
      out.push('請確認轉租期間（' + (d.sub.term.from || '—') + '～' + (d.sub.term.to || '—') +
               '）沒有超出與房東約定的包租期間（' +
               signedBz.map(function (c) { return c.no; }).join('、') +
               '）；超出的部分公司並沒有出租權源。');
    }
    var dupe = list.filter(function (c) {
      return c.kind === 'sub' && c.booking_id === bookingId && c.status !== 'void';
    });
    if (dupe.length) out.push('這筆訂單已經有 ' + dupe.length + ' 份未作廢的轉租契約（' +
      dupe.map(function (c) { return c.no; }).join('、') + '），確認不是重複產生。');
  } else {
    var same = list.filter(function (c) {
      return c.kind === kind && ctSameId(c.prop_id, propId) && c.status !== 'void';
    });
    if (same.length) out.push('這個館別已經有 ' + same.length + ' 份未作廢的同類型房東契約（' +
      same.map(function (c) { return c.no; }).join('、') + '），確認不是重複產生。');
  }
  return out;
}

async function ctDoCreate() {
  var btn = document.getElementById('ctg-ok');
  var msg = document.getElementById('ctg-msg');
  ctSyncGenEdits();

  /* 使用者可能在這個視窗裡把期間改短了，所以送出前再驗一次 */
  var vr = window.ContractRender.validate(CT_GEN.kind, CT_GEN.data);
  if (!vr.ok) {
    msg.style.color = '#c92a2a';
    msg.textContent = vr.errors[0];
    return;
  }
  btn.disabled = true;
  var d = CT_GEN.data;
  var r = await Cloud.createContract({
    kind: CT_GEN.kind, no: d.no,
    propId: CT_GEN.propId, room: d.room || null, bookingId: CT_GEN.bookingId,
    signerName: CT_GEN.kind === 'sub' ? d.tenant.name : d.owner.name,
    snapshot: d
  });
  btn.disabled = false;
  if (!r) return;
  ctShowLink(r.url, d.no, CT_GEN.kind);
}

function ctShowLink(url, no, kind) {
  var who = kind === 'sub' ? '房客' : '房東';
  document.getElementById('ctg-title').textContent = '簽署連結已產生';
  document.getElementById('ctg-body').innerHTML =
    '<div style="font-size:12.5px;line-height:1.9">' +
    '<b>' + ctEsc(no) + '</b> 已建立，狀態為「待簽署」。<br>' +
    '把下面的連結傳給' + who + '，' + who + '不需要帳號也不需要安裝任何東西，' +
    '打開就能看到契約全文、線上簽名。<br>' +
    '系統會記錄連結的首次開啟時間作為審閱期憑據，簽署後契約內容即鎖定不可修改。</div>' +
    '<div style="margin:12px 0;padding:10px 12px;background:var(--light);border-radius:8px;' +
    'font-size:12px;word-break:break-all" id="ctg-url">' + ctEsc(url) + '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn btn-primary sm" onclick="ctCopyLink()">📋 複製連結</button>' +
    '<a class="btn btn-ghost sm" href="' + ctEsc(url) + '" target="_blank" style="text-decoration:none">' +
    '🔗 自己先開一次看看</a></div>' +
    '<div style="font-size:11px;color:var(--muted);margin-top:10px;line-height:1.8">' +
    '注意：你自己點開也會被記錄成「首次開啟」。要留完整的審閱期證據，建議直接把連結給' + who + '。</div>';
  document.getElementById('ctg-ok').style.display = 'none';
  document.getElementById('ctg-msg').textContent = '';
}
function ctCopy(txt) {
  navigator.clipboard.writeText(txt).then(function () { alert('✅ 簽署連結已複製'); },
    function () { alert('複製失敗，請手動選取連結文字'); });
}
/* 剛產生的連結直接從畫面上那一塊讀，不經過 onclick 字串。
   URL 裡只要出現一個單引號，塞進 onclick 就會把整段 JS 弄壞。 */
function ctCopyLink() { ctCopy(document.getElementById('ctg-url').textContent); }

/* ══════════════════════════════════════════════════════════════════
   5. 契約管理
   ══════════════════════════════════════════════════════════════════ */
var CT_STATUS_UI = {
  pending: { label: '待簽署', color: '#e67700', bg: '#fff3bf' },
  signed:  { label: '已簽署', color: '#2f9e44', bg: '#ebfbee' },
  void:    { label: '已作廢', color: '#868e96', bg: '#f1f3f5' }
};

async function ctOpenList() {
  ctEnsureUI();
  document.getElementById('ctl-body').innerHTML =
    '<div style="padding:30px;text-align:center;color:var(--muted)">載入中…</div>';
  document.getElementById('ctl-ov').classList.add('open');
  await ctRenderList();
}
function ctCloseList() { document.getElementById('ctl-ov').classList.remove('open'); }

async function ctRenderList() {
  var CR = window.ContractRender;
  var list = await Cloud.listContracts();
  var cps = loadCPs();
  var nameOf = {};
  cps.forEach(function (p) { nameOf[p.id] = p.name; });
  var today = todayStr();

  var h = ctTodoBlock(list, nameOf, today);

  h += '<div style="font-size:12px;font-weight:700;margin:14px 0 6px">新增契約</div>';
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;' +
       'background:var(--light);border-radius:8px;padding:10px 12px;margin-bottom:14px">';
  h += '<select id="ctl-prop" style="padding:6px 8px;border:1px solid var(--border);' +
       'border-radius:6px;font-size:12px;font-family:inherit">' +
       cps.map(function (p) {
         return '<option value="' + ctEsc(p.id) + '">' + ctEsc(p.name) +
                '（' + ctEsc(p.serviceType || '未設') + '）</option>';
       }).join('') + '</select>';
  h += '<button class="btn btn-primary sm" onclick="ctGenOwner(document.getElementById(\'ctl-prop\').value)">' +
       '🏠 產生房東契約</button>';
  h += '<button class="btn btn-ghost sm" onclick="ctOpenData(document.getElementById(\'ctl-prop\').value)">' +
       '📋 契約設定</button>';
  h += '<span style="flex:1"></span>';
  h += '<span style="font-size:11px;color:var(--muted)">房客契約請從訂單視窗內的「產生簽約連結」建立</span>';
  h += '</div>';

  h += '<div style="font-size:12px;font-weight:700;margin:0 0 6px">契約清單（' + list.length + '）</div>';
  if (!list.length) {
    h += '<div style="padding:30px;text-align:center;color:var(--muted);font-size:13px">' +
         '還沒有任何契約。先完成「簽約主體設定」與館別的「契約設定」，再產生簽署連結。</div>';
  } else {
    h += '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
         '<tr style="background:var(--light)">' +
         ['種類', '契約編號', '館別 · 房號', '簽署人', '狀態', '建立', '簽署', '操作']
           .map(function (t) { return '<th style="padding:6px 7px;text-align:left;' +
             'border-bottom:1px solid var(--border);white-space:nowrap">' + t + '</th>'; }).join('') +
         '</tr>';
    list.forEach(function (c) {
      var st = CT_STATUS_UI[c.status] || { label: c.status, color: '#495057', bg: '#f1f3f5' };
      h += '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:6px 7px;white-space:nowrap">' + ctEsc(CR.KIND_LABEL[c.kind] || c.kind) + '</td>' +
        '<td style="padding:6px 7px;white-space:nowrap"><code style="font-size:10.5px">' +
          ctEsc(c.no) + '</code></td>' +
        '<td style="padding:6px 7px">' + ctEsc(nameOf[c.prop_id] || '—') +
          (c.room ? ' · ' + ctEsc(c.room) : '') + '</td>' +
        '<td style="padding:6px 7px">' + ctEsc(c.signer_name || '—') + '</td>' +
        '<td style="padding:6px 7px;white-space:nowrap"><span style="display:inline-block;' +
          'padding:2px 8px;border-radius:999px;background:' + st.bg + ';color:' + st.color +
          ';font-weight:700">' + st.label + '</span></td>' +
        '<td style="padding:6px 7px;white-space:nowrap">' + ctEsc(ctTW(c.created_at)) + '</td>' +
        '<td style="padding:6px 7px;white-space:nowrap">' + ctEsc(ctTW(c.signed_at) || '—') + '</td>' +
        '<td style="padding:6px 7px;white-space:nowrap">' + ctRowActions(c) + '</td>' +
        '</tr>';
    });
    h += '</table>';
  }
  document.getElementById('ctl-body').innerHTML = h;
}

function ctRowActions(c) {
  var s = '<button class="btn btn-ghost sm" style="padding:3px 8px" ' +
          'onclick="ctView(\'' + c.id + '\')">檢視</button> ';
  if (c.status !== 'void')
    s += '<button class="btn btn-ghost sm" style="padding:3px 8px" ' +
         'onclick="ctCopy(Cloud.contractUrl(\'' + c.token + '\'))">複製連結</button> ';
  if (c.status === 'pending')
    s += '<button class="btn btn-ghost sm" style="padding:3px 8px;color:#c92a2a" ' +
         'onclick="ctDelete(\'' + c.id + '\',\'' + ctEsc(c.no) + '\')">撤回</button>';
  if (c.status === 'signed')
    s += '<button class="btn btn-ghost sm" style="padding:3px 8px;color:#c92a2a" ' +
         'onclick="ctVoid(\'' + c.id + '\',\'' + ctEsc(c.no) + '\')">作廢</button>';
  return s;
}

/* 待辦：這些是系統有資料、人卻容易忘掉的法定義務與到期提醒 */
function ctTodoBlock(list, nameOf, today) {
  var items = [];
  var sg = Cloud.get(CT_KV_SIGNER, {}) || {};
  var missSigner = CT_SIGNER_FIELDS.filter(function (f) {
    return f[3] && f[3].req && !String(ctGet(sg, f[0]) || '').trim();
  });
  if (missSigner.length)
    items.push(['#c92a2a', '簽約主體設定還缺 ' + missSigner.length + ' 個法定必填欄位（' +
      missSigner.slice(0, 3).map(function (f) { return f[1]; }).join('、') +
      (missSigner.length > 3 ? '…' : '') + '），目前無法產生任何契約。',
      '<button class="btn btn-primary sm" style="padding:3px 9px" onclick="ctOpenSigner()">去設定</button>']);

  list.forEach(function (c) {
    if (c.status !== 'signed') return;
    /* 包租業簽訂轉租契約後三十日內，應以書面將轉租範圍與次承租人資料告知出租人 */
    if (c.kind === 'sub' && !c.notified_at) {
      var due = ctTW(new Date(c.signed_at).getTime() + 30 * 86400000);
      items.push([due < today ? '#c92a2a' : '#e67700',
        (due < today ? '【已逾期】' : '') + '轉租契約 ' + c.no + '（' +
        (nameOf[c.prop_id] || '') + (c.room ? ' · ' + c.room : '') +
        '）尚未告知房東轉租情形，法定期限 ' + due + '。',
        '<button class="btn btn-ghost sm" style="padding:3px 9px" onclick="ctNotified(\'' +
        c.id + '\')">標記已告知</button>']);
    }
  });

  var pend = list.filter(function (c) {
    return c.status === 'pending' && c.opened_at &&
      (Date.now() - new Date(c.opened_at).getTime()) > 7 * 86400000;
  });
  if (pend.length)
    items.push(['#e67700', '有 ' + pend.length +
      ' 份契約簽署人已開啟超過七天但尚未簽署（' +
      pend.map(function (c) { return c.no; }).join('、') + '），建議追蹤。', '']);

  if (!items.length) return '';
  return '<div style="border:1px solid #f0d58c;background:#fff9db;border-radius:8px;' +
    'padding:10px 12px;margin-bottom:12px"><div style="font-size:12px;font-weight:700;' +
    'margin-bottom:6px">🔔 契約待辦（' + items.length + '）</div>' +
    items.map(function (it) {
      return '<div style="display:flex;gap:8px;align-items:center;font-size:11.5px;' +
        'line-height:1.8;padding:3px 0"><span style="color:' + it[0] + ';flex:1">' +
        it[1] + '</span>' + it[2] + '</div>';
    }).join('') + '</div>';
}

async function ctView(id) {
  var c = await Cloud.getContract(id);
  if (!c) return;
  var snap = c.snapshot || {};
  if (!snap.sign) snap.sign = {};
  if (c.sig_img) snap.sign.sigImg = c.sig_img;
  var head = '';
  if (c.status === 'signed') {
    head = '已於 <b>' + ctEsc(ctTW(c.signed_at, true)) +
      '</b> 完成簽署。身分證統一編號：' +
      ctEsc(c.signer_id_no ? window.ContractRender.maskId(c.signer_id_no) : '—') +
      '　IP：' + ctEsc(c.signer_ip || '—') +
      '　內容指紋：' + ctEsc(c.content_hash || '—') +
      '　<b>此契約已鎖定，內容不可修改。</b>';
  } else if (c.status === 'void') {
    head = '此契約<b>已作廢</b>。' + (c.void_reason ? '原因：' + ctEsc(c.void_reason) : '');
  } else {
    head = '此契約<b>尚未簽署</b>（首次開啟時間：' +
      ctEsc(c.opened_at ? ctTW(c.opened_at, true) : '尚未開啟') + '）。';
  }
  var w = window.open('', '_blank');
  if (!w) { alert('瀏覽器阻擋了新視窗，請允許彈出視窗後再試'); return; }
  w.document.write('<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">' +
    '<title>' + ctEsc(c.no) + '</title><link rel="stylesheet" href="css/contract.css"></head>' +
    '<body class="plain"><div class="warnbar">' + head +
    '<button onclick="window.print()" style="margin-left:10px">🖨 列印／儲存 PDF</button></div>' +
    window.ContractRender.render(c.kind, 'all', snap) + '</body></html>');
  w.document.close();
}

async function ctVoid(id, no) {
  var reason = prompt('作廢契約 ' + no + '。\n已簽署的契約依規定要保存五年，' +
    '所以系統不會刪除它，而是標記為作廢並留下原因。\n\n請輸入作廢原因：');
  if (reason === null) return;
  if (!reason.trim()) { alert('請輸入作廢原因'); return; }
  if (await Cloud.voidContract(id, reason.trim())) await ctRenderList();
}
async function ctDelete(id, no) {
  if (!confirm('撤回尚未簽署的契約 ' + no + '？\n連結會立刻失效，對方開啟時會看到「連結無效」。')) return;
  if (await Cloud.deleteContract(id)) await ctRenderList();
}
async function ctNotified(id) {
  if (!confirm('確認已以書面（含電子郵件）將轉租範圍與次承租人資料告知房東？\n' +
               '系統只記錄時間，書面本身請自行留存。')) return;
  if (await Cloud.markContractNotified(id)) await ctRenderList();
}
