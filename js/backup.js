/* ══════════════════════════════════════════════════════════════════
   資料備份與還原
   ------------------------------------------------------------------
   這個系統最大的單點風險不是功能不足，是「全部資料只存在雲端一份」。
   免費方案沒有自動備份、沒有時間點還原，誤刪一張表或帳號被盜就全沒了，
   而契約與點交紀錄依租賃住宅條例要保存五年——那不只是資料，是法定義務。

   和 ⬇️ 匯出資料（Excel）的分工（兩個都要留，不能互相取代）：
     Excel  給人看。中文欄名、推導後的數字、沒有內部 ID → 只能對帳，救不回系統。
     JSON   給機器看。原封不動的鍵值與資料表列 → 真的還原得回去。

   三個動作刻意分開，而且順序有意義：
     1. 下載備份      — 做得到
     2. 檢查備份檔    — 證明那個檔案是真的（沒驗過的備份不算備份）
     3. 從備份還原    — 證明救得回來
   只做 1 的系統，等到真要用的那天才會發現檔案是壞的。

   還原只動 company_kv，原因見 Cloud.restoreKV 的註解。
   ══════════════════════════════════════════════════════════════════ */

var BK_UI_READY = false;
var BK_INSPECT = null;   // 使用者剛挑選、已解析成功的備份檔內容

/* 備份紀錄。只存「做過這件事」的事實，不存備份內容本身——
   把資料再抄一份進 company_kv，等於讓需要被備份的東西又長大一倍。 */
function bkLoadLog() {
  var a = Cloud.get('qj_backup_log', []);
  return Array.isArray(a) ? a : [];
}

/* 距今最近一次備份的天數；從來沒備份過回 null。
   這是待辦提醒唯一的判斷依據，所以要能在 Cloud 還沒就緒時安全回話。 */
function bkDaysSince() {
  var log = bkLoadLog();
  if (!log.length) return null;
  var best = null;
  for (var i = 0; i < log.length; i++) {
    // 紀錄是瀏覽器寫的，壞掉的字串會讓 diffDays 回 NaN。
    // 不濾掉的話 NaN 會一路傳到待辦判斷，讓提醒永遠不出現。
    var d = diffDays(String(log[i].at || '').slice(0, 10), todayStr());
    if (isNaN(d)) continue;
    if (best === null || d < best) best = d;
  }
  return best;
}

function bkEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function bkBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/* ══════════════════════════════════════════════════════════════════
   介面
   ══════════════════════════════════════════════════════════════════ */

function bkEnsureUI() {
  if (BK_UI_READY) return;
  BK_UI_READY = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="overlay" id="bk-ov" onclick="if(event.target===this)bkClose()">' +
    '<div class="modal" style="width:780px;max-width:98vw">' +
    '<div class="modal-h"><h2>🛡️ 資料備份</h2>' +
    '<button class="close-btn" onclick="bkClose()">✕</button></div>' +
    '<div class="modal-body" style="max-height:72vh;overflow-y:auto" id="bk-body"></div>' +
    '<div class="modal-f"><button class="btn btn-ghost" onclick="bkClose()">關閉</button></div>' +
    '</div></div>');
}

function bkOpen() {
  bkEnsureUI();
  BK_INSPECT = null;
  bkRender();
  document.getElementById('bk-ov').classList.add('open');
}

function bkClose() {
  var ov = document.getElementById('bk-ov');
  if (ov) ov.classList.remove('open');
  BK_INSPECT = null;
}

function bkRender() {
  var body = document.getElementById('bk-body');
  if (!body) return;
  var log = bkLoadLog(), d = bkDaysSince();

  /* 狀態條。顏色的級距和待辦提醒用同一個門檻，不要一邊說「該備份了」
     另一邊還是綠的。 */
  var tone = d === null ? ['#c92a2a', '從來沒有備份過']
    : d <= 7 ? ['#2f9e44', d === 0 ? '今天已備份' : d + ' 天前備份過']
      : d <= 30 ? ['#e8590c', d + ' 天前備份過，建議重做一次']
        : ['#c92a2a', '已經 ' + d + ' 天沒有備份'];

  var h = '<div style="padding:11px 13px;border-radius:7px;border-left:4px solid ' + tone[0] +
    ';background:' + tone[0] + '12;font-size:12.5px;font-weight:700;color:' + tone[0] + '">' +
    tone[1] + '</div>';

  h += '<div style="margin-top:13px;font-weight:800;font-size:12.5px">① 下載完整備份</div>' +
    '<div style="font-size:10.5px;color:var(--muted);line-height:1.8;margin:3px 0 7px">' +
    '這份 JSON 是<strong>可還原</strong>的備份：房源、訂單、客戶、租金、結算、房東、' +
    '維修清潔、設備主檔與所有設定（原封不動的鍵值），加上契約、點交單、房客連結、' +
    '房客報修、詢問單、訂單異動紀錄。<br>' +
    '⚠️ <strong>不含房源照片原檔</strong>（存放在雲端儲存空間，JSON 內只有網址），' +
    '也不含登入密碼（密碼是單向雜湊，任何人都讀不出來）。<br>' +
    '⚠️ 檔案含全部客戶個資，請存到加密磁碟或有密碼的雲端硬碟，不要留在桌面或寄給自己。</div>' +
    '<button class="btn btn-primary" id="bk-dl" onclick="bkDownload()">⬇️ 下載完整備份（JSON）</button>' +
    '<span id="bk-dl-msg" style="font-size:11px;margin-left:9px"></span>';

  h += '<div style="margin-top:17px;font-weight:800;font-size:12.5px">② 檢查備份檔</div>' +
    '<div style="font-size:10.5px;color:var(--muted);line-height:1.8;margin:3px 0 7px">' +
    '沒有打開驗證過的備份，不算備份。挑一個剛下載的檔案，這裡會把裡面實際有幾筆' +
    '資料列出來，和目前雲端的筆數並排比對。</div>' +
    '<input type="file" id="bk-file" accept=".json,application/json" ' +
    'onchange="bkInspect(this.files[0])" style="font-size:11px">' +
    '<div id="bk-inspect" style="margin-top:9px"></div>';

  h += '<div style="margin-top:17px;font-weight:800;font-size:12.5px">③ 備份紀錄</div>';
  if (!log.length) {
    h += '<div style="font-size:10.5px;color:var(--muted);margin-top:4px">尚無紀錄。</div>';
  } else {
    h += '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:4px">';
    for (var i = 0; i < Math.min(log.length, 8); i++) {
      var L = log[i];
      h += '<tr style="border-top:1px solid var(--border)">' +
        '<td style="padding:4px 6px;white-space:nowrap">' + bkEsc(String(L.at || '').replace('T', ' ').slice(0, 16)) + '</td>' +
        '<td style="padding:4px 6px">' + bkEsc(L.by || '') + '</td>' +
        '<td style="padding:4px 6px;white-space:nowrap;color:var(--muted)">' +
        (L.kind === 'restore' ? '↩️ 還原' : '⬇️ 下載備份') +
        (L.size ? '　' + bkBytes(L.size) : '') + '</td></tr>';
    }
    h += '</table>';
  }

  body.innerHTML = h;
}

/* ══════════════════════════════════════════════════════════════════
   ① 下載
   ══════════════════════════════════════════════════════════════════ */

async function bkDownload() {
  var btn = document.getElementById('bk-dl'), msg = document.getElementById('bk-dl-msg');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 讀取中…'; }
  if (msg) { msg.textContent = ''; msg.style.color = ''; }
  try {
    var dump = await Cloud.dumpAll();
    var json = JSON.stringify(dump, null, 1);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (Cloud.companyName || '企業') + '_完整備份_' +
      new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    /* 訂閱到期的公司是唯讀的，但畫面上明寫「資料都還在、也可以匯出」，
       所以備份本身不能被擋。只有「記錄這次備份」會寫入，先問過 writable()
       再寫，否則 Cloud.set 失敗會跳一個與備份無關的錯誤 alert，
       讓人以為備份沒成功。 */
    if (Cloud.writable()) {
      var log = bkLoadLog();
      log.unshift({
        at: new Date().toISOString(), by: Cloud.myDisplayName || Cloud.myEmail || '',
        kind: 'export', size: blob.size, kv: Object.keys(dump.kv).length
      });
      Cloud.set('qj_backup_log', log.slice(0, 30));
      if (typeof refreshTodoBadge === 'function') refreshTodoBadge();
    }

    /* 先重畫（狀態條和備份紀錄都要更新），再寫訊息。
       順序顛倒的話 bkRender() 會把整個 #bk-body 重建，連訊息一起蓋掉，
       看起來就像什麼都沒發生。重建後 msg 變數指向已被丟棄的節點，要重新 query。 */
    bkRender();
    var m2 = document.getElementById('bk-dl-msg');
    if (m2) {
      m2.style.color = '#2f9e44';
      m2.innerHTML = '✅ 已下載 ' + bkBytes(blob.size) +
        '　<strong>請接著用下面②打開它確認一次</strong>';
    }
    if (dump.meta.warn.length)
      alert('⚠️ 備份完成，但有部分資料沒有備到：\n\n' + dump.meta.warn.join('\n') +
        '\n\n其餘資料都在這份檔案裡。請把這段訊息記下來再回報。');
  } catch (e) {
    var m3 = document.getElementById('bk-dl-msg');
    if (m3) { m3.style.color = '#c92a2a'; m3.textContent = '❌ ' + (e.message || '備份失敗'); }
  } finally {
    var b2 = document.getElementById('bk-dl');
    if (b2) { b2.disabled = false; b2.textContent = '⬇️ 下載完整備份（JSON）'; }
  }
}

/* ══════════════════════════════════════════════════════════════════
   ② 檢查
   ══════════════════════════════════════════════════════════════════ */

/* 目前雲端各區塊的筆數，用來和備份檔並排比對。
   刻意從本機快取推導而不是重打一次資料庫：這裡要回答的問題是
   「我剛才備份的和我現在看到的一樣嗎」，看到的就是快取。 */
function bkLiveCounts() {
  function n(v) { return Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0); }
  return {
    訂單: n(Cloud.get('qj_bks', [])),
    館別: n(Cloud.get('qj_cps', [])),
    客戶: n(Cloud.get('qj_customers', [])),
    維修清潔: n(Cloud.get('qj_tasks', []))
  };
}

function bkInspect(file) {
  var box = document.getElementById('bk-inspect');
  BK_INSPECT = null;
  if (!file || !box) { if (box) box.innerHTML = ''; return; }
  var fr = new FileReader();
  fr.onerror = function () {
    box.innerHTML = '<div style="font-size:11.5px;color:#c92a2a">❌ 讀不到這個檔案。</div>';
  };
  fr.onload = function () {
    var o;
    try { o = JSON.parse(fr.result); }
    catch (e) {
      box.innerHTML = '<div style="font-size:11.5px;color:#c92a2a">❌ 這不是有效的 JSON 檔，' +
        '可能已經損壞或被編輯過。<br>請重新下載一份備份。</div>';
      return;
    }
    if (!o || !o.meta || o.meta.format !== 'quanju-room-system-backup' || !o.kv) {
      box.innerHTML = '<div style="font-size:11.5px;color:#c92a2a">❌ 這是 JSON，但不是本系統的備份檔。' +
        '<br>（⬇️ 匯出資料的 Excel 檔不能用在這裡，那是報表不是備份。）</div>';
      return;
    }
    BK_INSPECT = { file: file, data: o };
    box.innerHTML = bkInspectHtml(o, file);
  };
  fr.readAsText(file);
}

function bkInspectHtml(o, file) {
  var live = bkLiveCounts();
  var sameCo = String(o.meta.companyId) === String(Cloud.companyId);

  var h = '<div style="padding:9px 11px;background:var(--bg2,#f6f7f9);border-radius:6px;font-size:11px;line-height:1.9">' +
    '<strong>' + bkEsc(file.name) + '</strong>　' + bkBytes(file.size) + '<br>' +
    '企業：' + bkEsc(o.meta.companyName || '(未命名)') +
    (sameCo ? '' : ' <span style="color:#c92a2a;font-weight:700">⚠️ 不是目前登入的企業</span>') + '<br>' +
    '備份時間：' + bkEsc(String(o.meta.exportedAt || '').replace('T', ' ').slice(0, 16)) +
    '　由 ' + bkEsc(o.meta.exportedBy || '—') + ' 製作</div>';

  if (o.meta.warn && o.meta.warn.length)
    h += '<div style="margin-top:7px;font-size:11px;color:#e8590c;line-height:1.8">' +
      '⚠️ 這份備份製作時有缺漏：<br>· ' + o.meta.warn.map(bkEsc).join('<br>· ') + '</div>';

  function row(label, bakN, liveN) {
    var diff = liveN === null ? '' :
      bakN === liveN ? '<span style="color:#2f9e44">一致</span>' :
        '<span style="color:#e8590c">目前 ' + liveN + ' 筆</span>';
    return '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:4px 6px">' + label + '</td>' +
      '<td style="padding:4px 6px;text-align:right;font-weight:700">' + bakN + '</td>' +
      '<td style="padding:4px 6px;font-size:10.5px">' + diff + '</td></tr>';
  }
  function kvN(key) {
    var v = o.kv[key];
    return Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0);
  }

  h += '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px">' +
    '<tr style="font-size:10px;color:var(--muted)"><td style="padding:3px 6px">內容</td>' +
    '<td style="padding:3px 6px;text-align:right">備份檔</td>' +
    '<td style="padding:3px 6px">與目前雲端比對</td></tr>' +
    row('館別', kvN('qj_cps'), live.館別) +
    row('訂單', kvN('qj_bks'), live.訂單) +
    row('客戶', kvN('qj_customers'), live.客戶) +
    row('維修／清潔', kvN('qj_tasks'), live.維修清潔) +
    row('設定與其他鍵值', Object.keys(o.kv).length, null);

  var db = o.db || {};
  ['contracts', 'handovers', 'tenant_links', 'tenant_reports', 'inquiries', 'booking_history'].forEach(function (t) {
    var label = { contracts: '契約', handovers: '點交單', tenant_links: '房客連結', tenant_reports: '房客報修', inquiries: '詢問單', booking_history: '訂單異動紀錄' }[t];
    h += db[t] === null || db[t] === undefined
      ? '<tr style="border-top:1px solid var(--border)"><td style="padding:4px 6px">' + label +
        '</td><td style="padding:4px 6px;text-align:right;color:#c92a2a;font-weight:700">缺</td>' +
        '<td style="padding:4px 6px;font-size:10.5px;color:#c92a2a">備份時失敗</td></tr>'
      : row(label, db[t].length, null);
  });
  h += '</table>';

  /* 「目前 N 筆」不等於備份壞掉——備份之後又接了新訂單本來就會不一樣。
     不解釋清楚的話，橘色數字會讓人以為備份是壞的而不敢用。 */
  h += '<div style="font-size:10.5px;color:var(--muted);line-height:1.8;margin-top:6px">' +
    '筆數不一致是正常的：備份之後新增或刪除的資料不會在舊檔案裡。' +
    '只要上面這張表讀得出來、沒有「缺」，這份備份就是完整可用的。</div>';

  h += '<div style="margin-top:13px;font-weight:800;font-size:12.5px">③ 從這個檔案還原</div>' +
    '<div style="font-size:10.5px;color:var(--muted);line-height:1.8;margin:3px 0 7px">' +
    '把備份檔裡的鍵值寫回雲端，覆蓋目前的館別、訂單、客戶、租金、結算與所有設定。' +
    '<br><strong>備份檔裡沒有的 key 不會被刪除</strong>（例如備份之後才啟用的功能，設定會留著）。' +
    '<br>契約與點交單<strong>不會被還原</strong>：那兩張表有「簽署後不可修改」的保護，' +
    '是法定保存的文件，必須由平台方以資料庫層處理。</div>';

  if (!sameCo) {
    h += '<div style="font-size:11.5px;color:#c92a2a;font-weight:700;line-height:1.8">' +
      '🚫 無法還原：這份備份屬於另一間企業（' + bkEsc(o.meta.companyName || o.meta.companyId) + '）。' +
      '<br>把別家的資料寫進這裡會同時毀掉兩邊的帳，所以直接禁止。</div>';
    return h;
  }
  if (!isAdmin()) {
    h += '<div style="font-size:11.5px;color:#c92a2a;font-weight:700">🚫 只有管理者可以還原資料。</div>';
    return h;
  }
  if (!Cloud.writable()) {
    h += '<div style="font-size:11.5px;color:#c92a2a;font-weight:700">🚫 訂閱已到期，目前為唯讀模式，無法寫入。</div>';
    return h;
  }

  h += '<div style="padding:10px 12px;border:1px solid #ffc9c9;background:#fff5f5;border-radius:7px">' +
    '<div style="font-size:11px;color:#c92a2a;line-height:1.8;font-weight:600">' +
    '這個動作會覆蓋全公司目前的營運資料，而且<strong>無法復原</strong>。' +
    '還原前請先用上面①下載一份「現在」的備份，否則一旦還原錯檔案，' +
    '現在的資料就同時消失了。</div>' +
    '<div style="margin-top:8px;font-size:11px">請輸入企業名稱 <strong>' +
    bkEsc(Cloud.companyName) + '</strong> 以確認：</div>' +
    '<input type="text" id="bk-confirm" placeholder="輸入企業名稱" ' +
    'style="margin-top:5px;width:220px;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px">' +
    '<button class="btn btn-danger sm" id="bk-rs" onclick="bkRestore()" style="margin-left:7px">↩️ 覆蓋還原</button>' +
    '<div id="bk-rs-msg" style="font-size:11px;margin-top:6px"></div></div>';
  return h;
}

/* ══════════════════════════════════════════════════════════════════
   ③ 還原
   ══════════════════════════════════════════════════════════════════ */

async function bkRestore() {
  var msg = document.getElementById('bk-rs-msg'), btn = document.getElementById('bk-rs');
  var inp = document.getElementById('bk-confirm');
  function fail(t) { if (msg) { msg.style.color = '#c92a2a'; msg.textContent = '❌ ' + t; } }

  /* 每個條件都在這裡再查一次，不靠畫面上有沒有長出按鈕。
     bkInspectHtml 的判斷是「要不要顯示」，這裡的判斷才是「能不能做」——
     前者在 DOM 裡，任何人都改得動。 */
  if (!BK_INSPECT || !BK_INSPECT.data) return fail('請重新選擇備份檔。');
  var o = BK_INSPECT.data;
  if (String(o.meta.companyId) !== String(Cloud.companyId)) return fail('這份備份不屬於目前登入的企業。');
  if (!isAdmin()) return fail('只有管理者可以還原資料。');
  if (!Cloud.writable()) return fail('訂閱已到期，目前為唯讀模式。');
  if (!inp || inp.value.trim() !== String(Cloud.companyName).trim())
    return fail('企業名稱不符，請完整輸入「' + Cloud.companyName + '」。');

  var keys = Object.keys(o.kv || {});
  if (!keys.length) return fail('這份備份檔裡沒有任何可還原的資料。');
  if (!confirm('最後確認：即將用 ' +
    String(o.meta.exportedAt || '').replace('T', ' ').slice(0, 16) +
    ' 的備份覆蓋 ' + keys.length + ' 項資料。\n\n' +
    '目前的館別、訂單、客戶、租金與結算紀錄會被取代，無法復原。\n\n要繼續嗎？')) return;

  if (btn) { btn.disabled = true; btn.textContent = '⏳ 還原中…'; }
  try {
    var n = await Cloud.restoreKV(o.kv);
    /* 備份檔裡也有一份 qj_backup_log，上一行已經把它寫回資料庫了。
       這裡 bkLoadLog() 讀的是 KV_CACHE（restoreKV 直接打資料庫、沒動快取），
       也就是「還原前」那份紀錄——這正是要的：備份當天到今天之間做過的備份
       不該因為一次還原就從歷史裡消失。接著 Cloud.set 再覆蓋一次，
       順序由上面的 await 保證，最後留在資料庫的是現行紀錄＋這筆還原。 */
    var log = bkLoadLog();
    log.unshift({
      at: new Date().toISOString(), by: Cloud.myDisplayName || Cloud.myEmail || '',
      kind: 'restore', from: o.meta.exportedAt || '', kv: n
    });
    Cloud.set('qj_backup_log', log.slice(0, 30));
    /* 一定要整頁重載：KV_CACHE 是模組內的變數，restoreKV 只改了資料庫，
       畫面上每一個清單都還握著舊值，不重載會看到新舊混在一起的假狀態。 */
    alert('✅ 已還原 ' + n + ' 項資料。\n\n按確定後會重新載入頁面。');
    location.reload();
  } catch (e) {
    fail(e.message || '還原失敗');
    if (btn) { btn.disabled = false; btn.textContent = '↩️ 覆蓋還原'; }
  }
}
