/* ══════════════════════════════════════════════════════════
   入住／退房點交確認單的唯一真實來源。
   後台預覽、房客簽收頁、列印 PDF 全部呼叫這個檔案，
   所以不可能出現「預覽的金額跟房客簽的那張不一樣」。

   kind：
     in  = 入住點交。交屋時逐項確認設備狀態，建立「原狀」基準。
           這一張沒有金額欄，因為入住當下不會向房客收任何賠償。
     out = 退房點交。與入住基準並排比對，認定損壞與歸責，
           並在現場填入雙方確認的估定賠償金額。

   為什麼金額在點交現場就要定案：
     賠償金額是房客唯一有機會當面異議的數字。若留到事後憑實際修費
     追加，房客簽的那張就只是一份「有破損」的紀錄，押金扣多少變成
     單方面決定，這正是租賃糾紛最常見的起點。所以設計上金額當場填、
     當場簽，估定與實際修費的差額由業者自行吸收。

   版面刻意吃 css/contract.css：
     .paper／table.t／.signblock／.audit／@page 與列印規則都和契約
     共用一份，業者不會看到兩種紙張樣式，也只有一條列印管線要維護。
   ══════════════════════════════════════════════════════════ */
(function (root) {
'use strict';

var KIND_LABEL = { in: '入住點交確認單', out: '退房點交確認單' };
var KIND_SHORT = { in: '入住點交', out: '退房點交' };

/* 四種狀態缺一不可：
   「無此項」和「缺少」看起來很像，意思完全相反——前者是本來就沒有
   這項設備（例如這間沒配冰箱），後者是本來有、現在不見了。混成一種，
   退房時沒有任何方法判斷該不該賠。 */
var ST_LABEL = { ok: '堪用正常', bad: '損壞／功能異常', missing: '缺少', na: '無此項' };
var ST_SHORT = { ok: '正常', bad: '損壞', missing: '缺少', na: '無此項' };

/* 歸責三分法對應到押金該不該扣：只有 tenant 會進賠償合計。 */
var FAULT_LABEL = {
  tenant: '可歸責於房客',
  wear:   '正常使用之耗損',
  pre:    '入住前既已存在'
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
/* 空值回全角空白格而不是空字串：點交單常常要印出來現場手寫補填，
   留白格才看得出「這裡該填東西」。 */
function v(x, w) {
  var s = (x == null || x === '') ? '　'.repeat(w || 4) : String(x);
  return '<span class="v">' + esc(s) + '</span>';
}
function money(n) {
  if (n === '' || n == null || isNaN(Number(n))) return '';
  return Number(n).toLocaleString('en-US');
}
function rocStr(iso) {
  if (!iso) return '民國　年　月　日';
  var p = String(iso).split('-');
  return '民國' + (+p[0] - 1911) + '年' + (+p[1]) + '月' + (+p[2]) + '日';
}

/* ══════════════════════════════════════════════════════════
   合計。賠償金額只累加「可歸責於房客」的項目。
   這個函數是後台清單、結算單、列印、簽收頁共用的唯一算法——
   任何一處自己再加一次總和，就會出現兩個不一樣的數字。
   ══════════════════════════════════════════════════════════ */
function sumOf(items) {
  var s = { bad: 0, missing: 0, cost: 0, charge: 0 };
  (items || []).forEach(function (it) {
    if (it.st === 'bad') s.bad++;
    if (it.st === 'missing') s.missing++;
    var c = Number(it.cost) || 0;
    if (it.st !== 'bad' && it.st !== 'missing') return;
    s.cost += c;                                  /* 不分歸責的估價總額 */
    if (it.fault === 'tenant') { s.charge += c; }  /* 真正要扣押金的 */
  });
  return s;
}

/* 有異狀才允許上傳照片（決策：避免照片吃掉免費方案的儲存空間），
   所以「正常」的項目就算 photos 有殘留也不顯示。 */
function photosOf(it) {
  if (it.st !== 'bad' && it.st !== 'missing') return [];
  return (it.photos || []).filter(Boolean);
}

function blank(kind) {
  return {
    v: 1, kind: (kind === 'in' ? 'in' : 'out'),
    no: '', on: '', by: '',
    co: { name: '', taxid: '', tel: '', addr: '' },
    guest: { name: '', phone: '' },
    prop: { id: '', name: '', addr: '', room: '' },
    period: { checkin: '', checkout: '' },
    items: [], meter: null, base: null,
    note: '', sign: {}
  };
}

/* ── 當事人與標的 ──────────────────────────────────── */
function headBlock(d) {
  var co = d.co || {}, g = d.guest || {}, p = d.prop || {}, t = d.period || {};
  var h = '';
  h += '<table class="t"><tr>' +
       '<td class="g" style="width:26px">當事人</td>' +
       '<td style="width:50%"><b>甲方（出租人／管理方）</b><br>' +
       '名稱：' + v(co.name, 10) + '<br>' +
       '統一編號：' + v(co.taxid, 8) + '<br>' +
       '電話：' + v(co.tel, 10) + '<br>' +
       '地址：' + v(co.addr, 16) + '</td>' +
       '<td><b>乙方（承租人／房客）</b><br>' +
       '姓名：' + v(g.name, 8) + '<br>' +
       '聯絡電話：' + v(g.phone, 10) + '<br>' +
       '<span style="color:#666;font-size:10.5px">（本單以乙方於訂單登記之手機號碼核對簽收人身分，' +
       '不另蒐集國民身分證統一編號。）</span></td></tr>' +
       '<tr><td class="g">標的</td><td colspan="2">' +
       '館別：' + v(p.name, 8) + '　房號：' + v(p.room, 4) + '<br>' +
       '地址：' + v(p.addr, 20) + '<br>' +
       '租期：' + v(t.checkin ? rocStr(t.checkin) : '', 10) + ' 至 ' +
       v(t.checkout ? rocStr(t.checkout) : '', 10) + '</td></tr>' +
       '</table>';
  return h;
}

/* ── 設備與現況明細 ────────────────────────────────── */
/* 退房單多出「入住時現況」一欄，而且是從已簽收的入住點交單抓來的，
   不是現場憑印象填。沒有入住點交單時這一欄會印「無入住點交紀錄」，
   刻意不留白——留白看起來像「入住時正常」，而那是對房客不利的推定。 */
function itemsBlock(d) {
  var out = d.kind === 'out';
  var items = d.items || [];
  var baseMap = {};
  var hasBase = !!(d.base && Array.isArray(d.base.items));
  if (hasBase) {
    d.base.items.forEach(function (b) { baseMap[String(b.id)] = b; });
  }

  var h = '<div class="art"><div class="art-h">' +
          (out ? '二、設備與現況點交明細（與入住點交基準比對）'
               : '二、設備與現況點交明細（本表作為退房點交之比對基準）') +
          '</div></div>';

  h += '<table class="t"><tr>' +
       '<th style="width:30px">項次</th><th>項目</th><th style="width:40px">數量</th>';
  if (out) h += '<th style="width:64px">入住時</th>';
  h += '<th style="width:74px">' + (out ? '退房時' : '現況') + '</th>';
  if (out) h += '<th style="width:96px">歸責</th><th style="width:72px">估定賠償</th>';
  h += '<th>說明／照片</th></tr>';

  if (!items.length) {
    h += '<tr><td class="c" colspan="' + (out ? 8 : 5) + '" style="color:#888;padding:14px">' +
         '（本房間尚未建立設備清單）</td></tr>';
  }

  items.forEach(function (it, i) {
    var bad = it.st === 'bad' || it.st === 'missing';
    var ph = photosOf(it);
    h += '<tr>' +
         '<td class="c">' + (i + 1) + '</td>' +
         '<td>' + esc(it.name || '') + '</td>' +
         '<td class="c">' + esc(it.qty == null || it.qty === '' ? '1' : it.qty) + '</td>';
    if (out) {
      var b = baseMap[String(it.id)];
      h += '<td class="c" style="color:#666">' +
           (hasBase ? (b ? esc(ST_SHORT[b.st] || '—') : '未列於入住單')
                    : '無入住點交紀錄') + '</td>';
    }
    h += '<td class="c"' + (bad ? ' style="font-weight:700"' : '') + '>' +
         esc(ST_SHORT[it.st] || '—') + '</td>';
    if (out) {
      h += '<td class="c">' + (bad ? esc(FAULT_LABEL[it.fault] || '—') : '—') + '</td>' +
           '<td class="c">' +
           (bad && it.fault === 'tenant' ? money(it.cost || 0) + ' 元'
            : bad ? '不計賠' : '—') + '</td>';
    }
    h += '<td>' + esc(it.note || '') +
         (ph.length ? '<div class="ho-ph">' + ph.map(function (u) {
           return '<img src="' + esc(u) + '" alt="現況照片">';
         }).join('') + '</div>' : '') +
         '</td></tr>';
  });

  var s = sumOf(items);
  h += '<tr><td class="g" colspan="' + (out ? 5 : 3) + '" ' +
       'style="writing-mode:horizontal-tb;letter-spacing:0">合計</td>';
  if (out) {
    h += '<td class="c" style="background:#f6f7f9">損壞 ' + s.bad + ' 項<br>缺少 ' + s.missing + ' 項</td>' +
         '<td class="c" style="background:#f6f7f9;font-weight:700">' + money(s.charge) + ' 元</td>' +
         '<td style="background:#f6f7f9;font-size:10.5px;color:#444">' +
         '僅「可歸責於房客」之項目列入賠償；正常使用之耗損與入住前既有瑕疵不計。</td>';
  } else {
    h += '<td class="c" colspan="2" style="background:#f6f7f9">損壞 ' + s.bad +
         ' 項、缺少 ' + s.missing + ' 項</td>';
  }
  h += '</tr></table>';
  return h;
}

/* ── 水電表抄錄 ────────────────────────────────────── */
/* 抄表本來就是點交當下的同一個動作，所以直接印在同一張單上給房客確認。
   度數爭議和設備爭議一樣，事後都沒有辦法重現現場。 */
function meterBlock(d) {
  var m = d.meter;
  if (!m) return '';
  var out = d.kind === 'out';
  var h = '<div class="art"><div class="art-h">三、水電表抄錄</div></div>' +
          '<table class="t"><tr><th style="width:84px">項目</th>' +
          '<th>入住時度數</th>' + (out ? '<th>退房時度數</th><th>使用度數</th>' : '') +
          '<th>抄表日期</th></tr>';
  h += '<tr><td class="c">電表</td><td class="c">' + v(m.inE, 6) + '</td>';
  if (out) {
    var kwh = (m.inE !== '' && m.inE != null && m.outE !== '' && m.outE != null)
      ? (Number(m.outE) - Number(m.inE)) : '';
    h += '<td class="c">' + v(m.outE, 6) + '</td><td class="c">' + v(kwh, 6) + '</td>';
  }
  h += '<td class="c">' + v(out ? (m.outOn || '') : (m.inOn || ''), 10) + '</td></tr>';
  if (m.inW !== '' && m.inW != null || m.outW !== '' && m.outW != null) {
    h += '<tr><td class="c">水表</td><td class="c">' + v(m.inW, 6) + '</td>';
    if (out) {
      var t = (m.inW !== '' && m.inW != null && m.outW !== '' && m.outW != null)
        ? (Number(m.outW) - Number(m.inW)) : '';
      h += '<td class="c">' + v(m.outW, 6) + '</td><td class="c">' + v(t, 6) + '</td>';
    }
    h += '<td class="c">' + v(out ? (m.outOn || '') : (m.inOn || ''), 10) + '</td></tr>';
  }
  h += '</table>' +
       '<p style="font-size:10.5px;color:#666;margin:3px 0 0">' +
       '水電費單價與計費方式依租約約定，實際金額另載於退房結算單。</p>';
  return h;
}

/* ── 聲明 ──────────────────────────────────────────── */
function termsBlock(d) {
  var out = d.kind === 'out';
  var n = d.meter ? '四' : '三';
  var h = '<div class="art"><div class="art-h">' + n + '、雙方確認事項</div><div class="art-b">';
  if (out) {
    h += '<p>1. 本單所載各項設備之現況，係雙方於退房點交時共同到場逐項確認。</p>' +
         '<p>2. 本單所載「估定賠償」金額，係雙方於點交現場就可歸責於乙方之毀損、' +
         '滅失項目共同確認之金額，由甲方自押金中扣抵。嗣後實際修復或補購費用' +
         '高於估定金額者，其差額由甲方自行吸收，不另向乙方追加請求。</p>' +
         '<p>3. 歸責認定為「正常使用之耗損」或「入住前既已存在」之項目，' +
         '依民法第四百三十二條及租約約定，不列入乙方賠償範圍。</p>' +
         '<p>4. 押金扣抵之完整計算（含積欠租金、水電費及本單之賠償金額）' +
         '另以退房結算單載明，並以該單所載應退金額為結算依據。</p>' +
         '<p>5. 乙方對本單所載內容如有異議，應於簽收前提出並協商修正；' +
         '經乙方簽收後，本單內容即不得修改，僅得由甲方整份作廢並重新點交。</p>';
  } else {
    h += '<p>1. 本單所載各項設備之現況，係雙方於交屋點交時共同到場逐項確認，' +
         '作為退房點交時認定毀損、滅失之比對基準。</p>' +
         '<p>2. 本單記載為「損壞」或「缺少」之項目，係乙方入住前即已存在之狀態，' +
         '退房時不列入乙方賠償範圍。</p>' +
         '<p>3. 乙方應於簽收前逐項核對。簽收後如發現本單未記載之既有瑕疵，' +
         '應即通知甲方，由甲方查明後補正紀錄或另行作廢重新點交。</p>' +
         '<p>4. 乙方應以合於租賃住宅使用方法之方式使用設備，' +
         '因故意或過失致毀損、滅失者，依租約約定負賠償責任；' +
         '因正常使用所生之耗損，不負賠償責任。</p>' +
         '<p>5. 經乙方簽收後，本單內容即不得修改，僅得由甲方整份作廢並重新點交。</p>';
  }
  if (d.note) h += '<p>6. 其他約定事項：' + v(d.note, 20) + '</p>';
  h += '</div></div>';
  return h;
}

/* ── 簽署區與稽核欄 ────────────────────────────────── */
/* 稽核欄的四個值（開啟時間、簽署時間、來源 IP、內容指紋）全部由資料庫
   寫入，前端拿不到也改不掉。指紋算在「清空指紋與簽名圖」的內容上，
   任何人要驗證只要把這兩欄清空重算 md5 就能比對。 */
function signBlock(d) {
  var s = d.sign || {};
  var g = d.guest || {}, co = d.co || {};
  var signed = !!s.signedAt;
  var h = '<div class="signblock">' +
    '<div class="sigrow">' +
      '<div class="sigcol"><div class="lb">甲方（出租人／管理方）</div>' +
        '<div class="fl">名稱：' + v(co.name, 10) + '</div>' +
        '<div class="fl">點交經辦人：' + v(d.by, 6) + '</div>' +
        '<div class="sigbox">（經辦人簽章）</div></div>' +
      '<div class="sigcol"><div class="lb">乙方（承租人／房客）</div>' +
        '<div class="fl">姓名：' + v(g.name, 8) + '</div>' +
        '<div class="fl">核對手機：' + v(s.phone || '', 10) + '</div>' +
        '<div class="sigbox">' +
          (s.sigImg ? '<img src="' + esc(s.sigImg) + '" alt="房客簽名">'
                    : '（房客線上簽收後顯示簽名）') +
        '</div></div>' +
    '</div>';

  h += '<div class="audit"><b>電子簽收紀錄</b>　' +
       '（依電子簽章法，本簽收與親筆簽名具同等效力）<br>' +
       '首次開啟連結時間：' + esc(s.openedAt || '—') +
       '　｜　簽收完成時間：' + esc(s.signedAt || '—') + '<br>' +
       '簽收來源 IP：' + esc(s.ip || '—') +
       '　｜　裝置資訊：' + esc((s.ua || '—').slice(0, 120)) + '<br>' +
       '內容指紋（MD5）：' + esc(s.hash || '—') + '<br>' +
       (signed
         ? '本單已完成簽收，內容於資料庫層鎖定，任何人（含本公司人員）均無法修改或刪除；' +
           '需終止時僅能整份作廢並記錄原因，另行重新點交。'
         : '本單尚未簽收。上列紀錄將於房客完成線上簽收時由系統寫入，不可事後編輯。') +
       '</div>';

  h += '<div class="datefoot">' + rocStr(d.on) + '</div></div>';
  return h;
}

function render(data) {
  var d = data || blank('out');
  if (!KIND_LABEL[d.kind]) d.kind = 'out';
  var h = '<div class="paper">';
  h += '<h1 class="doc-title">' + KIND_LABEL[d.kind] + '</h1>';
  h += '<div class="doc-sub">本單為押金扣抵與損害賠償之依據，雙方應逐項確認後簽收</div>';
  h += '<div class="doc-no">單號：' + v(d.no, 8) + '　點交日期：' + v(d.on, 10) + '</div>';
  h += '<div class="art"><div class="art-h">一、當事人與標的</div></div>';
  h += headBlock(d);
  h += itemsBlock(d);
  h += meterBlock(d);
  h += termsBlock(d);
  h += signBlock(d);
  h += '</div>';
  return h;
}

/* 產生點交單前的檢查。
   「金額填了卻沒選歸責」是最容易漏的一種：金額會印在單上、房客也簽了，
   但合計只算 tenant，印出來的合計會比明細的加總少，業者當場無法解釋。 */
function validate(d) {
  var errs = [], warns = [];
  var g = d.guest || {}, co = d.co || {};
  if (!String(co.name || '').trim()) errs.push('簽約主體設定：公司（商號）名稱未填');
  if (!String(g.name || '').trim()) errs.push('訂單上沒有房客姓名');
  if (!String(g.phone || '').replace(/[^0-9]/g, '')) {
    errs.push('訂單上沒有房客手機號碼（房客需以手機號碼核對身分才能簽收）');
  }
  if (!(d.items || []).length) errs.push('這個房間還沒有設備清單，請先建立設備主檔');

  (d.items || []).forEach(function (it, i) {
    var bad = it.st === 'bad' || it.st === 'missing';
    var c = Number(it.cost) || 0;
    if (d.kind === 'out' && bad && !it.fault) {
      errs.push('第 ' + (i + 1) + ' 項「' + (it.name || '') + '」標記為' +
                ST_SHORT[it.st] + '但未選擇歸責');
    }
    if (d.kind === 'out' && c > 0 && it.fault !== 'tenant') {
      errs.push('第 ' + (i + 1) + ' 項「' + (it.name || '') + '」填了賠償金額 ' +
                money(c) + ' 元，但歸責不是「可歸責於房客」，這筆金額不會列入合計');
    }
    if (d.kind === 'out' && bad && it.fault === 'tenant' && !(c > 0)) {
      warns.push('第 ' + (i + 1) + ' 項「' + (it.name || '') + '」歸責於房客但賠償金額為 0');
    }
    if (bad && !photosOf(it).length) {
      warns.push('第 ' + (i + 1) + ' 項「' + (it.name || '') + '」沒有附現況照片');
    }
    if (bad && !String(it.note || '').trim()) {
      warns.push('第 ' + (i + 1) + ' 項「' + (it.name || '') + '」沒有填損壞說明');
    }
  });
  if (!d.meter) warns.push('沒有帶入水電表度數（可在退房結算的抄表頁補登）');
  return { ok: errs.length === 0, errors: errs, warnings: warns };
}

var API = {
  KIND_LABEL: KIND_LABEL, KIND_SHORT: KIND_SHORT,
  ST_LABEL: ST_LABEL, ST_SHORT: ST_SHORT, FAULT_LABEL: FAULT_LABEL,
  blank: blank, render: render, sumOf: sumOf, validate: validate, rocStr: rocStr
};
root.HandoverRender = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
