/* ══════════════════════════════════════════════════════════════════
   月損益總表
   ------------------------------------------------------------------
   系統裡已經有租金收款台帳、房東撥款單、維修單、退房結算，每一張都算得很細，
   但沒有任何一張回答老闆每個月真正在問的那一句：「這個月到底賺多少？」
   這支模組不新增任何輸入，只把現有資料擺成一張損益表。

   四個會決定數字對不對的會計決定：

   ① **代管館代收的房客租金不是公司營收。**
      那筆錢進來、扣掉服務報酬後要原封轉付房東，公司從頭到尾只賺到報酬。
      把代收租金算成營收會讓營業額虛增好幾倍——這是整張表最容易錯、
      錯了也最難發現的一個地方（因為每個數字看起來都「有根據」）。
      所以代管館的營收一律只取服務報酬，代收的部分另列「代收轉付」。

   ② **包租館的營收是房客租金、成本是保證租金。**
      兩者相減自然把空置損失顯示出來：房間租不出去，保證租金照付。
      這正是包租模式唯一需要盯的數字，也是這張表存在的理由。

   ③ **只有「自行吸收」的維修費是公司成本。**
      屋主請款狀態＝未請款／已請款的，會在撥款單裡向房東扣回；
      房客自行負擔的，會在退房結算時從押金扣抵。兩者對公司都是收支兩平，
      列入成本等於把別人付的錢算成自己的損失。

   ④ **全部採權責發生制（應收應付），不是現金收付制。**
      房客租金以「計費起日」歸月，保證租金以契約涵蓋天數歸月。
      這樣同一個月的收入與成本才對得上同一段期間。實收金額另外列出來，
      它要回答的是「錢有沒有進來」，是現金流的問題，不是損益的問題。

   金額算法與房東撥款單共用 poPropMoney()／poRentByProp()，不另寫一套——
   兩張表只要差一塊錢，業者就不會再相信其中任何一張。

   ⚠️ 這張表刻意不自稱「財務報表」：清潔成本、人事、公用水電、稅捐、
   行銷等間接費用系統裡根本沒有欄位可以填，所以表上永遠會把這件事寫明，
   而不是靜靜地顯示一個看起來很漂亮的淨額。
   ══════════════════════════════════════════════════════════════════ */
'use strict';

/* 當月維修費，依館別、依「費用歸屬」分桶。
   歸月與撥款單一致，用「完成日，沒有就用開始日」：錢往往是叫修當下就付了。
   清潔單不計入——tkCost() 對清潔一律回 0，系統沒有欄位可以填清潔成本，
   這件事會在表上寫明，不會被當成 0 元混進淨額裡。 */
function pnlRepairByProp(ym) {
  var rg = poRange(ym);
  var out = {};
  loadTasks().forEach(function (t) {
    if (t.type !== 'repair') return;
    var c = tkCost(t);
    if (!(c > 0)) return;
    var d = t.doneAt || t.start || '';
    if (!(d >= rg.from && d < rg.toEx)) return;
    var pid = String(t.prop_id);
    var o = out[pid] || (out[pid] = { self: 0, lord: 0, tenant: 0, n: 0 });
    /* 沒填 billing 的舊單視為自行吸收，與維修追蹤的統計同一套判斷 */
    var bl = t.billing || 'none';
    if (bl === 'unbilled' || bl === 'billed') o.lord += c;
    else if (bl === 'tenant') o.tenant += c;
    else o.self += c;
    o.n++;
  });
  return out;
}

function pnlEmptyRep() { return { self: 0, lord: 0, tenant: 0, n: 0 }; }

/* 一個月份的損益，依館別一列。
   刻意走 getAllProps() ＋ qj_cdata 而不是 ldIndex()：後者會跳過「還沒填房東
   電話」的包租／代管館別，那些館別的保證租金照樣要付、租金照樣在收，
   從損益表漏掉會讓淨額虛高。房東有沒有建檔是撥款單的前提，不是損益的前提。 */
function pnlBuild(ym) {
  var rg = poRange(ym);
  var rent = poRentByProp(ym);
  var rep = pnlRepairByProp(ym);
  var cd = Cloud.get('qj_cdata', {}) || {};
  var rows = [], noLordCnt = 0;
  var warnRent = [], warnFee = [];
  var seen = {};

  getAllProps().forEach(function (p) {
    var pid = String(p.id);
    seen[pid] = true;
    var b = ldBrief(p, cd[pid] || {});
    var R = rent[pid] || { collected: 0, due: 0, rows: [] };
    var P = rep[pid] || pnlEmptyRep();
    var row = {
      propId: pid, propName: b.name || '(未命名館別)', rooms: b.rooms,
      kind: b.kind || 'own',
      serviceType: b.kind ? b.serviceType : '自有房源',
      rentDue: R.due, rentGot: R.collected,
      rev: 0, revLabel: '', lordCost: 0, passRent: 0,
      repairSelf: P.self, repairLord: P.lord, repairTenant: P.tenant, repairN: P.n,
      ovDays: rg.days, partial: false, monthDays: rg.days,
      term: { from: b.from, to: b.to }, deleted: false
    };

    if (b.kind) {
      /* 代墊維修傳 0：那筆錢會向房東收回，不是公司的損益。
         撥款單傳的是實際代墊金額（它要算的是「這個月該匯多少給房東」）。 */
      var M = poPropMoney(b, R, 0, rg);
      row.ovDays = M.ovDays;
      row.partial = M.partial;
      if (b.kind === 'bz') {
        row.rev = R.due;
        row.revLabel = '房客租金（應收）';
        row.lordCost = M.rentDue;
        /* 契約有涵蓋本月卻沒填月租金 → 成本被低估，淨額會虛高 */
        if (M.ovDays > 0 && !(b.rent > 0)) warnRent.push(row.propName);
      } else {
        row.rev = M.fee;
        row.revLabel = '服務報酬';
        row.passRent = M.handOver;
        row.feeMode = b.feeMode;
        row.feePct = b.feePct;
        row.feeAmt = b.feeAmt;
        row.feeBase = M.feeBase;
        row.baseLabel = M.baseLabel;
        row.collectRent = b.collectRent;
        if (M.ovDays > 0 && !(b.feeMode === 'fix' ? b.feeAmt > 0 : b.feePct > 0))
          warnFee.push(row.propName);
      }
      if (!ldKey(((cd[pid] || {}).owner || {}).tel)) noLordCnt++;
    } else {
      row.rev = R.due;
      row.revLabel = '房客租金（應收）';
    }

    row.cost = row.lordCost + row.repairSelf;
    row.net = row.rev - row.cost;
    rows.push(row);
  });

  /* 館別被刪掉、但訂單與維修單還在的情況。
     直接忽略會讓那部分營收與成本從總表上消失（看起來像生意變差了），
     所以補一列出來。已刪除的館別沒有契約可讀，一律以自有房源處理。 */
  Object.keys(rent).concat(Object.keys(rep)).forEach(function (pid) {
    if (seen[pid]) return;
    seen[pid] = true;
    var R = rent[pid] || { collected: 0, due: 0, rows: [] };
    var P = rep[pid] || pnlEmptyRep();
    /* 館別名稱已經連同館別一起被刪掉了，poRentByProp 的列也沒有留館名，
       所以這裡只能顯示通用字樣——與租金收款台帳的 pn() 用同一個說法。 */
    rows.push({
      propId: pid, propName: '（已刪除館別）', rooms: 0, kind: 'own', serviceType: '已刪除',
      rentDue: R.due, rentGot: R.collected,
      rev: R.due, revLabel: '房客租金（應收）', lordCost: 0, passRent: 0,
      repairSelf: P.self, repairLord: P.lord, repairTenant: P.tenant, repairN: P.n,
      ovDays: rg.days, partial: false, monthDays: rg.days,
      term: { from: '', to: '' }, deleted: true,
      cost: P.self, net: R.due - P.self
    });
  });

  var tot = { rev: 0, revRent: 0, revFee: 0, cost: 0, lordCost: 0, repairSelf: 0,
              net: 0, rentDue: 0, rentGot: 0, passRent: 0,
              repairLord: 0, repairTenant: 0, repairN: 0 };
  rows.forEach(function (r) {
    tot.rev += r.rev;
    if (r.kind === 'wg') tot.revFee += r.rev; else tot.revRent += r.rev;
    tot.cost += r.cost;
    tot.lordCost += r.lordCost;
    tot.repairSelf += r.repairSelf;
    tot.net += r.net;
    tot.rentDue += r.rentDue;
    tot.rentGot += r.rentGot;
    tot.passRent += r.passRent;
    tot.repairLord += r.repairLord;
    tot.repairTenant += r.repairTenant;
    tot.repairN += r.repairN;
  });
  tot.margin = tot.rev > 0 ? (tot.net / tot.rev * 100) : null;

  rows.sort(function (a, b) {
    return b.net - a.net || a.propName.localeCompare(b.propName);
  });
  return { ym: ym, days: rg.days, rows: rows, tot: tot,
           warnRent: warnRent, warnFee: warnFee, noLordCnt: noLordCnt };
}

/* 近 n 個月的淨額。只取總額，不取明細——趨勢要看的是走勢，
   每個月的細節在上面的表切月份就看得到。 */
function pnlTrend(ym, n) {
  var out = [], m = ym;
  for (var i = 0; i < n; i++) {
    var d = pnlBuild(m);
    out.unshift({ ym: m, rev: d.tot.rev, cost: d.tot.cost, net: d.tot.net });
    m = poPrevMonth(m);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   UI
   ══════════════════════════════════════════════════════════════════ */
var PNL_UI_READY = false;

function pnlEnsureUI() {
  if (PNL_UI_READY) return;
  PNL_UI_READY = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="overlay" id="pnl-ov" onclick="if(event.target===this)closePnl()">' +
    '<div class="modal" style="width:1080px;max-width:98vw">' +
    '<div class="modal-h"><h2>📊 月損益總表</h2>' +
    '<button class="close-btn" onclick="closePnl()">✕</button></div>' +
    '<div style="padding:10px 17px 4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<input class="sel" id="pnl-month" type="month" onchange="pnlRender()" style="width:140px">' +
      '<button class="btn btn-ghost sm" onclick="pnlShiftMonth(-1)">← 上一月</button>' +
      '<button class="btn btn-ghost sm" onclick="pnlShiftMonth(1)">下一月 →</button>' +
      '<button class="btn btn-ghost sm" onclick="pnlPrint()">🖨 列印／PDF</button>' +
    '</div>' +
    '<div class="modal-body" style="max-height:68vh;overflow-y:auto" id="pnl-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="closePnl()">關閉</button></div>' +
    '</div></div>');
}

/* 損益表含全部館別的保證租金與公司總營收，是最敏感的一張表。
   權限擋在這裡而不是只隱藏選單按鈕：選單按鈕任何人都能在 DevTools 裡叫出來。
   也刻意不像撥款單那樣用 ldVisible() 過濾成「只看自己的房東」——
   過濾過的損益表會印出一個看起來像公司總額、其實只是一部分的數字，
   那比直接不給看危險得多。 */
function openPnl() {
  if (typeof isAdmin === 'function' && !isAdmin()) {
    alert('月損益總表含全公司營收與各館別保證租金，僅限管理者查看。\n\n' +
      '若您需要查看自己負責館別的收款與撥款情形，請改用「💰 租金收款」與「📄 房東撥款單」。');
    return;
  }
  pnlEnsureUI();
  var mEl = document.getElementById('pnl-month');
  if (!mEl.value) mEl.value = poThisMonth();
  pnlRender();
  document.getElementById('pnl-ov').classList.add('open');
}
function closePnl() { document.getElementById('pnl-ov').classList.remove('open'); }

function pnlShiftMonth(d) {
  var el = document.getElementById('pnl-month');
  var ym = el.value || poThisMonth();
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) + d;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  el.value = y + '-' + String(m).padStart(2, '0');
  pnlRender();
}

function pnlMonthLbl(ym) {
  return ym.slice(0, 4) + ' 年 ' + (+ym.slice(5, 7)) + ' 月';
}
function pnlPct(n) {
  return n === null ? '—' : (n >= 0 ? '' : '−') + Math.abs(n).toFixed(1) + '%';
}

/* 成本欄位：0 元就印 $0，不要印成「−$0」（那會讓人以為真的扣掉了零元） */
function pnlNeg(n) { return n ? '−' + money(n) : money(0); }

/* 保證租金那一格。0 元有三種完全不同的意思，印成「−$0」會讓人以為
   這個館別這個月真的不用付房東錢，淨利率還會漂亮地顯示 100%：
     ・不是包租館            → 沒有這個欄位
     ・契約沒有涵蓋本月      → 本月確實不必付（類型欄已經標了原因）
     ・契約涵蓋本月但沒填租金 → 資料缺漏，成本被低估，必須標紅
   回傳 {txt, warn}，畫面與列印共用同一個判斷。 */
function pnlLordCell(r) {
  if (r.kind !== 'bz') return { txt: '—', warn: false };
  if (r.lordCost > 0) return { txt: '−' + money(r.lordCost), warn: false };
  if (r.ovDays <= 0) return { txt: '—', warn: false };
  return { txt: '未填', warn: true };
}

function pnlRender() {
  var ym = document.getElementById('pnl-month').value || poThisMonth();
  var d = pnlBuild(ym);
  var t = d.tot;
  var tod = todayStr();
  var e = escH;

  /* 會讓數字算錯的設定缺漏，和「系統本來就沒追蹤」的項目分開寫：
     前者是業者補得起來的，後者補不了，只能知道這張表的界線在哪。
     這一段必須排在統計卡「後面、表格前面」——缺漏會直接讓淨額與淨利率
     偏高，把警告藏在表格下方等於讓老闆先看到一個錯的大數字。 */
  var warns = [];
  if (d.warnRent.length)
    warns.push('<strong>' + d.warnRent.length + ' 個包租館別沒填保證租金</strong>（' +
      e(d.warnRent.slice(0, 4).join('、')) + (d.warnRent.length > 4 ? ' 等' : '') +
      '）。成本被低估，淨額與淨利率都會比實際好看。請到「🏠 房東建檔」補齊契約月租金。');
  if (d.warnFee.length)
    warns.push('<strong>' + d.warnFee.length + ' 個代管館別沒填服務報酬</strong>（' +
      e(d.warnFee.slice(0, 4).join('、')) + (d.warnFee.length > 4 ? ' 等' : '') +
      '）。收入被低估。請到「🏠 房東建檔」補齊報酬比例或固定金額。');
  if (d.noLordCnt)
    warns.push('有 <strong>' + d.noLordCnt + ' 個包租／代管館別還沒填房東電話</strong>。' +
      '它們的金額已納入本表，但「📄 房東撥款單」產不出來（無法歸戶），' +
      '所以兩張表的合計會對不上。');

  var netColor = t.net > 0 ? '#2f9e44' : (t.net < 0 ? '#c92a2a' : '#868e96');
  /* 成本缺漏時不讓淨利率單獨站在那裡：那個百分比在成本不全的情況下
     只是「收入的一個比例」，不是利潤率。 */
  var netSub = '淨利率 ' + pnlPct(t.margin) +
    (d.warnRent.length || d.warnFee.length
      ? '<span style="color:#c92a2a;font-weight:700"> ⚠️ 成本不完整</span>' : '');
  var h = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:11px">' +
    [['營業收入', money(t.rev), '#1a56a0', '包租房客租金＋代管服務報酬'],
     ['營業成本', money(t.cost), '#e67700', '保證租金＋自行吸收的維修'],
     ['本月淨額', (t.net < 0 ? '−' : '') + money(Math.abs(t.net)), netColor, netSub],
     ['代收轉付（不列損益）', money(t.passRent), '#868e96', '代管代收、須轉付房東']
    ].map(function (x) {
      return '<div style="flex:1;min-width:150px;background:#f8fafc;border:1px solid var(--border);' +
        'border-radius:8px;padding:9px 11px">' +
        '<div style="font-size:10px;color:var(--muted)">' + x[0] + '</div>' +
        '<div style="font-size:16px;font-weight:700;margin:2px 0 1px;color:' + x[2] + '">' + x[1] + '</div>' +
        '<div style="font-size:9.5px;color:var(--muted)">' + x[3] + '</div></div>';
    }).join('') + '</div>';

  if (warns.length)
    h += '<div style="padding:11px 13px;border-radius:7px;margin-bottom:11px;' +
      'border-left:4px solid #e67700;background:#fff9db">' +
      '<div style="font-weight:800;font-size:12px;color:#b54708;margin-bottom:4px">⚠️ 會影響數字的設定缺漏</div>' +
      '<div style="font-size:11px;line-height:1.9;color:#5c4813">' +
      warns.map(function (x) { return '・' + x; }).join('<br>') + '</div></div>';

  /* 當月還沒過完的話，淨額一定是偏低的（月底才會收到的租金還沒計入）。
     不講清楚的話，老闆每個月初都會以為生意崩了。 */
  if (ym >= tod.slice(0, 7))
    h += '<div style="background:#fff3bf;border-left:4px solid #e67700;border-radius:6px;' +
      'padding:8px 11px;font-size:11px;line-height:1.8;margin-bottom:11px">' +
      '⚠️ <strong>' + e(pnlMonthLbl(ym)) + '還沒結束</strong>，' +
      '保證租金已按整月計算，但房客租金只累計到目前已產生的期數，' +
      '所以淨額會偏低。要看完整的一個月請切到上一月。</div>';

  h += '<div style="font-size:10.5px;color:var(--muted);line-height:1.9;margin-bottom:12px">' +
    '採權責發生制：房客租金以「計費起日」歸月、保證租金以契約涵蓋天數歸月，' +
    '收入與成本才對得上同一段期間。本月房客租金<strong>應收 ' + money(t.rentDue) +
    '</strong>、<strong>實收 ' + money(t.rentGot) + '</strong>' +
    '（實收以收款日歸月，可能含上月份的租金，所以兩者不會剛好相等）。</div>';

  if (!d.rows.length) {
    h += '<div style="padding:18px;background:#f8fafc;border-radius:8px;font-size:12px;color:var(--muted)">' +
      '還沒有任何館別，無法產生損益表。請先到「🏢 管理房源」建立館別。</div>';
    document.getElementById('pnl-body').innerHTML = h;
    return;
  }

  var SVC = { bz: { bg: '#e7f5ff', color: '#1971c2' },
              wg: { bg: '#f3f0ff', color: '#7048e8' },
              own: { bg: '#ebfbee', color: '#2f9e44' } };
  h += '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
    '<thead><tr style="background:#f8fafc;border-bottom:2px solid var(--border)">' +
    ['館別', '類型', '營業收入', '保證租金', '維修（自行吸收）', '淨額', '淨利率'].map(function (x, i) {
      return '<th style="padding:7px 9px;text-align:' + (i >= 2 ? 'right' : 'left') +
        ';color:var(--muted);font-size:10px;white-space:nowrap">' + x + '</th>';
    }).join('') + '</tr></thead><tbody>' +
    d.rows.map(function (r) {
      var sv = SVC[r.kind] || SVC.own;
      var nc = r.net > 0 ? '#2f9e44' : (r.net < 0 ? '#c92a2a' : 'var(--muted)');
      var mg = r.rev > 0 ? (r.net / r.rev * 100) : null;
      var lc = pnlLordCell(r);
      return '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:7px 9px"><strong>' + e(r.propName) + '</strong>' +
          (r.rooms ? '<span style="font-size:10px;color:var(--muted)"> · ' + r.rooms + ' 間</span>' : '') +
          (r.deleted ? '<div style="font-size:9.5px;color:#c92a2a">館別已刪除，訂單或維修單還在</div>' : '') +
        '</td>' +
        '<td style="padding:7px 9px;white-space:nowrap">' +
          '<span style="background:' + sv.bg + ';color:' + sv.color + ';border-radius:4px;' +
            'padding:1px 6px;font-size:10.5px;font-weight:700">' + e(r.serviceType) + '</span>' +
          (r.kind !== 'own' && r.ovDays <= 0
            ? '<div style="font-size:9.5px;color:#c92a2a">房東契約未涵蓋本月</div>'
            : (r.partial ? '<div style="font-size:9.5px;color:#e67700">契約僅 ' +
                r.ovDays + '/' + r.monthDays + ' 天</div>' : '')) +
        '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' + money(r.rev) +
          '<div style="font-size:9.5px;color:var(--muted)">' + e(r.revLabel) + '</div>' +
          (r.kind === 'wg' && r.passRent
            ? '<div style="font-size:9.5px;color:var(--muted)">代收 ' + money(r.passRent) + ' 須轉付</div>'
            : '') +
        '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' +
          '<span style="color:' + (lc.warn ? '#c92a2a;font-weight:700' :
            (r.lordCost > 0 ? '#e67700' : 'var(--muted)')) + '">' + lc.txt + '</span></td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' +
          (r.repairSelf
            ? '<span style="color:#e67700">−' + money(r.repairSelf) + '</span>'
            : '<span style="color:var(--muted)">—</span>') + '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap;font-weight:700;color:' + nc + '">' +
          (r.net < 0 ? '−' : '') + money(Math.abs(r.net)) + '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap;color:' + nc + '">' +
          pnlPct(mg) + '</td></tr>';
    }).join('') +
    '<tr style="background:#f0f4fa;font-weight:700;border-top:2px solid var(--border)">' +
      '<td style="padding:8px 9px" colspan="2">合計</td>' +
      '<td style="padding:8px 9px;text-align:right">' + money(t.rev) + '</td>' +
      '<td style="padding:8px 9px;text-align:right;color:#e67700">' + pnlNeg(t.lordCost) + '</td>' +
      '<td style="padding:8px 9px;text-align:right;color:#e67700">' + pnlNeg(t.repairSelf) + '</td>' +
      '<td style="padding:8px 9px;text-align:right;color:' + netColor + '">' +
        (t.net < 0 ? '−' : '') + money(Math.abs(t.net)) + '</td>' +
      '<td style="padding:8px 9px;text-align:right;color:' + netColor + '">' + pnlPct(t.margin) + '</td>' +
    '</tr></tbody></table>';

  /* 代收代付：金額可能很大，但對損益完全沒有影響。
     不列出來業者會懷疑系統算漏了，列進淨額才是真的算錯。 */
  if (t.passRent || t.repairLord || t.repairTenant)
    h += '<div style="margin-top:14px;padding:11px 13px;border-radius:7px;background:#f8fafc;' +
      'border:1px solid var(--border)">' +
      '<div style="font-weight:700;font-size:12px;margin-bottom:5px">代收代付（刻意不列入損益）</div>' +
      '<div style="font-size:11px;line-height:2;color:var(--muted)">' +
      (t.passRent ? '・<strong>代收房客租金 ' + money(t.passRent) +
        '</strong>　代管館收到的租金，扣除服務報酬後須轉付房東，公司只賺報酬。<br>' : '') +
      (t.repairLord ? '・<strong>代墊維修 ' + money(t.repairLord) +
        '</strong>　依契約應由房東負擔，在房東撥款單中扣回，收支兩平。<br>' : '') +
      (t.repairTenant ? '・<strong>房客負擔維修 ' + money(t.repairTenant) +
        '</strong>　在退房結算時從押金扣抵，收支兩平。<br>' : '') +
      '押金與水電代收同理，都是代收代付，不是公司的收入或成本。</div></div>';

  h += '<div style="margin-top:12px;padding:11px 13px;border-radius:7px;background:#f8fafc;' +
    'border:1px solid var(--border);font-size:10.5px;line-height:1.9;color:var(--muted)">' +
    '<strong style="color:var(--text)">這張表還沒有涵蓋的成本</strong><br>' +
    '・<strong>清潔費用</strong>：清潔單目前沒有金額欄位，系統完全沒有這筆資料，' +
    '所以上表不是把它算成 0，而是根本沒算。<br>' +
    '・<strong>人事薪資、公用水電、稅捐、行銷、系統訂閱費</strong>等間接費用：' +
    '系統沒有這些輸入，請在自己的帳上另計。<br>' +
    '也就是說，上表的淨額是<strong>房源層級的毛利</strong>，不是公司的稅後淨利。' +
    '它要回答的是「哪個館別在賺錢、哪個在賠」，不能直接拿去報稅。</div>';

  h += pnlTrendHtml(ym);

  document.getElementById('pnl-body').innerHTML = h;
}

/* 近 6 個月淨額。用等比例的橫條，不畫座標軸——
   這裡要看的只有「在變好還是變壞」，精確數字就寫在旁邊。 */
function pnlTrendHtml(ym) {
  var tr = pnlTrend(ym, 6);
  var max = 1;
  tr.forEach(function (x) { if (Math.abs(x.net) > max) max = Math.abs(x.net); });
  return '<div style="margin-top:14px">' +
    '<div style="font-weight:700;font-size:12px;margin-bottom:7px">近 6 個月淨額</div>' +
    tr.map(function (x) {
      var w = Math.round(Math.abs(x.net) / max * 100);
      var pos = x.net >= 0;
      return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:11px">' +
        '<div style="width:62px;color:var(--muted);white-space:nowrap">' + escH(x.ym) + '</div>' +
        '<div style="flex:1;background:#f1f3f5;border-radius:4px;height:16px;position:relative">' +
          '<div style="width:' + w + '%;height:100%;border-radius:4px;background:' +
            (pos ? '#51cf66' : '#ff8787') + '"></div></div>' +
        '<div style="width:98px;text-align:right;font-weight:700;white-space:nowrap;color:' +
          (pos ? '#2f9e44' : '#c92a2a') + '">' + (pos ? '' : '−') + money(Math.abs(x.net)) + '</div>' +
        '<div style="width:78px;text-align:right;color:var(--muted);white-space:nowrap">收入 ' +
          money(x.rev) + '</div></div>';
    }).join('') + '</div>';
}

function pnlPrint() {
  var ym = document.getElementById('pnl-month').value || poThisMonth();
  var d = pnlBuild(ym), t = d.tot;
  var w = window.open('', '_blank');
  if (!w) { alert('瀏覽器阻擋了新視窗，請允許彈出視窗後再試'); return; }
  var e = escH;

  var html = '<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">' +
    '<title>月損益總表 ' + e(ym) + '</title><style>' +
    '@page{size:A4 landscape;margin:12mm}' +
    '*{box-sizing:border-box}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Microsoft JhengHei",sans-serif;' +
      'color:#1a2535;margin:0;padding:20px;line-height:1.65;font-size:12px}' +
    '.bar{background:#e8f0fb;border-radius:8px;padding:9px 13px;font-size:12px;margin-bottom:14px}' +
    'h1{font-size:19px;margin:0 0 3px}.sub{color:#6b7a99;font-size:12px;margin-bottom:14px}' +
    'table{width:100%;border-collapse:collapse;font-size:11.5px;margin:8px 0 13px}' +
    'th,td{border:1px solid #d8dde8;padding:5px 8px;text-align:left}' +
    'th{background:#f0f4fa;white-space:nowrap}' +
    '.num{text-align:right;white-space:nowrap}' +
    '.tot{background:#f0f4fa;font-weight:700}' +
    'h2{font-size:13px;margin:15px 0 4px;border-left:4px solid #1a56a0;padding-left:8px}' +
    '.foot{margin-top:16px;font-size:10.5px;color:#6b7a99;line-height:1.75;' +
      'border-top:1px solid #d8dde8;padding-top:9px}' +
    '@media print{.bar{display:none}body{padding:0}}' +
    '</style></head><body>' +
    '<div class="bar">這是系統依館別契約設定、租金收款台帳與維修單自動產生的損益總表。' +
      '<button onclick="window.print()" style="margin-left:8px">🖨 列印／儲存 PDF</button></div>' +
    '<h1>月損益總表</h1>' +
    '<div class="sub">' + e(pnlMonthLbl(ym)) + '　｜　' + e(poBizName()) +
      '　｜　製表日 ' + e(todayStr()) + '　｜　權責發生制</div>' +

    '<table><tr><th>館別</th><th>類型</th><th class="num">營業收入</th>' +
    '<th>收入性質</th><th class="num">保證租金</th><th class="num">維修（自行吸收）</th>' +
    '<th class="num">淨額</th><th class="num">淨利率</th></tr>' +
    d.rows.map(function (r) {
      var mg = r.rev > 0 ? (r.net / r.rev * 100) : null;
      return '<tr><td>' + e(r.propName) + (r.rooms ? '（' + r.rooms + ' 間）' : '') + '</td>' +
        '<td>' + e(r.serviceType) +
          (r.kind !== 'own' && r.ovDays <= 0 ? '（契約未涵蓋本月）'
            : (r.partial ? '（' + r.ovDays + '/' + r.monthDays + ' 天）' : '')) + '</td>' +
        '<td class="num">' + money(r.rev) + '</td>' +
        '<td>' + e(r.revLabel) +
          (r.kind === 'wg' && r.passRent ? '（另代收 ' + money(r.passRent) + ' 須轉付）' : '') + '</td>' +
        '<td class="num">' + pnlLordCell(r).txt + '</td>' +
        '<td class="num">' + (r.repairSelf ? pnlNeg(r.repairSelf) : '—') + '</td>' +
        '<td class="num">' + (r.net < 0 ? '−' : '') + money(Math.abs(r.net)) + '</td>' +
        '<td class="num">' + pnlPct(mg) + '</td></tr>';
    }).join('') +
    '<tr class="tot"><td colspan="2">合計</td>' +
      '<td class="num">' + money(t.rev) + '</td><td></td>' +
      '<td class="num">' + pnlNeg(t.lordCost) + '</td>' +
      '<td class="num">' + pnlNeg(t.repairSelf) + '</td>' +
      '<td class="num">' + (t.net < 0 ? '−' : '') + money(Math.abs(t.net)) + '</td>' +
      '<td class="num">' + pnlPct(t.margin) + '</td></tr></table>' +

    '<h2>代收代付（不列入損益）</h2><table>' +
    '<tr><th>項目</th><th class="num">金額</th><th>說明</th></tr>' +
    '<tr><td>代收房客租金</td><td class="num">' + money(t.passRent) + '</td>' +
      '<td>代管館代收，扣除服務報酬後轉付房東</td></tr>' +
    '<tr><td>代墊維修（可向房東請款）</td><td class="num">' + money(t.repairLord) + '</td>' +
      '<td>於房東撥款單扣回</td></tr>' +
    '<tr><td>房客負擔維修</td><td class="num">' + money(t.repairTenant) + '</td>' +
      '<td>於退房結算自押金扣抵</td></tr></table>' +

    '<div class="foot">' +
      '本表採權責發生制：房客租金以計費起日歸月，保證租金以契約涵蓋本月之天數比例計算。' +
      '本月房客租金應收 ' + money(t.rentDue) + '、實收 ' + money(t.rentGot) +
      '（實收依收款日歸月，可能含其他月份之租金）。<br>' +
      '代管館之營業收入僅計服務報酬；代收之房客租金為代收代付，不計入收入。' +
      '維修費僅「公司自行吸收」者計入成本。<br>' +
      '<strong>本表未涵蓋</strong>：清潔費用（系統無金額欄位）、人事薪資、公用水電、' +
      '稅捐、行銷及系統訂閱等間接費用。因此上列淨額為房源層級毛利，非公司稅後淨利，' +
      '不得逕行作為申報依據。' +
    '</div></body></html>';

  w.document.write(html);
  w.document.close();
}
