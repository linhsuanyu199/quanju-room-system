/* ════════════════════════════════════════════════════════════════════
   入住／退房點交（後台）

   三個入口：
     1. 設備主檔（qj_equip）── 每個館別填一次預設清單，單一房間可覆寫
     2. 點交作業（handovers 資料表）── 逐項確認現況、估定賠償、產生簽收連結
     3. 點交管理 ── 待辦提醒、清單、檢視、作廢

   為什麼設備清單不讀契約附件三：點交不能依賴「有沒有線上簽約」。
   舊房客、紙本約、代租代管的案件都要能點交，所以設備清單自成主檔。
   反過來簽約時可以把主檔帶進附件三，方向是對的。

   為什麼單據版面不在這裡：全部在 js/handover-render.js，後台預覽、
   房客簽收頁（handover.html）、列印 PDF 共用那一份，不可能出現
   「預覽跟房客簽的不一樣」。這個檔案只負責「把系統裡的資料對應到
   點交欄位」與「簽收後的後續動作」。

   依賴：contracts-admin.js 的 ctEsc／ctTW／ctSameId／ctProp，
         settlement.js 的 stMeters／stMeterKey／stCfg，
         主 script 的 loadBks／loadTasks／saveTasks／genId／addDays／
         todayStr／money。載入順序見 index.html 的 script 標籤註解。
   ════════════════════════════════════════════════════════════════════ */
'use strict';

var HO_KV_EQUIP = 'qj_equip';    /* { 館別id: { '_default':[item], 房號:[item] } }，item={id,name,qty,note} */
var HO_KV_DRAFT = 'qj_hodraft';  /* { 'kind|訂單id|館別id|房號': {items,meter,note} } 現場填寫中的草稿 */
var HO_KV_TASK  = 'qj_hotask';   /* { 點交單id: [維修單id,…] } 已對帳過的簽收單，用來去重 */

/* 常見設備起始清單。刻意不當成「系統內建固定項目」，按一下帶進主檔之後
   就是業者自己的資料，可以增刪改——每一家的配備本來就不一樣，
   而點交單上出現房間裡沒有的東西，房客第一個反應就是不信任整張單。
   鑰匙與門禁卡也放在這裡：它們同樣是「交付、清點、歸還、遺失要賠」，
   另立一套結構只會讓同一件事有兩個地方要維護。 */
var HO_EQUIP_SEED = [
  ['冷氣', 1], ['電視', 1], ['電冰箱', 1], ['洗衣機', 1], ['熱水器', 1],
  ['瓦斯爐／電磁爐', 1], ['抽油煙機', 1], ['床架', 1], ['床墊', 1], ['衣櫃', 1],
  ['書桌', 1], ['椅子', 1], ['窗簾', 1], ['燈具', 1], ['對講機', 1],
  ['門鎖', 1], ['鑰匙', 2], ['門禁卡', 1], ['住宅用火災警報器', 1],
  ['馬桶', 1], ['洗手台', 1], ['蓮蓬頭', 1], ['浴室排風扇', 1], ['曬衣架', 1]
];

var HO_ST_OPTS    = ['ok', 'bad', 'missing', 'na'];
var HO_FAULT_OPTS = ['', 'tenant', 'wear', 'pre'];

var HO_STATUS_UI = {
  pending: { label: '待簽收', color: '#e67700', bg: '#fff3bf' },
  signed:  { label: '已簽收', color: '#2f9e44', bg: '#ebfbee' },
  void:    { label: '已作廢', color: '#868e96', bg: '#f1f3f5' }
};

/* ══════════════════════════════════════════════════════════════════
   設備主檔
   ══════════════════════════════════════════════════════════════════ */
function hoEquipAll() { return Cloud.get(HO_KV_EQUIP, {}) || {}; }
function hoSaveEquipAll(o) { Cloud.set(HO_KV_EQUIP, o); }

/* 回 { items, src }。src='room' 房間自訂、'default' 沿用館別預設、'none' 都沒有。
   「沿用館別預設」是常態：一棟樓二十間房的配備幾乎一樣，逼業者填二十次
   只會換來二十份互相矛盾的清單。 */
function hoEquipFor(propId, room) {
  var p = hoEquipAll()[String(propId)] || {};
  var r = p[String(room)];
  if (Array.isArray(r) && r.length) return { items: r, src: 'room' };
  var d = p._default;
  if (Array.isArray(d) && d.length) return { items: d, src: 'default' };
  return { items: [], src: 'none' };
}

var HO_EQ = null;   /* 編輯中的設備主檔 { propId, room, items } */

/* 同仁可以點交，但不能改設備主檔——主檔就是點交時的對帳基準，
   改了之後退房對不起來的東西會無聲消失，連帶不會開出維修單。 */
function hoOpenEquip(propId, room) {
  if (typeof adminOnly === 'function' && !adminOnly('維護房間設備主檔'))return;
  hoEnsureUI();
  var cur = hoEquipFor(propId, room || '');
  /* 編輯「房間覆寫」時，若目前是沿用館別預設，先把預設複製進來當起點，
     而不是給一張空白表——空白表會讓人以為這間房什麼都沒有。 */
  var items = (cur.src === 'room' || !room) ? cur.items : (cur.src === 'default' ? cur.items : []);
  HO_EQ = {
    propId: String(propId), room: String(room || ''),
    items: items.map(function (x) {
      return { id: x.id || hoNewItemId(), name: x.name || '', qty: x.qty == null ? 1 : x.qty, note: x.note || '' };
    }),
    inherited: !!room && cur.src === 'default'
  };
  var cp = ctProp(propId) || {};
  document.getElementById('hoe-title').textContent =
    '🧰 設備主檔 — ' + (cp.name || propId) + (room ? ' · ' + room : '（館別預設）');
  hoRenderEquip();
  document.getElementById('hoe-ov').classList.add('open');
}
function hoCloseEquip() { document.getElementById('hoe-ov').classList.remove('open'); HO_EQ = null; }
function hoNewItemId() { return 'E' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

function hoRenderEquip() {
  var e = HO_EQ, h = '';
  h += '<div style="font-size:11.5px;color:var(--muted);line-height:1.8;margin-bottom:10px">' +
       (e.room
         ? '這是 <b>' + ctEsc(e.room) + '</b> 的專屬清單。儲存後這間房的點交單只會用這一份；' +
           '若把所有項目刪到剩 0 項再儲存，這間房會回頭沿用館別預設。'
         : '這是本館別的<b>預設清單</b>，所有沒有專屬清單的房間都會用它。' +
           '哪一間房配備不同，再從房源管理點進那一間單獨設定。') +
       (e.inherited ? '<br><span style="color:#e67700">目前這間房沿用館別預設，下面已先把預設帶進來當起點。</span>' : '') +
       '</div>';

  h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">' +
       '<button class="btn btn-ghost sm" onclick="hoSeedEquip()">📥 帶入常見設備（' + HO_EQUIP_SEED.length + ' 項）</button>' +
       '<button class="btn btn-ghost sm" onclick="hoAddEquip()">＋ 新增一項</button>' +
       '</div>';

  if (!e.items.length) {
    h += '<div style="padding:26px;text-align:center;color:var(--muted);font-size:12.5px;' +
         'background:var(--light);border-radius:8px">還沒有任何設備項目。' +
         '按上面的「帶入常見設備」最快，再刪掉沒有的、補上自己有的。</div>';
  } else {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
         '<tr style="background:var(--light)">' +
         ['項次', '項目名稱', '數量', '備註（規格、品牌、位置）', ''].map(function (t) {
           return '<th style="padding:5px 6px;text-align:left;border-bottom:1px solid var(--border)">' + t + '</th>';
         }).join('') + '</tr>';
    var st = 'width:100%;padding:4px 6px;border:1px solid var(--border);border-radius:5px;' +
             'font-size:12px;font-family:inherit';
    e.items.forEach(function (it, i) {
      h += '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:4px 6px;color:var(--muted)">' + (i + 1) + '</td>' +
        '<td style="padding:4px 6px"><input style="' + st + '" value="' + ctEsc(it.name) +
          '" oninput="HO_EQ.items[' + i + '].name=this.value"></td>' +
        '<td style="padding:4px 6px;width:70px"><input type="number" min="0" style="' + st +
          '" value="' + ctEsc(it.qty) + '" oninput="HO_EQ.items[' + i + '].qty=this.value"></td>' +
        '<td style="padding:4px 6px"><input style="' + st + '" value="' + ctEsc(it.note) +
          '" oninput="HO_EQ.items[' + i + '].note=this.value"></td>' +
        '<td style="padding:4px 6px;width:34px"><button class="btn btn-ghost sm" ' +
          'style="padding:2px 7px;color:#c92a2a" onclick="hoDelEquip(' + i + ')">✕</button></td>' +
        '</tr>';
    });
    h += '</table>';
  }
  document.getElementById('hoe-body').innerHTML = h;
  document.getElementById('hoe-msg').textContent = '';
}

function hoSeedEquip() {
  /* 已經有的項目不重複帶入，否則按兩次就會出現兩台冷氣 */
  var have = {};
  HO_EQ.items.forEach(function (it) { have[String(it.name).trim()] = 1; });
  HO_EQUIP_SEED.forEach(function (s) {
    if (have[s[0]]) return;
    HO_EQ.items.push({ id: hoNewItemId(), name: s[0], qty: s[1], note: '' });
  });
  HO_EQ.inherited = false;
  hoRenderEquip();
}
function hoAddEquip() {
  HO_EQ.items.push({ id: hoNewItemId(), name: '', qty: 1, note: '' });
  HO_EQ.inherited = false;
  hoRenderEquip();
}
function hoDelEquip(i) { HO_EQ.items.splice(i, 1); HO_EQ.inherited = false; hoRenderEquip(); }

function hoSaveEquip() {
  var e = HO_EQ;
  var items = e.items.filter(function (it) { return String(it.name || '').trim(); })
    .map(function (it) {
      var q = Number(it.qty);
      return { id: it.id, name: String(it.name).trim(),
               qty: isFinite(q) && q >= 0 ? q : 1, note: String(it.note || '').trim() };
    });
  var all = hoEquipAll();
  var key = String(e.propId);
  if (!all[key]) all[key] = {};
  var slot = e.room || '_default';
  if (items.length) all[key][slot] = items;
  else delete all[key][slot];
  hoSaveEquipAll(all);
  document.getElementById('hoe-msg').style.color = '#2f9e44';
  document.getElementById('hoe-msg').textContent =
    items.length ? ('✅ 已儲存 ' + items.length + ' 項') :
      (e.room ? '✅ 已清空，這間房將沿用館別預設' : '✅ 已清空館別預設');
  HO_EQ.items = items.map(function (x) { return { id: x.id, name: x.name, qty: x.qty, note: x.note }; });
  HO_EQ.inherited = false;
}

/* ══════════════════════════════════════════════════════════════════
   點交作業：從訂單組出點交單
   ══════════════════════════════════════════════════════════════════ */
var HO_CUR = null;   /* 編輯中的 snapshot */
var HO_CTX = null;   /* { kind, bkId, propId, room, no } */

function hoDraftKey(kind, bkId, propId, room) {
  return [kind, bkId, propId, room || ''].join('|');
}
function hoDrafts() { return Cloud.get(HO_KV_DRAFT, {}) || {}; }
function hoSaveDraft() {
  if (!HO_CTX) return;
  var all = hoDrafts();
  all[hoDraftKey(HO_CTX.kind, HO_CTX.bkId, HO_CTX.propId, HO_CTX.room)] =
    { items: HO_CUR.items, meter: HO_CUR.meter, note: HO_CUR.note, at: new Date().toISOString() };
  Cloud.set(HO_KV_DRAFT, all);
}
function hoDropDraft(kind, bkId, propId, room) {
  var all = hoDrafts();
  delete all[hoDraftKey(kind, bkId, propId, room)];
  Cloud.set(HO_KV_DRAFT, all);
}

/* 編號：種類＋年份＋當年流水號。和契約編號同一套規則。 */
function hoMakeNo(kind, list) {
  var pfx = kind === 'in' ? '入交' : '退交';
  var y = new Date().getFullYear();
  var n = (list || []).filter(function (h) {
    return h.kind === kind && String(h.no || '').indexOf(pfx + '-' + y + '-') === 0;
  }).length + 1;
  return pfx + '-' + y + '-' + String(n).padStart(4, '0');
}

/* 同一筆訂單、同一房間、同一種點交只能有一份有效的單——資料庫有唯一索引擋著，
   前端先找出來才能給出「複製既有連結」而不是撞進一個看不懂的資料庫錯誤。 */
function hoFindLive(list, kind, bkId, propId, room) {
  return (list || []).find(function (h) {
    return h.kind === kind && h.status !== 'void' &&
      ctSameId(h.booking_id, bkId) &&
      String(h.prop_id || '') === String(propId || '') &&
      String(h.room || '') === String(room || '');
  }) || null;
}

/* 從訂單視窗進來時還不知道要點交哪一間：一筆訂單可以有好幾個住宿區段
   （同一組客人訂兩間、或中途換房）。只有一間就直接進去，多於一間才讓人選，
   不預設挑第一間——挑錯房間的點交單等於一張廢紙，而且還會占掉唯一索引。 */
async function hoStartFromBk(kind, bookingId) {
  hoEnsureUI();
  var bk = loadBks().find(function (b) { return ctSameId(b.id, bookingId); });
  if (!bk) { alert('找不到這筆訂單'); return; }
  var segs = (bk.segments || []).filter(function (s) { return s.status !== 'cancelled'; });
  if (!segs.length) { alert('這筆訂單沒有可點交的住宿區段'); return; }
  if (segs.length === 1) { await hoStart(kind, bk.id, segs[0].prop_id, segs[0].room); return; }

  var list = await Cloud.listHandovers();
  var HR = window.HandoverRender;
  var h = '<div style="font-size:12.5px;line-height:1.9;margin-bottom:10px">' +
    '這筆訂單有 ' + segs.length + ' 個住宿區段，請選擇要做「' + HR.KIND_SHORT[kind] + '」的房間。</div>';
  segs.forEach(function (s) {
    var cp = ctProp(s.prop_id) || {};
    var live = hoFindLive(list, kind, bk.id, s.prop_id, s.room);
    var eq = hoEquipFor(s.prop_id, s.room);
    h += '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;' +
      'border-bottom:1px solid var(--border);font-size:12px">' +
      '<div style="flex:1"><b>' + ctEsc(cp.name || s.prop_id) + ' · ' + ctEsc(s.room) + '</b><br>' +
      '<span style="color:var(--muted);font-size:11px">' + ctEsc(s.checkin || '') + ' ～ ' +
      ctEsc(s.checkout || '') + '　設備 ' + eq.items.length + ' 項' +
      (live ? '　已有' + (live.status === 'signed' ? '已簽收' : '待簽收') + '單 ' + ctEsc(live.no) : '') +
      '</span></div>' +
      '<button class="btn btn-primary sm" onclick="hoStart(\'' + kind + '\',\'' + ctEsc(bk.id) +
      '\',\'' + ctEsc(s.prop_id) + '\',\'' + ctEsc(s.room) + '\')">選這間</button></div>';
  });
  document.getElementById('hol-body').innerHTML = h;
  document.getElementById('hol-ov').classList.add('open');
}

async function hoStart(kind, bookingId, propId, room) {
  hoEnsureUI();
  var bk = loadBks().find(function (b) { return ctSameId(b.id, bookingId); });
  if (!bk) { alert('找不到這筆訂單'); return; }
  var segs = (bk.segments || []).filter(function (s) { return s.status !== 'cancelled'; });
  var seg = propId
    ? segs.find(function (s) { return ctSameId(s.prop_id, propId) && String(s.room) === String(room); })
    : segs[0];
  if (!seg) { alert('這筆訂單沒有可點交的住宿區段'); return; }

  var list = await Cloud.listHandovers();
  var live = hoFindLive(list, kind, bk.id, seg.prop_id, seg.room);
  if (live) {
    if (live.status === 'signed') {
      alert('這個房間的' + HandoverRender.KIND_SHORT[kind] + '單（' + live.no +
            '）房客已經簽收了。\n已簽收的點交單不能修改，要重做請先在「點交管理」把它作廢。');
      hoView(live.id);
      return;
    }
    if (!confirm('這個房間已經有一份待簽收的' + HandoverRender.KIND_SHORT[kind] + '單（' + live.no + '）。\n\n' +
                 '按「確定」撤回那一份並重新點交（舊連結立刻失效），\n' +
                 '按「取消」保留它（可到「點交管理」複製連結）。')) {
      hoOpenList();
      return;
    }
    if (!await Cloud.deleteHandover(live.id)) return;
    list = await Cloud.listHandovers();
  }

  var d = hoBuild(kind, bk, seg, list);
  if (!d) return;
  HO_CUR = d;
  HO_CTX = { kind: kind, bkId: String(bk.id), propId: String(seg.prop_id),
             room: String(seg.room || ''), no: d.no };

  /* 已簽收的入住點交單是退房比對的基準，要從資料庫把完整 snapshot 抓回來。
     清單查詢刻意不帶 snapshot（列表只要摘要），所以這裡多一次查詢。 */
  if (kind === 'out') {
    var baseRow = (list || []).find(function (h) {
      return h.kind === 'in' && h.status === 'signed' &&
        ctSameId(h.booking_id, bk.id) &&
        String(h.prop_id || '') === String(seg.prop_id) &&
        String(h.room || '') === String(seg.room || '');
    });
    if (baseRow) {
      var full = await Cloud.getHandover(baseRow.id);
      if (full && full.snapshot && Array.isArray(full.snapshot.items)) {
        HO_CUR.base = { no: full.no, on: full.snapshot.on || '', items: full.snapshot.items };
      }
    }
  }

  hoRenderWork();
  /* 從點交管理或區段選擇器進來的，把那層關掉再開作業視窗：
     兩層 overlay 疊著，使用者關掉上面一層會看到一份已經過期的清單。 */
  hoCloseList();
  document.getElementById('how-ov').classList.add('open');
}

/* 把系統資料對應到點交單欄位。
   草稿只還原「人填的那一部分」（狀態、歸責、金額、說明、照片、備註），
   當事人／標的／租期／入住基準一律重新帶入最新資料——那些是系統的事實，
   草稿存著反而會把三天前的舊房名印到單上。 */
function hoBuild(kind, bk, seg, list) {
  var HR = window.HandoverRender;
  var d = HR.blank(kind);
  var sg = (Cloud.get(CT_KV_SIGNER, {}) || {}).biz || {};
  var cp = ctProp(seg.prop_id) || {};

  d.no = hoMakeNo(kind, list);
  d.on = todayStr();
  d.by = Cloud.myDisplayName || Cloud.myEmail || '';
  d.co = { name: sg.name || '', taxid: sg.taxid || '', tel: sg.tel || '', addr: sg.addr || '' };
  d.guest = { name: bk.guest || '', phone: bk.phone || '' };
  d.prop = { id: String(seg.prop_id), name: cp.name || '',
             addr: cp.address || '', room: String(seg.room || '') };
  d.period = { checkin: seg.checkin || '', checkout: seg.checkout || '' };

  /* 主檔的備註（規格、品牌、位置）併進項目名稱，不另開欄位：
     「冷氣（客廳窗型 Hitachi）」要印在單上才有意義——退房時爭的往往就是
     「你說的那台冷氣是哪一台」。另存一個欄位但渲染器不印，等於白存。 */
  var eq = hoEquipFor(seg.prop_id, seg.room);
  d.items = eq.items.map(function (x) {
    return { id: x.id, qty: x.qty,
             name: x.note ? x.name + '（' + x.note + '）' : x.name,
             st: 'ok', note: '', fault: '', cost: '', photos: [] };
  });

  /* 水電度數讀退房結算的抄表資料，不另外存一份。同一個電表讀數在兩個地方
     各填一次，遲早會出現點交單寫 1200、結算單寫 1250 的情形，而房客簽的是前者。 */
  var m = stMeters()[stMeterKey(bk.id, seg.prop_id, seg.room)] || {};
  d.meter = { inE: m.inE == null ? '' : m.inE, outE: m.outE == null ? '' : m.outE,
              inW: m.inW == null ? '' : m.inW, outW: m.outW == null ? '' : m.outW,
              inOn: m.inOn || (kind === 'in' ? todayStr() : ''),
              outOn: m.outOn || (kind === 'out' ? todayStr() : '') };

  var dr = hoDrafts()[hoDraftKey(kind, bk.id, seg.prop_id, seg.room)];
  if (dr) {
    var byId = {};
    (dr.items || []).forEach(function (x) { byId[String(x.id)] = x; });
    d.items.forEach(function (it) {
      var o = byId[String(it.id)];
      if (!o) return;   /* 設備主檔後來新增的項目，草稿裡沒有，保持預設 */
      it.st = HO_ST_OPTS.indexOf(o.st) >= 0 ? o.st : 'ok';
      it.note = o.note || '';
      it.fault = HO_FAULT_OPTS.indexOf(o.fault) >= 0 ? o.fault : '';
      it.cost = o.cost == null ? '' : o.cost;
      it.photos = Array.isArray(o.photos) ? o.photos : [];
    });
    if (dr.meter) ['inE', 'outE', 'inW', 'outW', 'inOn', 'outOn'].forEach(function (k) {
      if (dr.meter[k] !== '' && dr.meter[k] != null) d.meter[k] = dr.meter[k];
    });
    d.note = dr.note || '';
    d.draftAt = dr.at || '';
  }
  return d;
}

function hoCloseWork() {
  document.getElementById('how-ov').classList.remove('open');
  HO_CUR = null; HO_CTX = null;
}

function hoRenderWork() {
  var HR = window.HandoverRender, d = HO_CUR, out = d.kind === 'out';
  document.getElementById('how-title').textContent =
    HR.KIND_LABEL[d.kind] + '　' + d.no + '　' + (d.prop.name || '') +
    (d.prop.room ? ' · ' + d.prop.room : '');

  var h = '';
  h += '<div style="font-size:11.5px;color:var(--muted);line-height:1.8;margin-bottom:10px">' +
       '房客：<b>' + ctEsc(d.guest.name || '（訂單未填）') + '</b>　' +
       '核對手機：<b>' + ctEsc(d.guest.phone || '（訂單未填）') + '</b>　' +
       '租期：' + ctEsc(d.period.checkin || '—') + ' ～ ' + ctEsc(d.period.checkout || '—') + '<br>' +
       (out
         ? '每一項都要逐一確認。標為「損壞」或「缺少」時才需要選歸責、填賠償金額、上傳照片；' +
           '只有「可歸責於房客」的金額會列入合計並自動開立維修單帶進退房結算。'
         : '這一張是日後退房比對的基準，所以「現在就是壞的」一定要當場標出來——' +
           '沒標出來，退房時就會被算成房客弄壞的。') +
       (d.draftAt ? '<br><span style="color:#e67700">已還原 ' + ctEsc(ctTW(d.draftAt, true)) +
                    ' 的現場草稿。</span>' : '') +
       '</div>';

  if (!d.items.length) {
    h += '<div style="background:#fff5f5;border:1px solid #ffc9c9;border-radius:8px;padding:14px;' +
         'font-size:12.5px;line-height:1.9">這個房間還沒有設備清單，無法點交。' +
         '<br><button class="btn btn-primary sm" style="margin-top:8px" onclick="hoOpenEquip(\'' +
         ctEsc(d.prop.id) + '\',\'' + ctEsc(d.prop.room) + '\')">🧰 先建立設備主檔</button></div>';
  } else {
    h += '<div id="ho-grid">' + hoGridHtml() + '</div>';
  }

  h += hoMeterHtml();

  h += '<div style="margin-top:12px">' +
       '<div style="font-size:12px;font-weight:700;margin-bottom:4px">其他約定或備註（會印在單上）</div>' +
       '<textarea id="ho-note" rows="2" style="width:100%;padding:6px 8px;border:1px solid var(--border);' +
       'border-radius:6px;font-size:12px;font-family:inherit" ' +
       'oninput="HO_CUR.note=this.value" onchange="hoSaveDraft()">' + ctEsc(d.note || '') + '</textarea></div>';

  h += '<div id="ho-chk"></div>';
  document.getElementById('how-body').innerHTML = h;
  hoSyncChecks();
}

function hoGridHtml() {
  var HR = window.HandoverRender, d = HO_CUR, out = d.kind === 'out';
  var baseMap = {};
  var hasBase = !!(d.base && Array.isArray(d.base.items));
  if (hasBase) d.base.items.forEach(function (b) { baseMap[String(b.id)] = b; });

  var h = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">' +
          '<div style="font-size:12px;font-weight:700">設備與現況（' + d.items.length + ' 項）</div>' +
          '<button class="btn btn-ghost sm" style="padding:2px 8px" onclick="hoAllOk()">全部標為正常</button>' +
          '<span style="flex:1"></span><div id="ho-sum" style="font-size:12px;font-weight:700"></div></div>';

  if (out && !hasBase) {
    h += '<div style="background:#fff4e6;border:1px solid #ffc078;border-radius:8px;padding:8px 11px;' +
         'font-size:11.5px;line-height:1.8;margin-bottom:7px">' +
         '這筆訂單沒有已簽收的入住點交單，單上「入住時」一欄會印「無入住點交紀錄」。' +
         '沒有基準時，房客主張「本來就壞的」在爭議中通常站得住腳，認定損壞請保守一些。</div>';
  } else if (out) {
    h += '<div style="font-size:11.5px;color:var(--muted);margin-bottom:7px">' +
         '比對基準：入住點交單 ' + ctEsc(d.base.no || '') +
         (d.base.on ? '（' + ctEsc(d.base.on) + '）' : '') + '</div>';
  }

  var st = 'width:100%;padding:3px 5px;border:1px solid var(--border);border-radius:5px;' +
           'font-size:11.5px;font-family:inherit';
  var cols = ['#', '項目'];
  if (out && hasBase) cols.push('入住時');
  cols.push(out ? '退房時現況' : '現況');
  if (out) cols.push('歸責', '估定賠償');
  cols.push('說明／照片');

  h += '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
       '<tr style="background:var(--light)">' + cols.map(function (t) {
         return '<th style="padding:5px 6px;text-align:left;border-bottom:1px solid var(--border);' +
                'white-space:nowrap">' + t + '</th>';
       }).join('') + '</tr>';

  d.items.forEach(function (it, i) {
    var bad = it.st === 'bad' || it.st === 'missing';
    h += '<tr style="border-bottom:1px solid var(--border)' + (bad ? ';background:#fff9f9' : '') + '">' +
      '<td style="padding:4px 6px;color:var(--muted)">' + (i + 1) + '</td>' +
      '<td style="padding:4px 6px"><b>' + ctEsc(it.name) + '</b>' +
        (it.qty != null && it.qty !== '' && Number(it.qty) !== 1 ? ' ×' + ctEsc(it.qty) : '') +
        '</td>';
    if (out && hasBase) {
      var b = baseMap[String(it.id)];
      h += '<td style="padding:4px 6px;color:var(--muted);white-space:nowrap">' +
           (b ? ctEsc(HR.ST_SHORT[b.st] || '—') : '未列於入住單') + '</td>';
    }
    h += '<td style="padding:4px 6px;width:104px"><select style="' + st + '" ' +
         'onchange="hoSetSt(' + i + ',this.value)">' +
         HO_ST_OPTS.map(function (k) {
           return '<option value="' + k + '"' + (it.st === k ? ' selected' : '') + '>' +
                  ctEsc(HR.ST_LABEL[k]) + '</option>';
         }).join('') + '</select></td>';
    if (out) {
      h += '<td style="padding:4px 6px;width:120px">' +
           (bad ? '<select style="' + st + '" onchange="hoSetFault(' + i + ',this.value)">' +
             HO_FAULT_OPTS.map(function (k) {
               return '<option value="' + k + '"' + (it.fault === k ? ' selected' : '') + '>' +
                      (k ? ctEsc(HR.FAULT_LABEL[k]) : '— 請選擇 —') + '</option>';
             }).join('') + '</select>' : '<span style="color:var(--muted)">—</span>') + '</td>';
      h += '<td style="padding:4px 6px;width:88px">' +
           (bad && it.fault === 'tenant'
             ? '<input type="number" min="0" step="1" style="' + st + '" value="' + ctEsc(it.cost) +
               '" placeholder="0" oninput="hoSetCost(' + i + ',this.value)" onchange="hoSaveDraft()">'
             : '<span style="color:var(--muted)">' + (bad ? '不計賠' : '—') + '</span>') + '</td>';
    }
    h += '<td style="padding:4px 6px">' +
         (bad
           ? '<input style="' + st + '" value="' + ctEsc(it.note) +
             '" placeholder="例：面板裂開約 10 公分" oninput="HO_CUR.items[' + i +
             '].note=this.value" onchange="hoSaveDraft()">' + hoPhotoHtml(i)
           : '<input style="' + st + '" value="' + ctEsc(it.note) +
             '" placeholder="（選填）" oninput="HO_CUR.items[' + i +
             '].note=this.value" onchange="hoSaveDraft()">' +
             ((it.photos || []).length
               ? '<div style="font-size:10.5px;color:#e67700;margin-top:3px">狀態已改回「' +
                 ctEsc(HR.ST_LABEL[it.st]) + '」，先前上傳的 ' + it.photos.length +
                 ' 張照片不會印在單上。</div>' : '')) +
         '</td></tr>';
  });
  h += '</table>';
  return h;
}

/* 只有標記異狀的項目才讓上傳照片。二十項設備每項三張原圖，一個房間就吃掉
   幾十 MB；真正有爭議的永遠只是那兩三項，把額度留給它們。 */
function hoPhotoHtml(i) {
  var ph = HO_CUR.items[i].photos || [];
  var h = '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px" id="ho-ph-' + i + '">';
  ph.forEach(function (u, j) {
    h += '<span style="position:relative;display:inline-block">' +
         '<a href="' + ctEsc(u) + '" target="_blank"><img src="' + ctEsc(u) +
         '" style="height:42px;width:42px;object-fit:cover;border:1px solid var(--border);border-radius:4px"></a>' +
         '<button onclick="hoDelPhoto(' + i + ',' + j + ')" title="移除這張照片" ' +
         'style="position:absolute;top:-5px;right:-5px;width:16px;height:16px;line-height:14px;' +
         'border:none;border-radius:50%;background:#c92a2a;color:#fff;font-size:10px;cursor:pointer">✕</button>' +
         '</span>';
  });
  h += '<label class="btn btn-ghost sm" style="padding:2px 8px;cursor:pointer;margin:0">📷 照片' +
       '<input type="file" accept="image/*" multiple style="display:none" ' +
       'onchange="hoUploadPhotos(' + i + ',this)"></label>' +
       '<span style="font-size:10.5px;color:var(--muted)" id="ho-phmsg-' + i + '"></span></div>';
  return h;
}

function hoSetSt(i, val) {
  var it = HO_CUR.items[i];
  it.st = val;
  /* 狀態改回正常／無此項時，歸責與金額一定要跟著清掉。留著的話畫面上看不到，
     但金額還在資料裡，印出來的合計就會多出一筆沒人解釋得了的錢。 */
  if (val !== 'bad' && val !== 'missing') { it.fault = ''; it.cost = ''; }
  hoSaveDraft();
  hoRedrawGrid();
}
function hoSetFault(i, val) {
  var it = HO_CUR.items[i];
  it.fault = val;
  if (val !== 'tenant') it.cost = '';
  hoSaveDraft();
  hoRedrawGrid();
}
function hoSetCost(i, val) {
  HO_CUR.items[i].cost = val;
  hoSyncSum();
  hoSyncChecks();
}
function hoAllOk() {
  if (!confirm('把全部 ' + HO_CUR.items.length + ' 項標為「堪用正常」？\n已填的歸責與賠償金額會一併清除。')) return;
  HO_CUR.items.forEach(function (it) { it.st = 'ok'; it.fault = ''; it.cost = ''; });
  hoSaveDraft();
  hoRedrawGrid();
}

/* 只重畫表格這一塊，不重畫整個視窗：水電度數與備註欄是使用者正在打字的地方，
   整份 innerHTML 重設會讓游標跳掉、已輸入但還沒觸發 change 的值也會不見。 */
function hoRedrawGrid() {
  var box = document.getElementById('ho-grid');
  if (!box) return;
  box.innerHTML = hoGridHtml();
  hoSyncChecks();
}

function hoSyncSum() {
  var el = document.getElementById('ho-sum');
  if (!el) return;
  var s = window.HandoverRender.sumOf(HO_CUR.items);
  if (HO_CUR.kind !== 'out') {
    el.innerHTML = '損壞 ' + s.bad + ' 項、缺少 ' + s.missing + ' 項';
    el.style.color = (s.bad + s.missing) ? '#c92a2a' : 'var(--muted)';
    return;
  }
  el.innerHTML = '損壞 ' + s.bad + '、缺少 ' + s.missing +
                 '　應賠償合計 <span style="font-size:14px">' + money(s.charge) + '</span>';
  el.style.color = s.charge > 0 ? '#c92a2a' : 'var(--muted)';
}

async function hoUploadPhotos(i, input) {
  var files = [].slice.call(input.files);
  if (!files.length) return;
  var msg = document.getElementById('ho-phmsg-' + i);
  input.disabled = true;
  var ok = [], fail = [];
  for (var k = 0; k < files.length; k++) {
    if (msg) msg.textContent = '上傳中… ' + (k + 1) + ' / ' + files.length;
    try { ok.push(await Cloud.uploadPhoto(files[k], HO_CTX.propId, HO_CTX.room)); }
    catch (e) { fail.push(files[k].name + '：' + e.message); }
  }
  input.disabled = false; input.value = '';
  if (ok.length) {
    HO_CUR.items[i].photos = (HO_CUR.items[i].photos || []).concat(ok);
    hoSaveDraft();
  }
  hoRedrawGrid();
  if (fail.length) alert('以下照片未能上傳：\n\n' + fail.join('\n'));
}
async function hoDelPhoto(i, j) {
  var list = (HO_CUR.items[i].photos || []).slice();
  var url = list[j];
  if (!url) return;
  if (!confirm('移除這張現況照片？移除後無法復原。')) return;
  list.splice(j, 1);
  HO_CUR.items[i].photos = list;
  hoSaveDraft();
  hoRedrawGrid();
  await Cloud.deletePhoto(url);
}

/* ── 水電表 ─────────────────────────────────────────── */
function hoMeterHtml() {
  var d = HO_CUR, out = d.kind === 'out', m = d.meter || {};
  var st = 'width:100%;padding:4px 6px;border:1px solid var(--border);border-radius:5px;' +
           'font-size:12px;font-family:inherit';
  var f = function (k, label, type) {
    return '<div><label style="font-size:10.5px;color:var(--muted);display:block">' + label + '</label>' +
      '<input type="' + (type || 'number') + '"' + (type ? '' : ' step="any" min="0"') +
      ' style="' + st + '" value="' + ctEsc(m[k] == null ? '' : m[k]) +
      '" oninput="HO_CUR.meter[\'' + k + '\']=this.value" onchange="hoMeterChanged()"></div>';
  };
  var cfg = stCfg();
  return '<div style="margin-top:14px;background:var(--light);border-radius:8px;padding:10px 12px">' +
    '<div style="font-size:12px;font-weight:700;margin-bottom:3px">水電表抄錄</div>' +
    '<div style="font-size:11px;color:var(--muted);line-height:1.8;margin-bottom:7px">' +
    '這裡填的度數會<b>同時寫進退房結算的抄表資料</b>，兩邊永遠是同一筆，不必填兩次。' +
    (cfg.waterMode === 'meter' ? '' : '目前水費設定為「每月定額」，水表度數可留空。') + '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px">' +
    f('inE', '入住電表（度）') + (out ? f('outE', '退房電表（度）') : '') +
    f('inW', '入住水表') + (out ? f('outW', '退房水表') : '') +
    f(out ? 'outOn' : 'inOn', '抄表日期', 'date') +
    '</div></div>';
}
/* 寫回 qj_meters。只覆蓋這次有填的欄位，不把對方欄位清成空字串——
   退房點交不該把入住度數洗掉。 */
function hoMeterChanged() {
  hoSaveDraft();
  var all = stMeters();
  var key = stMeterKey(HO_CTX.bkId, HO_CTX.propId, HO_CTX.room);
  var rec = all[key] || {};
  var m = HO_CUR.meter || {};
  ['inE', 'outE', 'inW', 'outW', 'inOn', 'outOn'].forEach(function (k) {
    if (m[k] !== '' && m[k] != null) rec[k] = m[k];
  });
  rec.at = new Date().toISOString();
  rec.by = Cloud.myDisplayName || Cloud.myEmail || '';
  all[key] = rec;
  stSaveMeters(all);
  hoSyncChecks();
}

/* ── 定稿 ───────────────────────────────────────────── */
/* 預覽、檢查、產生連結全部走這一份，確保畫面上看到的、檢查過的、
   房客簽的是同一個物件。四個度數都空的時候把 meter 設成 null：
   渲染器看 meter 是否存在來決定要不要印那一段，留著空物件會印出一張
   全是空格的水電表，房客會以為自己簽的單漏了東西。 */
function hoFinal() {
  var d = JSON.parse(JSON.stringify(HO_CUR));
  var m = d.meter || {};
  var any = ['inE', 'outE', 'inW', 'outW'].some(function (k) {
    return m[k] !== '' && m[k] != null;
  });
  if (!any) d.meter = null;
  delete d.draftAt;
  return d;
}

/* ── 檢查結果 ───────────────────────────────────────── */
function hoSyncChecks() {
  hoSyncSum();
  var box = document.getElementById('ho-chk');
  if (!box) return;
  var vr = window.HandoverRender.validate(hoFinal());
  var h = '';
  if (!vr.ok) {
    h += '<div style="background:#fff5f5;border:1px solid #ffc9c9;border-radius:8px;padding:10px 12px;' +
         'font-size:12px;line-height:1.9;margin-top:10px"><b style="color:#c92a2a">' +
         '以下問題必須先處理，否則無法產生簽收連結：</b><br>' +
         vr.errors.map(function (e) { return '• ' + ctEsc(e); }).join('<br>') + '</div>';
  }
  if (vr.warnings.length) {
    h += '<div style="background:#fff9db;border:1px solid #f0d58c;border-radius:8px;padding:10px 12px;' +
         'font-size:12px;line-height:1.9;margin-top:10px"><b style="color:#8a6d00">' +
         '提醒（不影響產生連結，但事後有爭議時這些就是缺的證據）：</b><br>' +
         vr.warnings.map(function (e) { return '• ' + ctEsc(e); }).join('<br>') + '</div>';
  }
  box.innerHTML = h;
  var btn = document.getElementById('how-ok');
  if (btn) btn.disabled = !vr.ok;
}

function hoPreview() {
  hoOpenPaper(window.HandoverRender.render(hoFinal()), HO_CUR.no + '（草稿預覽）',
    '這是<b>草稿預覽</b>，還沒有產生簽收連結，房客也還沒簽。黃底是系統帶入的欄位。');
}

/* 預覽與檢視都開新視窗：css/contract.css 會改掉 body 的字型、底色與 @page，
   直接 link 進排房系統會把整個畫面與列印版面一起弄壞。 */
function hoOpenPaper(html, title, head) {
  var w = window.open('', '_blank');
  if (!w) { alert('瀏覽器阻擋了新視窗，請允許彈出視窗後再試'); return; }
  w.document.write('<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">' +
    '<title>' + ctEsc(title) + '</title><link rel="stylesheet" href="css/contract.css"></head>' +
    '<body><div class="warnbar">' + head +
    '<button onclick="window.print()" style="margin-left:10px">🖨 列印／儲存 PDF</button></div>' +
    html + '</body></html>');
  w.document.close();
}

async function hoCreate() {
  var fin = hoFinal();
  var vr = window.HandoverRender.validate(fin);
  if (!vr.ok) { alert('資料還不完整：\n\n' + vr.errors.join('\n')); return; }
  var s = window.HandoverRender.sumOf(fin.items);
  var ask = '即將產生 ' + HO_CUR.no + ' 的簽收連結。\n\n' +
    (HO_CUR.kind === 'out'
      ? '房客簽收的就是這張單上的金額：應賠償合計 ' + money(s.charge) + ' 元。\n' +
        '簽收後單據內容鎖定不可修改，金額會自動開立維修單帶進退房結算。\n' +
        '預估金額與實際修復費用的差額由貴公司自行吸收。\n\n'
      : '這張單會成為退房點交的比對基準，簽收後不可修改。\n\n') +
    '確定產生嗎？';
  if (!confirm(ask)) return;

  var btn = document.getElementById('how-ok');
  btn.disabled = true; btn.textContent = '產生中…';
  var r = await Cloud.createHandover({
    kind: fin.kind, no: fin.no,
    bookingId: HO_CTX.bkId, propId: HO_CTX.propId, room: HO_CTX.room,
    signerName: fin.guest.name, signerPhone: fin.guest.phone,
    snapshot: fin
  });
  btn.disabled = false; btn.textContent = '🔗 產生簽收連結';
  if (!r) return;

  hoDropDraft(HO_CTX.kind, HO_CTX.bkId, HO_CTX.propId, HO_CTX.room);
  var no = HO_CUR.no;
  hoCloseWork();
  hoShowLink(r.url, no);
}

function hoShowLink(url, no) {
  hoEnsureUI();
  document.getElementById('hol-body').innerHTML =
    '<div style="font-size:12.5px;line-height:1.9">' +
    '<b>' + ctEsc(no) + '</b> 已建立，狀態為「待簽收」。<br>' +
    '把連結給房客，或直接拿現場的手機／平板打開讓房客當場簽。' +
    '房客不需要帳號，只要輸入訂單上登記的手機號碼就能簽收。</div>' +
    '<div style="margin:12px 0;padding:10px 12px;background:var(--light);border-radius:8px;' +
    'font-size:12px;word-break:break-all" id="ho-url">' + ctEsc(url) + '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn btn-primary sm" onclick="hoCopyShown()">📋 複製連結</button>' +
    '<a class="btn btn-ghost sm" href="' + ctEsc(url) + '" target="_blank" style="text-decoration:none">' +
    '🔗 現在就打開讓房客簽</a>' +
    '<button class="btn btn-ghost sm" onclick="hoOpenList()">📋 回點交管理</button></div>' +
    '<div style="font-size:11px;color:var(--muted);margin-top:10px;line-height:1.8">' +
    '簽收後內容即鎖定不可修改。要更正只能整份作廢並重新點交，' +
    '作廢紀錄與原簽名會一併保留，不會被刪掉。</div>';
  document.getElementById('hol-ov').classList.add('open');
}
function hoCopy(txt) {
  navigator.clipboard.writeText(txt).then(function () { alert('✅ 簽收連結已複製'); },
    function () { alert('複製失敗，請手動選取連結文字'); });
}
function hoCopyShown() { hoCopy(document.getElementById('ho-url').textContent); }

/* ══════════════════════════════════════════════════════════════════
   點交管理
   ══════════════════════════════════════════════════════════════════ */
async function hoOpenList() {
  hoEnsureUI();
  document.getElementById('hol-body').innerHTML =
    '<div style="padding:30px;text-align:center;color:var(--muted)">載入中…</div>';
  document.getElementById('hol-ov').classList.add('open');
  await hoRenderList();
}
function hoCloseList() {
  document.getElementById('hol-ov').classList.remove('open');
  /* 在面板裡建了點交單、作廢、或讓系統對帳過之後，待辦數就變了。
     關閉時重算一次，否則選單紅點會一直停在進來之前的舊數字。 */
  if (typeof refreshHoBadge === 'function') refreshHoBadge();
}

async function hoRenderList() {
  var HR = window.HandoverRender;
  var list = await Cloud.listHandovers();
  var made = await hoReconcile(list);
  var nameOf = {};
  loadCPs().forEach(function (p) { nameOf[p.id] = p.name; });

  var h = '';
  if (made) {
    /* 新開的維修單會影響排房表上的房況與維修追蹤的數字，不重畫的話
       使用者要關掉視窗再重新整理才看得到，會以為「說開了卻沒開」。 */
    if (typeof render === 'function') render();
    h += '<div style="background:#ebfbee;border:1px solid #8ce99a;border-radius:8px;padding:9px 12px;' +
         'font-size:12px;line-height:1.8;margin-bottom:10px">已依簽收的退房點交單自動開立 <b>' + made +
         '</b> 張「房客自行負擔」維修單，金額會出現在退房結算的損壞扣抵。' +
         '維修追蹤裡可以再指派廠商、調整金額。</div>';
  }
  h += hoTodoBlock(list, nameOf);

  h += '<div style="font-size:12px;font-weight:700;margin:0 0 6px">點交單清單（' + list.length + '）</div>';
  if (!list.length) {
    h += '<div style="padding:26px;text-align:center;color:var(--muted);font-size:12.5px">' +
         '還沒有任何點交單。先到房源管理替館別建立「設備主檔」，' +
         '再從訂單視窗按「入住點交」或「退房點交」。</div>';
  } else {
    h += '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
         '<tr style="background:var(--light)">' +
         ['種類', '單號', '館別 · 房號', '房客', '狀態', '建立', '簽收', '操作'].map(function (t) {
           return '<th style="padding:6px 7px;text-align:left;border-bottom:1px solid var(--border);' +
                  'white-space:nowrap">' + t + '</th>';
         }).join('') + '</tr>';
    list.forEach(function (x) {
      var s = HO_STATUS_UI[x.status] || { label: x.status, color: '#495057', bg: '#f1f3f5' };
      h += '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:6px 7px;white-space:nowrap">' + ctEsc(HR.KIND_SHORT[x.kind] || x.kind) + '</td>' +
        '<td style="padding:6px 7px;white-space:nowrap"><code style="font-size:10.5px">' +
          ctEsc(x.no) + '</code></td>' +
        '<td style="padding:6px 7px">' + ctEsc(nameOf[x.prop_id] || '—') +
          (x.room ? ' · ' + ctEsc(x.room) : '') + '</td>' +
        '<td style="padding:6px 7px">' + ctEsc(x.signer_name || '—') + '</td>' +
        '<td style="padding:6px 7px;white-space:nowrap"><span style="display:inline-block;' +
          'padding:2px 8px;border-radius:999px;background:' + s.bg + ';color:' + s.color +
          ';font-weight:700">' + s.label + '</span>' +
          (x.status === 'pending' && x.opened_at
            ? '<br><span style="font-size:10px;color:var(--muted)">已開啟未簽</span>' : '') + '</td>' +
        '<td style="padding:6px 7px;white-space:nowrap">' + ctEsc(ctTW(x.created_at)) + '</td>' +
        '<td style="padding:6px 7px;white-space:nowrap">' + ctEsc(ctTW(x.signed_at) || '—') + '</td>' +
        '<td style="padding:6px 7px;white-space:nowrap">' + hoRowActions(x) + '</td>' +
        '</tr>';
    });
    h += '</table>';
  }
  document.getElementById('hol-body').innerHTML = h;
}

function hoRowActions(x) {
  var s = '<button class="btn btn-ghost sm" style="padding:3px 8px" ' +
          'onclick="hoView(\'' + x.id + '\')">檢視</button> ';
  if (x.status !== 'void')
    s += '<button class="btn btn-ghost sm" style="padding:3px 8px" ' +
         'onclick="hoCopy(Cloud.handoverUrl(\'' + x.token + '\'))">複製連結</button> ';
  if (x.status === 'pending')
    s += '<button class="btn btn-ghost sm" style="padding:3px 8px;color:#c92a2a" ' +
         'onclick="hoDelete(\'' + x.id + '\',\'' + ctEsc(x.no) + '\')">撤回</button>';
  if (x.status === 'signed')
    s += '<button class="btn btn-ghost sm" style="padding:3px 8px;color:#c92a2a" ' +
         'onclick="hoVoid(\'' + x.id + '\',\'' + ctEsc(x.no) + '\')">作廢</button>';
  return s;
}

/* 系統知道「這間房已經入住／已經退房了」，但還沒有點交單。
   這是最常被忘掉的一件事——退房當天忙著收鑰匙，隔週要扣押金才發現沒有憑據。

   待辦清單與選單上的紅點共用這一支：兩邊各算一次的話，紅點顯示 3
   而清單只列出 2 筆，使用者會一直點進來找那筆不存在的待辦。 */
function hoPendingSegs(list) {
  var out = [];
  loadBks().forEach(function (b) {
    (b.segments || []).forEach(function (sg) {
      if (sg.status !== 'checkin' && sg.status !== 'checkout') return;
      var kind = sg.status === 'checkin' ? 'in' : 'out';
      if (hoFindLive(list, kind, b.id, sg.prop_id, sg.room)) return;
      out.push({ bk: b, seg: sg, kind: kind, eq: hoEquipFor(sg.prop_id, sg.room) });
    });
  });
  return out;
}

/* 選單紅點用。刻意不另外算一遍，而是直接走同一條路。 */
async function hoTodoCount() {
  if (!Cloud.isLoggedIn || !Cloud.isLoggedIn()) return 0;
  var list = await Cloud.listHandovers();
  var stale = list.filter(function (x) {
    return x.status === 'pending' && x.opened_at &&
      (Date.now() - new Date(x.opened_at).getTime()) > 3 * 86400000;
  });
  return hoPendingSegs(list).length + (stale.length ? 1 : 0);
}

function hoTodoBlock(list, nameOf) {
  var items = [];
  var sgName = ((Cloud.get(CT_KV_SIGNER, {}) || {}).biz || {}).name;
  if (!String(sgName || '').trim())
    items.push(['#c92a2a', '「簽約主體設定」還沒填公司名稱，目前無法產生任何點交單。',
      '<button class="btn btn-primary sm" style="padding:3px 9px" onclick="ctOpenSigner()">去設定</button>']);

  hoPendingSegs(list).forEach(function (p) {
    var sg = p.seg, b = p.bk, kind = p.kind;
    var where = (nameOf[sg.prop_id] || '') + (sg.room ? ' · ' + sg.room : '');
    if (!p.eq.items.length) {
      items.push(['#c92a2a', where + '（' + (b.guest || '') + '）還沒有設備清單，無法點交。',
        '<button class="btn btn-primary sm" style="padding:3px 9px" onclick="hoOpenEquip(\'' +
        ctEsc(sg.prop_id) + '\',\'\')">🧰 建立設備主檔</button>']);
      return;
    }
    items.push([kind === 'out' ? '#c92a2a' : '#e67700',
      where + '（' + (b.guest || '') + '）' +
      (kind === 'in' ? '已入住（' + (sg.checkin || '') + '）但尚未做入住點交，' +
                       '退房時將沒有比對基準。'
                     : '已退房（' + (sg.checkout || '') + '）但尚未做退房點交，' +
                       '押金扣抵缺少憑據。'),
      '<button class="btn btn-primary sm" style="padding:3px 9px" onclick="hoStart(\'' + kind +
      '\',\'' + ctEsc(b.id) + '\',\'' + ctEsc(sg.prop_id) + '\',\'' + ctEsc(sg.room) + '\')">' +
      (kind === 'in' ? '📋 入住點交' : '📋 退房點交') + '</button>']);
  });

  var stale = list.filter(function (x) {
    return x.status === 'pending' && x.opened_at &&
      (Date.now() - new Date(x.opened_at).getTime()) > 3 * 86400000;
  });
  if (stale.length)
    items.push(['#e67700', '有 ' + stale.length + ' 份點交單房客已開啟超過三天但還沒簽（' +
      stale.map(function (x) { return x.no; }).join('、') + '），建議當面確認。', '']);

  if (!items.length) return '';
  /* 清單可能很長（一整棟樓同時換約），超過十筆就收起來，不然真正要看的
     「清單下面有哪些單」會被推到看不見的地方。 */
  var show = items.slice(0, 10), rest = items.length - show.length;
  return '<div style="border:1px solid #f0d58c;background:#fff9db;border-radius:8px;' +
    'padding:10px 12px;margin-bottom:12px"><div style="font-size:12px;font-weight:700;' +
    'margin-bottom:6px">🔔 點交待辦（' + items.length + '）</div>' +
    show.map(function (it) {
      return '<div style="display:flex;gap:8px;align-items:center;font-size:11.5px;' +
        'line-height:1.8;padding:3px 0"><span style="color:' + it[0] + ';flex:1">' +
        ctEsc(it[1]) + '</span>' + it[2] + '</div>';
    }).join('') +
    (rest > 0 ? '<div style="font-size:11px;color:var(--muted);padding-top:4px">' +
      '另有 ' + rest + ' 筆同類待辦，處理完上面幾筆後會繼續顯示。</div>' : '') +
    '</div>';
}

async function hoView(id) {
  var x = await Cloud.getHandover(id);
  if (!x) return;
  var snap = x.snapshot || {};
  if (!snap.sign) snap.sign = {};
  if (x.sig_img) snap.sign.sigImg = x.sig_img;
  var head;
  if (x.status === 'signed') {
    head = '房客已於 <b>' + ctEsc(ctTW(x.signed_at, true)) + '</b> 簽收。' +
      'IP：' + ctEsc(x.signer_ip || '—') +
      '　內容指紋：' + ctEsc(x.content_hash || '—') +
      '　<b>此點交單已鎖定，內容不可修改。</b>';
  } else if (x.status === 'void') {
    head = '此點交單<b>已作廢</b>。' + (x.void_reason ? '原因：' + ctEsc(x.void_reason) : '');
  } else {
    head = '此點交單<b>房客尚未簽收</b>（首次開啟時間：' +
      ctEsc(x.opened_at ? ctTW(x.opened_at, true) : '尚未開啟') + '）。';
  }
  hoOpenPaper(window.HandoverRender.render(snap), x.no, head);
}

async function hoVoid(id, no) {
  var reason = prompt('作廢點交單 ' + no + '。\n已簽收的點交單是押金扣抵的依據，系統不會刪除它，' +
    '而是標記為作廢並留下原因；原簽名與時間戳一併保留。\n\n請輸入作廢原因：');
  if (reason === null) return;
  if (!reason.trim()) { alert('請輸入作廢原因'); return; }
  if (!await Cloud.voidHandover(id, reason.trim())) return;
  hoVoidTasks(id, no);
  await hoRenderList();
}

/* 作廢後處理它自動開立的維修單。
   不處理的話會出現最糟的一種狀況：點交單已作廢（匯出表上扣抵歸零），
   但維修單還在，退房結算照樣扣房客 3,200 元——而作廢的理由通常正是
   「金額填錯」。兩個數字不一致、而且錯的那個還真的被扣了錢。

   只動「還沒有人碰過」的單（todo、未指派廠商／處理人、未填實際完成日）。
   已經派工或已完工的維修單代表東西真的修了、錢真的花了，不該因為一張
   單據作廢就被系統刪掉，那會把實際支出憑空消滅；這些只列出來請人自己判斷。 */
function hoVoidTasks(id, no) {
  var map = Cloud.get(HO_KV_TASK, {}) || {};
  var ids = map[id];
  if (!Array.isArray(ids) || !ids.length) return;

  var tasks = loadTasks();
  var byId = {};
  tasks.forEach(function (t) { byId[t.id] = t; });
  var free = [], busy = [];
  ids.forEach(function (tid) {
    var t = byId[tid];
    if (!t) return;                                  /* 早就被手動刪掉了 */
    var touched = t.status !== 'todo' || t.doneAt || t.handler || t.vendorId;
    (touched ? busy : free).push(t);
  });
  if (!free.length && !busy.length) return;

  var desc = function (t) {
    return '　· ' + (t.room || '') + '　' + money(Number(t.cost) || 0) + ' 元　' +
           String(t.note || '').replace(/^退房點交 \S+ 認定：/, '');
  };
  if (free.length) {
    if (confirm('這張點交單自動開立了 ' + free.length + ' 張「房客自行負擔」維修單，\n' +
      '金額合計 ' + money(free.reduce(function (a, t) { return a + (Number(t.cost) || 0); }, 0)) +
      ' 元，目前仍會扣在退房結算上：\n' + free.map(desc).join('\n') +
      '\n\n一併刪除嗎？\n' +
      '按「確定」刪除（結算上的損壞賠償同步歸零，建議作廢金額填錯的單時選這個）。\n' +
      '按「取消」保留（損壞仍會扣款，請自行到維修追蹤調整金額）。')) {
      var drop = {};
      free.forEach(function (t) { drop[t.id] = 1; });
      saveTasks(tasks.filter(function (t) { return !drop[t.id]; }));
      /* 標記留著、內容清空：代表「這張單對帳過了，但單子已作廢」。
         刪掉標記的話，reconcile 下次雖然因為 status 已是 void 而不會補建，
         但紀錄上就看不出這些維修單是從哪來的。 */
      map[id] = [];
      Cloud.set(HO_KV_TASK, map);
      if (typeof render === 'function') render();
    }
  }
  if (busy.length) {
    alert('另有 ' + busy.length + ' 張維修單已經派工或已完工，系統不會自動刪除' +
      '（刪掉等於把實際發生的支出憑空抹掉）：\n' + busy.map(desc).join('\n') +
      '\n\n請自行到「🔧 維修追蹤」判斷要不要調整。');
  }
}
async function hoDelete(id, no) {
  if (!confirm('撤回尚未簽收的點交單 ' + no + '？\n連結會立刻失效，房客開啟時會看到「連結無效」。')) return;
  if (await Cloud.deleteHandover(id)) await hoRenderList();
}

/* ══════════════════════════════════════════════════════════════════
   匯出（供 exportCompanyData 呼叫）
   ══════════════════════════════════════════════════════════════════
   拆成兩張工作表，而不是「一個項目一列」攤平成一張：
   一張單有二十幾個項目，若每個項目都出一列，一棟樓一年的點交就是上萬列，
   而其中 99% 是「正常」——真正要查的異常被埋在裡面。所以
   「點交單」一張單一列（看哪些單存在、狀態、合計），
   「點交異常明細」只列損壞／缺少的項目（看錢是怎麼算出來的）。

   所有欄位都取自 snapshot，不回頭查現在的房源資料：點交單是證據，
   上面寫的館名與租期就該是當時簽的那份，館別日後改名也不該被改寫。
   ══════════════════════════════════════════════════════════════════ */
async function hoExportRows() {
  var HR = window.HandoverRender;
  var empty = { sheet: [], items: [] };
  if (!HR || !Cloud.isLoggedIn || !Cloud.isLoggedIn()) return empty;
  var list = await Cloud.exportHandovers();
  if (!list.length) return empty;

  var sheet = [], items = [];
  list.forEach(function (x) {
    var s = x.snapshot || {};
    var sum = HR.sumOf(s.items);
    var where = (s.prop && s.prop.name) || '';
    var room = (s.prop && s.prop.room) || x.room || '';
    var st = HO_STATUS_UI[x.status] ? HO_STATUS_UI[x.status].label : (x.status || '');
    sheet.push({
      單號: x.no || '', 類型: HR.KIND_SHORT[x.kind] || x.kind || '',
      館別: where, 房號: room,
      房客: (s.guest && s.guest.name) || x.signer_name || '',
      訂單編號: x.booking_id || '',
      入住日: (s.period && s.period.checkin) || '', 退房日: (s.period && s.period.checkout) || '',
      點交日期: s.on || '', 點交人員: s.by || '',
      項目數: (s.items || []).length, 損壞項數: sum.bad, 缺少項數: sum.missing,
      估價總額: sum.cost, 應賠償合計: sum.charge,
      狀態: st,
      房客開啟時間: x.opened_at ? ctTW(x.opened_at, true) : '',
      簽收時間: x.signed_at ? ctTW(x.signed_at, true) : '',
      作廢原因: x.void_reason || '',
      建立時間: x.created_at ? ctTW(x.created_at, true) : ''
    });

    /* 已作廢的單仍然列進異常明細，但「實際扣抵」一律歸零。
       整列不列的話，日後有人問「那張 3,200 元是怎麼不見的」就查不到；
       照原金額列的話，把這一欄加總起來又會比結算單多出已作廢的錢。
       兩害相權，留列、金額歸零，狀態欄寫明已作廢。 */
    var dead = x.status === 'void';
    (s.items || []).forEach(function (it) {
      if (it.st !== 'bad' && it.st !== 'missing') return;
      items.push({
        單號: x.no || '', 類型: HR.KIND_SHORT[x.kind] || x.kind || '',
        館別: where, 房號: room,
        房客: (s.guest && s.guest.name) || x.signer_name || '',
        退房日: (s.period && s.period.checkout) || '',
        設備項目: it.name || '',
        狀態: HR.ST_LABEL[it.st] || it.st || '',
        歸責: it.fault ? (HR.FAULT_LABEL[it.fault] || it.fault) : '',
        現況說明: it.note || '',
        /* 只有可歸責於房客才會進結算扣抵，所以兩欄分開：估價是現場填的，
           實際扣押金的是右邊那一欄。混成一欄會讓會計以為耗損也要收錢。 */
        估價金額: Number(it.cost) || 0,
        實際扣抵: (!dead && it.fault === 'tenant') ? (Number(it.cost) || 0) : 0,
        照片張數: (it.photos || []).filter(Boolean).length,
        點交單狀態: HO_STATUS_UI[x.status] ? HO_STATUS_UI[x.status].label : (x.status || '')
      });
    });
  });
  return { sheet: sheet, items: items };
}

/* ══════════════════════════════════════════════════════════════════
   簽收後：自動開立「房客自行負擔」維修單
   ══════════════════════════════════════════════════════════════════
   為什麼用對帳式補建、而不是在簽收那一刻寫：簽收是房客在自己手機上完成的，
   那時候後台沒有人在線，沒有任何程式可以跑。所以改成每次打開點交管理時
   比對「哪些已簽收的退房單還沒開過維修單」，缺的補上。

   qj_hotask 記錄「這份點交單已經對帳過了」。它存在就不再補建——業者若是
   刻意把自動開的維修單刪掉，系統不該下次開視窗時又長回來。
   ══════════════════════════════════════════════════════════════════ */
async function hoReconcile(list) {
  var map = Cloud.get(HO_KV_TASK, {}) || {};
  var need = (list || []).filter(function (x) {
    return x.kind === 'out' && x.status === 'signed' && !map[x.id];
  });
  if (!need.length) return 0;

  var tasks = loadTasks(), made = 0, touched = false;
  for (var i = 0; i < need.length; i++) {
    var x = await Cloud.getHandover(need[i].id);
    if (!x) continue;               /* 讀取失敗就先不要標記，下次再試 */
    var snap = x.snapshot || {};
    var ids = [];
    /* 維修日期用退房日：結算的損壞比對窗是「入住日 ～ 退房日＋退款作業天數」，
       退房日一定落在窗內。用簽收日的話，房客拖到兩週後才簽就會掉出窗外，
       金額靜默消失在結算單上。 */
    var start = (snap.period && snap.period.checkout) || x.created_at &&
                String(x.created_at).slice(0, 10) || todayStr();
    (snap.items || []).forEach(function (it) {
      var bad = it.st === 'bad' || it.st === 'missing';
      var c = Number(it.cost) || 0;
      if (!bad || it.fault !== 'tenant' || !(c > 0)) return;
      var tid = genId('TK');
      tasks.push({
        id: tid, prop_id: x.prop_id, room: x.room, type: 'repair',
        start: start, end: addDays(start, 1),
        note: '退房點交 ' + x.no + ' 認定：' + (it.name || '') +
              (it.st === 'missing' ? '（缺少）' : '（損壞）') +
              (it.note ? ' — ' + it.note : ''),
        isAuto: false, bookingId: x.booking_id || null, complaintId: null,
        handoverId: x.id, handoverItem: it.id || '',
        status: 'todo', handler: '', vendorId: '', cat: '', dueDate: '',
        cost: c, billing: 'tenant',
        /* 刻意用「可續住」：自動產生的單只是為了把金額帶進結算，
           擅自用「需淨空」會把該房間的可售期整段擋掉，業者會莫名其妙接不到單。
           真的需要淨空施工，由人到維修追蹤改。 */
        blocking: 'occupied',
        doneAt: '', hist: pushTkHist({}, 'todo'),
        createdAt: new Date().toISOString(),
        updatedBy: Cloud.myDisplayName || Cloud.myEmail || ''
      });
      ids.push(tid);
    });
    map[x.id] = ids;
    made += ids.length;
    touched = true;
  }
  if (made) saveTasks(tasks);
  if (touched) Cloud.set(HO_KV_TASK, map);
  return made;
}

/* ══════════════════════════════════════════════════════════════════
   Modal 骨架（第一次用到時才插入 DOM）
   ══════════════════════════════════════════════════════════════════ */
var HO_UI_READY = false;
function hoEnsureUI() {
  if (HO_UI_READY) return;
  HO_UI_READY = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="overlay" id="hoe-ov" onclick="if(event.target===this)hoCloseEquip()">' +
    '<div class="modal" style="width:720px;max-width:97vw">' +
    '<div class="modal-h"><h2 id="hoe-title">🧰 設備主檔</h2>' +
    '<button class="close-btn" onclick="hoCloseEquip()">✕</button></div>' +
    '<div class="modal-body" style="max-height:66vh;overflow-y:auto" id="hoe-body"></div>' +
    '<div class="modal-f"><div id="hoe-msg" style="font-size:11.5px;font-weight:700;flex:1"></div>' +
    '<button class="btn btn-ghost" onclick="hoCloseEquip()">關閉</button>' +
    '<button class="btn btn-primary" onclick="hoSaveEquip()">💾 儲存</button></div>' +
    '</div></div>' +

    '<div class="overlay" id="how-ov" onclick="if(event.target===this)hoCloseWork()">' +
    '<div class="modal" style="width:1040px;max-width:98vw">' +
    '<div class="modal-h"><h2 id="how-title" style="font-size:15px">點交作業</h2>' +
    '<button class="close-btn" onclick="hoCloseWork()">✕</button></div>' +
    '<div class="modal-body" style="max-height:72vh;overflow-y:auto" id="how-body"></div>' +
    '<div class="modal-f">' +
    '<span style="font-size:11px;color:var(--muted);flex:1">填寫內容會自動存成現場草稿，' +
    '中途關掉再開回來不會不見。</span>' +
    '<button class="btn btn-ghost" onclick="hoPreview()">👁 預覽單據</button>' +
    '<button class="btn btn-ghost" onclick="hoCloseWork()">關閉</button>' +
    '<button class="btn btn-primary" id="how-ok" onclick="hoCreate()">🔗 產生簽收連結</button></div>' +
    '</div></div>' +

    '<div class="overlay" id="hol-ov" onclick="if(event.target===this)hoCloseList()">' +
    '<div class="modal" style="width:1000px;max-width:98vw">' +
    '<div class="modal-h"><h2>📋 入住／退房點交</h2>' +
    '<button class="close-btn" onclick="hoCloseList()">✕</button></div>' +
    '<div class="modal-body" style="max-height:74vh;overflow-y:auto" id="hol-body"></div>' +
    '<div class="modal-f">' +
    '<span style="font-size:11px;color:var(--muted);flex:1">設備主檔在「房源管理」各館別／各房間的按鈕裡。</span>' +
    '<button class="btn btn-primary" onclick="hoCloseList()">關閉</button></div>' +
    '</div></div>'
  );
}
