/* ══════════════════════════════════════════════════════════════════
   租金收款台帳
   ------------------------------------------------------------------
   原本訂單只有「預定中／已付款待入住」這種一次性狀態，但月租一住就是
   好幾個月、每個月都要收一次租，系統裡完全沒有「第 3 期收了嗎」的概念。
   這支模組補的就是這一段。

   設計原則：**繳租期數一律從租期推導，不另外建檔**。
   期數 = 起租日每月同一天切一期，應收金額由月租金決定——這些全部是
   既有訂單欄位算得出來的。只有「實際收了多少、哪天收的」才存進 KV。
   這樣做的好處是續約延長退房日、改期、換房之後，台帳會自動跟著長出
   新期數，不會出現「租約改了但帳還是舊的」這種對不起來的狀況。

   金額算法刻意與訂單的「總租金」不同，要注意：
   訂單 totalRent 用 calcRent() 的日計法（月租 ÷ 30 × 天數），滿 31 天
   的月份會算成 1.033 個月的租金；但實務上收租是「一個月就收一個月」，
   不會因為這個月有 31 天就多收。所以台帳的滿月期數一律收足月租，只有
   最後不滿一個月的尾款才按日計。兩邊因此可能差幾十元，台帳才是收款依據。
   ══════════════════════════════════════════════════════════════════ */

var RL_KV      = 'qj_rent';      /* { 期數key: {amt,on,method,note,at,by} } */
var RL_KV_CFG  = 'qj_rent_cfg';  /* { graceDays } */
var RL_METHODS = ['匯款／轉帳', '現金', '信用卡', '支票', '其他'];

/* 寬限天數：租金到期當天就判逾期的話，每個房客在繳款日都會先紅一次，
   待辦會長期掛著一堆其實還在正常繳款流程中的項目，提醒就失去意義。 */
function rlCfg() {
  var c = Cloud.get(RL_KV_CFG, {}) || {};
  var n = parseInt(c.graceDays, 10);
  return { graceDays: (n >= 0 && n <= 30) ? n : 3 };
}
function rlSetGrace(v) {
  /* 寬限天數決定「哪些期數算逾期」，整間公司共用一個值，所以是管理者的設定。
     擋下來要順便 rlRender() 把輸入框重畫回原值，否則畫面上會留著改過的數字。
     typeof 判斷是因為 tenant.html 也載這支檔案，那裡沒有 adminOnly。 */
  if (typeof adminOnly === 'function' && !adminOnly('調整租金的寬限天數')) {
    if (document.getElementById('rl-grace')) rlRender();   // 畫面還沒建起來時不要重畫
    return;
  }
  var n = parseInt(v, 10);
  if (!(n >= 0)) n = 0;
  if (n > 30) n = 30;
  Cloud.set(RL_KV_CFG, { graceDays: n });
  rlRender();
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}

function rlLoad() { return Cloud.get(RL_KV, {}) || {}; }
function rlSave(o) { Cloud.set(RL_KV, o); }

/* 期數的識別碼。刻意不用 segments 的陣列索引：段落會因為新增／刪除
   同組房間而整排位移，用索引當 key 的話收款紀錄就會對到別的房間去。
   改用「訂單＋館別＋房號＋該期起日」，這四個值只要租約沒變就不會變。 */
function rlKey(bkId, propId, room, from) {
  return [bkId, propId, room, from].join('|');
}

/* 加 n 個月。日期一律以起租日的「日」為基準往後推，不是拿上一期的結果
   再加一個月——後者遇到 1/31 → 2/28 之後會一路變成 3/28、4/28，整份
   台帳的繳款日就漂掉了。當月沒有那一天時（如 2/31）取該月最後一天。 */
function rlAddMonths(s, n) {
  var p = String(s).split('-');
  var y = +p[0], m = +p[1], d = +p[2];
  var t = m - 1 + n;
  y += Math.floor(t / 12);
  m = ((t % 12) + 12) % 12 + 1;
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) d = last;
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/* 把一個租期段落展開成各期應收 */
function rlPeriods(seg) {
  if (!seg || !seg.checkin || !seg.checkout) return [];
  if ((seg.status || 'reserved') === 'cancelled') return [];
  var mp = Number(seg.monthlyPrice) || 0;
  if (mp <= 0) return [];
  var out = [], k = 0;
  while (k < 600) { /* 上限純粹防呆，600 期 ＝ 50 年 */
    var from = k === 0 ? seg.checkin : rlAddMonths(seg.checkin, k);
    if (from >= seg.checkout) break;
    var nxt = rlAddMonths(seg.checkin, k + 1);
    var full = nxt <= seg.checkout;
    var to = full ? nxt : seg.checkout;
    var days = diffDays(from, to);
    out.push({
      no: k + 1, from: from, to: to, days: days, full: full,
      due: Math.round(full ? mp : days * (mp / 30))
    });
    k++;
  }
  return out;
}

/* 全部訂單 × 全部段落 × 全部期數，附上收款狀態。
   狀態：future 尚未到期｜unpaid 未收｜overdue 逾期｜partial 部分收款｜paid 已收 */
function rlBuild() {
  var tod = todayStr();
  var grace = rlCfg().graceDays;
  var recs = rlLoad();
  var props = getAllProps();
  var pn = function (pid) {
    var p = props.find(function (x) { return String(x.id) === String(pid); });
    return p ? p.name : '（已刪除館別）';
  };
  var rows = [];
  loadBks().forEach(function (b) {
    /* 匯入的歷史訂單（b.imported 記著來源，如 '2026月報'）不進台帳。
       那些租金當年是在系統外收的，系統裡永遠不會有對應的收款紀錄，
       留著只會讓每一期都算成逾期——匯入一年的歷史就是上千筆假逾期，
       待辦被灌爆之後真正該催的那幾筆就被埋掉了，提醒等於失效。
       它們仍然是真訂單：入住率、營業額、訂單數、行事曆、房況都照算，
       只有「拿系統收款／結算」這件事對它們沒有意義。 */
    if (b.imported) return;
    (b.segments || []).forEach(function (s) {
      rlPeriods(s).forEach(function (pd) {
        var key = rlKey(b.id, s.prop_id, s.room, pd.from);
        var r = recs[key] || null;
        var amt = r ? (Number(r.amt) || 0) : 0;
        var st;
        if (amt >= pd.due && pd.due > 0) st = 'paid';
        else if (amt > 0) st = 'partial';
        else if (pd.from > tod) st = 'future';
        else st = (diffDays(pd.from, tod) > grace) ? 'overdue' : 'unpaid';
        rows.push({
          key: key, bkId: b.id, guest: b.guest || '(未命名)', phone: b.phone || '',
          propId: s.prop_id, propName: pn(s.prop_id), room: s.room || '',
          no: pd.no, from: pd.from, to: pd.to, days: pd.days, full: pd.full,
          due: pd.due, amt: amt, rec: r, status: st,
          over: st === 'overdue' ? diffDays(pd.from, tod) - grace : 0
        });
      });
    });
  });
  return rows.sort(function (a, b) {
    return a.from.localeCompare(b.from) || a.guest.localeCompare(b.guest);
  });
}

var RL_ST = {
  future:  { label: '尚未到期', color: '#868e96', bg: '#f1f3f5' },
  unpaid:  { label: '未收',     color: '#e67700', bg: '#fff3bf' },
  overdue: { label: '逾期',     color: '#c92a2a', bg: '#fff5f5' },
  partial: { label: '部分收款', color: '#1971c2', bg: '#e7f5ff' },
  paid:    { label: '已收',     color: '#2f9e44', bg: '#ebfbee' }
};

/* 給今日待辦用：只回逾期未收足的期數 */
function rlOverdue() {
  return rlBuild().filter(function (r) {
    return r.status === 'overdue' || (r.status === 'partial' && r.from <= todayStr());
  }).sort(function (a, b) { return b.over - a.over || a.from.localeCompare(b.from); });
}

/* 給資料匯出用 */
function rlExportRows() {
  return rlBuild().map(function (r) {
    return {
      訂單編號: r.bkId, 客戶姓名: r.guest, 電話: r.phone,
      館別: r.propName, 房號: r.room, 期數: r.no,
      計費起日: r.from, 計費迄日: r.to, 天數: r.days,
      是否滿月: r.full ? '是' : '否（按日計）',
      應收金額: r.due, 實收金額: r.amt,
      收款狀態: RL_ST[r.status].label,
      收款日: r.rec ? (r.rec.on || '') : '',
      收款方式: r.rec ? (r.rec.method || '') : '',
      備註: r.rec ? (r.rec.note || '') : '',
      經手人: r.rec ? (r.rec.by || '') : ''
    };
  });
}

/* ══════════════════════════════════════════════════════════════════
   UI
   ══════════════════════════════════════════════════════════════════ */
var RL_UI_READY = false;
var RL_EDIT_KEY = null;

function rlEnsureUI() {
  if (RL_UI_READY) return;
  RL_UI_READY = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="overlay" id="rl-ov" onclick="if(event.target===this)closeRent()">' +
    '<div class="modal" style="width:1080px;max-width:98vw">' +
    '<div class="modal-h"><h2 id="rl-title">💰 租金收款</h2>' +
    '<button class="close-btn" onclick="closeRent()">✕</button></div>' +
    '<div style="padding:10px 17px 4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<select class="sel" id="rl-f-status" onchange="rlRender()">' +
        '<option value="due">待收（未收／逾期／部分）</option>' +
        '<option value="overdue">只看逾期</option>' +
        '<option value="paid">已收</option>' +
        '<option value="future">尚未到期</option>' +
        '<option value="">全部</option>' +
      '</select>' +
      '<select class="sel" id="rl-f-prop" onchange="rlRender()"><option value="">全部館別</option></select>' +
      '<input class="sel" id="rl-f-month" type="month" onchange="rlRender()" style="width:140px" title="依計費起日篩選月份">' +
      '<input class="sel" id="rl-search" type="text" placeholder="搜尋客戶／房號／電話" oninput="rlRender()" style="width:180px">' +
      '<button class="btn btn-ghost sm" onclick="rlClearFilters()">清除條件</button>' +
    '</div>' +
    '<div class="modal-body" style="max-height:66vh;overflow-y:auto" id="rl-body"></div>' +
    '<div class="modal-f">' +
      '<div style="font-size:11px;color:var(--muted);flex:1;display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<span>逾期寬限</span>' +
        '<input type="number" min="0" max="30" step="1" id="rl-grace" onchange="rlSetGrace(this.value)" ' +
          'style="width:52px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;font-size:11px">' +
        '<span>天後才算逾期（設 0 ＝ 到期當天就算）</span>' +
      '</div>' +
      '<button class="btn btn-ghost" onclick="closeRent()">關閉</button>' +
    '</div></div></div>' +

    '<div class="overlay" id="rl-ed-ov" onclick="if(event.target===this)rlEditClose()">' +
    '<div class="modal" style="width:420px;max-width:96vw">' +
    '<div class="modal-h"><h2 id="rl-ed-title">收款紀錄</h2>' +
    '<button class="close-btn" onclick="rlEditClose()">✕</button></div>' +
    '<div class="modal-body" id="rl-ed-body"></div>' +
    '<div class="modal-f">' +
      '<div style="flex:1"><button class="btn btn-danger sm" id="rl-ed-del" onclick="rlEditDelete()">🗑 清除此筆收款</button></div>' +
      '<button class="btn btn-ghost" onclick="rlEditClose()">取消</button>' +
      '<button class="btn btn-primary" onclick="rlEditSave()">💾 儲存</button>' +
    '</div></div></div>');
}

/* bkId 有值時＝從訂單按「繳租紀錄」進來，自動把條件縮到這筆訂單 */
function openRent(bkId) {
  rlEnsureUI();
  document.getElementById('rl-f-prop').innerHTML = '<option value="">全部館別</option>' +
    getAllProps().map(function (p) {
      return '<option value="' + escH(p.id) + '">' + escH(p.name) + '</option>';
    }).join('');
  document.getElementById('rl-grace').value = rlCfg().graceDays;
  if (bkId) {
    var bk = loadBks().find(function (b) { return String(b.id) === String(bkId); });
    document.getElementById('rl-f-status').value = '';
    document.getElementById('rl-f-prop').value = '';
    document.getElementById('rl-f-month').value = '';
    document.getElementById('rl-search').value = bk ? (bk.guest || bk.id) : String(bkId);
  }
  rlRender();
  document.getElementById('rl-ov').classList.add('open');
}
function closeRent() {
  document.getElementById('rl-ov').classList.remove('open');
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}
function rlClearFilters() {
  document.getElementById('rl-f-status').value = 'due';
  document.getElementById('rl-f-prop').value = '';
  document.getElementById('rl-f-month').value = '';
  document.getElementById('rl-search').value = '';
  rlRender();
}

function rlFiltered(all) {
  var fs = document.getElementById('rl-f-status').value;
  var fp = document.getElementById('rl-f-prop').value;
  var fm = document.getElementById('rl-f-month').value;
  var kw = (document.getElementById('rl-search').value || '').trim().toLowerCase();
  return all.filter(function (r) {
    if (fs === 'due' && !(r.status === 'unpaid' || r.status === 'overdue' || r.status === 'partial')) return false;
    if (fs === 'overdue' && r.status !== 'overdue') return false;
    if (fs === 'paid' && r.status !== 'paid') return false;
    if (fs === 'future' && r.status !== 'future') return false;
    if (fp && String(r.propId) !== fp) return false;
    if (fm && r.from.slice(0, 7) !== fm) return false;
    if (kw) {
      var hay = (r.guest + ' ' + r.phone + ' ' + r.room + ' ' + r.propName + ' ' + r.bkId).toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });
}

function rlRender() {
  var all = rlBuild();
  var list = rlFiltered(all);
  var tod = todayStr(), ym = tod.slice(0, 7);

  /* 統計卡一律看「本月」且不受上方篩選影響：篩選是用來找人的，
     本月該收多少、收了多少是固定要回答的問題，不該被條件改掉。 */
  var mRows = all.filter(function (r) { return r.from.slice(0, 7) === ym; });
  var mDue = 0, mGot = 0;
  mRows.forEach(function (r) { mDue += r.due; mGot += Math.min(r.amt, r.due); });
  var odRows = all.filter(function (r) { return r.status === 'overdue'; });
  var odAmt = 0;
  odRows.forEach(function (r) { odAmt += r.due - r.amt; });

  var card = function (lbl, val, color, note) {
    return '<div style="flex:1;min-width:132px;background:#fff;border:1px solid var(--border);' +
      'border-radius:8px;padding:9px 11px">' +
      '<div style="font-size:10px;color:var(--muted)">' + lbl + '</div>' +
      '<div style="font-size:17px;font-weight:800;color:' + color + ';margin:1px 0">' + val + '</div>' +
      '<div style="font-size:9.5px;color:var(--muted)">' + note + '</div></div>';
  };
  var h = '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px">' +
    card('本月應收', money(mDue), 'var(--primary)', ym + '　共 ' + mRows.length + ' 期') +
    card('本月已收', money(mGot), '#2f9e44',
      mDue > 0 ? '收款率 ' + Math.round(mGot / mDue * 100) + '%' : '—') +
    card('本月未收', money(mDue - mGot), (mDue - mGot) > 0 ? '#e67700' : '#868e96', '含部分收款的差額') +
    card('逾期未收', money(odAmt), odRows.length > 0 ? '#c92a2a' : '#868e96',
      '共 ' + odRows.length + ' 期（不限月份）') +
    '</div>';

  h += '<div style="font-size:11px;color:var(--muted);line-height:1.7;background:var(--primary-light);' +
    'border-radius:8px;padding:9px 12px;margin-bottom:11px">' +
    '繳租期數是<strong>依租期自動展開</strong>的，不需要手動建立：以起租日為每月繳款日切期，' +
    '滿一個月收足月租、最後不滿一個月的尾款按日計。續約延長退房日之後，新的期數會自己長出來。<br>' +
    '這裡的合計與訂單的「總租金」可能差幾十元：訂單總額是用「月租 ÷ 30 × 天數」估的，' +
    '遇到 31 天的月份會多算一天；<strong>實際收款請以本表為準</strong>。' +
    '</div>';

  /* 匯入的歷史訂單被 rlBuild() 擋在外面。這件事一定要講出來：
     訂單清單有 800 多筆、台帳卻是空的，不解釋就是一個看起來壞掉的畫面。 */
  var impN = loadBks().filter(function (b) { return !!b.imported; }).length;
  if (impN > 0) {
    h += '<div style="font-size:11px;color:var(--muted);line-height:1.7;background:#fff8e1;' +
      'border:1px solid #ffe08a;border-radius:8px;padding:9px 12px;margin-bottom:11px">' +
      '另有 <strong>' + impN + '</strong> 筆<strong>匯入的歷史訂單不列入台帳</strong>' +
      '（它們的租金當年是在系統外收的，系統裡沒有收款紀錄，全列進來會變成上千筆假逾期）。' +
      '這些訂單仍然照算入住率、營業額與訂單數。' +
      '</div>';
  }

  document.getElementById('rl-title').textContent = '💰 租金收款 — 符合條件 ' + list.length + ' 期';

  if (list.length === 0) {
    h += '<div style="text-align:center;padding:30px;color:var(--muted);font-size:12px">' +
      '沒有符合條件的繳租期數。<br><span style="font-size:11px">' +
      '台帳只會展開「月租金大於 0 且有填入住／退房日」的訂單段落，已取消的段落不列入。</span></div>';
    document.getElementById('rl-body').innerHTML = h;
    return;
  }

  h += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;min-width:940px">' +
    '<thead><tr style="position:sticky;top:0;background:#f8fafc;border-bottom:2px solid var(--border);z-index:1">' +
    ['客戶', '館別 / 房號', '期', '計費期間', '應收', '實收', '收款資訊', '狀態', ''].map(function (x, i) {
      return '<th style="padding:8px 9px;text-align:' + (i === 4 || i === 5 ? 'right' : (i === 8 ? 'right' : 'left')) +
        ';color:var(--muted);font-size:10px;white-space:nowrap">' + x + '</th>';
    }).join('') + '</tr></thead><tbody>' +
    list.map(function (r) {
      var st = RL_ST[r.status];
      var k = jsArg(r.key);
      var acts = '';
      if (r.status === 'paid') {
        acts = '<button class="btn btn-ghost sm" onclick="rlEditOpen(' + k + ')">✎ 修改</button>';
      } else {
        acts = '<button class="btn btn-primary sm" onclick="rlMark(' + k + ')" ' +
          'title="以應收金額、今天的日期記一筆收款">✓ ' + (r.status === 'partial' ? '補足' : '標記已收') + '</button>' +
          ' <button class="btn btn-ghost sm" onclick="rlEditOpen(' + k + ')" title="自行填寫金額、日期與方式">✎</button>';
      }
      return '<tr style="border-bottom:1px solid var(--border)' + (r.status === 'paid' ? ';opacity:.7' : '') + '">' +
        '<td style="padding:7px 9px"><a href="javascript:void(0)" onclick="rlOpenBk(' + jsArg(r.bkId) + ')" ' +
          'style="color:#1a56a0;font-weight:700">' + escH(r.guest) + '</a>' +
          (r.phone ? '<div style="font-size:9.5px;color:var(--muted)">' + escH(r.phone) + '</div>' : '') + '</td>' +
        '<td style="padding:7px 9px;font-size:11px">' + escH(r.propName) +
          '<div style="font-weight:700;color:var(--primary)">' + escH(r.room) + '</div></td>' +
        '<td style="padding:7px 9px;white-space:nowrap;font-weight:700">第 ' + r.no + ' 期</td>' +
        '<td style="padding:7px 9px;white-space:nowrap;font-size:11px">' + escH(r.from) + ' ～ ' + escH(r.to) +
          '<div style="font-size:9.5px;color:var(--muted)">' + r.days + ' 天' +
          (r.full ? '（滿月）' : '（按日計）') + '</div></td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap;font-weight:700">' + money(r.due) + '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap;color:' +
          (r.amt > 0 ? '#2f9e44' : 'var(--muted)') + '">' + (r.amt > 0 ? money(r.amt) : '—') +
          (r.status === 'partial' ? '<div style="font-size:9.5px;color:#c92a2a">尚差 ' +
            money(r.due - r.amt) + '</div>' : '') + '</td>' +
        '<td style="padding:7px 9px;font-size:10.5px;color:var(--muted)">' +
          (r.rec ? (escH(r.rec.on || '') + (r.rec.method ? '　' + escH(r.rec.method) : '') +
            (r.rec.note ? '<div>' + escH(r.rec.note) + '</div>' : '') +
            (r.rec.by ? '<div style="font-size:9px">經手：' + escH(r.rec.by) + '</div>' : '')) : '—') + '</td>' +
        '<td style="padding:7px 9px;white-space:nowrap">' +
          '<span style="display:inline-block;padding:2px 7px;border-radius:99px;font-size:10px;font-weight:700;' +
          'background:' + st.bg + ';color:' + st.color + '">' + st.label + '</span>' +
          (r.status === 'overdue' ? '<div style="font-size:9.5px;color:#c92a2a;font-weight:700">逾 ' +
            r.over + ' 天</div>' : '') + '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' + acts + '</td>' +
      '</tr>';
    }).join('') + '</tbody></table></div>';

  document.getElementById('rl-body').innerHTML = h;
}

function rlOpenBk(id) {
  var bk = loadBks().find(function (b) { return String(b.id) === String(id); });
  closeRent();
  if (!bk) { alert('這筆訂單已不存在，可能已被其他成員刪除。'); return; }
  openEditBk(bk);
}

function rlFind(key) {
  return rlBuild().find(function (r) { return r.key === key; }) || null;
}

/* 一鍵記收：金額＝應收、日期＝今天。最常見的情境就是這個，
   不該為了「照帳單金額收款」還要開一次表單填四個欄位。 */
function rlMark(key) {
  var r = rlFind(key);
  if (!r) { alert('找不到這期資料，可能租約剛被其他成員改過，請重新開啟。'); return; }
  var o = rlLoad();
  var prev = o[key] || null;
  var note = (prev && prev.note) || '';
  /* 從「部分收款」按補足時，一筆紀錄只存得下一個金額與一個日期，
     舊備註（例如「少收 5000 已協議」）留著會與補足後的全額互相矛盾。
     把前一次的實收金額與日期併進備註，紀錄才讀得通、也不會遺失軌跡。 */
  if (prev && Number(prev.amt) > 0 && Number(prev.amt) < r.due) {
    note = ('原收 ' + money(prev.amt) + (prev.on ? '（' + prev.on + '）' : '') +
            (note ? '：' + note : '') + '，本次補足').slice(0, 300);
  }
  o[key] = {
    amt: r.due, on: todayStr(), method: (prev && prev.method) || RL_METHODS[0],
    note: note,
    at: new Date().toISOString(), by: Cloud.myDisplayName || Cloud.myEmail || ''
  };
  rlSave(o);
  rlRender();
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}

function rlEditOpen(key) {
  var r = rlFind(key);
  if (!r) { alert('找不到這期資料，可能租約剛被其他成員改過，請重新開啟。'); return; }
  RL_EDIT_KEY = key;
  var rec = r.rec || {};
  document.getElementById('rl-ed-title').textContent =
    '收款紀錄 · ' + r.guest + ' 第 ' + r.no + ' 期';
  document.getElementById('rl-ed-body').innerHTML =
    '<div style="font-size:11px;color:var(--muted);line-height:1.8;background:var(--primary-light);' +
      'border-radius:7px;padding:9px 11px;margin-bottom:12px">' +
      escH(r.propName) + ' ' + escH(r.room) + '<br>' +
      '計費期間 ' + escH(r.from) + ' ～ ' + escH(r.to) + '（' + r.days + ' 天' +
      (r.full ? '，滿月' : '，按日計') + '）<br>' +
      '<strong>應收 ' + money(r.due) + '</strong>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">' +
      '<div><label style="font-size:11px;color:var(--muted)">實收金額</label>' +
        '<input id="rl-ed-amt" type="number" min="0" step="1" value="' +
        escH(rec.amt != null ? rec.amt : r.due) + '" style="width:100%;padding:6px 8px;' +
        'border:1px solid var(--border);border-radius:5px;font-size:13px"></div>' +
      '<div><label style="font-size:11px;color:var(--muted)">收款日期</label>' +
        '<input id="rl-ed-on" type="date" value="' + escH(rec.on || todayStr()) + '" ' +
        'style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:5px;font-size:13px"></div>' +
    '</div>' +
    '<div style="margin-top:9px"><label style="font-size:11px;color:var(--muted)">收款方式</label>' +
      '<select id="rl-ed-method" style="width:100%;padding:6px 8px;border:1px solid var(--border);' +
      'border-radius:5px;font-size:13px">' +
      RL_METHODS.map(function (m) {
        return '<option value="' + escH(m) + '"' + (rec.method === m ? ' selected' : '') + '>' + escH(m) + '</option>';
      }).join('') + '</select></div>' +
    '<div style="margin-top:9px"><label style="font-size:11px;color:var(--muted)">備註</label>' +
      '<input id="rl-ed-note" type="text" value="' + escH(rec.note || '') + '" ' +
      'placeholder="例如：匯款末五碼 12345、少收 500 元已協議" ' +
      'style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:5px;font-size:13px"></div>' +
    '<div style="margin-top:10px;font-size:10.5px;color:var(--muted);line-height:1.7">' +
      '實收小於應收時會標記為「部分收款」並顯示尚差金額；填 0 等於沒收到款。' +
      (rec.by ? '<br>上次由 ' + escH(rec.by) + ' 於 ' + escH((rec.at || '').slice(0, 10)) + ' 記錄。' : '') +
    '</div>';
  document.getElementById('rl-ed-del').style.display = r.rec ? '' : 'none';
  document.getElementById('rl-ed-ov').classList.add('open');
}
function rlEditClose() {
  document.getElementById('rl-ed-ov').classList.remove('open');
  RL_EDIT_KEY = null;
}
function rlEditSave() {
  if (!RL_EDIT_KEY) return;
  var amt = parseFloat(document.getElementById('rl-ed-amt').value);
  if (!(amt >= 0)) { alert('請填寫實收金額（可填 0）'); return; }
  var on = document.getElementById('rl-ed-on').value;
  if (!on) { alert('請選擇收款日期'); return; }
  var o = rlLoad();
  o[RL_EDIT_KEY] = {
    amt: Math.round(amt), on: on,
    method: document.getElementById('rl-ed-method').value,
    note: (document.getElementById('rl-ed-note').value || '').trim(),
    at: new Date().toISOString(), by: Cloud.myDisplayName || Cloud.myEmail || ''
  };
  rlSave(o);
  rlEditClose();
  rlRender();
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}
function rlEditDelete() {
  if (!RL_EDIT_KEY) return;
  if (!confirm('確定清除這一期的收款紀錄？\n清除後這期會回到「未收」狀態。')) return;
  var o = rlLoad();
  delete o[RL_EDIT_KEY];
  rlSave(o);
  rlEditClose();
  rlRender();
  if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
}
