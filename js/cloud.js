// ════════════════════════════════════════════════
// CLOUD（Supabase 帳號系統 + 多企業資料同步）
// 每個企業(company)有獨立的 company_id，資料存放在 company_kv 表，
// 以 Row Level Security 確保不同企業之間完全隔離；同企業員工登入
// 各自帳號都能看到、編輯同一份雲端資料，達成多裝置即時同步。
// ════════════════════════════════════════════════
const _sb = supabase.createClient(window.CLOUD_URL, window.CLOUD_KEY);

const NAME_CHANGE_LIMIT = 2; // 顯示名稱最多可修改次數
// 平台管理者白名單（僅供企業管理後台存取判斷用，實際安全檢查同時在資料庫 RPC 內做一次）
const PLATFORM_ADMIN_EMAILS = ['linhsuanyu199@gmail.com'];

const KV_CACHE = {};
const Cloud = {
  ready: false,
  companyId: null,
  companyName: '',
  inviteCode: '',
  myRole: 'member',
  myEmail: '',
  myUserId: null,
  myDisplayName: '',
  myNameChangeCount: 0,
  shareMarket: true,
  companyMembers: [],
  _pendingDisplayName: '',

  async init() {
    const { data: { session } } = await _sb.auth.getSession();
    if (session) {
      await this._afterLogin();
    }
    _sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') location.reload();
    });
  },

  isLoggedIn() { return this.ready; },

  // ── 資料存取（取代原本的 localStorage）──────────
  get(key, defVal) {
    return key in KV_CACHE ? KV_CACHE[key] : defVal;
  },
  set(key, value) {
    KV_CACHE[key] = value;
    _sb.from('company_kv').upsert({
      company_id: this.companyId, key, value, updated_at: new Date().toISOString()
    }, { onConflict: 'company_id,key' }).then(({ error }) => {
      if (error) console.error('雲端儲存失敗：', key, error.message);
    });
  },

  async _loadKV() {
    const { data, error } = await _sb.from('company_kv').select('key, value').eq('company_id', this.companyId);
    if (error) { alert('讀取雲端資料失敗：' + error.message); return; }
    for (const row of data) KV_CACHE[row.key] = row.value;
  },

  // 直接向雲端撈取單一 key 的最新資料（略過本機快取），用於多人同時編輯時的
  // 「先讀最新、再合併寫回」流程，避免用過期的本機快照覆蓋掉別人剛存的異動
  async getFresh(key, defVal) {
    const { data, error } = await _sb.from('company_kv').select('value')
      .eq('company_id', this.companyId).eq('key', key).maybeSingle();
    if (error) { alert('讀取雲端最新資料失敗：' + error.message); throw error; }
    const val = data ? data.value : defVal;
    KV_CACHE[key] = val;
    return val;
  },

  // ── 官網預約詢問單（獨立資料表，靠 RLS 隔離企業）──────────
  async listInquiries() {
    const { data, error } = await _sb.from('inquiries').select('*')
      .eq('company_id', this.companyId).order('created_at', { ascending: false });
    if (error) { alert('讀取詢問單失敗：' + error.message); return []; }
    return data || [];
  },
  async countNewInquiries() {
    const { count, error } = await _sb.from('inquiries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', this.companyId).eq('status', 'new');
    if (error) return 0;
    return count || 0;
  },
  async updateInquiry(id, patch) {
    const { error } = await _sb.from('inquiries')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).eq('company_id', this.companyId);
    if (error) { alert('更新詢問單失敗：' + error.message); return false; }
    return true;
  },

  // ── 全平台成交行情庫（跨公司共享，但看不到是誰成交的）──────────
  // 只送出縣市／行政區／路名／社區名／房型／月租金／成交月份；
  // 不含門牌號、房客資料與館別名稱。company_id 由資料庫端蓋章，前端偽造不了。
  // 行情回報是附加價值，失敗不能影響訂單本身，所以只寫 console 不打擾使用者。
  async submitMarketDeal(d) {
    const { data, error } = await _sb.rpc('submit_market_deal', {
      p_city: d.city, p_district: d.district, p_rtype: d.rtype,
      p_monthly_rent: d.rent, p_deal_month: d.month,
      p_road: d.road || null, p_building: d.building || null,
      p_booking_id: d.dealKey || null
    });
    if (error) { console.error('行情回報失敗：', error.message); return null; }
    return data;
  },
  // 回傳 {level:'building'|'road'|'district'|'none', n, median, p25, p75, scope}
  async marketStats(q) {
    const { data, error } = await _sb.rpc('market_stats', {
      p_city: q.city, p_district: q.district, p_rtype: q.rtype,
      p_road: q.road || null, p_building: q.building || null
    });
    if (error) { console.error('讀取行情失敗：', error.message); return null; }
    return data;
  },
  async setShareMarket(on) {
    const { error } = await _sb.rpc('set_share_market', { p_on: !!on });
    if (error) { alert('設定失敗：' + error.message); return false; }
    this.shareMarket = !!on;
    return true;
  },

  // 記錄某筆訂單被覆蓋前的舊版內容，供之後查核
  async logBookingHistory(bookingId, oldValue) {
    const { error } = await _sb.from('booking_history').insert({
      company_id: this.companyId, booking_id: bookingId,
      old_value: oldValue, changed_by: this.myDisplayName || this.myEmail
    });
    if (error) console.error('訂單歷史紀錄寫入失敗：', error.message);
  },

  async _afterLogin() {
    const { data: { user } } = await _sb.auth.getUser();
    if (!user) return;
    this.myEmail = user.email || '';
    this.myUserId = user.id;
    const { data: profile, error: pErr } = await _sb.from('profiles')
      .select('company_id, role, display_name, name_change_count').eq('id', user.id).maybeSingle();
    if (pErr) { alert('讀取帳號資料失敗：' + pErr.message); return; }
    if (!profile || !profile.company_id) {
      this._showCompanyScreen();
      return;
    }
    this.companyId = profile.company_id;
    this.myRole = profile.role;
    this.myDisplayName = profile.display_name || '';
    this.myNameChangeCount = profile.name_change_count || 0;
    const { data: comp } = await _sb.from('companies').select('name, invite_code, share_market').eq('id', this.companyId).maybeSingle();
    this.companyName = comp ? comp.name : '';
    this.inviteCode = comp ? comp.invite_code : '';
    this.shareMarket = comp ? comp.share_market !== false : true;
    await this._loadKV();
    await this._loadCompanyMembers();
    this.ready = true;
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('company-screen').classList.add('hidden');
    this._renderUserBox();
    if (!document.getElementById('month-lbl').textContent) init();
  },

  _renderUserBox() {
    const box = document.getElementById('cloud-user-box');
    if (!box) return;
    const boxText = this.companyName + ' · ' + (this.myDisplayName || '未顯示');
    box.textContent = boxText;
    box.title = boxText;
    const inviteBtn = document.getElementById('more-invite');
    if (inviteBtn) inviteBtn.style.display = this.myRole === 'admin' ? '' : 'none';
    const marketBtn = document.getElementById('pm-market-btn');
    if (marketBtn) marketBtn.style.display = this.myRole === 'admin' ? '' : 'none';
    const cleanCfgBtn = document.getElementById('more-cleancfg');
    if (cleanCfgBtn) cleanCfgBtn.style.display = this.myRole === 'admin' ? '' : 'none';
    const adminBtn = document.getElementById('more-platform-admin');
    if (adminBtn) adminBtn.style.display = PLATFORM_ADMIN_EMAILS.includes(this.myEmail) ? '' : 'none';
    const siteLink = document.getElementById('btn-public-site');
    if (siteLink && this.companyId) siteLink.href = this.getPublicUrl();
  },

  // ── 對外公開房源頁連結（可分享給房客）──────────
  getPublicUrl() {
    return location.origin + location.pathname.replace(/index\.html$/, '') + 'public.html?co=' + this.companyId;
  },
  copyPublicLink() {
    if (!this.companyId) return;
    navigator.clipboard.writeText(this.getPublicUrl()).then(() => alert('✅ 公開房源連結已複製，可直接分享給房客：\n' + this.getPublicUrl()));
  },

  async _loadCompanyMembers() {
    const { data, error } = await _sb.from('profiles').select('display_name').eq('company_id', this.companyId);
    if (error) { console.error('讀取企業成員清單失敗：', error.message); this.companyMembers = []; return; }
    this.companyMembers = data.map(m => m.display_name).filter(Boolean).sort();
  },

  // ── 登入 / 註冊 分頁 ──────────────────────────
  switchAuthTab(tab) {
    document.getElementById('tab-login').classList.toggle('active', tab === 'login');
    document.getElementById('tab-register').classList.toggle('active', tab === 'register');
    document.getElementById('auth-panel-login').style.display = tab === 'login' ? '' : 'none';
    document.getElementById('auth-panel-register').style.display = tab === 'register' ? '' : 'none';
    document.getElementById('login-err').style.display = 'none';
  },

  async doLogin() {
    const email = (document.getElementById('login-email').value || '').trim();
    const pass = document.getElementById('login-pass').value || '';
    const err = document.getElementById('login-err');
    err.style.display = 'none';
    if (!email || !pass) { err.textContent = '⚠️ 請輸入 Email 與密碼'; err.style.display = 'block'; return; }
    const { error } = await _sb.auth.signInWithPassword({ email, password: pass });
    if (error) {
      err.textContent = '⚠️ ' + this._translateError(error.message);
      err.style.display = 'block';
      return;
    }
    await this._afterLogin();
  },

  async doRegister() {
    const email = (document.getElementById('reg-email').value || '').trim();
    const pass = document.getElementById('reg-pass').value || '';
    const displayName = (document.getElementById('reg-display-name').value || '').trim();
    const err = document.getElementById('login-err');
    err.style.display = 'none';
    if (!email || !pass || !displayName) { err.textContent = '⚠️ 請輸入 Email、密碼與顯示名稱'; err.style.display = 'block'; return; }
    const nameErr = this._checkDisplayNameLength(displayName);
    if (nameErr) { err.textContent = '⚠️ ' + nameErr; err.style.display = 'block'; return; }
    const pwErr = this._checkPasswordStrength(pass);
    if (pwErr) { err.textContent = '⚠️ ' + pwErr; err.style.display = 'block'; return; }
    const { data, error } = await _sb.auth.signUp({ email, password: pass });
    if (error) {
      err.textContent = '⚠️ ' + this._translateError(error.message);
      err.style.display = 'block';
      return;
    }
    this._pendingDisplayName = displayName;
    if (data.session) {
      await this._afterLogin();
    } else {
      alert('✅ 註冊成功！請至信箱收取驗證信，完成驗證後再登入。');
      this.switchAuthTab('login');
    }
  },

  async doForgotPassword() {
    const email = (document.getElementById('login-email').value || '').trim();
    if (!email) { alert('請先在 Email 欄位輸入您的帳號 Email'); return; }
    const { error } = await _sb.auth.resetPasswordForEmail(email);
    if (error) { alert('寄送失敗：' + this._translateError(error.message)); return; }
    alert('✅ 已寄送密碼重設信至 ' + email + '，請至信箱查看。');
  },

  async doLogout() {
    if (!confirm('確定要登出系統？')) return;
    await _sb.auth.signOut();
  },

  // 顯示名稱長度限制：中文最多4個字，英文（純字母）最多6個字母，避免頂部工具列被撐爆
  _checkDisplayNameLength(name) {
    const hasCJK = /[\u4e00-\u9fff]/.test(name);
    if (hasCJK && name.length > 4) return '顯示名稱過長，中文最多 4 個字';
    if (!hasCJK && name.length > 6) return '顯示名稱過長，英文最多 6 個字母';
    return null;
  },

  _checkPasswordStrength(pass) {
    if (pass.length < 8) return '密碼至少需 8 個字元';
    const hasUpper = /[A-Z]/.test(pass);
    const hasLower = /[a-z]/.test(pass);
    const hasDigit = /[0-9]/.test(pass);
    const hasSymbol = /[^A-Za-z0-9]/.test(pass);
    const kinds = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
    if (kinds < 3) return '密碼需混合大寫、小寫、數字、符號中至少 3 種';
    return null;
  },

  _translateError(msg) {
    if (/Invalid login credentials/i.test(msg)) return 'Email 或密碼錯誤';
    if (/User already registered/i.test(msg)) return '此 Email 已被註冊，請直接登入';
    if (/Email not confirmed/i.test(msg)) return '請先至信箱完成驗證';
    return msg;
  },

  _translateDbError(msg) {
    if (/profiles_company_display_name_uniq/.test(msg) || /duplicate key value violates unique constraint/i.test(msg)) {
      return '此顯示名稱在企業內已被使用，請更換一個名稱（例如加上姓氏區分）';
    }
    return msg;
  },

  // ── 企業設定（首次登入 / 尚未加入企業）──────────
  _showCompanyScreen() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('company-screen').classList.remove('hidden');
  },
  switchCoTab(tab) {
    document.getElementById('tab-co-create').classList.toggle('active', tab === 'create');
    document.getElementById('tab-co-join').classList.toggle('active', tab === 'join');
    document.getElementById('co-panel-create').style.display = tab === 'create' ? '' : 'none';
    document.getElementById('co-panel-join').style.display = tab === 'join' ? '' : 'none';
    document.getElementById('co-err').style.display = 'none';
  },
  async doCreateCompany() {
    const name = (document.getElementById('co-name').value || '').trim();
    const err = document.getElementById('co-err');
    err.style.display = 'none';
    if (!name) { err.textContent = '⚠️ 請輸入企業名稱'; err.style.display = 'block'; return; }
    if (!this._pendingDisplayName) { err.textContent = '⚠️ 尚未設定顯示名稱，請重新註冊'; err.style.display = 'block'; return; }
    const { data, error } = await _sb.rpc('create_company', { company_name: name, p_display_name: this._pendingDisplayName });
    if (error) { err.textContent = '⚠️ ' + this._translateDbError(error.message); err.style.display = 'block'; return; }
    const row = data && data[0];
    alert('✅ 企業建立成功！\n\n您的邀請碼：' + (row ? row.invite_code : '') +
      '\n\n請將此邀請碼提供給同企業的其他員工，供他們註冊帳號時加入同一企業（之後也可以在系統內「👥 邀請成員」查看）。');
    await this._afterLogin();
  },
  async doJoinCompany() {
    const code = (document.getElementById('co-code').value || '').trim();
    const err = document.getElementById('co-err');
    err.style.display = 'none';
    if (!code) { err.textContent = '⚠️ 請輸入邀請碼'; err.style.display = 'block'; return; }
    if (!this._pendingDisplayName) { err.textContent = '⚠️ 尚未設定顯示名稱，請重新註冊'; err.style.display = 'block'; return; }
    const { data, error } = await _sb.rpc('join_company', { code, p_display_name: this._pendingDisplayName });
    if (error) { err.textContent = '⚠️ ' + (/invite code invalid/.test(error.message) ? '邀請碼無效，請確認後重新輸入' : this._translateDbError(error.message)); err.style.display = 'block'; return; }
    await this._afterLogin();
  },

  // ── 邀請成員（僅企業管理者可見）──────────────
  openInvite() {
    document.getElementById('invite-code-show').value = this.inviteCode;
    document.getElementById('invite-ov').classList.add('open');
  },
  closeInvite() { document.getElementById('invite-ov').classList.remove('open'); },
  copyInviteCode() {
    navigator.clipboard.writeText(this.inviteCode).then(() => alert('✅ 邀請碼已複製'));
  },

  // ── 修改密碼／顯示名稱 ──────────────────────
  openCPW() {
    document.getElementById('cpw-email-show').value = this.myEmail;
    document.getElementById('cpw-dname').value = this.myDisplayName || '';
    document.getElementById('cpw-new1').value = '';
    document.getElementById('cpw-new2').value = '';
    document.getElementById('cpw-current').value = '';
    document.getElementById('cpw-err').style.display = 'none';
    const remain = NAME_CHANGE_LIMIT - this.myNameChangeCount;
    const dnameInput = document.getElementById('cpw-dname');
    const hint = document.getElementById('cpw-dname-hint');
    if (remain > 0) {
      dnameInput.disabled = false;
      hint.textContent = '顯示名稱最多可修改 ' + NAME_CHANGE_LIMIT + ' 次，目前還剩 ' + remain + ' 次';
    } else {
      dnameInput.disabled = true;
      hint.textContent = '顯示名稱已達修改次數上限（' + NAME_CHANGE_LIMIT + ' 次），如需再次修改請聯繫我們協助處理';
    }
    document.getElementById('cpw-ov').classList.add('open');
  },
  closeCPW() { document.getElementById('cpw-ov').classList.remove('open'); },
  async doChangePW() {
    const dname = (document.getElementById('cpw-dname').value || '').trim();
    const new1 = document.getElementById('cpw-new1').value || '';
    const new2 = document.getElementById('cpw-new2').value || '';
    const curPass = document.getElementById('cpw-current').value || '';
    const err = document.getElementById('cpw-err');
    function showErr(msg) { err.textContent = msg; err.style.display = 'block'; }
    err.style.display = 'none';

    const wantsNameChange = dname && dname !== this.myDisplayName;
    const wantsPwChange = !!new1;
    if (!wantsNameChange && !wantsPwChange) { showErr('❌ 請修改顯示名稱或新密碼其中一項後再儲存'); return; }
    if (wantsNameChange) {
      if (this.myNameChangeCount >= NAME_CHANGE_LIMIT) { showErr('❌ 顯示名稱已達修改次數上限（' + NAME_CHANGE_LIMIT + ' 次），如需再次修改請聯繫我們協助處理'); return; }
      const nameErr = this._checkDisplayNameLength(dname);
      if (nameErr) { showErr('❌ ' + nameErr); return; }
    }
    if (wantsPwChange) {
      const pwErr = this._checkPasswordStrength(new1);
      if (pwErr) { showErr('❌ ' + pwErr); return; }
      if (new1 !== new2) { showErr('❌ 兩次新密碼輸入不一致'); return; }
    }
    if (!curPass) { showErr('❌ 請輸入目前密碼以確認為本人操作'); return; }

    // 用目前密碼重新驗證身份，確認操作者本人才能改名或改密碼
    const { error: authErr } = await _sb.auth.signInWithPassword({ email: this.myEmail, password: curPass });
    if (authErr) { showErr('❌ 目前密碼輸入錯誤，請重新確認'); return; }

    if (wantsNameChange) {
      const { error: nErr } = await _sb.from('profiles')
        .update({ display_name: dname, name_change_count: this.myNameChangeCount + 1 }).eq('id', this.myUserId);
      if (nErr) { showErr('❌ ' + this._translateDbError(nErr.message)); return; }
      this.myDisplayName = dname;
      this.myNameChangeCount += 1;
      this._renderUserBox();
    }
    if (wantsPwChange) {
      const { error: pErr } = await _sb.auth.updateUser({ password: new1 });
      if (pErr) { showErr('❌ ' + pErr.message); return; }
    }

    this.closeCPW();
    if (wantsPwChange) {
      alert('✅ 已儲存修改！密碼已變更，下次登入請使用新密碼。');
    } else {
      alert('✅ 顯示名稱已修改成功！');
    }
  },

  // ── 平台管理後台（僅平台擁有者可見，白名單同時在 DB RPC 內二次驗證）──
  async openPlatformAdmin() {
    const ov = document.getElementById('platform-admin-ov');
    const body = document.getElementById('platform-admin-body');
    if (!ov || !body) return;
    ov.classList.add('open');
    body.innerHTML = '載入中…';
    const { data, error } = await _sb.rpc('admin_list_companies');
    if (error) { body.innerHTML = '<div style="color:#ff8a8a">讀取失敗：' + error.message + '</div>'; return; }
    if (!data || !data.length) { body.innerHTML = '<div>目前沒有企業資料</div>'; return; }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<tr style="text-align:left;border-bottom:1px solid #ddd"><th style="padding:6px 8px">企業名稱</th><th style="padding:6px 8px">邀請碼</th><th style="padding:6px 8px">成員數</th><th style="padding:6px 8px">館別數</th><th style="padding:6px 8px">建立時間</th></tr>';
    for (const c of data) {
      html += '<tr style="border-bottom:1px solid #eee">' +
        '<td style="padding:6px 8px">' + c.name + '</td>' +
        '<td style="padding:6px 8px">' + c.invite_code + '</td>' +
        '<td style="padding:6px 8px">' + c.member_count + '</td>' +
        '<td style="padding:6px 8px">' + c.room_count + '</td>' +
        '<td style="padding:6px 8px">' + new Date(c.created_at).toLocaleDateString('zh-TW') + '</td>' +
        '</tr>';
    }
    html += '</table>';
    body.innerHTML = html;
  },
  closePlatformAdmin() { document.getElementById('platform-admin-ov').classList.remove('open'); },
};

Cloud.init();
