/* ══════════════════════════════════════════════════════════════════
   房客自助入口（後台側）
   ------------------------------------------------------------------
   兩件事：
     1. 房客連結 — 一筆訂單發一條網址（tenant.html?t=…），房客不必註冊
        帳號就能看自己的租約、繳費、文件與押金結算。
     2. 房客報修 — 房客從那頁送出的報修申請，在這裡確認後才轉成維修單。

   為什麼報修要多一道「待確認」：
     維修單會影響房況、可售期與退房結算的扣抵金額。讓外部人能直接建立
     正式單據，等於把營運排程的寫入權開給不特定對象——灌一百張單就能
     把一整個月的可售期弄亂，而且每一張都會出現在維修報表的成本裡。
     所以房客送出的只是「申請」，轉不轉成維修單由業者決定。

   連結一律「停用」不「刪除」：
     誰在什麼時候開過這條連結是紀錄。發生爭議時（「我根本沒收到通知」）
     open_count 與 last_seen_at 就是證據，刪掉就什麼都不剩。
   ══════════════════════════════════════════════════════════════════ */

var TN_UI_READY = false;
var TN_LINKS = [];
var TN_REPORTS = [];
var TN_REP_TAB = 'new';

/* escH() 不處理 > 與 '，而報修內容是外部匿名使用者送進來的字串，
   這裡自己轉一份完整的，不共用。 */
function tnEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function tnEnsureUI() {
  if (TN_UI_READY) return;
  TN_UI_READY = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="overlay" id="tn-ov" onclick="if(event.target===this)tnCloseLinks()">' +
    '<div class="modal" style="width:1000px;max-width:98vw">' +
    '<div class="modal-h"><h2>🔗 房客自助連結</h2>' +
    '<button class="close-btn" onclick="tnCloseLinks()">✕</button></div>' +
    '<div style="padding:10px 17px 4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<input class="sel" id="tn-search" type="text" placeholder="搜尋客戶／房號／電話" ' +
        'oninput="tnRenderLinks()" style="width:200px">' +
      '<label style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer">' +
        '<input type="checkbox" id="tn-all" onchange="tnRenderLinks()">顯示已退房超過 30 天的訂單</label>' +
    '</div>' +
    '<div class="modal-body" style="max-height:66vh;overflow-y:auto" id="tn-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="tnCloseLinks()">關閉</button></div>' +
    '</div></div>' +

    '<div class="overlay" id="tnr-ov" onclick="if(event.target===this)tnCloseReports()">' +
    '<div class="modal" style="width:960px;max-width:98vw">' +
    '<div class="modal-h"><h2 id="tnr-title">📥 房客報修</h2>' +
    '<button class="close-btn" onclick="tnCloseReports()">✕</button></div>' +
    '<div style="padding:10px 17px 4px;display:flex;gap:6px;flex-wrap:wrap" id="tnr-tabs"></div>' +
    '<div class="modal-body" style="max-height:66vh;overflow-y:auto" id="tnr-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="tnCloseReports()">關閉</button></div>' +
    '</div></div>');
}

/* ══════════════════════════════════════════════════════════════════
   房客連結
   ══════════════════════════════════════════════════════════════════ */

/* 一筆訂單的租期範圍。取消的段落不算：整張訂單只剩取消段落時，
   它不該出現在「目前在住」的清單裡占位子。 */
function tnRange(b) {
  var segs = (b.segments || []).filter(function (s) {
    return (s.status || 'reserved') !== 'cancelled';
  });
  if (!segs.length) return null;
  var from = '', to = '';
  segs.forEach(function (s) {
    if (s.checkin && (!from || s.checkin < from)) from = s.checkin;
    if (s.checkout && (!to || s.checkout > to)) to = s.checkout;
  });
  return { from: from, to: to, segs: segs };
}

async function tnOpenLinks() {
  tnEnsureUI();
  document.getElementById('tn-body').innerHTML =
    '<div style="padding:26px;text-align:center;color:var(--muted)">載入中…</div>';
  document.getElementById('tn-ov').classList.add('open');
  TN_LINKS = await Cloud.listTenantLinks();
  tnRenderLinks();
}
function tnCloseLinks() {
  document.getElementById('tn-ov').classList.remove('open');
}

function tnRenderLinks() {
  var kw = (document.getElementById('tn-search').value || '').trim().toLowerCase();
  var showAll = document.getElementById('tn-all').checked;
  var cutoff = addDays(todayStr(), -30);
  var nameOf = {};
  loadCPs().forEach(function (p) { nameOf[p.id] = p.name; });

  /* 一筆訂單只會有一條 active 連結（DB 的 tenant_links_one_live 保證），
     但停用過的歷史連結還在，所以要挑出 active 的那一條來顯示。 */
  var live = {}, hist = {};
  TN_LINKS.forEach(function (l) {
    if (l.status === 'active') live[l.booking_id] = l;
    else hist[l.booking_id] = (hist[l.booking_id] || 0) + 1;
  });

  var rows = [];
  loadBks().forEach(function (b) {
    var r = tnRange(b);
    if (!r) return;
    if (!showAll && r.to && r.to < cutoff) return;
    if (kw) {
      var hay = ((b.guest || '') + ' ' + (b.phone || '') + ' ' +
        r.segs.map(function (s) { return (nameOf[s.prop_id] || '') + ' ' + (s.room || ''); }).join(' ')
      ).toLowerCase();
      if (hay.indexOf(kw) < 0) return;
    }
    rows.push({ bk: b, r: r, link: live[b.id] || null, revoked: hist[b.id] || 0 });
  });
  rows.sort(function (a, b) { return (b.r.from || '').localeCompare(a.r.from || ''); });

  var h = '<div style="font-size:11.5px;color:var(--muted);line-height:1.8;' +
    'background:var(--primary-light);border-radius:8px;padding:9px 12px;margin-bottom:11px">' +
    '房客用這條網址就能看到自己的<strong>租約、繳費明細、契約與點交單、押金結算</strong>，' +
    '也能線上報修（送出的報修會進「房客報修」待您確認，不會直接變成維修單）。<br>' +
    '頁面上<strong>不會出現</strong>完整電話、Email、身分證字號、內部備註與業務姓名；' +
    '金額是即時從系統撈的，不是寄出當下的快照。<br>' +
    '連結可轉傳，所以換房客或發錯人時請按「停用」，再產生一條新的。' +
    '</div>';

  if (!rows.length) {
    h += '<div style="padding:26px;text-align:center;color:var(--muted);font-size:12.5px">' +
      '沒有符合條件的訂單。' + (showAll ? '' : '<br>已退房超過 30 天的訂單預設不顯示，可勾選上方選項查看。') +
      '</div>';
    document.getElementById('tn-body').innerHTML = h;
    return;
  }

  h += '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
    '<tr style="background:var(--light)">' +
    ['房客', '館別 · 房號', '租期', '連結狀態', '操作'].map(function (t) {
      return '<th style="padding:6px 7px;text-align:left;border-bottom:1px solid var(--border);' +
        'white-space:nowrap">' + t + '</th>';
    }).join('') + '</tr>';

  rows.forEach(function (x) {
    var b = x.bk, l = x.link;
    var where = x.r.segs.map(function (s) {
      return tnEsc(nameOf[s.prop_id] || '（已刪除館別）') + ' · ' + tnEsc(s.room || '');
    }).join('<br>');
    var state, acts;
    if (l) {
      state = '<span style="display:inline-block;padding:2px 8px;border-radius:999px;' +
        'background:#ebfbee;color:#2f9e44;font-weight:700">有效</span>' +
        '<div style="font-size:9.5px;color:var(--muted)">' +
        (l.open_count > 0
          ? '已開啟 ' + l.open_count + ' 次，最後 ' + String(l.last_seen_at || '').slice(0, 10)
          : '房客尚未開啟') + '</div>';
      acts = '<button class="btn btn-primary sm" onclick="tnCopy(' + jsArg(l.token) + ')">📋 複製網址</button> ' +
        '<button class="btn btn-ghost sm" onclick="tnPreview(' + jsArg(l.token) + ')" ' +
        'title="用房客的視角開啟，確認看到的內容正確">👁 預覽</button> ' +
        '<button class="btn btn-danger sm" onclick="tnRevoke(' + jsArg(l.id) + ')">停用</button>';
    } else {
      state = '<span style="color:var(--muted)">尚未產生</span>' +
        (x.revoked ? '<div style="font-size:9.5px;color:var(--muted)">曾停用 ' + x.revoked + ' 條</div>' : '');
      acts = '<button class="btn btn-primary sm" onclick="tnCreate(' + jsArg(b.id) + ')">🔗 產生連結</button>';
    }
    h += '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:6px 7px">' + tnEsc(b.guest || '(未命名)') +
        (b.phone ? '<div style="font-size:9.5px;color:var(--muted)">' + tnEsc(b.phone) + '</div>' : '') + '</td>' +
      '<td style="padding:6px 7px">' + where + '</td>' +
      '<td style="padding:6px 7px;white-space:nowrap">' + tnEsc(x.r.from || '—') +
        '<br>～' + tnEsc(x.r.to || '—') + '</td>' +
      '<td style="padding:6px 7px;white-space:nowrap">' + state + '</td>' +
      '<td style="padding:6px 7px;white-space:nowrap">' + acts + '</td></tr>';
  });
  h += '</table>';
  document.getElementById('tn-body').innerHTML = h;
}

async function tnCreate(bkId) {
  var b = loadBks().find(function (x) { return String(x.id) === String(bkId); });
  if (!b) { alert('找不到這筆訂單，可能已被其他成員刪除。'); return; }
  var res = await Cloud.createTenantLink(b.id, b.guest || '');
  if (!res) return;
  TN_LINKS = await Cloud.listTenantLinks();
  tnRenderLinks();
  tnCopy(res.token, '✅ 連結已產生並複製到剪貼簿，可直接貼給房客：\n');
}

/* 複製失敗時（權限被擋、非 https）要把網址顯示出來讓人手動複製，
   不能只說「複製失敗」——那等於功能整個不能用卻沒有替代路徑。 */
function tnCopy(token, prefix) {
  var url = Cloud.tenantUrl(token);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function () {
      alert((prefix || '✅ 已複製房客連結：\n') + url);
    }, function () { prompt('請手動複製以下網址：', url); });
  } else {
    prompt('請手動複製以下網址：', url);
  }
}

function tnPreview(token) {
  window.open(Cloud.tenantUrl(token), '_blank', 'noopener');
}

async function tnRevoke(id) {
  if (!confirm('停用這條房客連結？\n\n' +
    '停用後房客再開啟會看到「連結已停用」，需要重新產生一條新的給他。\n' +
    '開啟紀錄會保留，不會被刪掉。')) return;
  if (!await Cloud.revokeTenantLink(id)) return;
  TN_LINKS = await Cloud.listTenantLinks();
  tnRenderLinks();
}

/* ══════════════════════════════════════════════════════════════════
   房客報修
   ══════════════════════════════════════════════════════════════════ */
var TN_REP_ST = {
  'new':      { label: '待確認', color: '#e67700', bg: '#fff3bf' },
  'accepted': { label: '已受理', color: '#2f9e44', bg: '#ebfbee' },
  'rejected': { label: '未受理', color: '#868e96', bg: '#f1f3f5' }
};

async function tnTodoCount() {
  if (!Cloud.isLoggedIn || !Cloud.isLoggedIn()) return 0;
  return await Cloud.countNewTenantReports();
}

async function tnOpenReports(tab) {
  tnEnsureUI();
  if (tab) TN_REP_TAB = tab;
  document.getElementById('tnr-body').innerHTML =
    '<div style="padding:26px;text-align:center;color:var(--muted)">載入中…</div>';
  document.getElementById('tnr-ov').classList.add('open');
  TN_REPORTS = await Cloud.listTenantReports();
  tnRenderReports();
}
function tnCloseReports() {
  document.getElementById('tnr-ov').classList.remove('open');
  if (typeof refreshRepBadge === 'function') refreshRepBadge();
}
function tnRepTab(t) { TN_REP_TAB = t; tnRenderReports(); }

function tnRenderReports() {
  var nameOf = {};
  loadCPs().forEach(function (p) { nameOf[p.id] = p.name; });
  var guestOf = {};
  loadBks().forEach(function (b) { guestOf[b.id] = b.guest || ''; });

  var counts = { 'new': 0, accepted: 0, rejected: 0 };
  TN_REPORTS.forEach(function (r) { if (counts[r.status] != null) counts[r.status]++; });

  var tabs = [['new', '待確認'], ['accepted', '已受理'], ['rejected', '未受理'], ['', '全部']];
  document.getElementById('tnr-tabs').innerHTML = tabs.map(function (t) {
    var on = TN_REP_TAB === t[0];
    var n = t[0] ? counts[t[0]] : TN_REPORTS.length;
    return '<button class="btn ' + (on ? 'btn-primary' : 'btn-ghost') + ' sm" ' +
      'onclick="tnRepTab(' + jsArg(t[0]) + ')">' + t[1] + '（' + n + '）</button>';
  }).join('');
  document.getElementById('tnr-title').textContent =
    '📥 房客報修' + (counts['new'] ? '　待確認 ' + counts['new'] + ' 件' : '');

  var list = TN_REPORTS.filter(function (r) { return !TN_REP_TAB || r.status === TN_REP_TAB; });

  var h = '<div style="font-size:11.5px;color:var(--muted);line-height:1.8;' +
    'background:var(--primary-light);border-radius:8px;padding:9px 12px;margin-bottom:11px">' +
    '這些是房客從自助連結送出的<strong>報修申請</strong>，還不是維修單。' +
    '按「受理」才會建立一張維修單（金額 0、不擋房），之後到維修追蹤派工與填金額。<br>' +
    '受理時可先選<strong>費用歸屬</strong>（公司吸收／屋主負擔／房客負擔）；' +
    '金額是 0 的時候選什麼都不會動到錢，到維修追蹤填金額時才生效，屆時也還能再改。' +
    '</div>';

  if (!list.length) {
    h += '<div style="padding:26px;text-align:center;color:var(--muted);font-size:12.5px">' +
      (TN_REP_TAB === 'new' ? '目前沒有待確認的房客報修。' : '沒有符合條件的紀錄。') + '</div>';
    document.getElementById('tnr-body').innerHTML = h;
    return;
  }

  list.forEach(function (r) {
    var s = TN_REP_ST[r.status] || { label: r.status, color: '#495057', bg: '#f1f3f5' };
    h += '<div style="border:1px solid var(--border);border-radius:9px;padding:11px 13px;margin-bottom:9px">' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:10.5px;' +
        'font-weight:700;background:' + s.bg + ';color:' + s.color + '">' + s.label + '</span>' +
        '<strong style="font-size:12.5px">' + tnEsc(r.category) + '</strong>' +
        '<span style="font-size:11px;color:var(--muted)">' +
          tnEsc(guestOf[r.booking_id] || '（訂單已刪除）') + '　' +
          tnEsc(nameOf[r.prop_id] || '') + (r.room ? ' · ' + tnEsc(r.room) : '') + '</span>' +
        '<span style="margin-left:auto;font-size:10.5px;color:var(--muted)">' +
          tnEsc(String(r.created_at || '').replace('T', ' ').slice(0, 16)) + '</span>' +
      '</div>' +
      '<div style="font-size:12.5px;line-height:1.75;margin-top:7px;white-space:pre-wrap">' +
        tnEsc(r.detail) + '</div>' +
      (r.contact ? '<div style="font-size:11px;color:var(--muted);margin-top:4px">' +
        '方便聯絡：' + tnEsc(r.contact) + '</div>' : '') +
      (r.reply ? '<div style="font-size:11.5px;margin-top:6px;padding-top:6px;' +
        'border-top:1px dashed var(--border);color:var(--muted)">回覆房客：' + tnEsc(r.reply) +
        (r.handled_by ? '（' + tnEsc(r.handled_by) + '）' : '') + '</div>' : '') +
      (r.task_id ? '<div style="font-size:11px;color:#2f9e44;margin-top:4px">' +
        '已開立維修單 ' + tnEsc(r.task_id) + '</div>' : '') +
      (r.status === 'new'
        ? '<div style="margin-top:9px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="btn btn-primary sm" onclick="tnAcceptForm(' + jsArg(r.id) + ')">✓ 受理並開維修單</button>' +
          '<button class="btn btn-ghost sm" onclick="tnReject(' + jsArg(r.id) + ')">✗ 不受理</button>' +
          '</div><div id="tn-acc-' + tnEsc(r.id) + '"></div>'
        : '') +
      '</div>';
  });
  document.getElementById('tnr-body').innerHTML = h;
}

/* 這筆報修要開在哪一間房。房客端送出時帶的是當時的段落，但訂單可能已經
   換房或整筆刪掉；對應不到房間的維修單會掛在空館別上，排房表與報表都找
   不到它。 */
function tnWhere(r) {
  var pid = r.prop_id || '', room = r.room || '';
  if (!pid || !room) {
    var b = loadBks().find(function (x) { return String(x.id) === String(r.booking_id); });
    var seg = b && (b.segments || []).filter(function (s) {
      return (s.status || 'reserved') !== 'cancelled';
    })[0];
    if (seg) { pid = pid || seg.prop_id; room = room || seg.room; }
  }
  return (pid && room) ? { pid: pid, room: room } : null;
}

/* 費用歸屬在受理當下就能決定，但預設一律「自行吸收」。
   受理時金額還是 0，所以選錯不會立刻有錢跑掉；真正的風險是選了
   unbilled／tenant 之後沒人回頭修正，金額一填就自動流進撥款單或退房結算。
   'billed'（已請款）不列：還沒跟屋主請過款，開單當下不可能是這個狀態。 */
var TN_BILL_OPTS = [
  ['none',     '不需請款（自行吸收）', '公司自己吸收，不進任何單據'],
  ['unbilled', '屋主負擔（未請款）',   '金額會自動進該館的房東撥款單扣抵'],
  ['tenant',   '房客自行負擔',         '金額會自動進退房結算，從押金扣抵']
];

function tnAcceptForm(id) {
  var r = TN_REPORTS.find(function (x) { return String(x.id) === String(id); });
  if (!r) return;
  var w = tnWhere(r);
  if (!w) {
    alert('這筆報修對應不到館別與房號（訂單可能已被刪除或改過房間）。\n' +
      '請直接到維修追蹤手動開單，再回來把這筆標記為已受理。');
    return;
  }
  var box = document.getElementById('tn-acc-' + r.id);
  if (!box) return;
  if (box.innerHTML) { box.innerHTML = ''; return; }   /* 再按一次收起來 */

  box.innerHTML =
    '<div style="margin-top:9px;padding:10px 12px;border:1px dashed var(--border);' +
      'border-radius:8px;background:var(--light)">' +
    '<div style="font-size:11px;color:var(--muted);margin-bottom:7px">' +
      '將在 <strong>' + tnEsc(w.pid ? (loadCPs().find(function (p) { return p.id === w.pid; }) || {}).name || '' : '') +
      ' · ' + tnEsc(w.room) + '</strong> 開立一張維修單（金額 0、不擋房），' +
      '金額與廠商到「維修追蹤」再補。</div>' +
    '<label style="font-size:11.5px;font-weight:700;display:block;margin-bottom:3px">費用歸屬</label>' +
    '<select class="sel" id="tn-acc-bill-' + tnEsc(r.id) + '" ' +
      'onchange="tnBillHint(' + jsArg(r.id) + ')" style="width:100%;max-width:320px">' +
      TN_BILL_OPTS.map(function (o) {
        return '<option value="' + o[0] + '">' + o[1] + '</option>';
      }).join('') + '</select>' +
    '<div id="tn-acc-hint-' + tnEsc(r.id) + '" ' +
      'style="font-size:10.5px;color:var(--muted);margin:4px 0 9px">' + TN_BILL_OPTS[0][2] + '</div>' +
    '<label style="font-size:11.5px;font-weight:700;display:block;margin-bottom:3px">' +
      '回覆房客<span style="font-weight:400;color:var(--muted)">（會顯示在他的自助頁上，可留空）</span></label>' +
    '<textarea class="sel" id="tn-acc-msg-' + tnEsc(r.id) + '" rows="2" maxlength="500" ' +
      'style="width:100%;resize:vertical">已收到您的報修，會儘快安排人員處理。</textarea>' +
    '<div style="margin-top:8px;display:flex;gap:6px">' +
      '<button class="btn btn-primary sm" onclick="tnAccept(' + jsArg(r.id) + ')">確認受理</button>' +
      '<button class="btn btn-ghost sm" onclick="tnAcceptForm(' + jsArg(r.id) + ')">取消</button>' +
    '</div></div>';
}

function tnBillHint(id) {
  var v = document.getElementById('tn-acc-bill-' + id).value;
  var o = TN_BILL_OPTS.find(function (x) { return x[0] === v; });
  document.getElementById('tn-acc-hint-' + id).textContent = o ? o[2] : '';
}

async function tnAccept(id) {
  var r = TN_REPORTS.find(function (x) { return String(x.id) === String(id); });
  if (!r) return;
  var w = tnWhere(r);
  if (!w) return;
  var pid = w.pid, room = w.room;

  var selEl = document.getElementById('tn-acc-bill-' + r.id);
  var msgEl = document.getElementById('tn-acc-msg-' + r.id);
  if (!selEl || !msgEl) return;
  var billing = selEl.value || 'none';
  var reply = msgEl.value;

  var start = todayStr();
  var tid = genId('TK');
  var tasks = loadTasks();
  tasks.push({
    id: tid, prop_id: pid, room: room, type: 'repair',
    start: start, end: addDays(start, 1),
    note: '房客報修：' + r.category + ' — ' + r.detail +
          (r.contact ? '（方便聯絡：' + r.contact + '）' : ''),
    isAuto: false, bookingId: r.booking_id || null, complaintId: null,
    status: 'todo', handler: '', vendorId: '', cat: '', dueDate: '',
    cost: 0,
    /* 受理畫面上選的費用歸屬（預設 none）。金額此刻是 0，所以即使之後
       發現責任判斷錯了，也還來得及在維修追蹤改掉，不會先扣到錢。 */
    billing: billing,
    /* 不擋房：房客人還住在裡面，擅自把房間設成需淨空會把可售期整段拿掉。 */
    blocking: 'occupied',
    doneAt: '', hist: pushTkHist({}, 'todo'),
    createdAt: new Date().toISOString(),
    updatedBy: Cloud.myDisplayName || Cloud.myEmail || ''
  });
  saveTasks(tasks);

  var ok = await Cloud.updateTenantReport(r.id, {
    status: 'accepted', reply: (reply || '').trim().slice(0, 500), task_id: tid
  });
  if (!ok) {
    /* 維修單已經寫進 KV、報修狀態卻沒更新，下次開啟還會看到「待確認」，
       再按一次就變成兩張單。寫不回去就把剛剛那張收回來。 */
    saveTasks(loadTasks().filter(function (t) { return t.id !== tid; }));
    return;
  }
  TN_REPORTS = await Cloud.listTenantReports();
  tnRenderReports();
  if (typeof render === 'function') render();
  if (typeof refreshRepBadge === 'function') refreshRepBadge();
  var bl = TN_BILL_OPTS.find(function (x) { return x[0] === billing; });
  alert('✅ 已受理，並建立維修單 ' + tid + '。\n' +
    '費用歸屬：' + (bl ? bl[1] : billing) + '（金額 0，填金額後才會生效）\n' +
    '到「維修追蹤」可指派廠商、填寫金額，歸屬也還能再改。');
}

async function tnReject(id) {
  var r = TN_REPORTS.find(function (x) { return String(x.id) === String(id); });
  if (!r) return;
  var reply = prompt('不受理這筆報修。\n\n' +
    '請填寫原因（會顯示在房客的自助頁上）：', '');
  if (reply === null) return;
  if (!reply.trim()) { alert('請填寫不受理的原因，房客看到一個沒有說明的「未受理」只會再送一次。'); return; }
  if (!await Cloud.updateTenantReport(r.id, { status: 'rejected', reply: reply.trim().slice(0, 500) })) return;
  TN_REPORTS = await Cloud.listTenantReports();
  tnRenderReports();
  if (typeof refreshRepBadge === 'function') refreshRepBadge();
}
