/* ══════════════════════════════════════════════════════════════════
   房東月結撥款單
   ------------------------------------------------------------------
   包租與代管的錢流方向完全相反，但業者每個月都得跟房東對一次帳，這件事
   原本完全靠人工算：
     ・包租館 — 業者付房東「保證租金」，不論房間租不租得出去
     ・代管館 — 業者代房客收租，扣掉服務報酬後把餘額撥給房東

   所有輸入其實系統裡都有了，只是沒人把它們擺在同一張紙上：
     保證租金／報酬比例／撥款帳戶 → 館別契約設定（qj_cdata）
     當月實際收到多少租金       → 租金收款台帳（qj_rent）
     代墊了多少維修費           → 維修單裡「屋主請款狀態＝未請款」的金額
   這支模組只做「把它們算成一張可以寄給房東的對帳單」，不新增任何輸入。

   三個刻意的算法決定：
   ① **代管服務報酬的計算基準是「當月實收租金」，不是契約上的月租金。**
      契約寫的是「月租金百分之 X」，但實務上房客沒繳租、業者就沒代收到錢，
      這時仍按契約月租金收滿報酬會變成業者替房客的欠租買單。只有在館別
      「未約定代收租金」時才退而以當月應收租金為基準（因為業者根本沒有
      實收數字），並在單上標明用的是哪一個基準。
   ② **跨月的契約起訖按當月實際天數比例計算**，不是用 30 天。保證租金是
      按月約定的，中途起租那個月用當月天數分攤才跟房東對得上。
   ③ **代墊維修只扣「屋主請款狀態＝未請款」的單**，扣完提供一鍵改成
      「已請款」。不自動改：撥款單印出來不等於房東已經認帳，業者可能還要
      跟房東解釋，認帳之後才該改狀態。
   ══════════════════════════════════════════════════════════════════ */
'use strict';

var PO_KV = 'qj_payout';   /* { '館別id|YYYY-MM': {on,amt,method,note,at,by} } */
var PO_METHODS = ['匯款／轉帳', '現金', '票據', '其他'];

function poLoad() { return Cloud.get(PO_KV, {}) || {}; }
function poSave(o) { Cloud.set(PO_KV, o); }
function poKey(propId, ym) { return String(propId) + '|' + ym; }

function poThisMonth() { var t = todayStr(); return t.slice(0, 7); }
function poPrevMonth(ym) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
  if (m === 0) { y--; m = 12; }
  return y + '-' + String(m).padStart(2, '0');
}
function poAddDay(s) {
  var d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
/* 月份的半開區間 [from, toEx)，月底界線一律用「下個月 1 號」表達，
   就不必到處處理 28/29/30/31 天的差異。 */
function poRange(ym) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  var days = dim(y, m);
  return { from: ds(y, m, 1), toEx: poAddDay(ds(y, m, days)), days: days };
}

/* 當月的租金收款情形，依館別彙總。
   實收以「收款日」歸月（錢是那個月進來的，撥款才對得上），
   應收以「計費起日」歸月（那是契約上該收的月份）。 */
function poRentByProp(ym) {
  var rg = poRange(ym);
  var out = {};
  var rows = (typeof rlBuild === 'function') ? rlBuild() : [];
  rows.forEach(function (r) {
    var pid = String(r.propId);
    var o = out[pid] || (out[pid] = { collected: 0, due: 0, rows: [] });
    var paidOn = r.rec && r.rec.on ? r.rec.on : '';
    var inPaid = paidOn && paidOn >= rg.from && paidOn < rg.toEx;
    var inDue = r.from >= rg.from && r.from < rg.toEx;
    if (inPaid) o.collected += r.amt;
    if (inDue) o.due += r.due;
    if (inPaid || inDue) {
      o.rows.push({
        guest: r.guest, room: r.room, no: r.no, from: r.from, to: r.to,
        due: r.due, amt: r.amt, on: paidOn, inPaid: inPaid, inDue: inDue,
        status: r.status
      });
    }
  });
  return out;
}

/* 已標記撥款的單上，當時扣抵了哪幾張維修單。
   撥款時若一併把維修單改成「已請款」，那幾筆就不再是 unbilled，之後重印同一
   個月的撥款單會少掉那段扣抵、金額跟著變——等於給房東的簽收本與系統對不起來。
   所以撥款紀錄會把扣抵的維修單 id 留下來，重算該月時照樣納入。 */
function poKeepRepairs(ym) {
  var recs = poLoad(), keep = {};
  Object.keys(recs).forEach(function (k) {
    if (k.slice(k.indexOf('|') + 1) !== ym) return;
    var ids = recs[k] && recs[k].repairIds;
    if (!ids || !ids.length) return;
    var pid = k.slice(0, k.indexOf('|'));
    var m = keep[pid] || (keep[pid] = {});
    ids.forEach(function (id) { m[String(id)] = true; });
  });
  return keep;
}

/* 當月代墊的維修費（屋主請款狀態＝未請款）。
   歸月用「完成日，沒有就用開始日」：還沒修完的單也會列入，因為錢往往是
   叫修當下就先付給廠商了，業者確實已經代墊。 */
function poRepairByProp(ym) {
  var rg = poRange(ym);
  var keep = poKeepRepairs(ym);
  var out = {};
  loadTasks().forEach(function (t) {
    if (t.type !== 'repair') return;
    if (t.billing !== 'unbilled' &&
        !(keep[String(t.prop_id)] && keep[String(t.prop_id)][String(t.id)])) return;
    var c = tkCost(t);
    if (!(c > 0)) return;
    var d = t.doneAt || t.start || '';
    if (!(d >= rg.from && d < rg.toEx)) return;
    var pid = String(t.prop_id);
    var o = out[pid] || (out[pid] = { sum: 0, list: [] });
    o.sum += c;
    o.list.push({ id: t.id, room: t.room || '', date: d, cost: c,
                  note: t.note || '', cat: t.cat || '', closed: tkClosed(t) });
  });
  return out;
}

/* 一個月份的全部撥款單。一張單＝一個館別（契約是按館別簽的），再標上房東。 */
function poBuild(ym) {
  var rg = poRange(ym);
  var rent = poRentByProp(ym);
  var rep = poRepairByProp(ym);
  var recs = poLoad();
  /* 權限擋在這裡而不是在畫面上：撥款單帶著房東姓名、電話與完整帳號，
     poFind/poPrint/poExportRows/poUnpaid 全都走 poBuild，只要有一支忘記過濾
     就等於開後門。用 ldVisible() 和房東建檔同一套規則。 */
  var lords = ldVisible();
  var out = [];
  lords.forEach(function (L) {
    L.props.forEach(function (b) {
      /* 契約期間與本月的重疊天數。契約的「至」是含當日，所以換成開區間要 +1 天 */
      var ovFrom = b.from && b.from > rg.from ? b.from : rg.from;
      var ovToEx = b.to && poAddDay(b.to) < rg.toEx ? poAddDay(b.to) : rg.toEx;
      var ovDays = diffDays(ovFrom, ovToEx);
      if (ovDays < 0) ovDays = 0;
      var partial = ovDays > 0 && ovDays < rg.days;

      var R = rent[b.id] || { collected: 0, due: 0, rows: [] };
      var P = rep[b.id] || { sum: 0, list: [] };

      var rentDue = 0, fee = 0, feeBase = 0, baseLabel = '';
      if (b.kind === 'bz') {
        rentDue = ovDays <= 0 ? 0
          : (partial ? Math.round(b.rent * ovDays / rg.days) : b.rent);
      } else {
        /* 有代收租金就以實收為報酬基準；沒代收的話業者手上沒有實收數字，
           只能退而用當月應收，並在單上標明。 */
        feeBase = b.collectRent ? R.collected : R.due;
        baseLabel = b.collectRent ? '當月實收租金' : '當月應收租金（未約定代收）';
        if (b.feeMode === 'fix') {
          fee = ovDays <= 0 ? 0 : (partial ? Math.round(b.feeAmt * ovDays / rg.days) : b.feeAmt);
        } else {
          fee = ovDays <= 0 ? 0 : Math.round(feeBase * b.feePct / 100);
        }
      }
      var handOver = b.kind === 'wg' && b.collectRent ? R.collected : 0;
      var net = b.kind === 'bz' ? rentDue - P.sum : handOver - fee - P.sum;

      var key = poKey(b.id, ym);
      var rec = recs[key] || null;
      out.push({
        key: key, ym: ym, propId: b.id, propName: b.name, kind: b.kind,
        serviceType: b.serviceType, rooms: b.rooms,
        lordKey: L.key, lordName: L.name, lordTel: L.tel, lordEmail: L.email,
        lordMail: L.mail,
        bank: b.bank, acctName: b.acctName, acctNo: b.acctNo,
        term: { from: b.from, to: b.to }, ovDays: ovDays, partial: partial,
        monthDays: rg.days, payDay: b.payDay,
        rentDue: rentDue, collected: R.collected, dueTotal: R.due,
        handOver: handOver, fee: fee, feeBase: feeBase, baseLabel: baseLabel,
        feeMode: b.feeMode, feePct: b.feePct, feeAmt: b.feeAmt,
        collectRent: b.collectRent,
        rentRows: R.rows, repairs: P.list, repairSum: P.sum,
        net: net, rec: rec, paid: !!rec
      });
    });
  });
  return out.sort(function (a, b) {
    return a.lordName.localeCompare(b.lordName) || a.propName.localeCompare(b.propName);
  });
}

/* 給今日待辦用：上個月的撥款單還沒標記撥款的，且金額不為 0。
   只看上個月——當月的還沒結束，提醒也沒意義。 */
function poUnpaid() {
  var ym = poPrevMonth(poThisMonth());
  return poBuild(ym).filter(function (s) {
    return !s.paid && s.ovDays > 0 && s.net !== 0;
  });
}

function poExportRows() {
  var ym = poThisMonth();
  return [ym, poPrevMonth(ym)].reduce(function (acc, m) {
    return acc.concat(poBuild(m).map(function (s) {
      return {
        月份: s.ym, 房東: s.lordName, 電話: s.lordTel,
        館別: s.propName, 服務類型: s.serviceType,
        保證租金: s.kind === 'bz' ? s.rentDue : '',
        代收租金: s.kind === 'wg' ? s.handOver : '',
        服務報酬: s.kind === 'wg' ? s.fee : '',
        代墊維修: s.repairSum,
        應撥付: s.net,
        撥款狀態: s.paid ? '已撥款' : '未撥款',
        撥款日: s.rec ? (s.rec.on || '') : '',
        撥款方式: s.rec ? (s.rec.method || '') : '',
        備註: s.rec ? (s.rec.note || '') : '',
        經手人: s.rec ? (s.rec.by || '') : ''
      };
    }));
  }, []);
}

/* ══════════════════════════════════════════════════════════════════
   UI
   ══════════════════════════════════════════════════════════════════ */
var PO_UI_READY = false;
var PO_LORD = '';   /* 只看某位房東時的 key，空字串＝全部 */

function poEnsureUI() {
  if (PO_UI_READY) return;
  PO_UI_READY = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="overlay" id="po-ov" onclick="if(event.target===this)closePayout()">' +
    '<div class="modal" style="width:1120px;max-width:98vw">' +
    '<div class="modal-h"><h2 id="po-title">📄 房東月結撥款單</h2>' +
    '<button class="close-btn" onclick="closePayout()">✕</button></div>' +
    '<div style="padding:10px 17px 4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<input class="sel" id="po-month" type="month" onchange="poRender()" style="width:140px">' +
      '<select class="sel" id="po-lord" onchange="PO_LORD=this.value;poRender()">' +
        '<option value="">全部房東</option></select>' +
      '<select class="sel" id="po-f-st" onchange="poRender()">' +
        '<option value="">全部狀態</option>' +
        '<option value="unpaid">只看未撥款</option>' +
        '<option value="paid">只看已撥款</option>' +
      '</select>' +
      '<button class="btn btn-ghost sm" onclick="poShiftMonth(-1)">← 上一月</button>' +
      '<button class="btn btn-ghost sm" onclick="poShiftMonth(1)">下一月 →</button>' +
    '</div>' +
    '<div class="modal-body" style="max-height:66vh;overflow-y:auto" id="po-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="closePayout()">關閉</button></div>' +
    '</div></div>' +

    '<div class="overlay" id="po-ed-ov" onclick="if(event.target===this)poEditClose()">' +
    '<div class="modal" style="width:440px;max-width:96vw">' +
    '<div class="modal-h"><h2 id="po-ed-title">標記撥款</h2>' +
    '<button class="close-btn" onclick="poEditClose()">✕</button></div>' +
    '<div class="modal-body" id="po-ed-body"></div>' +
    '<div class="modal-f">' +
      '<div style="flex:1"><button class="btn btn-danger sm" id="po-ed-del" onclick="poEditDelete()">🗑 清除撥款紀錄</button></div>' +
      '<button class="btn btn-ghost" onclick="poEditClose()">取消</button>' +
      '<button class="btn btn-primary" onclick="poEditSave()">💾 儲存</button>' +
    '</div></div></div>');
}

function openPayout(lordKey, ym) {
  poEnsureUI();
  PO_LORD = lordKey || '';
  var sel = document.getElementById('po-lord');
  sel.innerHTML = '<option value="">全部房東</option>' +
    ldVisible().map(function (L) {
      return '<option value="' + escH(L.key) + '">' + escH(L.name) + '</option>';
    }).join('');
  sel.value = PO_LORD;
  var mEl = document.getElementById('po-month');
  if (ym) mEl.value = ym;
  else if (!mEl.value) mEl.value = poThisMonth();
  poRender();
  document.getElementById('po-ov').classList.add('open');
}
function closePayout() { document.getElementById('po-ov').classList.remove('open'); }

function poShiftMonth(d) {
  var el = document.getElementById('po-month');
  var ym = el.value || poThisMonth();
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) + d;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  el.value = y + '-' + String(m).padStart(2, '0');
  poRender();
}

function poRender() {
  var ym = document.getElementById('po-month').value || poThisMonth();
  var fst = document.getElementById('po-f-st').value || '';
  var all = poBuild(ym);   /* poBuild 已按 ldVisible() 過濾過權限 */

  var list = all.filter(function (s) {
    if (PO_LORD && s.lordKey !== PO_LORD) return false;
    if (fst === 'paid' && !s.paid) return false;
    if (fst === 'unpaid' && s.paid) return false;
    return true;
  });

  var payOut = 0, payIn = 0, repSum = 0, feeSum = 0, unpaidN = 0;
  all.forEach(function (s) {
    if (s.net >= 0) payOut += s.net; else payIn += -s.net;
    repSum += s.repairSum; feeSum += s.fee;
    if (!s.paid && s.ovDays > 0 && s.net !== 0) unpaidN++;
  });

  var h = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:11px">' +
    [['應撥付房東', money(payOut), '#1a56a0'],
     ['房東應付本公司', money(payIn), '#7048e8'],
     ['服務報酬收入', money(feeSum), '#2f9e44'],
     ['代墊維修待扣', money(repSum), '#e67700'],
     ['未標記撥款', unpaidN + ' 張', unpaidN ? '#c92a2a' : '#868e96']].map(function (x) {
      return '<div style="flex:1;min-width:120px;background:#f8fafc;border:1px solid var(--border);' +
        'border-radius:8px;padding:9px 11px">' +
        '<div style="font-size:10px;color:var(--muted)">' + x[0] + '</div>' +
        '<div style="font-size:15px;font-weight:700;margin-top:2px;color:' + x[2] + '">' + x[1] + '</div></div>';
    }).join('') + '</div>' +
    '<div style="font-size:10.5px;color:var(--muted);margin:-4px 0 10px">' +
      '統計卡一律看 ' + escH(ym) + ' 整月、且不受上方「房東／狀態」篩選影響。</div>';

  if (!list.length) {
    h += '<div style="padding:18px;background:#f8fafc;border-radius:8px;font-size:12px;color:var(--muted);line-height:1.9">' +
      (ldVisible().length
        ? '這個月份沒有符合條件的撥款單。'
        : ldHidden()
          ? '沒有歸屬給您的房東，因此沒有可查看的撥款單。撥款單含房東帳號等資料，' +
            '需要查看請請管理者在「🏠 房東建檔 → 詳情」指定「歸屬業務」。'
          : '還沒有房東資料，無法產生撥款單。請先到「🏠 房東建檔」看怎麼補齊。') + '</div>';
    document.getElementById('po-body').innerHTML = h;
    return;
  }

  h += '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
    '<thead><tr style="background:#f8fafc;border-bottom:2px solid var(--border)">' +
    ['房東 / 館別', '類型', '租金', '服務報酬', '代墊維修', '應撥付', '狀態', ''].map(function (x, i) {
      return '<th style="padding:7px 9px;text-align:' + (i >= 2 && i <= 5 ? 'right' : (i === 7 ? 'right' : 'left')) +
        ';color:var(--muted);font-size:10px;white-space:nowrap">' + x + '</th>';
    }).join('') + '</tr></thead><tbody>' +
    list.map(function (s) {
      var rentCell = s.kind === 'bz'
        ? money(s.rentDue) + '<div style="font-size:9.5px;color:var(--muted)">保證租金</div>'
        : (s.collectRent
          ? money(s.handOver) + '<div style="font-size:9.5px;color:var(--muted)">代收實收</div>'
          : '<span style="color:var(--muted)">未代收</span>');
      var netColor = s.net > 0 ? '#1a56a0' : (s.net < 0 ? '#7048e8' : 'var(--muted)');
      return '<tr style="border-bottom:1px solid var(--border)' + (s.ovDays <= 0 ? ';opacity:.55' : '') + '">' +
        '<td style="padding:7px 9px"><strong>' + escH(s.lordName) + '</strong>' +
          '<div style="font-size:10.5px;color:var(--muted)">' + escH(s.propName) + '</div></td>' +
        '<td style="padding:7px 9px;font-size:11px;white-space:nowrap">' + escH(s.serviceType) +
          (s.ovDays <= 0 ? '<div style="font-size:9.5px;color:#c92a2a">契約未涵蓋本月</div>'
            : (s.partial ? '<div style="font-size:9.5px;color:#e67700">僅 ' + s.ovDays + '/' + s.monthDays + ' 天</div>' : '')) +
        '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' + rentCell + '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' +
          (s.kind === 'wg' ? '−' + money(s.fee) : '<span style="color:var(--muted)">—</span>') + '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' +
          (s.repairSum ? '<span style="color:#e67700">−' + money(s.repairSum) + '</span>' +
            '<div style="font-size:9.5px;color:var(--muted)">' + s.repairs.length + ' 筆</div>'
            : '<span style="color:var(--muted)">—</span>') + '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap;font-weight:700;color:' + netColor + '">' +
          money(Math.abs(s.net)) +
          (s.net < 0 ? '<div style="font-size:9.5px;font-weight:400">房東應付本公司</div>' : '') + '</td>' +
        '<td style="padding:7px 9px;font-size:11px;white-space:nowrap">' +
          (s.paid
            ? '<span style="color:#2f9e44;font-weight:700">✔ 已撥款</span>' +
              '<div style="font-size:9.5px;color:var(--muted)">' + escH((s.rec.on || '')) + '</div>'
            : (s.ovDays <= 0 ? '<span style="color:var(--muted)">無須撥款</span>'
              : '<span style="color:#e67700;font-weight:700">未撥款</span>')) + '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' +
          '<button class="btn btn-ghost sm" onclick="poPrint(' + jsArg(s.key) + ')" title="開新視窗產生可列印／存 PDF 的對帳單">🖨 撥款單</button> ' +
          '<button class="btn ' + (s.paid ? 'btn-ghost' : 'btn-primary') + ' sm" onclick="poEditOpen(' + jsArg(s.key) + ')">' +
            (s.paid ? '✏️ 修改' : '標記撥款') + '</button>' +
        '</td></tr>';
    }).join('') + '</tbody></table>' +
    '<div style="margin-top:12px;font-size:10.5px;color:var(--muted);line-height:1.85">' +
      '<strong style="color:var(--text)">金額怎麼來的</strong><br>' +
      '包租館：應撥付 ＝ 契約保證租金 − 代墊維修（未請款）。房間租不租得出去都要付，' +
      '所以這裡不看房客的收款情形。<br>' +
      '代管館：應撥付 ＝ 當月<strong>實際代收到</strong>的租金 − 服務報酬 − 代墊維修（未請款）。' +
      '報酬按比例計算時，基準是當月實收租金而不是契約月租金——房客沒繳租，業者就沒代收到錢，' +
      '這時仍收滿報酬等於要業者替房客的欠租買單。館別若未約定代收租金，則以當月應收租金為基準，' +
      '並在撥款單上標明。<br>' +
      '契約起訖落在月中時，保證租金與固定報酬按<strong>當月實際天數</strong>比例計算。<br>' +
      '代墊維修只扣維修單裡「屋主請款狀態＝未請款」且有金額的單，依完成日（未完成則依開始日）歸月。' +
      '撥款單印出來不等於房東已認帳，所以不會自動改狀態；在「標記撥款」時可一併改成「已請款」。' +
    '</div>';
  document.getElementById('po-body').innerHTML = h;
}

function poFind(key) {
  var ym = key.split('|')[1] || '';
  return poBuild(ym).find(function (s) { return s.key === key; }) || null;
}

/* ── 標記撥款 ──────────────────────────────────── */
var PO_EDIT_KEY = null;

function poEditOpen(key) {
  var s = poFind(key);
  if (!s) { alert('找不到這張撥款單，可能契約設定剛被其他成員改過，請重新開啟。'); return; }
  PO_EDIT_KEY = key;
  var r = s.rec || {};
  var inp = 'height:30px;font-size:12px;border:1px solid var(--border);border-radius:5px;padding:0 8px;width:100%;background:#fff';
  var dir = s.net < 0 ? '向房東收取' : '撥付房東';
  document.getElementById('po-ed-title').textContent = dir + ' — ' + s.lordName + '（' + s.propName + '・' + s.ym + '）';
  document.getElementById('po-ed-body').innerHTML =
    '<div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:9px 11px;' +
      'font-size:11.5px;line-height:1.8;margin-bottom:11px">' +
      '系統計算金額：<strong>' + money(Math.abs(s.net)) + '</strong>（' + dir + '）<br>' +
      '收款帳戶：' + (s.bank || s.acctNo ? escH([s.bank, s.acctName, s.acctNo].filter(Boolean).join(' / '))
        : '<span style="color:#c92a2a">契約設定裡沒填帳戶</span>') +
    '</div>' +
    '<div class="form-grid" style="gap:10px">' +
      '<div class="field"><label style="font-size:10.5px">實際金額</label>' +
        '<input type="number" id="po-ed-amt" value="' + (r.amt != null ? r.amt : Math.abs(s.net)) + '" style="' + inp + '"></div>' +
      '<div class="field"><label style="font-size:10.5px">撥款日期</label>' +
        '<input type="date" id="po-ed-on" value="' + escH(r.on || todayStr()) + '" style="' + inp + '"></div>' +
      '<div class="field"><label style="font-size:10.5px">方式</label>' +
        '<select id="po-ed-method" style="' + inp + '">' +
          PO_METHODS.map(function (m) {
            return '<option value="' + escH(m) + '"' + ((r.method || PO_METHODS[0]) === m ? ' selected' : '') + '>' + escH(m) + '</option>';
          }).join('') + '</select></div>' +
      '<div class="field"><label style="font-size:10.5px">備註</label>' +
        '<input type="text" id="po-ed-note" value="' + escH(r.note || '') + '" placeholder="差額原因、分次撥付…" style="' + inp + '"></div>' +
    '</div>' +
    (s.repairs.length
      ? '<label style="display:flex;gap:7px;align-items:flex-start;margin-top:11px;font-size:11.5px;' +
          'background:#fff3bf;border-radius:8px;padding:9px 11px;cursor:pointer;line-height:1.7">' +
          '<input type="checkbox" id="po-ed-billed" checked style="width:15px;height:15px;margin-top:2px;flex-shrink:0">' +
          '<span>同時把本單扣抵的 ' + s.repairs.length + ' 筆維修單（' + money(s.repairSum) + '）' +
          '的屋主請款狀態改為「<strong>已請款</strong>」。<br>' +
          '<span style="color:var(--muted);font-size:10.5px">不改的話下個月這幾筆會再被扣一次。' +
          '若房東還沒認帳，請取消勾選。</span></span></label>'
      : '') +
    '<div style="margin-top:10px;font-size:10.5px;color:var(--muted);line-height:1.7">' +
      '金額可以改——實際匯出去的數字才是帳。系統算的金額仍會留在撥款單上，兩者不同時單上會標出差額。</div>';
  document.getElementById('po-ed-del').style.display = s.rec ? '' : 'none';
  document.getElementById('po-ed-ov').classList.add('open');
}
function poEditClose() { document.getElementById('po-ed-ov').classList.remove('open'); PO_EDIT_KEY = null; }

function poEditSave() {
  var key = PO_EDIT_KEY;
  var s = poFind(key);
  if (!s) { alert('找不到這張撥款單，請重新開啟。'); return; }
  var amt = Number(document.getElementById('po-ed-amt').value);
  var on = document.getElementById('po-ed-on').value || '';
  if (!(amt >= 0)) { alert('金額必須是 0 或正數。'); return; }
  if (!on) { alert('請填撥款日期。'); return; }
  if (on > todayStr()) { alert('撥款日期不能是未來日期。'); return; }
  var o = poLoad();
  o[key] = {
    amt: Math.round(amt), on: on,
    method: document.getElementById('po-ed-method').value || PO_METHODS[0],
    note: (document.getElementById('po-ed-note').value || '').trim().slice(0, 300),
    calc: s.net,                                /* 當下系統算出的金額，日後要對帳查得到 */
    /* 本單扣抵了哪幾張維修單。留著才能在維修單被改成「已請款」之後，
       重印這個月的撥款單仍得到同一個金額（見 poKeepRepairs）。 */
    repairIds: s.repairs.map(function (x) { return x.id; }),
    at: new Date().toISOString(), by: Cloud.myDisplayName || Cloud.myEmail || ''
  };
  poSave(o);

  var ck = document.getElementById('po-ed-billed');
  if (ck && ck.checked && s.repairs.length) {
    var ids = {};
    s.repairs.forEach(function (x) { ids[x.id] = true; });
    var tasks = loadTasks().map(function (t) {
      if (!ids[t.id]) return t;
      return Object.assign({}, t, { billing: 'billed',
        updatedAt: new Date().toISOString(), updatedBy: Cloud.myDisplayName || Cloud.myEmail });
    });
    saveTasks(tasks);
  }
  poEditClose();
  poRender();
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}

function poEditDelete() {
  var key = PO_EDIT_KEY;
  if (!key) return;
  if (!confirm('確定要清除這張撥款單的撥款紀錄嗎？\n（金額會回到系統計算值，狀態變回「未撥款」。先前改成「已請款」的維修單不會跟著回復。）')) return;
  var o = poLoad();
  delete o[key];
  poSave(o);
  poEditClose();
  poRender();
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}

/* ── 列印用的對帳單 ────────────────────────────── */
function poBizName() {
  var sg = Cloud.get('qj_signer', {}) || {};
  return ((sg.biz && sg.biz.name) || '') || '（請到「✍️ 簽約主體設定」填公司名稱）';
}

function poPrint(key) {
  var s = poFind(key);
  if (!s) { alert('找不到這張撥款單。'); return; }
  var w = window.open('', '_blank');
  if (!w) { alert('瀏覽器阻擋了新視窗，請允許彈出視窗後再試'); return; }

  var e = escH;
  var rows = [];
  if (s.kind === 'bz') {
    rows.push(['保證租金（' + (s.partial ? s.ovDays + '/' + s.monthDays + ' 天' : '全月') + '）', s.rentDue, '']);
  } else {
    rows.push(['代收租金' + (s.collectRent ? '' : '（未約定代收，故為 0）'), s.handOver, '']);
    rows.push(['服務報酬' +
      (s.feeMode === 'fix'
        ? '（固定 ' + money(s.feeAmt) + (s.partial ? '，按 ' + s.ovDays + '/' + s.monthDays + ' 天計' : '') + '）'
        : '（' + s.feePct + '% × ' + s.baseLabel + ' ' + money(s.feeBase) + '）'),
      -s.fee, '']);
  }
  if (s.repairSum) rows.push(['代墊維修費（' + s.repairs.length + ' 筆，明細見下）', -s.repairSum, '']);

  var diff = s.rec ? (s.rec.amt - Math.abs(s.net)) : 0;

  var html = '<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">' +
    '<title>撥款單 ' + e(s.ym) + ' ' + e(s.lordName) + ' ' + e(s.propName) + '</title><style>' +
    '@page{size:A4;margin:16mm 14mm}' +
    '*{box-sizing:border-box}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Microsoft JhengHei",sans-serif;' +
      'color:#1a2535;margin:0;padding:22px;line-height:1.7;font-size:13px}' +
    '.bar{background:#e8f0fb;border-radius:8px;padding:9px 13px;font-size:12px;margin-bottom:16px}' +
    'h1{font-size:19px;margin:0 0 3px}.sub{color:#6b7a99;font-size:12px;margin-bottom:16px}' +
    'table{width:100%;border-collapse:collapse;font-size:12.5px;margin:9px 0 15px}' +
    'th,td{border:1px solid #d8dde8;padding:6px 9px;text-align:left}' +
    'th{background:#f0f4fa;white-space:nowrap}' +
    '.num{text-align:right;white-space:nowrap}' +
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
    '<div class="bar">這是系統依契約設定、租金收款台帳與維修單自動產生的對帳單。' +
      '<button onclick="window.print()" style="margin-left:8px">🖨 列印／儲存 PDF</button></div>' +
    '<h1>租金撥款對帳單</h1>' +
    '<div class="sub">' + e(s.ym.slice(0, 4)) + ' 年 ' + e(String(+s.ym.slice(5, 7))) + ' 月　｜　' +
      e(s.serviceType) + '　｜　製表日 ' + e(todayStr()) + '</div>' +

    '<table class="kv"><tr><td>出表單位</td><td>' + e(poBizName()) + '</td></tr>' +
    '<tr><td>房東</td><td>' + e(s.lordName) + '　' + e(s.lordTel) +
      (s.lordEmail ? '　' + e(s.lordEmail) : '') + '</td></tr>' +
    (s.lordMail ? '<tr><td>通訊地址</td><td>' + e(s.lordMail) + '</td></tr>' : '') +
    '<tr><td>標的</td><td>' + e(s.propName) + '（' + s.rooms + ' 間房）</td></tr>' +
    '<tr><td>契約期間</td><td>' + e(s.term.from || '未填') + ' ～ ' + e(s.term.to || '未填') +
      (s.partial ? '（本月僅 ' + s.ovDays + '/' + s.monthDays + ' 天在契約期間內）' : '') + '</td></tr>' +
    (s.payDay ? '<tr><td>約定付款日</td><td>每月 ' + e(s.payDay) + ' 日前</td></tr>' : '') +
    '</table>' +

    '<h2>結算明細</h2>' +
    '<table><tr><th>項目</th><th class="num">金額（元）</th></tr>' +
    rows.map(function (r) {
      return '<tr><td>' + e(r[0]) + '</td><td class="num">' +
        (r[1] < 0 ? '−' + money(-r[1]) : money(r[1])) + '</td></tr>';
    }).join('') +
    '<tr class="tot"><td>' + (s.net < 0 ? '房東應付出表單位' : '本期應撥付房東') +
      '</td><td class="num">' + money(Math.abs(s.net)) + '</td></tr></table>';

  if (s.repairs.length) {
    html += '<h2>代墊維修明細</h2><table>' +
      '<tr><th>日期</th><th>房號</th><th>項目</th><th class="num">金額</th><th>狀態</th></tr>' +
      s.repairs.map(function (x) {
        return '<tr><td>' + e(x.date) + '</td><td>' + e(x.room) + '</td>' +
          '<td>' + e((x.cat ? '[' + x.cat + '] ' : '') + (x.note || '—')) + '</td>' +
          '<td class="num">' + money(x.cost) + '</td>' +
          '<td>' + (x.closed ? '已完成' : '處理中') + '</td></tr>';
      }).join('') + '</table>';
  }

  if (s.kind === 'wg' && s.rentRows.length) {
    html += '<h2>租金收取明細</h2><table>' +
      '<tr><th>房號</th><th>房客</th><th>期間</th><th class="num">應收</th>' +
      '<th class="num">實收</th><th>收款日</th></tr>' +
      s.rentRows.map(function (x) {
        return '<tr><td>' + e(x.room) + '</td><td>' + e(x.guest) + '</td>' +
          '<td>' + e(x.from) + '～' + e(x.to) + '</td>' +
          '<td class="num">' + money(x.due) + '</td>' +
          '<td class="num">' + (x.inPaid ? money(x.amt) : '—') + '</td>' +
          '<td>' + e(x.on || '未收') + '</td></tr>';
      }).join('') +
      '<tr class="tot"><td colspan="3">合計</td><td class="num">' + money(s.dueTotal) +
      '</td><td class="num">' + money(s.handOver) + '</td><td></td></tr></table>' +
      '<div style="font-size:11px;color:#6b7a99">應收依計費起日歸月，實收依收款日歸月，' +
      '因此兩欄的筆數可能不同（例如上月的租金這個月才收到）。</div>';
  }

  html += '<h2>撥款資訊</h2><table class="kv">' +
    '<tr><td>收款帳戶</td><td>' +
      ((s.bank || s.acctNo) ? e([s.bank, s.acctName, s.acctNo].filter(Boolean).join('　')) : '契約設定未填') +
    '</td></tr>' +
    (s.rec
      ? '<tr><td>撥款日</td><td>' + e(s.rec.on || '') + '　' + e(s.rec.method || '') + '</td></tr>' +
        '<tr><td>實際金額</td><td>' + money(s.rec.amt) +
          (diff ? '（與系統計算相差 ' + (diff > 0 ? '+' : '−') + money(Math.abs(diff)) + '）' : '') + '</td></tr>' +
        (s.rec.note ? '<tr><td>備註</td><td>' + e(s.rec.note) + '</td></tr>' : '') +
        '<tr><td>經手人</td><td>' + e(s.rec.by || '') + '</td></tr>'
      : '<tr><td>撥款狀態</td><td>尚未撥款</td></tr>') +
    '</table>' +

    '<div class="sign"><div>出表單位（簽章）</div><div>房東簽收</div></div>' +

    '<div class="foot">' +
      (s.kind === 'bz'
        ? '本單為包租契約之保證租金結算：不論房間是否出租，出表單位均依契約支付約定租金。'
        : '本單為委託管理契約之代收代付結算：服務報酬以' + e(s.baseLabel) + '為計算基準。') +
      '<br>代墊維修費為出表單位先行支付給廠商、依契約應由房東負擔之費用，自本期撥款中扣抵。' +
      '<br>如對本單任何項目有疑義，請於收到後十日內提出，以便查核更正。' +
    '</div></body></html>';

  w.document.write(html);
  w.document.close();
}
