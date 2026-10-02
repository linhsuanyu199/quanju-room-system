/* ══════════════════════════════════════════════════════════════════
   房東客戶建檔
   ------------------------------------------------------------------
   原本的「客戶列表」只有房客：buildCustomerIndex() 整張表都是從 qj_bks
   訂單推導出來的，而房東永遠不會出現在訂單裡。房東資料其實早就存在系統
   中，只是散落在「管理房源 → 館別 → 📋 契約設定 → 房東資料」底下、
   一個館別一份，所以
     ① 同一位房東名下有三個館，就要分別填三次；
     ② 系統裡沒有任何地方看得到「這位房東名下有哪些館、合計幾間房、
        契約什麼時候到期、錢要撥到哪個帳戶」。

   設計原則與租金台帳一致：**房東主檔一律從館別契約設定推導，不另外建一份
   名冊**。歸戶鍵是房東電話去掉所有非數字後的字串，所以 0912-345-678 與
   0912345678 會自動併成同一位房東（契約設定是人工輸入，這種格式差異幾乎
   一定會發生）。生日／祝福同意／歸屬業務／備註這些契約上沒有的欄位，另存
   覆蓋層 qj_landlords，與房客的 qj_customers 同一個套路。

   為什麼不把房東併進「客戶列表」？房東與房客要看的欄位幾乎沒有交集——
   房客看的是入住紀錄與風險燈號，房東看的是契約到期與撥款金額；權限敏感度
   也不同（房東資料含身分證字號與戶籍地址）。硬併成一張表只會讓兩邊都難用。
   兩邊真正共用的只有「祝福提醒」，所以只把那一支打通。
   ══════════════════════════════════════════════════════════════════ */
'use strict';

var LD_KV = 'qj_landlords';   /* { 電話數字: {owner,birthday,optIn,note,email} } */
var LD_SVC_KIND = { '包租': 'bz', '代租代管': 'wg' };
var LD_METHOD = { transfer: '轉帳', cash: '現金', other: '其他', deduct: '於代收租金內扣付' };

function ldKey(tel) { return String(tel == null ? '' : tel).replace(/\D/g, ''); }
function ldLoad() { return Cloud.get(LD_KV, {}) || {}; }
function ldSave(o) { Cloud.set(LD_KV, o); }
function ldSetFields(key, f) {
  if (!key) return;
  var all = ldLoad();
  all[key] = Object.assign({}, all[key] || {}, f,
    { updatedAt: new Date().toISOString(), updatedBy: Cloud.myDisplayName || Cloud.myEmail });
  ldSave(all);
}

/* 一個館別的房東契約摘要。包租與代管的費用欄位完全不同，所以分開讀，
   但輸出統一成同一組欄位名，下游（清單、詳情、撥款單）才不必到處分支。 */
function ldBrief(p, d) {
  var kind = LD_SVC_KIND[p.serviceType] || '';
  var b = {
    id: String(p.id), name: p.name || '', serviceType: p.serviceType || '', kind: kind,
    rooms: (p.rooms || []).length,
    from: '', to: '', rent: 0, payUnit: '月', periods: '', payDay: '', method: '',
    feeMode: '', feePct: 0, feeAmt: 0, collectRent: false,
    bank: '', acctName: '', acctNo: ''
  };
  if (kind === 'bz') {
    var r = (d.bz && d.bz.rent) || {}, t = (d.bz && d.bz.term) || {};
    b.from = t.from || ''; b.to = t.to || '';
    b.rent = Number(r.monthly) || 0;
    b.payUnit = r.payUnit || '月'; b.periods = r.periods || ''; b.payDay = r.payDay || '';
    b.method = r.method || '';
    b.bank = r.bank || ''; b.acctName = r.acctName || ''; b.acctNo = r.acctNo || '';
  } else if (kind === 'wg') {
    var f = (d.wg && d.wg.fee) || {}, t2 = (d.wg && d.wg.term) || {}, op = (d.wg && d.wg.opt) || {};
    b.from = t2.from || ''; b.to = t2.to || '';
    b.feeMode = f.mode || 'pct';
    b.feePct = Number(f.pct) || 0;
    b.feeAmt = Number(f.amount) || 0;
    b.payUnit = f.payUnit || '月'; b.periods = f.periods || ''; b.payDay = f.payDay || '';
    b.method = f.method || '';
    b.collectRent = op.collectRent === true;
    b.bank = f.bank || ''; b.acctName = f.acctName || ''; b.acctNo = f.acctNo || '';
  }
  return b;
}

/* 報酬／租金的一句話描述，清單與撥款單共用 */
function ldFeeText(b) {
  if (b.kind === 'bz') return b.rent > 0 ? '保證租金 ' + money(b.rent) + ' / 月' : '未填月租金';
  if (b.kind === 'wg') {
    if (b.feeMode === 'fix') return b.feeAmt > 0 ? '服務報酬 ' + money(b.feeAmt) + ' / 月' : '未填固定報酬';
    return b.feePct > 0 ? '服務報酬 月租金 ' + b.feePct + '%' : '未填報酬比例';
  }
  return '—';
}
function ldAcctText(b) {
  if (!b.bank && !b.acctNo) return '';
  return [b.bank, b.acctName, b.acctNo].filter(Boolean).join(' / ');
}

function ldIndex() {
  var cd = Cloud.get('qj_cdata', {}) || {};
  var over = ldLoad();
  var tod = todayStr();
  var map = {};
  getAllProps().forEach(function (p) {
    if (!LD_SVC_KIND[p.serviceType]) return;   /* 自有房源沒有房東 */
    var d = cd[String(p.id)] || {};
    var o = d.owner || {};
    var key = ldKey(o.tel);
    if (!key) return;                          /* 沒電話無法歸戶，由 ldPropsMissing() 另外列出 */
    var rec = map[key];
    if (!rec) {
      rec = map[key] = {
        key: key, tel: o.tel || '', name: '', idNo: '', hukou: '', mail: '', email: '',
        names: [], props: [], roomCnt: 0
      };
    }
    if (o.name && rec.names.indexOf(o.name) < 0) rec.names.push(o.name);
    ['idNo', 'hukou', 'mail', 'email'].forEach(function (f) {
      if (!rec[f] && o[f]) rec[f] = o[f];
    });
    var b = ldBrief(p, d);
    rec.props.push(b);
    rec.roomCnt += b.rooms;
  });
  return Object.keys(map).map(function (k) {
    var rec = map[k], r = over[k] || {};
    rec.name = rec.names[0] || '（未填姓名）';
    /* 同一支電話在不同館別填了不同姓名，通常是打錯字或夫妻共有只寫其中一人。
       自動選一個會讓契約與撥款單署名錯人，所以標出來讓業者自己去改。 */
    rec.nameConflict = rec.names.length > 1;
    rec.owner = r.owner || '';
    rec.birthday = r.birthday || '';
    rec.optIn = r.optIn === true;
    rec.crmNote = r.note || '';
    if (r.email) rec.email = r.email;
    /* 契約到期：名下任一館別已經過期的優先顯示（過期還在收租＝無契約在管，
       是最該處理的狀況），都沒過期才顯示最快到期的那一份。 */
    var ends = rec.props.map(function (b) { return b.to; }).filter(Boolean).sort();
    var past = ends.filter(function (x) { return x < tod; });
    rec.termEnd = past.length ? past[past.length - 1] : (ends[0] || '');
    rec.termExpired = !!(rec.termEnd && rec.termEnd < tod);
    rec.termDays = rec.termEnd ? diffDays(tod, rec.termEnd) : null;
    rec.noTerm = ends.length < rec.props.length;
    /* 祝福提醒沿用房客那一套，而房客是以電話當 key。房東與房客有可能是
       同一支電話（把自己的房子委託出去、又在別館租房並非不可能），所以
       房東另外帶一個 gid 加 L| 前綴，寄送紀錄才不會互相覆蓋。 */
    rec.gid = 'L|' + k;
    rec.phone = rec.tel || k;
    rec.isLord = true;
    return rec;
  }).sort(function (a, b) {
    return (b.roomCnt - a.roomCnt) || a.name.localeCompare(b.name);
  });
}

/* 服務類型是包租／代租代管、卻還沒填房東姓名或電話的館別。
   少了這兩欄就無法歸戶，也無法產生房東契約與撥款單。 */
function ldPropsMissing() {
  var cd = Cloud.get('qj_cdata', {}) || {};
  return getAllProps().filter(function (p) {
    if (!LD_SVC_KIND[p.serviceType]) return false;
    var o = ((cd[String(p.id)] || {}).owner) || {};
    return !ldKey(o.tel) || !o.name;
  });
}

/* 房東資料含身分證字號與戶籍地址，比房客資料更敏感，所以一般成員只看得到
   歸屬給自己的房東。未歸屬的不顯示，但會提示有幾位待管理者指派，
   否則成員只會看到一張空表、以為系統壞了。 */
function ldVisible() {
  var all = ldIndex();
  if (isAdmin()) return all;
  var me = Cloud.myDisplayName || '';
  return all.filter(function (r) { return r.owner === me; });
}
function ldHidden() {
  if (isAdmin()) return 0;
  var me = Cloud.myDisplayName || '';
  return ldIndex().filter(function (r) { return r.owner !== me; }).length;
}

/* 祝福提醒用的名單。欄位名刻意與 buildCustomerIndex() 對齊
   （name / phone / email / optIn / owner / birthday / gid），
   這樣 index.html 的 custRow()、greetKey() 完全不必為房東改寫。 */
function ldGreetList() { return ldVisible(); }

function lordGreetContent(c, kind, fkey) {
  var me = Cloud.myDisplayName || '';
  if (kind === 'bday') {
    return {
      subject: '生日快樂！敬祝 ' + c.name + ' 房東 平安順心',
      body: c.name + ' 房東您好：\n\n' +
        '在這個特別的日子，我們全體同仁祝您生日快樂、平安順心。\n' +
        '感謝您將房屋交由我們管理，這份信任是我們最重要的資產。\n\n' +
        '物件管理或收益上若有任何想調整的地方，隨時與我們聯繫。\n\n' +
        '短租團隊　' + me + ' 敬上\n' + GREET_OPTOUT
    };
  }
  var f = FESTIVALS.find(function (x) { return x.key === fkey; }) || FESTIVALS[0];
  return {
    subject: f.name + '祝福｜敬賀 ' + c.name + ' 房東',
    body: c.name + ' 房東您好：\n\n' +
      f.name + '將至，謹向您與家人獻上誠摯的祝福，願您佳節愉快、身體健康。\n' +
      '感謝您長期以來的委託與信任，我們會持續把您的房子照顧好。\n\n' +
      '短租團隊　' + me + ' 敬上\n' + GREET_OPTOUT
  };
}

/* 匯出 Excel 一般成員也能用（⚙️ 更多 → 匯出資料），所以這裡走 ldVisible()，
   和「客戶」工作表只匯出自己的客戶是同一個規則。 */
function ldExportRows() {
  return ldVisible().map(function (r) {
    return {
      房東姓名: r.name, 電話: r.tel, Email: r.email,
      戶籍地址: r.hukou, 通訊地址: r.mail,
      名下館別數: r.props.length, 名下房間數: r.roomCnt,
      館別明細: r.props.map(function (b) {
        return b.name + '（' + (b.serviceType || '未設') + '・' + ldFeeText(b) + '）';
      }).join('；'),
      最近契約到期日: r.termEnd, 契約是否已過期: r.termExpired ? '是' : '否',
      撥款帳戶: r.props.map(function (b) { return ldAcctText(b); }).filter(Boolean).join('；'),
      歸屬業務: r.owner, 生日: r.birthday,
      祝福同意: r.optIn ? '是' : '否', 備註: r.crmNote
    };
  });
}

/* ══════════════════════════════════════════════════════════════════
   UI
   ══════════════════════════════════════════════════════════════════ */
var LD_UI_READY = false;

function ldEnsureUI() {
  if (LD_UI_READY) return;
  LD_UI_READY = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="overlay" id="ld-ov" onclick="if(event.target===this)closeLandlords()">' +
    '<div class="modal" style="width:1040px;max-width:98vw">' +
    '<div class="modal-h"><h2 id="ld-title">🏠 房東建檔</h2>' +
    '<button class="close-btn" onclick="closeLandlords()">✕</button></div>' +
    '<div style="padding:10px 17px 4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<select class="sel" id="ld-f-kind" onchange="ldRender()">' +
        '<option value="">全部服務類型</option>' +
        '<option value="bz">只看包租</option>' +
        '<option value="wg">只看代租代管</option>' +
      '</select>' +
      '<input class="sel" id="ld-search" type="text" placeholder="搜尋房東／電話／館別" ' +
        'oninput="ldRender()" style="width:200px">' +
      '<label style="display:flex;align-items:center;gap:5px;font-size:11.5px;cursor:pointer">' +
        '<input type="checkbox" id="ld-f-term" onchange="ldRender()">契約 90 天內到期或已過期</label>' +
    '</div>' +
    '<div class="modal-body" style="max-height:66vh;overflow-y:auto" id="ld-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="closeLandlords()">關閉</button></div>' +
    '</div></div>' +

    '<div class="overlay" id="ldd-ov" onclick="if(event.target===this)ldCloseDetail()">' +
    '<div class="modal" style="width:820px;max-width:97vw">' +
    '<div class="modal-h"><h2 id="ldd-title">房東詳情</h2>' +
    '<button class="close-btn" onclick="ldCloseDetail()">✕</button></div>' +
    '<div class="modal-body" style="max-height:70vh;overflow-y:auto" id="ldd-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="ldCloseDetail()">關閉</button></div>' +
    '</div></div>');
}

function openLandlords() {
  ldEnsureUI();
  ldRender();
  document.getElementById('ld-ov').classList.add('open');
}
function closeLandlords() { document.getElementById('ld-ov').classList.remove('open'); }

function ldRender() {
  var q = (document.getElementById('ld-search').value || '').trim().toLowerCase();
  var fk = document.getElementById('ld-f-kind').value || '';
  var onlyTerm = document.getElementById('ld-f-term').checked;
  var all = ldVisible();
  var tod = todayStr();

  var list = all.filter(function (r) {
    if (fk && !r.props.some(function (b) { return b.kind === fk; })) return false;
    if (onlyTerm && !(r.termEnd && r.termDays !== null && r.termDays <= 90)) return false;
    if (!q) return true;
    return [r.name, r.tel, r.email, r.owner].concat(r.props.map(function (b) { return b.name; }))
      .join(' ').toLowerCase().indexOf(q) >= 0;
  });

  var propCnt = 0, roomCnt = 0, soon = 0;
  all.forEach(function (r) {
    propCnt += r.props.length; roomCnt += r.roomCnt;
    if (r.termEnd && r.termDays !== null && r.termDays <= 90) soon++;
  });
  var missing = isAdmin() ? ldPropsMissing() : [];
  var hidden = ldHidden();

  var h = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:11px">' +
    [['房東', all.length + ' 位'], ['名下館別', propCnt + ' 個'], ['名下房間', roomCnt + ' 間'],
     ['契約 90 天內到期／已過期', soon + ' 位']].map(function (x) {
      return '<div style="flex:1;min-width:130px;background:#f8fafc;border:1px solid var(--border);' +
        'border-radius:8px;padding:9px 11px">' +
        '<div style="font-size:10px;color:var(--muted)">' + x[0] + '</div>' +
        '<div style="font-size:16px;font-weight:700;margin-top:2px">' + x[1] + '</div></div>';
    }).join('') + '</div>';

  if (missing.length) {
    h += '<div style="background:#fff3bf;border:1px solid #ffd43b;border-radius:8px;padding:10px 12px;' +
      'margin-bottom:11px;font-size:11.5px;line-height:1.8">' +
      '<strong style="color:#a06000">有 ' + missing.length + ' 個館別還沒填房東姓名或電話</strong>' +
      '（服務類型是包租或代租代管，卻沒有房東資料，無法歸戶、也無法產生房東契約與撥款單）<br>' +
      missing.map(function (p) {
        return '<button class="btn btn-ghost sm" style="margin:4px 4px 0 0" ' +
          'onclick="ldGoProp(' + jsArg(p.id) + ')">📋 ' + escH(p.name) + ' 去補填</button>';
      }).join('') + '</div>';
  }
  if (hidden > 0) {
    h += '<div style="background:var(--primary-light);border-radius:8px;padding:9px 12px;' +
      'margin-bottom:11px;font-size:11.5px;color:var(--primary-d)">' +
      '另有 ' + hidden + ' 位房東未歸屬給您，因含身分證字號等個資而不顯示。' +
      '需要查看請請管理者在房東詳情中指定「歸屬業務」。</div>';
  }

  if (!list.length) {
    h += '<div style="padding:18px;background:#f8fafc;border-radius:8px;font-size:12px;color:var(--muted);line-height:1.9">' +
      (all.length ? '沒有符合條件的房東。' :
       /* 有被權限擋掉的房東時不能說「還沒有房東資料」，否則成員會以為是建檔漏了，
          跑去重複填一份。上面的藍色提示已經說明原因，這裡只要別講反話。 */
       hidden > 0 ? '沒有歸屬給您的房東。' :
        '目前還沒有房東資料。房東是從「管理房源 → 館別 → 📋 契約設定 → 房東資料」自動歸戶的：<br>' +
        '① 先把館別的服務類型設成「包租」或「代租代管」；② 再到該館別的契約設定填入房東姓名與電話。<br>' +
        '同一支電話的多個館別會自動併成一位房東，不必重複建檔。') + '</div>';
    document.getElementById('ld-body').innerHTML = h;
    return;
  }

  h += '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
    '<thead><tr style="background:#f8fafc;border-bottom:2px solid var(--border)">' +
    ['房東', '聯絡方式', '名下館別', '房間', '最近契約到期', '歸屬業務', '祝福', ''].map(function (x, i) {
      return '<th style="padding:7px 9px;text-align:' + (i === 7 ? 'right' : 'left') +
        ';color:var(--muted);font-size:10px;white-space:nowrap">' + x + '</th>';
    }).join('') + '</tr></thead><tbody>' +
    list.map(function (r) {
      var term = !r.termEnd
        ? '<span style="color:#e67700">未填契約期間</span>'
        : (r.termExpired
          ? '<span style="color:#c92a2a;font-weight:700">已過期 ' + Math.abs(r.termDays) + ' 天</span>'
          : (r.termDays <= 90
            ? '<span style="color:#e67700;font-weight:700">' + r.termDays + ' 天後到期</span>'
            : '<span style="color:var(--muted)">' + r.termDays + ' 天後到期</span>'));
      return '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:7px 9px"><strong>' + escH(r.name) + '</strong>' +
          (r.nameConflict ? '<span title="不同館別填的房東姓名不一致，請確認" ' +
            'style="margin-left:4px;color:#e67700">⚠</span>' : '') +
          (r.birthday ? '<div style="font-size:9.5px;color:var(--muted)">🎂 ' + escH(r.birthday) + '</div>' : '') +
        '</td>' +
        '<td style="padding:7px 9px;font-size:11px">' + escH(r.tel) +
          (r.email ? '<div style="font-size:9.5px;color:var(--muted)">' + escH(r.email) + '</div>' : '') +
        '</td>' +
        '<td style="padding:7px 9px;font-size:11px">' +
          r.props.map(function (b) {
            return escH(b.name) + '<span style="color:var(--muted)">（' + escH(b.serviceType) + '）</span>';
          }).join('<br>') + '</td>' +
        '<td style="padding:7px 9px;white-space:nowrap">' + r.roomCnt + ' 間</td>' +
        '<td style="padding:7px 9px;font-size:11px;white-space:nowrap">' +
          (r.termEnd ? escH(r.termEnd) + '<br>' : '') + term + '</td>' +
        '<td style="padding:7px 9px;font-size:11px">' + escH(r.owner || '—') + '</td>' +
        '<td style="padding:7px 9px;font-size:11px;white-space:nowrap">' +
          (r.optIn ? '<span style="color:#2f9e44;font-weight:700">✔ 同意</span>'
                   : '<span style="color:var(--muted)">未同意</span>') + '</td>' +
        '<td style="padding:7px 9px;text-align:right;white-space:nowrap">' +
          '<button class="btn btn-ghost sm" onclick="ldDetail(' + jsArg(r.key) + ')">詳情</button>' +
        '</td></tr>';
    }).join('') + '</tbody></table>' +
    '<div style="margin-top:12px;font-size:10.5px;color:var(--muted);line-height:1.8">' +
      '房東名冊是從各館別的「契約設定 → 房東資料」自動歸戶的，以<strong>電話</strong>為同一人的判斷依據' +
      '（忽略 - 與空白等格式差異）。姓名、身分證字號、地址請到館別的契約設定修改，' +
      '那裡才是契約的真實來源；生日、Email、歸屬業務、祝福同意與備註則在詳情中直接編輯。' +
    '</div>';
  document.getElementById('ld-body').innerHTML = h;
}

function ldGoProp(pid) {
  closeLandlords();
  ctOpenData(String(pid), 'owner');
}

/* 走 ldVisible() 而非 ldIndex()：詳情頁會把身分證字號與戶籍地址攤開，
   不能讓人用別處拿到的 key 直接呼叫 ldDetail() 繞過歸屬限制。 */
function ldFind(key) {
  return ldVisible().find(function (r) { return r.key === key; }) || null;
}

function ldDetail(key) {
  ldEnsureUI();
  var r = ldFind(key);
  if (!r) { alert('找不到這位房東，可能契約設定剛被其他成員改過，請重新開啟。'); return; }
  if (!isAdmin() && r.owner !== (Cloud.myDisplayName || '')) {
    alert('此房東目前歸屬於「' + (r.owner || '未指定') + '」，您沒有檢視權限。');
    return;
  }
  var tod = todayStr();
  var agents = Cloud.companyMembers || [];
  var inp = 'height:28px;font-size:11px;border:1px solid var(--border);border-radius:5px;padding:0 7px;width:100%;background:#fff';
  /* 身分證字號只顯示遮蔽版：名冊是日常查閱用的畫面，完整字號只有契約正文需要。 */
  var maskedId = r.idNo
    ? ((window.ContractRender && ContractRender.maskId) ? ContractRender.maskId(r.idNo) : r.idNo)
    : '—';

  document.getElementById('ldd-title').textContent =
    '🏠 ' + r.name + '（' + r.tel + '）— 名下 ' + r.props.length + ' 個館別・' + r.roomCnt + ' 間房';

  var h = '';
  if (r.nameConflict) {
    h += '<div style="background:#fff3bf;border:1px solid #ffd43b;border-radius:8px;padding:9px 12px;' +
      'margin-bottom:10px;font-size:11.5px;line-height:1.7">' +
      '⚠️ 這支電話在不同館別填了不同姓名：<strong>' + r.names.map(escH).join('、') + '</strong>。' +
      '契約與撥款單會用第一個，請到各館別的契約設定確認哪一個才對。</div>';
  }

  h += '<div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:11px 13px;margin-bottom:11px">' +
    '<div style="font-size:11.5px;font-weight:700;color:var(--primary);margin-bottom:7px">契約上的房東資料（唯讀）</div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
    [['姓名', r.name], ['身分證字號', maskedId], ['電話', r.tel],
     ['Email（契約）', r.email || '—'], ['戶籍地址', r.hukou || '—'], ['通訊地址', r.mail || '—']]
      .map(function (x) {
        return '<tr><td style="padding:3px 0;width:100px;color:var(--muted)">' + x[0] + '</td>' +
          '<td style="padding:3px 0">' + escH(x[1]) + '</td></tr>';
      }).join('') + '</table>' +
    '<div style="font-size:10px;color:var(--muted);margin-top:7px">' +
      '以上欄位是契約的法定必載內容，一律以館別的「📋 契約設定 → 房東資料」為真實來源，' +
      '要修改請在下方館別清單點「契約設定」。</div>' +
  '</div>';

  h += '<div style="font-size:11.5px;font-weight:700;color:var(--primary);margin:0 0 7px">名下館別與契約條件</div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
    '<thead><tr style="background:#f8fafc;border-bottom:2px solid var(--border)">' +
    ['館別', '服務類型', '房間', '契約期間', '租金／報酬', '撥款帳戶', ''].map(function (x, i) {
      return '<th style="padding:6px 8px;text-align:' + (i === 6 ? 'right' : 'left') +
        ';color:var(--muted);font-size:10px;white-space:nowrap">' + x + '</th>';
    }).join('') + '</tr></thead><tbody>' +
    r.props.map(function (b) {
      var termTxt = (b.from || b.to)
        ? escH(b.from || '?') + ' ~ ' + escH(b.to || '?') +
          (b.to && b.to < tod ? '<div style="color:#c92a2a;font-weight:700">已過期</div>' : '')
        : '<span style="color:#e67700">未填</span>';
      var acct = ldAcctText(b);
      return '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:6px 8px"><strong>' + escH(b.name) + '</strong></td>' +
        '<td style="padding:6px 8px;white-space:nowrap">' + escH(b.serviceType) + '</td>' +
        '<td style="padding:6px 8px;white-space:nowrap">' + b.rooms + ' 間</td>' +
        '<td style="padding:6px 8px;white-space:nowrap">' + termTxt + '</td>' +
        '<td style="padding:6px 8px">' + escH(ldFeeText(b)) +
          (b.payDay ? '<div style="font-size:9.5px;color:var(--muted)">每月 ' + escH(b.payDay) + ' 日前</div>' : '') +
          (b.kind === 'wg' && !b.collectRent
            ? '<div style="font-size:9.5px;color:#e67700">未約定代收租金</div>' : '') +
        '</td>' +
        '<td style="padding:6px 8px;font-size:10.5px">' +
          (acct ? escH(acct) : '<span style="color:#e67700">未填帳戶</span>') + '</td>' +
        '<td style="padding:6px 8px;text-align:right;white-space:nowrap">' +
          '<button class="btn btn-ghost sm" onclick="ldGoProp(' + jsArg(b.id) + ')">契約設定</button> ' +
          '<button class="btn btn-ghost sm" onclick="ldCloseDetail();ctGenOwner(' + jsArg(b.id) + ')">產生契約</button>' +
        '</td></tr>';
    }).join('') + '</tbody></table>';

  h += '<div style="margin:13px 0 0;padding:11px 13px;background:#f8fafc;border:1px solid var(--border);border-radius:8px">' +
    '<div style="font-size:11.5px;font-weight:700;color:var(--primary);margin-bottom:8px">' +
      '本系統自行維護的欄位（契約上沒有）</div>' +
    '<div class="form-grid" style="gap:9px">' +
      '<div class="field"><label style="font-size:10px">房東生日</label>' +
        '<input type="date" id="ldd-bday" value="' + escH(r.birthday || '') + '" style="' + inp + '"></div>' +
      '<div class="field"><label style="font-size:10px">Email（寄祝福用）</label>' +
        '<input type="email" id="ldd-email" value="' + escH(r.email || '') + '" placeholder="尚未填寫" style="' + inp + '"></div>' +
      '<div class="field"><label style="font-size:10px">歸屬業務' + (isAdmin() ? '' : '（僅管理者可改）') + '</label>' +
        '<select id="ldd-owner" ' + (isAdmin() ? '' : 'disabled') + ' style="' + inp + (isAdmin() ? '' : ';background:#f1f3f5') + '">' +
          '<option value="">— 未歸屬 —</option>' +
          agents.map(function (a) {
            return '<option value="' + escH(a) + '"' + (a === r.owner ? ' selected' : '') + '>' + escH(a) + '</option>';
          }).join('') +
          (r.owner && agents.indexOf(r.owner) < 0
            ? '<option value="' + escH(r.owner) + '" selected>' + escH(r.owner) + '（已離職）</option>' : '') +
        '</select></div>' +
      '<div class="field"><label style="font-size:10px">祝福訊息同意</label>' +
        '<label style="display:flex;align-items:center;gap:6px;height:28px;font-size:11px;cursor:pointer">' +
          '<input type="checkbox" id="ldd-optin" ' + (r.optIn ? 'checked' : '') + ' style="width:15px;height:15px;cursor:pointer">' +
          '同意接收活動與祝福訊息</label></div>' +
      '<div class="field span2"><label style="font-size:10px">房東備註（僅內部可見）</label>' +
        '<input type="text" id="ldd-note" value="' + escH(r.crmNote || '') + '" ' +
          'placeholder="溝通習慣、報修決策偏好、續約意願…" style="' + inp + '"></div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:9px;gap:10px">' +
      '<div style="font-size:10px;color:var(--muted);line-height:1.6">' +
        '未勾選「同意接收」的房東不會出現在祝福寄送名單中（個資法：主動行銷須經同意）。' +
        'Email 填在這裡只影響祝福寄送，不會改到契約內容。</div>' +
      '<button class="btn btn-primary sm" onclick="ldSaveProfile(' + jsArg(r.key) + ')" style="flex-shrink:0">💾 儲存</button>' +
    '</div></div>';

  h += '<div style="margin-top:11px;display:flex;gap:7px;flex-wrap:wrap">' +
    '<button class="btn btn-primary sm" onclick="ldCloseDetail();openPayout(' + jsArg(r.key) + ')">' +
      '📄 月結撥款單</button>' +
    (r.optIn && r.email
      ? '<button class="btn btn-ghost sm" onclick="ldCloseDetail();openGreet()">🎁 祝福提醒</button>' : '') +
    '</div>';

  document.getElementById('ldd-body').innerHTML = h;
  document.getElementById('ldd-ov').classList.add('open');
}
function ldCloseDetail() { document.getElementById('ldd-ov').classList.remove('open'); }

function ldSaveProfile(key) {
  var bday = document.getElementById('ldd-bday').value || '';
  if (bday && bday > todayStr()) { alert('生日不能是未來日期'); return; }
  var f = {
    birthday: bday,
    email: (document.getElementById('ldd-email').value || '').trim(),
    optIn: document.getElementById('ldd-optin').checked,
    note: (document.getElementById('ldd-note').value || '').trim()
  };
  if (isAdmin()) f.owner = document.getElementById('ldd-owner').value;
  ldSetFields(key, f);
  alert('✅ 房東資料已儲存');
  ldDetail(key);
  if (document.getElementById('ld-ov').classList.contains('open')) ldRender();
}
