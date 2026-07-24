// ════════════════════════════════════════════════
// CLOUD（Supabase 帳號系統 + 多企業資料同步）
// 每個企業(company)有獨立的 company_id，資料存放在 company_kv 表，
// 以 Row Level Security 確保不同企業之間完全隔離；同企業員工登入
// 各自帳號都能看到、編輯同一份雲端資料，達成多裝置即時同步。
// ════════════════════════════════════════════════
const _sb = supabase.createClient(window.CLOUD_URL, window.CLOUD_KEY);

const KV_CACHE = {};
const Cloud = {
  ready: false,
  companyId: null,
  companyName: '',
  inviteCode: '',
  myRole: 'member',
  myEmail: '',
  myDisplayName: '',
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

  async _afterLogin() {
    const { data: { user } } = await _sb.auth.getUser();
    if (!user) return;
    this.myEmail = user.email || '';
    const { data: profile, error: pErr } = await _sb.from('profiles')
      .select('company_id, role, display_name').eq('id', user.id).maybeSingle();
    if (pErr) { alert('讀取帳號資料失敗：' + pErr.message); return; }
    if (!profile || !profile.company_id) {
      this._showCompanyScreen();
      return;
    }
    this.companyId = profile.company_id;
    this.myRole = profile.role;
    this.myDisplayName = profile.display_name || '';
    const { data: comp } = await _sb.from('companies').select('name, invite_code').eq('id', this.companyId).maybeSingle();
    this.companyName = comp ? comp.name : '';
    this.inviteCode = comp ? comp.invite_code : '';
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
    box.textContent = this.companyName + ' · ' + (this.myDisplayName || '未設定名稱');
    const inviteBtn = document.getElementById('btn-invite');
    if (inviteBtn) inviteBtn.style.display = this.myRole === 'admin' ? '' : 'none';
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
    document.getElementById('invite-code-show').textContent = this.inviteCode;
    document.getElementById('invite-ov').classList.add('open');
  },
  closeInvite() { document.getElementById('invite-ov').classList.remove('open'); },
  copyInviteCode() {
    navigator.clipboard.writeText(this.inviteCode).then(() => alert('✅ 邀請碼已複製'));
  },

  // ── 修改密碼 ──────────────────────────────
  openCPW() {
    document.getElementById('cpw-email-show').value = this.myEmail;
    document.getElementById('cpw-new1').value = '';
    document.getElementById('cpw-new2').value = '';
    document.getElementById('cpw-err').style.display = 'none';
    document.getElementById('cpw-ov').classList.add('open');
  },
  closeCPW() { document.getElementById('cpw-ov').classList.remove('open'); },
  async doChangePW() {
    const new1 = document.getElementById('cpw-new1').value || '';
    const new2 = document.getElementById('cpw-new2').value || '';
    const err = document.getElementById('cpw-err');
    function showErr(msg) { err.textContent = msg; err.style.display = 'block'; }
    if (!new1) { showErr('❌ 請輸入新密碼'); return; }
    if (new1.length < 6) { showErr('❌ 新密碼至少 6 個字元'); return; }
    if (new1 !== new2) { showErr('❌ 兩次密碼輸入不一致'); return; }
    const { error } = await _sb.auth.updateUser({ password: new1 });
    if (error) { showErr('❌ ' + error.message); return; }
    this.closeCPW();
    alert('✅ 密碼已修改成功！');
  },
};

Cloud.init();
