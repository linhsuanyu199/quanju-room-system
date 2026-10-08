/* ══════════════════════════════════════════════════════════════════
   水電抄表 ＋ 押金退還結算單
   ------------------------------------------------------------------
   押金原本只是訂單裡的一個數字（bk.deposit），退房時系統幫不上任何忙：
   「押金兩萬，扣掉欠租五千、電費一千二、牆面修補三千，應退 10,800」
   這段算式沒有任何地方可以算、可以留存、可以給房客簽收。而租賃糾紛
   最常吵的就是這一張紙。

   為什麼水電和押金做在同一支：退租抄電表本來就是點交當下的同一個動作。
   拆成兩個功能，業者要開兩個畫面抄同一件事，最後就會兩邊都不填。

   ── 三個刻意的決定 ──────────────────────────────
   ① **扣抵順序固定為 欠租 → 水電 → 損壞**，不開放調整。
      押金不足時先扣哪一項會直接影響剩下哪一項要另外追討，業者各憑心情
      排序的話，同一家公司兩個業務算出來的結果會不一樣。固定順序才有
      一致的說法可以對房客解釋。
   ② **損壞只扣維修單裡「屋主請款狀態＝房客自行負擔」的單**。
      未請款／已請款是跟房東算的（見月結撥款單），自行吸收是業者認賠，
      都不該碰房客的押金。認定時間窗是「入住日 ～ 退房日＋退款作業天數」，
      因為牆面破損這類往往是點交當下才發現。
   ③ **結算單不自動產生、也不自動扣款**，一律要人按下「確認結算」。
      押金退還是對房客的金錢處分，系統只負責把算式擺出來。

   ── 不存什麼 ──────────────────────────────────
   欠租每次向租金台帳推導、損壞每次向維修單推導、電費每次由度數乘費率
   算出。KV 只存三種「人輸入的那一點」：電水表度數、費率設定、以及實際
   退了多少錢。
   ══════════════════════════════════════════════════════════════════ */
'use strict';

var ST_KV_METER = 'qj_meters';     /* { '訂單id|館別id|房號': {inOn,inE,outOn,outE,inW,outW,note,at,by} } */
var ST_KV_CFG   = 'qj_util_cfg';   /* { rateE, waterMode, waterFixed, rateW, byProp:{propId:{...}} } */
var ST_KV_REC   = 'qj_settle';     /* { 訂單id: {on,refund,extra:[{label,amt}],note,calc,at,by} } */

var ST_WATER_MODE = { fixed: '每月定額', meter: '水表抄表' };

/* 預設值刻意保守：台電非營業用約 3～6 元／度，分租套房常見收 5 元。
   水費每人每月 100～150 元是市場慣例。業者一定要自己改，所以設定頁
   會把「這是預設值，請依實際情況調整」寫在旁邊。 */
function stCfg() {
  var c = Cloud.get(ST_KV_CFG, {}) || {};
  return {
    rateE:      c.rateE != null ? Number(c.rateE) : 5,
    waterMode:  c.waterMode === 'meter' ? 'meter' : 'fixed',
    waterFixed: c.waterFixed != null ? Number(c.waterFixed) : 150,
    rateW:      c.rateW != null ? Number(c.rateW) : 12,
    refundDays: c.refundDays != null ? Number(c.refundDays) : 7,
    byProp:     c.byProp || {}
  };
}
function stSaveCfg(o) { Cloud.set(ST_KV_CFG, o); }

/* 館別可覆寫費率：同一家業者的不同大樓電費單價常常不同（有的管委會代收、
   有的直接台電）。沒填就落回全公司預設，不是落回 0。 */
function stRateOf(propId) {
  var c = stCfg();
  var o = c.byProp[String(propId)] || {};
  return {
    rateE:      o.rateE      != null && o.rateE      !== '' ? Number(o.rateE)      : c.rateE,
    waterMode:  o.waterMode  ? o.waterMode : c.waterMode,
    waterFixed: o.waterFixed != null && o.waterFixed !== '' ? Number(o.waterFixed) : c.waterFixed,
    rateW:      o.rateW      != null && o.rateW      !== '' ? Number(o.rateW)      : c.rateW
  };
}

function stMeters() { return Cloud.get(ST_KV_METER, {}) || {}; }
function stSaveMeters(o) { Cloud.set(ST_KV_METER, o); }
function stRecs() { return Cloud.get(ST_KV_REC, {}) || {}; }
function stSaveRecs(o) { Cloud.set(ST_KV_REC, o); }

/* 抄表 key 與租金台帳同樣的理由：不可用 segments 陣列索引，
   加減同組房間會整排位移，度數會對到別的房間。 */
function stMeterKey(bkId, propId, room) {
  return [bkId, propId, room].join('|');
}

function stAddDays(s, n) {
  var d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ── 一段住宿的水電費 ──────────────────────────── */
/* 回 {kwh, eAmt, wAmt, amt, ready, why}。ready=false 表示度數還沒抄齊，
   結算單上會明確標示「尚未抄表」而不是悄悄算成 0 元——算成 0 元的話，
   業者會以為這間真的沒用電。 */
function stUtilOf(seg, bkId) {
  var r = stRateOf(seg.prop_id);
  var m = stMeters()[stMeterKey(bkId, seg.prop_id, seg.room)] || {};
  var out = { kwh: 0, eAmt: 0, wAmt: 0, amt: 0, ready: false, why: '',
              inE: m.inE, outE: m.outE, inW: m.inW, outW: m.outW,
              inOn: m.inOn || '', outOn: m.outOn || '',
              rateE: r.rateE, waterMode: r.waterMode,
              waterFixed: r.waterFixed, rateW: r.rateW, months: 0 };

  var has = function (v) { return v !== '' && v != null; };
  out.hasIn = has(m.inE);
  out.hasOut = has(m.outE);
  if (out.hasIn && out.hasOut) {
    out.kwh = Number(m.outE) - Number(m.inE);
    /* 退租度數小於入住度數：換過電表、或抄錯、或填反了。
       直接算成負數會變成「退錢給房客用電」，一定要擋下來讓人去確認。 */
    if (out.kwh < 0) { out.why = '退租度數小於入住度數，請確認是否抄反或換過電表'; }
    else { out.eAmt = Math.round(out.kwh * r.rateE); out.ready = true; }
  } else {
    /* 兩種漏抄要分開講。「沒抄入住度數」是現在就該補、而且每天拖都讓誤差變大；
       「沒抄退租度數」是人還在裡面、時間還沒到。混成一句「尚未抄表」，
       業者會看不出哪一筆是真的來不及。 */
    out.why = !out.hasIn ? '尚未抄入住度數' : '尚未抄退租度數';
  }

  /* 定額水費按「租金期數」算，和租金台帳用同一套期數定義，
     不另外用 ceil(天數/30) 自創一套（兩套算下來月數會不一樣）。 */
  if (r.waterMode === 'fixed') {
    var n = (typeof rlPeriods === 'function') ? rlPeriods(seg).length : 0;
    out.months = n;
    out.wAmt = Math.round(n * r.waterFixed);
  } else {
    if (has(m.inW) && has(m.outW)) {
      var t = Number(m.outW) - Number(m.inW);
      if (t >= 0) out.wAmt = Math.round(t * r.rateW);
      else { out.ready = false; if (!out.why) out.why = '退租水表度數小於入住度數，請確認'; }
    } else {
      out.ready = false;
      if (!out.why) out.why = has(m.inW) ? '尚未抄退租水表' : '尚未抄入住水表';
      if (!has(m.inW)) out.hasIn = false;
      if (!has(m.outW)) out.hasOut = false;
    }
  }
  out.amt = out.eAmt + out.wAmt;
  return out;
}

/* 抄表清單自己走一遍訂單，不沿用 stBuild()：stBuild 只收「已有房間退房」的訂單，
   但入住度數必須在交屋當天就填。沿用 stBuild 等於要求業者先辦退房才能補入住度數，
   而那時候度數早就漲上去、基準值永遠拿不回來了。
   已取消與尚未入住（預定中／待入住）的段落不列：還沒交屋沒有表可抄。 */
function stMeterRows() {
  var props = getAllProps();
  var pn = function (pid) {
    var p = props.find(function (x) { return String(x.id) === String(pid); });
    return p ? p.name : '（已刪除館別）';
  };
  var out = [];
  loadBks().forEach(function (b) {
    /* 匯入的歷史訂單沒有水電底度可抄——人早就搬走了，電表現在的數字
       跟那張訂單無關。理由同 rlBuild()。 */
    if (b.imported) return;
    (b.segments || []).forEach(function (s) {
      if (s.status === 'cancelled' || s.status === 'reserved' || s.status === 'pending') return;
      out.push({ bkId: String(b.id), guest: b.guest || '(未命名)', phone: b.phone || '',
                 propId: s.prop_id, propName: pn(s.prop_id), room: s.room || '',
                 checkin: s.checkin || '', checkout: s.checkout || '', status: s.status,
                 u: stUtilOf(s, b.id), key: stMeterKey(b.id, s.prop_id, s.room) });
    });
  });
  /* 未抄完的排前面（那才是要動作的），其餘依退房日新到舊 */
  return out.sort(function (a, b) {
    return (a.u.ready === b.u.ready ? 0 : a.u.ready ? 1 : -1) ||
      (b.checkout || '').localeCompare(a.checkout || '');
  });
}

/* ── 退房結算單 ────────────────────────────────── */
/* 一張結算單＝一張訂單（押金是整張訂單收一筆，不是每間房一筆）。
   只有「至少有一段已退房」的訂單才需要結算。 */
/* ovrBkId/ovrExtra ＝「畫面上還沒存檔的其他扣抵」。按下確認結算時要先用畫面上的
   數字重算一次，但不能為了重算就先把它寫進 KV——驗證沒過時那半筆紀錄會留在庫裡，
   狀態直接變成「已結算」卻沒有退款日與金額。所以改成只在這次推導中覆蓋。 */
function stBuild(ovrBkId, ovrExtra) {
  var tod = todayStr();
  var cfg = stCfg();
  var props = getAllProps();
  var pn = function (pid) {
    var p = props.find(function (x) { return String(x.id) === String(pid); });
    return p ? p.name : '（已刪除館別）';
  };
  var recs = stRecs();
  var tasks = loadTasks();
  var rentRows = (typeof rlBuild === 'function') ? rlBuild() : [];

  var out = [];
  loadBks().forEach(function (b) {
    /* 匯入的歷史訂單不開結算單：押金當年是在系統外收退的，
       系統沒有那筆押金，算出來的「應退金額」是憑空捏造的數字。
       理由同 rlBuild()。 */
    if (b.imported) return;
    var segs = (b.segments || []).filter(function (s) {
      return s.status !== 'cancelled';
    });
    if (!segs.length) return;
    var outSegs = segs.filter(function (s) { return s.status === 'checkout'; });
    if (!outSegs.length) return;   /* 還沒有任何一間退房，不需要結算 */

    var allOut = outSegs.length === segs.length;
    var endDate = outSegs.map(function (s) { return s.checkout || ''; })
      .filter(Boolean).sort().pop() || '';

    /* ① 欠租：只算已到期而未收足的（future 期不是欠款，是還沒到）。
       整張訂單一起算，因為押金是整張收的。 */
    var rent = 0, rentList = [];
    rentRows.forEach(function (r) {
      if (String(r.bkId) !== String(b.id)) return;
      if (r.status === 'future' || r.status === 'paid') return;
      var owe = r.due - r.amt;
      if (owe <= 0) return;
      rent += owe;
      rentList.push({ room: r.room, propName: r.propName, no: r.no,
                      from: r.from, to: r.to, due: r.due, amt: r.amt, owe: owe });
    });

    /* ② 水電：逐段算，未抄表的標出來 */
    var util = 0, utilList = [], utilPending = 0;
    segs.forEach(function (s) {
      var u = stUtilOf(s, b.id);
      util += u.amt;
      if (!u.ready) utilPending++;
      utilList.push({ propId: s.prop_id, propName: pn(s.prop_id), room: s.room,
                      checkin: s.checkin, checkout: s.checkout, status: s.status, u: u,
                      key: stMeterKey(b.id, s.prop_id, s.room) });
    });

    /* ③ 損壞：維修單標「房客自行負擔」的才算。時間窗抓到退房日＋退款作業
       天數，因為點交當下才發現的破損，維修單通常是退房後幾天才開。 */
    var dmg = 0, dmgList = [];
    tasks.forEach(function (t) {
      if (t.type !== 'repair' || t.billing !== 'tenant') return;
      var c = (typeof tkCost === 'function') ? tkCost(t) : (Number(t.cost) || 0);
      if (!(c > 0)) return;
      var d = t.doneAt || t.start || '';
      if (!d) return;
      var hit = segs.some(function (s) {
        return String(s.prop_id) === String(t.prop_id) && String(s.room) === String(t.room) &&
          d >= (s.checkin || '') && d <= stAddDays(s.checkout || d, cfg.refundDays);
      });
      if (!hit) return;
      dmg += c;
      dmgList.push({ id: t.id, room: t.room || '', date: d, cost: c,
                     cat: t.cat || '', note: t.note || '' });
    });

    var rec = recs[String(b.id)] || null;
    var extra = (ovrBkId != null && String(ovrBkId) === String(b.id) && Array.isArray(ovrExtra))
      ? ovrExtra
      : ((rec && Array.isArray(rec.extra)) ? rec.extra : []);
    var extraSum = extra.reduce(function (a, x) { return a + (Number(x.amt) || 0); }, 0);

    var deposit = Number(b.deposit) || 0;

    /* 已結算的單一律以「結算當時的快照」為準，不用現況重算值。
       欠租之後被補繳、維修單之後被改成跟房東請款，重算出來的扣抵就會跟房客
       簽收的那張對不起來——畫面顯示應退兩萬、實際卻只退了三千六，業者無從解釋。
       快照是整套系統（清單／明細／匯出／列印）共用的唯一事實來源，
       現況值另外保留在 live，差異時在畫面與單據上標出來。 */
    var live = { deposit: deposit, rent: rent, util: util, dmg: dmg, extraSum: extraSum };
    var k = (rec && rec.snap) ? rec.snap : null;
    if (k) {
      deposit = Number(k.deposit) || 0;
      rent = Number(k.rent) || 0;
      util = Number(k.util) || 0;
      dmg = Number(k.dmg) || 0;
      extraSum = Number(k.extraSum) || 0;
    }
    var drifted = !!k && ['deposit', 'rent', 'util', 'dmg', 'extraSum'].some(function (f) {
      return Math.round(live[f]) !== Math.round(k[f]);
    });

    var deducted = rent + util + dmg + extraSum;
    var refund = deposit - deducted;
    /* 押金不夠扣時 refund 為負＝房客尚須補付。不夾到 0，
       因為「還差多少」正是業者要去追的數字。 */

    /* 退款期限只在「全部房間都退了」之後才成立。訂單裡還有人住著，押金仍在
       擔保那間房，拿其中一間的退房日去推期限會印出一個早就過去、卻又不算逾期的
       日期，畫面上自相矛盾。 */
    var dueBy = (allOut && endDate) ? stAddDays(endDate, cfg.refundDays) : '';

    out.push({
      bkId: String(b.id), guest: b.guest || '(未命名)', phone: b.phone || '',
      deposit: deposit, segs: segs.map(function (s) {
        return { propId: s.prop_id, propName: pn(s.prop_id), room: s.room || '',
                 checkin: s.checkin || '', checkout: s.checkout || '', status: s.status };
      }),
      allOut: allOut, endDate: endDate, dueBy: dueBy,
      rent: rent, rentList: rentList,
      util: util, utilList: utilList, utilPending: utilPending,
      dmg: dmg, dmgList: dmgList,
      extra: extra, extraSum: extraSum,
      deducted: deducted, refund: refund,
      live: live, drifted: drifted,
      rec: rec, settled: !!rec,
      overdue: !rec && allOut && dueBy && dueBy < tod ? diffDays(dueBy, tod) : 0
    });
  });

  return out.sort(function (a, b) {
    return (a.settled === b.settled ? 0 : a.settled ? 1 : -1) ||
      (b.endDate || '').localeCompare(a.endDate || '');
  });
}

function stFind(bkId, ovrExtra) {
  return stBuild(bkId, ovrExtra).find(function (x) { return x.bkId === String(bkId); }) || null;
}

/* 給今日待辦：全部退房、超過約定退款天數、仍未結算的 */
function stPending() {
  return stBuild().filter(function (x) { return x.overdue > 0; })
    .sort(function (a, b) { return b.overdue - a.overdue; });
}

/* 抄表待辦：兩種情形都要提醒，因為兩種都是「拖下去就再也補不回來」。
   ① 已入住卻沒抄入住度數——基準值每天都在被用掉。
   ② 已退房卻沒抄退租度數——人走了就沒有表可以抄。
   已結算的訂單不再提醒（結算單已經按當時的數字簽收完了）。 */
function stMeterTodo() {
  var done = stRecs();
  return stMeterRows().filter(function (x) {
    if (x.u.ready) return false;
    if (done[x.bkId]) return false;
    return x.status === 'checkout' ? !x.u.hasOut || !!x.u.why : !x.u.hasIn;
  }).map(function (x) {
    return { bkId: x.bkId, guest: x.guest, propName: x.propName, room: x.room,
             checkin: x.checkin, checkout: x.checkout, status: x.status, why: x.u.why };
  });
}

function stExportRows() {
  return stBuild().map(function (s) {
    return {
      訂單編號: s.bkId, 房客: s.guest, 電話: s.phone,
      房間: s.segs.map(function (x) { return x.propName + ' ' + x.room; }).join('；'),
      最後退房日: s.endDate, 應退期限: s.dueBy,
      押金: s.deposit, 欠租: s.rent, 水電費: s.util, 損壞賠償: s.dmg,
      其他扣抵: s.extraSum, 扣抵合計: s.deducted,
      應退還: s.refund >= 0 ? s.refund : 0,
      房客應補付: s.refund < 0 ? -s.refund : 0,
      結算狀態: s.settled ? '已結算' : (s.allOut ? '待結算' : '部分退房'),
      實退金額: s.rec ? s.rec.refund : '',
      退款日: s.rec ? (s.rec.on || '') : '',
      經手人: s.rec ? (s.rec.by || '') : ''
    };
  });
}

/* ══════════════════════════════════════════════════════════════════
   UI
   ══════════════════════════════════════════════════════════════════ */
var ST_UI_READY = false;
var ST_TAB = 'settle';     /* settle | meter */
var ST_EDIT_BK = null;
var ST_METER_KEY = null;

function stEnsureUI() {
  if (ST_UI_READY) return;
  ST_UI_READY = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="overlay" id="st-ov" onclick="if(event.target===this)closeSettle()">' +
    '<div class="modal" style="width:1080px;max-width:98vw">' +
    '<div class="modal-h"><h2 id="st-title">🧾 退房結算</h2>' +
    '<button class="close-btn" onclick="closeSettle()">✕</button></div>' +
    '<div style="padding:10px 17px 4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<button class="btn btn-ghost sm" id="st-tab-settle" onclick="stSetTab(\'settle\')">💰 押金結算</button>' +
      '<button class="btn btn-ghost sm" id="st-tab-meter" onclick="stSetTab(\'meter\')">🔌 水電抄表</button>' +
      '<input class="sel" type="text" id="st-search" placeholder="搜尋房客／房號" oninput="stRender()" ' +
        'style="flex:1;min-width:140px">' +
      '<label style="display:flex;gap:5px;align-items:center;font-size:11.5px;white-space:nowrap">' +
        '<input type="checkbox" id="st-f-todo" onchange="stRender()"> 只看未完成</label>' +
      '<button class="btn btn-ghost sm" onclick="stOpenCfg()">⚙️ 費率與退款設定</button>' +
    '</div>' +
    '<div class="modal-body" style="max-height:66vh;overflow-y:auto" id="st-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="closeSettle()">關閉</button></div>' +
    '</div></div>' +

    /* 結算明細 */
    '<div class="overlay" id="std-ov" onclick="if(event.target===this)stCloseDetail()">' +
    '<div class="modal" style="width:820px;max-width:97vw">' +
    '<div class="modal-h"><h2 id="std-title">退房結算單</h2>' +
    '<button class="close-btn" onclick="stCloseDetail()">✕</button></div>' +
    '<div class="modal-body" style="max-height:68vh;overflow-y:auto" id="std-body"></div>' +
    '<div class="modal-f">' +
      '<div style="flex:1"><button class="btn btn-ghost sm" id="std-print" onclick="stPrint()">🖨 列印結算單</button>' +
      ' <button class="btn btn-danger sm" id="std-del" onclick="stDeleteSettle()">🗑 清除結算紀錄</button></div>' +
      '<button class="btn btn-ghost" onclick="stCloseDetail()">關閉</button>' +
      '<button class="btn btn-primary" id="std-save" onclick="stSaveSettle()">✅ 確認結算</button>' +
    '</div></div></div>' +

    /* 抄表 */
    '<div class="overlay" id="stm-ov" onclick="if(event.target===this)stMeterClose()">' +
    '<div class="modal" style="width:460px;max-width:96vw">' +
    '<div class="modal-h"><h2 id="stm-title">水電抄表</h2>' +
    '<button class="close-btn" onclick="stMeterClose()">✕</button></div>' +
    '<div class="modal-body" id="stm-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="stMeterClose()">取消</button>' +
      '<button class="btn btn-primary" onclick="stMeterSave()">💾 儲存</button></div>' +
    '</div></div>' +

    /* 設定 */
    '<div class="overlay" id="stc-ov" onclick="if(event.target===this)stCloseCfg()">' +
    '<div class="modal" style="width:720px;max-width:97vw">' +
    '<div class="modal-h"><h2>⚙️ 水電費率與押金退款設定</h2>' +
    '<button class="close-btn" onclick="stCloseCfg()">✕</button></div>' +
    '<div class="modal-body" style="max-height:68vh;overflow-y:auto" id="stc-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="stCloseCfg()">取消</button>' +
      '<button class="btn btn-primary" onclick="stSaveCfgUI()">💾 儲存設定</button></div>' +
    '</div></div>');
}

/* tab='meter' ＝從抄表待辦進來：直接落在抄表頁籤，並把搜尋框填成該房客，
   否則待辦點下去會跳到一整頁清單，使用者還得自己找是哪一筆。 */
function openSettle(bkId, tab) {
  stEnsureUI();
  if (bkId) {
    ST_TAB = tab === 'meter' ? 'meter' : 'settle';
    var s = stFind(bkId);
    document.getElementById('st-search').value =
      (tab === 'meter' && s) ? (s.guest || '') : '';
    document.getElementById('st-f-todo').checked = false;
  }
  stSetTab(ST_TAB);
  document.getElementById('st-ov').classList.add('open');
  if (bkId && tab !== 'meter') stDetail(String(bkId));
}
function closeSettle() { document.getElementById('st-ov').classList.remove('open'); }

function stSetTab(t) {
  ST_TAB = t;
  ['settle', 'meter'].forEach(function (k) {
    var el = document.getElementById('st-tab-' + k);
    if (!el) return;
    el.className = 'btn sm ' + (k === t ? 'btn-primary' : 'btn-ghost');
  });
  stRender();
}

function stRender() {
  var q = (document.getElementById('st-search').value || '').trim().toLowerCase();
  var onlyTodo = document.getElementById('st-f-todo').checked;
  var all = stBuild();
  var cfg = stCfg();

  var match = function (s) {
    if (!q) return true;
    return [s.guest, s.phone].concat(s.segs.map(function (x) { return x.propName + ' ' + x.room; }))
      .join(' ').toLowerCase().indexOf(q) >= 0;
  };

  document.getElementById('st-title').textContent =
    ST_TAB === 'meter' ? '🔌 水電抄表' : '🧾 退房結算（押金）';

  var h = '';
  if (ST_TAB === 'settle') {
    var list = all.filter(match).filter(function (s) { return onlyTodo ? !s.settled : true; });
    var pend = all.filter(function (s) { return !s.settled && s.allOut; });
    var late = all.filter(function (s) { return s.overdue > 0; });
    var refundSum = pend.reduce(function (a, s) { return a + Math.max(0, s.refund); }, 0);
    var oweSum = pend.reduce(function (a, s) { return a + Math.max(0, -s.refund); }, 0);

    h += stCards([
      ['待結算', pend.length + ' 筆', pend.length ? '#e67700' : '#868e96'],
      ['逾期未退', late.length + ' 筆', late.length ? '#c92a2a' : '#868e96'],
      ['待退還押金', money(refundSum), '#1a56a0'],
      ['房客尚須補付', money(oweSum), oweSum ? '#c92a2a' : '#868e96']
    ]) +
    '<div style="font-size:10.5px;color:var(--muted);margin:-4px 0 10px">' +
      '約定退款期限為最後退房日起 ' + cfg.refundDays + ' 天（可在「⚙️ 費率與退款設定」調整）。' +
      '統計卡不受搜尋與篩選影響。</div>';

    if (!list.length) {
      h += stEmpty(all.length ? '沒有符合條件的結算單。' :
        '目前沒有需要結算的訂單。訂單裡有房間的狀態變成「已退房」之後，這裡才會出現結算單。');
    } else {
      h += '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        stHead(['房客', '房間', '最後退房', '押金', '扣抵合計', '應退／應補', '狀態', '']) + '<tbody>' +
        list.map(function (s) {
          var warn = [];
          if (s.utilPending && !s.settled) warn.push(s.utilPending + ' 間未抄表');
          if (!s.allOut) warn.push('尚有房間未退房');
          if (s.drifted) warn.push('金額為結算當時數字');
          var stTxt = s.settled
            ? '<span style="color:#2f9e44;font-weight:700">已結算</span>' +
              '<div style="font-size:9.5px;color:var(--muted)">' + escH(s.rec.on || '') + '</div>'
            : s.overdue > 0
              ? '<span style="color:#c92a2a;font-weight:700">逾期 ' + s.overdue + ' 天</span>'
              : !s.allOut
                ? '<span style="color:#868e96;font-weight:700">部分退房</span>' +
                  '<div style="font-size:9.5px;color:var(--muted)">全部退房後才計期限</div>'
                : '<span style="color:#e67700;font-weight:700">待結算</span>' +
                  (s.dueBy ? '<div style="font-size:9.5px;color:var(--muted)">應於 ' + escH(s.dueBy) + ' 前</div>' : '');
          return '<tr style="border-bottom:1px solid var(--border)">' +
            '<td style="padding:7px 9px"><strong>' + escH(s.guest) + '</strong>' +
              '<div style="font-size:10px;color:var(--muted)">' + escH(s.phone) + '</div></td>' +
            '<td style="padding:7px 9px;font-size:11px">' +
              s.segs.map(function (x) { return escH(x.propName) + ' ' + escH(x.room); }).join('<br>') + '</td>' +
            '<td style="padding:7px 9px;white-space:nowrap">' + escH(s.endDate) + '</td>' +
            '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' + money(s.deposit) + '</td>' +
            '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' +
              (s.deducted ? '−' + money(s.deducted) : '—') +
              (warn.length ? '<div style="font-size:9.5px;color:#e67700">' + escH(warn.join('、')) + '</div>' : '') + '</td>' +
            '<td style="padding:7px 9px;text-align:right;white-space:nowrap;font-weight:700;color:' +
              (s.refund < 0 ? '#c92a2a' : '#1a56a0') + '">' +
              (s.refund < 0 ? '應補 ' + money(-s.refund) : money(s.refund)) + '</td>' +
            '<td style="padding:7px 9px;white-space:nowrap">' + stTxt + '</td>' +
            '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' +
              '<button class="btn btn-ghost sm" onclick="stDetail(' + jsArg(s.bkId) + ')">結算單</button></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    }
    h += stNote(
      '<strong>扣抵順序固定為 ① 欠租 → ② 水電 → ③ 損壞賠償 → ④ 其他</strong>，不開放調整。' +
        '押金不夠扣時，先扣哪一項會直接影響剩下哪一項要另外追討；順序固定才有一致的說法對房客解釋。<br>' +
      '欠租取自「💰 租金收款」中已到期而未收足的期數；水電由抄表度數乘費率算出；' +
        '損壞只取維修單裡屋主請款狀態為「<strong>房客自行負擔</strong>」的單' +
        '（未請款／已請款是跟房東算的，自行吸收是公司認賠，都不會動到房客押金）。<br>' +
      '押金不足時「應退」會顯示為紅色的「應補」金額——那正是還要向房客追討的數字，系統不會把它藏成 0。');
  } else {
    var mall = stMeterRows();
    var rows = mall.filter(function (x) {
      if (q && [x.guest, x.phone, x.propName + ' ' + x.room].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return onlyTodo ? !x.u.ready : true;
    });
    var todoN = stMeterTodo().length;
    h += stCards([
      ['待抄表', todoN + ' 間', todoN ? '#c92a2a' : '#868e96'],
      ['每度電費', '$' + cfg.rateE, '#1a56a0'],
      ['水費計算', ST_WATER_MODE[cfg.waterMode], '#1a56a0'],
      [cfg.waterMode === 'fixed' ? '每月水費' : '每度水費', '$' + (cfg.waterMode === 'fixed' ? cfg.waterFixed : cfg.rateW), '#1a56a0']
    ]) +
    '<div style="font-size:10.5px;color:var(--muted);margin:-4px 0 10px">' +
      '卡片顯示的是全公司預設費率，個別館別可在「⚙️ 費率與退款設定」單獨覆寫。</div>';

    if (!rows.length) {
      h += stEmpty(mall.length ? (onlyTodo ? '沒有待抄表的房間。' : '沒有符合條件的房間。') :
        '目前沒有需要抄表的房間。房間狀態變成「入住中」之後就會出現在這裡，' +
        '請在交屋當天先把入住度數填進去。');
    } else {
      h += '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        stHead(['房客', '房間', '住宿期間', '狀態', '入住度數', '退租度數', '用電', '電費', '水費', '']) + '<tbody>' +
        rows.map(function (x) {
          var u = x.u;
          var num = function (v) { return (v === '' || v == null) ? '<span style="color:#c92a2a">未填</span>' : escH(String(v)); };
          var sl = (typeof STATUS !== 'undefined' && STATUS[x.status]) ? STATUS[x.status].label : x.status;
          return '<tr style="border-bottom:1px solid var(--border)">' +
            '<td style="padding:7px 9px"><strong>' + escH(x.guest) + '</strong></td>' +
            '<td style="padding:7px 9px;font-size:11px">' + escH(x.propName) + '<br>' + escH(x.room) + '</td>' +
            '<td style="padding:7px 9px;font-size:11px;white-space:nowrap">' +
              escH(x.checkin) + '<br>～ ' + escH(x.checkout) + '</td>' +
            '<td style="padding:7px 9px;font-size:11px;white-space:nowrap">' + escH(sl) + '</td>' +
            '<td style="padding:7px 9px;text-align:right">' + num(u.inE) + '</td>' +
            '<td style="padding:7px 9px;text-align:right">' +
              (x.status === 'checkout' ? num(u.outE)
                : '<span style="color:var(--muted)">退租再抄</span>') + '</td>' +
            '<td style="padding:7px 9px;text-align:right">' + (u.ready ? u.kwh + ' 度' : '—') + '</td>' +
            '<td style="padding:7px 9px;text-align:right">' + (u.ready ? money(u.eAmt) : '—') + '</td>' +
            '<td style="padding:7px 9px;text-align:right">' + money(u.wAmt) +
              (u.waterMode === 'fixed' ? '<div style="font-size:9.5px;color:var(--muted)">' + u.months + ' 期定額</div>' : '') + '</td>' +
            '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' +
              (u.why ? '<div style="font-size:9.5px;color:#c92a2a;margin-bottom:3px">' + escH(u.why) + '</div>' : '') +
              '<button class="btn btn-ghost sm" onclick="stMeterOpen(' + jsArg(x.bkId) + ',' +
                jsArg(String(x.propId)) + ',' + jsArg(x.room) + ')">抄表</button></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    }
    h += stNote(
      '<strong>入住度數請在交屋當天就填</strong>。沒有基準值，退租時無從計算用了多少，' +
        '那筆電費最後只能自己吸收或跟房客爭執。房間一變成「入住中」就會出現在這份清單上。<br>' +
      '<strong>退租度數一旦房客搬走就補不回來</strong>，請連同點交一起抄。<br>' +
      '退租度數小於入住度數時系統會擋下來不計費——那通常是抄反了或中途換過電表，' +
        '直接相減會變成「退錢給房客用電」。<br>' +
      '水費有兩種模式：沒有獨立水表的分租套房用「每月定額」（期數與租金台帳同一套定義），' +
        '有獨立水表的用「水表抄表」。');
  }
  document.getElementById('st-body').innerHTML = h;
}

/* 小工具：統計卡／表頭／空狀態／說明區塊，四個畫面共用 */
function stCards(items) {
  return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:11px">' +
    items.map(function (x) {
      return '<div style="flex:1;min-width:120px;background:#f8fafc;border:1px solid var(--border);' +
        'border-radius:8px;padding:9px 11px">' +
        '<div style="font-size:10px;color:var(--muted)">' + x[0] + '</div>' +
        '<div style="font-size:15px;font-weight:700;margin-top:2px;color:' + x[2] + '">' + x[1] + '</div></div>';
    }).join('') + '</div>';
}
function stHead(cols) {
  return '<thead><tr style="background:#f8fafc;border-bottom:2px solid var(--border)">' +
    cols.map(function (c, i) {
      return '<th style="padding:7px 9px;text-align:' + (i >= 3 ? 'right' : 'left') +
        ';color:var(--muted);font-size:10px;white-space:nowrap">' + c + '</th>';
    }).join('') + '</tr></thead>';
}
function stEmpty(t) {
  return '<div style="padding:18px;background:#f8fafc;border-radius:8px;font-size:12px;' +
    'color:var(--muted);line-height:1.9">' + t + '</div>';
}
function stNote(t) {
  return '<div style="margin-top:13px;padding:11px 13px;background:#f8fafc;border-radius:8px;' +
    'font-size:10.5px;color:var(--muted);line-height:1.85">' + t + '</div>';
}

/* ── 抄表 ─────────────────────────────────────── */
function stMeterOpen(bkId, propId, room) {
  stEnsureUI();
  ST_METER_KEY = stMeterKey(bkId, propId, room);
  var m = stMeters()[ST_METER_KEY] || {};
  var r = stRateOf(propId);
  var inp = 'height:30px;font-size:12px;border:1px solid var(--border);border-radius:5px;padding:0 8px;width:100%;background:#fff';
  var v = function (x) { return (x === '' || x == null) ? '' : escH(String(x)); };
  document.getElementById('stm-title').textContent = '水電抄表 — ' + room;
  document.getElementById('stm-body').innerHTML =
    '<div style="font-size:11px;color:var(--muted);margin-bottom:9px;line-height:1.8">' +
      '本館別費率：電 $' + r.rateE + ' / 度・水 ' +
      (r.waterMode === 'fixed' ? '每期定額 $' + r.waterFixed : '$' + r.rateW + ' / 度') + '</div>' +
    '<div class="form-grid" style="gap:10px">' +
      '<div class="field"><label style="font-size:10.5px">入住抄表日</label>' +
        '<input type="date" id="stm-in-on" value="' + v(m.inOn) + '" style="' + inp + '"></div>' +
      '<div class="field"><label style="font-size:10.5px">入住電表度數</label>' +
        '<input type="number" step="0.1" id="stm-in-e" value="' + v(m.inE) + '" style="' + inp + '"></div>' +
      '<div class="field"><label style="font-size:10.5px">退租抄表日</label>' +
        '<input type="date" id="stm-out-on" value="' + v(m.outOn) + '" style="' + inp + '"></div>' +
      '<div class="field"><label style="font-size:10.5px">退租電表度數</label>' +
        '<input type="number" step="0.1" id="stm-out-e" value="' + v(m.outE) + '" style="' + inp + '"></div>' +
      (r.waterMode === 'meter'
        ? '<div class="field"><label style="font-size:10.5px">入住水表度數</label>' +
            '<input type="number" step="0.1" id="stm-in-w" value="' + v(m.inW) + '" style="' + inp + '"></div>' +
          '<div class="field"><label style="font-size:10.5px">退租水表度數</label>' +
            '<input type="number" step="0.1" id="stm-out-w" value="' + v(m.outW) + '" style="' + inp + '"></div>'
        : '') +
      '<div class="field span2"><label style="font-size:10.5px">備註</label>' +
        '<input type="text" id="stm-note" value="' + escH(m.note || '') + '" ' +
        'placeholder="換錶、表身編號、照片存放位置…" style="' + inp + '"></div>' +
    '</div>' +
    '<div style="margin-top:10px;font-size:10.5px;color:var(--muted);line-height:1.75">' +
      '只填入住度數也可以先存——退租時再回來補退租度數即可。' +
      '建議抄表時一併拍照留存，日後有爭議時照片比數字有說服力。</div>';
  document.getElementById('stm-ov').classList.add('open');
}
function stMeterClose() { document.getElementById('stm-ov').classList.remove('open'); ST_METER_KEY = null; }

function stMeterSave() {
  var key = ST_METER_KEY;
  if (!key) return;
  var num = function (id) {
    var el = document.getElementById(id);
    if (!el) return '';
    var s = (el.value || '').trim();
    return s === '' ? '' : Number(s);
  };
  var patch = {
    inOn: document.getElementById('stm-in-on').value || '',
    outOn: document.getElementById('stm-out-on').value || '',
    inE: num('stm-in-e'), outE: num('stm-out-e'),
    note: (document.getElementById('stm-note').value || '').trim().slice(0, 200),
    at: new Date().toISOString(), by: Cloud.myDisplayName || Cloud.myEmail || ''
  };
  /* 水表欄位只在「水表抄表」模式下存在。公司改成每月定額時表單沒有這兩格，
     若照樣寫入就會把已經抄好的水表度數清成空值——日後改回抄表模式就找不回來了。 */
  if (document.getElementById('stm-in-w')) {
    patch.inW = num('stm-in-w'); patch.outW = num('stm-out-w');
  }
  var bad = ['inE', 'outE', 'inW', 'outW'].some(function (k) {
    return patch[k] !== '' && patch[k] != null && !(patch[k] >= 0);
  });
  if (bad) { alert('度數必須是 0 以上的數字。'); return; }
  var all = stMeters();
  all[key] = Object.assign({}, all[key] || {}, patch);
  stSaveMeters(all);
  stMeterClose();
  stRender();
  if (document.getElementById('std-ov').classList.contains('open') && ST_EDIT_BK) stDetail(ST_EDIT_BK);
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}

/* ── 結算明細 ──────────────────────────────────── */
function stDetail(bkId) {
  stEnsureUI();
  var s = stFind(bkId);
  if (!s) { alert('找不到這筆結算單，可能訂單剛被其他成員改過，請重新開啟。'); return; }
  ST_EDIT_BK = s.bkId;
  var r = s.rec || {};
  var inp = 'height:30px;font-size:12px;border:1px solid var(--border);border-radius:5px;padding:0 8px;width:100%;background:#fff';

  document.getElementById('std-title').textContent =
    '退房結算單 — ' + s.guest + '（' + (s.endDate || '未退房') + '）';

  var sec = function (title, sum, rows, color) {
    return '<div style="margin-top:12px">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline">' +
        '<div style="font-weight:800;font-size:12px;color:' + color + '">' + title + '</div>' +
        '<div style="font-weight:700;font-size:13px">' + (sum ? '−' + money(sum) : '$0') + '</div></div>' +
      (rows ? '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:5px">' + rows + '</table>'
            : '<div style="font-size:10.5px;color:var(--muted);margin-top:3px">無</div>') +
    '</div>';
  };

  var h = '<div style="background:#f8fafc;border-radius:8px;padding:11px 13px;font-size:11.5px;line-height:1.9">' +
    '<strong>' + escH(s.guest) + '</strong>　' + escH(s.phone) + '<br>' +
    s.segs.map(function (x) {
      return escH(x.propName) + ' ' + escH(x.room) + '　' + escH(x.checkin) + ' ～ ' + escH(x.checkout) +
        (x.status === 'checkout' ? '' : '<span style="color:#e67700">（' +
          ((STATUS[x.status] && STATUS[x.status].label) || x.status) + '）</span>');
    }).join('<br>') +
    '<div style="margin-top:6px;font-size:13px">押金 <strong>' + money(s.deposit) + '</strong>' +
      (s.dueBy ? '　｜　應於 <strong>' + escH(s.dueBy) + '</strong> 前退還' : '') + '</div></div>';

  if (!s.allOut) {
    h += '<div style="margin-top:10px;background:#fff3bf;border:1px solid #ffd43b;border-radius:8px;' +
      'padding:9px 12px;font-size:11.5px;line-height:1.8">' +
      '這張訂單還有房間沒有退房，現在結算等於提前把押金退掉。確認要結算前請先確定剩下的房間不再使用押金擔保。</div>';
  }
  if (s.utilPending && !s.settled) {
    h += '<div style="margin-top:10px;background:#fff5f5;border:1px solid #ffc9c9;border-radius:8px;' +
      'padding:9px 12px;font-size:11.5px;line-height:1.8">' +
      '有 <strong>' + s.utilPending + '</strong> 間房還沒抄完表，水電費目前以 ' + money(s.util) + ' 計算。' +
      '人走了度數就補不回來，請先到「🔌 水電抄表」補齊再結算。</div>';
  }
  /* 結算後底層資料又被改過：畫面上的金額是結算當時的，不是現在重算的。
     不講清楚的話，業者會以為系統算錯或資料被改壞。 */
  if (s.drifted) {
    h += '<div style="margin-top:10px;background:#fff9db;border:1px solid #ffe066;border-radius:8px;' +
      'padding:9px 12px;font-size:11.5px;line-height:1.8">' +
      '這張單結算後，底下的欠租或維修資料又有異動。本單仍以 <strong>結算當時</strong> 的金額為準' +
      '（與房客簽收的數字一致）；以現行資料重算會是 ' +
      money(s.live.deposit - (s.live.rent + s.live.util + s.live.dmg + s.live.extraSum)) + '。' +
      '若要改以新數字為準，請先「🗑 清除結算紀錄」再重新結算。</div>';
  }

  h += sec('① 欠租', s.rent, s.rentList.map(function (x) {
    return '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:4px 6px">' + escH(x.propName) + ' ' + escH(x.room) + ' 第 ' + x.no + ' 期</td>' +
      '<td style="padding:4px 6px;white-space:nowrap">' + escH(x.from) + '～' + escH(x.to) + '</td>' +
      '<td style="padding:4px 6px;text-align:right;white-space:nowrap">應收 ' + money(x.due) +
        '　已收 ' + money(x.amt) + '</td>' +
      '<td style="padding:4px 6px;text-align:right;white-space:nowrap;font-weight:700">' + money(x.owe) + '</td></tr>';
  }).join(''), '#c92a2a');

  h += sec('② 水電費', s.util, s.utilList.map(function (x) {
    var u = x.u;
    return '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:4px 6px">' + escH(x.propName) + ' ' + escH(x.room) + '</td>' +
      '<td style="padding:4px 6px">' + (u.ready
        ? '電 ' + u.inE + ' → ' + u.outE + '（' + u.kwh + ' 度 × $' + u.rateE + '）'
        : '<span style="color:#c92a2a">' + escH(u.why || '尚未抄表') + '</span>') + '</td>' +
      '<td style="padding:4px 6px">' + (u.waterMode === 'fixed'
        ? '水費定額 ' + u.months + ' 期 × $' + u.waterFixed
        : '水 ' + (u.inW === '' || u.inW == null ? '—' : u.inW) + ' → ' +
          (u.outW === '' || u.outW == null ? '—' : u.outW) + ' × $' + u.rateW) + '</td>' +
      '<td style="padding:4px 6px;text-align:right;white-space:nowrap;font-weight:700">' + money(u.amt) + '</td></tr>';
  }).join(''), '#e67700');

  h += sec('③ 損壞賠償', s.dmg, s.dmgList.map(function (x) {
    return '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:4px 6px;white-space:nowrap">' + escH(x.date) + '</td>' +
      '<td style="padding:4px 6px">' + escH(x.room) + '</td>' +
      '<td style="padding:4px 6px">' + (x.cat ? '[' + escH(x.cat) + '] ' : '') + escH(x.note) + '</td>' +
      '<td style="padding:4px 6px;text-align:right;white-space:nowrap;font-weight:700">' + money(x.cost) + '</td></tr>';
  }).join(''), '#7048e8');

  /* ④ 其他：清潔費、代謝費、遺留物處理…每家業者名目都不同，做成自由欄位。
     填負數＝退還給房客（例如多收的代收款），所以標題不寫死「扣款」。 */
  h += '<div style="margin-top:12px">' +
    '<div style="display:flex;justify-content:space-between;align-items:baseline">' +
      '<div style="font-weight:800;font-size:12px;color:#1971c2">④ 其他扣抵／加項</div>' +
      '<div style="font-weight:700;font-size:13px">' +
        (s.extraSum ? (s.extraSum > 0 ? '−' : '+') + money(Math.abs(s.extraSum)) : '$0') + '</div></div>' +
    '<div id="std-extra">' + stExtraRows(s.extra) + '</div>' +
    '<button class="btn btn-ghost sm" style="margin-top:5px" onclick="stAddExtra()">＋ 新增一項</button>' +
    '<div style="font-size:10px;color:var(--muted);margin-top:4px">' +
      '金額填正數＝從押金扣除（清潔費、遺留物處理…）；填負數＝退還給房客（多收的代收款…）。</div></div>';

  var neg = s.refund < 0;
  h += '<div style="margin-top:14px;background:' + (neg ? '#fff5f5' : '#e7f5ff') + ';border-radius:8px;' +
    'padding:12px 14px;font-size:13px;line-height:2">' +
    '<div style="display:flex;justify-content:space-between"><span>押金</span>' +
      '<strong>' + money(s.deposit) + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between"><span>扣抵合計</span>' +
      '<strong>−' + money(s.deducted) + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);' +
      'margin-top:5px;padding-top:5px;font-size:16px">' +
      '<span style="font-weight:700">' + (neg ? '房客尚須補付' : '應退還房客') + '</span>' +
      '<strong style="color:' + (neg ? '#c92a2a' : '#1a56a0') + '">' + money(Math.abs(s.refund)) + '</strong></div></div>';

  h += '<div class="form-grid" style="gap:10px;margin-top:12px">' +
    '<div class="field"><label style="font-size:10.5px">' + (neg ? '實收金額' : '實退金額') + '</label>' +
      '<input type="number" id="std-amt" value="' + (r.refund != null ? r.refund : Math.abs(s.refund)) +
      '" style="' + inp + '"></div>' +
    '<div class="field"><label style="font-size:10.5px">' + (neg ? '收款日' : '退款日') + '</label>' +
      '<input type="date" id="std-on" value="' + escH(r.on || todayStr()) + '" style="' + inp + '"></div>' +
    '<div class="field span2"><label style="font-size:10.5px">備註</label>' +
      '<input type="text" id="std-note" value="' + escH(r.note || '') + '" ' +
      'placeholder="差額原因、分期退還、房客異議…" style="' + inp + '"></div></div>' +
    '<div style="margin-top:8px;font-size:10.5px;color:var(--muted);line-height:1.75">' +
      '金額可以改——實際退出去的數字才是帳。系統算的金額仍會留在結算單上，兩者不同時單上會標出差額。</div>';

  if (s.settled) {
    h += '<div style="margin-top:10px;font-size:10.5px;color:var(--muted)">' +
      '已於 ' + escH(r.on || '') + ' 由 ' + escH(r.by || '') + ' 結算' +
      (r.calc != null && Math.round(r.calc) !== Math.round(r.refund)
        ? '；當時系統計算值為 ' + money(Math.abs(r.calc)) + '，與實際金額相差 ' +
          money(Math.abs(Math.abs(r.calc) - r.refund))
        : '') + '。</div>';
  }

  document.getElementById('std-body').innerHTML = h;
  document.getElementById('std-save').textContent = s.settled ? '✅ 更新結算' : '✅ 確認結算';
  /* 沒有結算紀錄就沒有東西可以清，按鈕藏起來（留著只會讓人去按然後看到「沒有紀錄」） */
  document.getElementById('std-del').style.display = s.settled ? '' : 'none';
  document.getElementById('std-ov').classList.add('open');
}
function stCloseDetail() { document.getElementById('std-ov').classList.remove('open'); ST_EDIT_BK = null; }

function stExtraRows(list) {
  var inp = 'height:28px;font-size:11.5px;border:1px solid var(--border);border-radius:5px;padding:0 7px;background:#fff';
  return (list || []).map(function (x, i) {
    return '<div class="std-ex" style="display:flex;gap:6px;margin-top:5px">' +
      '<input type="text" class="std-ex-label" value="' + escH(x.label || '') + '" ' +
        'placeholder="項目名稱" style="' + inp + ';flex:1">' +
      '<input type="number" class="std-ex-amt" value="' + (x.amt != null ? escH(String(x.amt)) : '') + '" ' +
        'placeholder="金額" style="' + inp + ';width:110px">' +
      '<button class="btn btn-ghost sm" onclick="this.parentNode.remove()">✕</button></div>';
  }).join('');
}
function stAddExtra() {
  document.getElementById('std-extra').insertAdjacentHTML('beforeend', stExtraRows([{ label: '', amt: '' }]));
}
function stReadExtra() {
  return Array.from(document.querySelectorAll('#std-extra .std-ex')).map(function (el) {
    return {
      label: (el.querySelector('.std-ex-label').value || '').trim().slice(0, 60),
      amt: Number(el.querySelector('.std-ex-amt').value) || 0
    };
  }).filter(function (x) { return x.label || x.amt; });
}

function stSaveSettle() {
  var bkId = ST_EDIT_BK;
  if (!bkId) return;
  var extra = stReadExtra();
  var bad = extra.find(function (x) { return !x.label; });
  if (bad) { alert('「其他扣抵／加項」每一列都要填項目名稱，否則房客看不懂扣的是什麼。'); return; }

  /* 帶著畫面上的 extra 重算，但不先寫進 KV——下面任何一道驗證沒過就直接 return，
     寫了就會留下一筆沒有退款日的「已結算」。 */
  var s = stFind(bkId, extra);
  if (!s) { alert('找不到這筆結算單，請重新開啟。'); return; }

  /* 一律用 live（現況重算值）寫入快照。s 本身對已結算的單會是舊快照，
     拿它來存等於永遠蓋回舊數字，「更新結算」就再也反映不了後來的更正。 */
  var L = s.live;
  var calc = L.deposit - (L.rent + L.util + L.dmg + L.extraSum);

  var amt = Number(document.getElementById('std-amt').value);
  var on = document.getElementById('std-on').value || '';
  if (!(amt >= 0)) { alert('金額必須是 0 或正數。'); return; }
  if (!on) { alert('請填退款日期。'); return; }
  if (on > todayStr()) { alert('退款日期不能是未來日期。'); return; }
  if (s.utilPending && !confirm(
      '還有 ' + s.utilPending + ' 間房沒有抄完表，水電費以 ' + money(L.util) + ' 計算。\n' +
      '房客搬走後度數就補不回來了，確定要直接結算嗎？')) return;
  if (!s.allOut && !confirm('這張訂單還有房間沒有退房，確定要現在結算押金嗎？')) return;
  if (s.drifted && !confirm(
      '這張單結算後底層資料有異動。\n' +
      '按下確定會改以現行資料重算（應退 ' + money(Math.abs(calc)) + '）作為新的結算依據，\n' +
      '原本與房客簽收的那份金額（應退 ' + money(Math.abs(s.refund)) + '）將被取代。\n\n確定要更新嗎？')) return;

  var recs = stRecs();
  recs[bkId] = {
    on: on, refund: Math.round(amt), extra: extra,
    note: (document.getElementById('std-note').value || '').trim().slice(0, 300),
    /* 當下系統算出的金額與各項扣抵，日後對帳查得到。
       欠租／維修日後可能被補登或修改，不留快照的話就再也還原不出
       「當初是依據什麼數字退這筆錢的」。 */
    calc: calc,
    snap: { deposit: L.deposit, rent: L.rent, util: L.util, dmg: L.dmg, extraSum: L.extraSum },
    at: new Date().toISOString(), by: Cloud.myDisplayName || Cloud.myEmail || ''
  };
  stSaveRecs(recs);
  stCloseDetail();
  stRender();
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}

function stDeleteSettle() {
  var bkId = ST_EDIT_BK;
  if (!bkId) return;
  if (!confirm('確定要清除這張結算紀錄嗎？\n（金額會回到系統計算值，狀態變回「待結算」。）')) return;
  var recs = stRecs();
  delete recs[bkId];
  stSaveRecs(recs);
  stCloseDetail();
  stRender();
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}

/* ── 設定 ─────────────────────────────────────── */
/* 同仁可以做退房結算，但不能改「算結算用的費率」——水電單價一改，
   每一張還沒結的結算單金額都會跟著變。 */
function stOpenCfg() {
  if (typeof adminOnly === 'function' && !adminOnly('修改水電費率設定'))return;
  stEnsureUI();
  var c = stCfg();
  var inp = 'height:30px;font-size:12px;border:1px solid var(--border);border-radius:5px;padding:0 8px;width:100%;background:#fff';
  var props = getAllProps();
  document.getElementById('stc-body').innerHTML =
    '<div style="font-weight:800;font-size:12px;margin-bottom:6px">全公司預設</div>' +
    '<div class="form-grid" style="gap:10px">' +
      '<div class="field"><label style="font-size:10.5px">每度電費 (NT$)</label>' +
        '<input type="number" step="0.1" id="stc-rate-e" value="' + c.rateE + '" style="' + inp + '"></div>' +
      '<div class="field"><label style="font-size:10.5px">水費計算方式</label>' +
        '<select id="stc-wmode" style="' + inp + '">' +
          Object.keys(ST_WATER_MODE).map(function (k) {
            return '<option value="' + k + '"' + (c.waterMode === k ? ' selected' : '') + '>' +
              ST_WATER_MODE[k] + '</option>';
          }).join('') + '</select></div>' +
      '<div class="field"><label style="font-size:10.5px">每期定額水費 (NT$)</label>' +
        '<input type="number" id="stc-wfixed" value="' + c.waterFixed + '" style="' + inp + '"></div>' +
      '<div class="field"><label style="font-size:10.5px">每度水費 (NT$)</label>' +
        '<input type="number" step="0.1" id="stc-rate-w" value="' + c.rateW + '" style="' + inp + '"></div>' +
      '<div class="field span2"><label style="font-size:10.5px">押金退還作業天數（自最後退房日起算）</label>' +
        '<input type="number" min="0" max="90" id="stc-refund" value="' + c.refundDays + '" style="' + inp + '"></div>' +
    '</div>' +
    '<div style="margin-top:8px;font-size:10.5px;color:var(--muted);line-height:1.8">' +
      '預設值只是起始參考（電 5 元／度、水每期 150 元），<strong>請務必改成貴公司實際的收費標準</strong>。<br>' +
      '退還作業天數會變成待辦提醒的門檻：全部退房後超過這個天數仍未結算，就會出現在今日待辦。' +
      '內政部定型化契約的原則是返還房屋並結清費用後即應返還押金，這個天數是給貴公司內部的作業緩衝，' +
      '實際期限仍以您與房客簽訂的契約為準。</div>' +

    '<div style="font-weight:800;font-size:12px;margin:15px 0 6px">個別館別覆寫' +
      '<span style="font-weight:400;color:var(--muted);font-size:10.5px">（留空＝沿用上方預設）</span></div>' +
    (props.length
      ? '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
          '<thead><tr style="background:#f8fafc"><th style="padding:5px 7px;text-align:left;font-size:10px;color:var(--muted)">館別</th>' +
          '<th style="padding:5px 7px;text-align:left;font-size:10px;color:var(--muted)">每度電費</th>' +
          '<th style="padding:5px 7px;text-align:left;font-size:10px;color:var(--muted)">水費方式</th>' +
          '<th style="padding:5px 7px;text-align:left;font-size:10px;color:var(--muted)">定額／每度</th></tr></thead><tbody>' +
          props.map(function (p) {
            var o = c.byProp[String(p.id)] || {};
            var si = 'height:26px;font-size:11.5px;border:1px solid var(--border);border-radius:5px;padding:0 6px;width:100%;background:#fff';
            return '<tr class="stc-row" data-pid="' + escH(String(p.id)) + '" style="border-top:1px solid var(--border)">' +
              '<td style="padding:4px 7px">' + escH(p.name) + '</td>' +
              '<td style="padding:4px 7px"><input type="number" step="0.1" class="stc-p-e" value="' +
                (o.rateE != null ? escH(String(o.rateE)) : '') + '" placeholder="' + c.rateE + '" style="' + si + '"></td>' +
              '<td style="padding:4px 7px"><select class="stc-p-m" style="' + si + '">' +
                '<option value="">預設</option>' +
                Object.keys(ST_WATER_MODE).map(function (k) {
                  return '<option value="' + k + '"' + (o.waterMode === k ? ' selected' : '') + '>' +
                    ST_WATER_MODE[k] + '</option>';
                }).join('') + '</select></td>' +
              '<td style="padding:4px 7px"><input type="number" step="0.1" class="stc-p-w" value="' +
                (o.waterFixed != null ? escH(String(o.waterFixed)) : (o.rateW != null ? escH(String(o.rateW)) : '')) +
                '" placeholder="沿用預設" style="' + si + '"></td></tr>';
          }).join('') + '</tbody></table>'
      : '<div style="font-size:11.5px;color:var(--muted)">還沒有館別。</div>');
  document.getElementById('stc-ov').classList.add('open');
}
function stCloseCfg() { document.getElementById('stc-ov').classList.remove('open'); }

function stSaveCfgUI() {
  var num = function (id) { var v = (document.getElementById(id).value || '').trim(); return v === '' ? null : Number(v); };
  var rateE = num('stc-rate-e'), wFixed = num('stc-wfixed'), rateW = num('stc-rate-w'), rd = num('stc-refund');
  if (rateE == null || !(rateE >= 0)) { alert('每度電費必須是 0 或正數。'); return; }
  if (wFixed == null || !(wFixed >= 0)) { alert('每期定額水費必須是 0 或正數。'); return; }
  if (rateW == null || !(rateW >= 0)) { alert('每度水費必須是 0 或正數。'); return; }
  if (rd == null || !(rd >= 0) || rd > 90) { alert('退還作業天數請填 0～90。'); return; }

  var mode = document.getElementById('stc-wmode').value;
  var byProp = {};
  Array.from(document.querySelectorAll('.stc-row')).forEach(function (tr) {
    var pid = tr.dataset.pid;
    var e = (tr.querySelector('.stc-p-e').value || '').trim();
    var m = tr.querySelector('.stc-p-m').value;
    var w = (tr.querySelector('.stc-p-w').value || '').trim();
    var o = {};
    if (e !== '') o.rateE = Number(e);
    if (m) o.waterMode = m;
    /* 第四欄是「定額或每度」共用一格：存進哪個欄位由該館別實際採用的
       水費模式決定（沒覆寫模式就看全公司預設），否則填了數字卻不生效。 */
    if (w !== '') {
      var eff = m || mode;
      if (eff === 'fixed') o.waterFixed = Number(w); else o.rateW = Number(w);
    }
    if (Object.keys(o).length) byProp[pid] = o;
  });

  stSaveCfg({ rateE: rateE, waterMode: mode, waterFixed: wFixed, rateW: rateW,
              refundDays: rd, byProp: byProp });
  stCloseCfg();
  stRender();
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}

/* ── 列印 ─────────────────────────────────────── */
function stBizName() {
  var sg = Cloud.get('qj_signer', {}) || {};
  return ((sg.biz && sg.biz.name) || '') || '（請到「✍️ 簽約主體設定」填公司名稱）';
}

function stPrint() {
  var s = ST_EDIT_BK ? stFind(ST_EDIT_BK) : null;
  if (!s) { alert('找不到這張結算單。'); return; }
  var w = window.open('', '_blank');
  if (!w) { alert('瀏覽器阻擋了新視窗，請允許彈出視窗後再試'); return; }
  var e = escH;

  /* s 的金額在 stBuild 已經換成結算當時的快照（已結算的單），這裡直接用。
     明細文字仍取現況（它只是說明），某一階段的現況與快照不同時標出來。 */
  var v = s;
  var neg = s.refund < 0;
  var drift = function (key) {
    return (s.drifted && Math.round(s[key]) !== Math.round(s.live[key]))
      ? '<br><span style="color:#b54708">（現行資料重算為 ' + money(s.live[key]) +
        '，本單以結算當時金額為準）</span>'
      : '';
  };

  var row = function (label, detail, amt) {
    return '<tr><td>' + label + '</td><td class="dt">' + detail + '</td>' +
      '<td class="num">' + (amt ? '−' + money(amt) : '—') + '</td></tr>';
  };
  var body = '';
  body += row('① 欠租', (s.rentList.length
    ? s.rentList.map(function (x) {
        return e(x.room) + ' 第 ' + x.no + ' 期（' + e(x.from) + '～' + e(x.to) + '）應收 ' +
          money(x.due) + '、已收 ' + money(x.amt);
      }).join('<br>')
    : '無') + drift('rent'), v.rent);
  body += row('② 水電費', s.utilList.map(function (x) {
    var u = x.u;
    return e(x.room) + '：' + (u.ready
      ? '電表 ' + u.inE + ' → ' + u.outE + '，用電 ' + u.kwh + ' 度 × $' + u.rateE + ' ＝ ' + money(u.eAmt)
      : '電費未抄表') +
      '；' + (u.waterMode === 'fixed'
        ? '水費定額 ' + u.months + ' 期 × $' + u.waterFixed + ' ＝ ' + money(u.wAmt)
        : '水表 ' + (u.inW == null || u.inW === '' ? '—' : u.inW) + ' → ' +
          (u.outW == null || u.outW === '' ? '—' : u.outW) + ' × $' + u.rateW + ' ＝ ' + money(u.wAmt));
  }).join('<br>') + drift('util'), v.util);
  body += row('③ 損壞賠償', (s.dmgList.length
    ? s.dmgList.map(function (x) {
        return e(x.date) + '　' + e(x.room) + '　' + (x.cat ? '[' + e(x.cat) + '] ' : '') +
          e(x.note) + '　' + money(x.cost);
      }).join('<br>')
    : '無') + drift('dmg'), v.dmg);
  if (s.extra.length) {
    body += s.extra.map(function (x) {
      return '<tr><td>④ ' + e(x.label) + '</td><td class="dt"></td><td class="num">' +
        (x.amt >= 0 ? '−' : '＋') + money(Math.abs(x.amt)) + '</td></tr>';
    }).join('');
  }

  var diff = s.rec ? (s.rec.refund - Math.abs(v.refund)) : 0;

  var html = '<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">' +
    '<title>退房結算單 ' + e(s.guest) + ' ' + e(s.endDate) + '</title><style>' +
    '@page{size:A4;margin:16mm 14mm}*{box-sizing:border-box}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Microsoft JhengHei",sans-serif;' +
      'color:#1a2535;margin:0;padding:22px;line-height:1.7;font-size:13px}' +
    '.bar{background:#e8f0fb;border-radius:8px;padding:9px 13px;font-size:12px;margin-bottom:16px}' +
    'h1{font-size:19px;margin:0 0 3px}.sub{color:#6b7a99;font-size:12px;margin-bottom:16px}' +
    'table{width:100%;border-collapse:collapse;font-size:12.5px;margin:9px 0 15px}' +
    'th,td{border:1px solid #d8dde8;padding:6px 9px;text-align:left;vertical-align:top}' +
    'th{background:#f0f4fa;white-space:nowrap}' +
    '.dt{font-size:11px;color:#45506b}.num{text-align:right;white-space:nowrap;width:110px}' +
    '.tot{background:#f0f4fa;font-weight:700;font-size:14px}' +
    'h2{font-size:13.5px;margin:17px 0 5px;border-left:4px solid #1a56a0;padding-left:8px}' +
    '.kv{width:100%;border:none}.kv td{border:none;padding:2px 0;font-size:12px}' +
    '.kv td:first-child{width:92px;color:#6b7a99}' +
    '.foot{margin-top:22px;font-size:11px;color:#6b7a99;line-height:1.8;' +
      'border-top:1px solid #d8dde8;padding-top:10px}' +
    '.sign{margin-top:26px;display:flex;gap:30px}' +
    '.sign div{flex:1;border-top:1px solid #1a2535;padding-top:5px;font-size:11.5px}' +
    '@media print{.bar{display:none}body{padding:0}}' +
    '</style></head><body>' +
    '<div class="bar">這是系統依租金收款台帳、水電抄表與維修單自動產生的押金結算單。' +
      '<button onclick="window.print()" style="margin-left:8px">🖨 列印／儲存 PDF</button></div>' +
    '<h1>退房結算暨押金返還明細</h1>' +
    '<div class="sub">製表日 ' + e(todayStr()) + '</div>' +
    '<table class="kv"><tr><td>出表單位</td><td>' + e(stBizName()) + '</td></tr>' +
    '<tr><td>承租人</td><td>' + e(s.guest) + '　' + e(s.phone) + '</td></tr>' +
    '<tr><td>租賃標的</td><td>' + s.segs.map(function (x) {
      return e(x.propName) + ' ' + e(x.room) + '（' + e(x.checkin) + ' ～ ' + e(x.checkout) + '）';
    }).join('<br>') + '</td></tr>' +
    '<tr><td>最後退房日</td><td>' + e(s.endDate) + '</td></tr></table>' +

    '<h2>押金結算明細</h2>' +
    '<table><tr><th>項目</th><th>計算說明</th><th class="num">金額</th></tr>' +
    '<tr><td>押金（原收）</td><td class="dt"></td><td class="num">' + money(v.deposit) + '</td></tr>' +
    body +
    '<tr class="tot"><td>' + (neg ? '承租人尚須補付' : '應返還承租人') + '</td><td class="dt"></td>' +
      '<td class="num">' + money(Math.abs(v.refund)) + '</td></tr></table>' +

    '<h2>' + (neg ? '收款' : '返還') + '資訊</h2>' +
    '<table class="kv">' +
    (s.rec
      ? '<tr><td>' + (neg ? '收款日' : '返還日') + '</td><td>' + e(s.rec.on || '') + '</td></tr>' +
        '<tr><td>實際金額</td><td>' + money(s.rec.refund) +
          (diff ? '（與系統計算差 ' + (diff > 0 ? '＋' : '−') + money(Math.abs(diff)) + '）' : '') + '</td></tr>' +
        (s.rec.note ? '<tr><td>備註</td><td>' + e(s.rec.note) + '</td></tr>' : '') +
        '<tr><td>經手人</td><td>' + e(s.rec.by || '') + '</td></tr>'
      : '<tr><td>狀態</td><td>尚未結算</td></tr>') +
    '</table>' +

    '<div class="sign"><div>出表單位（簽章）</div><div>承租人簽收</div></div>' +
    '<div class="foot">' +
      '押金扣抵順序為：① 積欠租金 ② 水電等代繳費用 ③ 可歸責於承租人之毀損修復費用 ④ 其他經雙方確認之費用。<br>' +
      '水電費依本單所載電（水）表度數與約定單價計算；度數以雙方點交時共同確認之讀數為準。<br>' +
      '自然耗損及正常使用之損耗不計入損壞賠償。如對本單任何項目有疑義，請於收到後十日內提出，以便查核更正。' +
    '</div></body></html>';

  w.document.write(html);
  w.document.close();
  w.focus();
}
