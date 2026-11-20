(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const icon = {
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  };

  const hashParams = new URLSearchParams(location.hash.slice(1));
  const handoff = hashParams.get('session');       // from the extension popup (becomes a normal session)
  const impHandoff = hashParams.get('imp');         // from the super-admin panel (support access, tab-scoped)
  if (handoff || impHandoff) history.replaceState(null, '', location.pathname + location.search);
  // A super-admin support session lives only in this tab, so it never disturbs a real owner login elsewhere.
  if (impHandoff) sessionStorage.setItem('sri_imp', impHandoff);
  let impersonating = !!sessionStorage.getItem('sri_imp');
  let token = impersonating ? sessionStorage.getItem('sri_imp') : localStorage.getItem('sri_token');
  let me = null;
  let meInfo = {};
  let comments = [];
  let users = [];
  const filters = { status: 'open', q: '', host: '', userId: '' };

  /* ------------------------------------------------------------ api */
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) { signOutLocal(); throw new Error(data.error || 'Signed out'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  const shotUrl = (file) => `/api/screenshots/${file}?token=${encodeURIComponent(token)}`;

  /* ------------------------------------------------------------ ui helpers */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
  }
  function modal(html, bind) {
    $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden');
    const close = () => $('#modal').classList.add('hidden');
    bind && bind($('#modalBody'), close);
    return close;
  }
  function confirmBox(title, text, okLabel = 'Confirm', danger = true) {
    return new Promise((resolve) => {
      modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`,
        (el, close) => {
          $('[data-x]', el).onclick = () => { close(); resolve(false); };
          $('[data-ok]', el).onclick = () => { close(); resolve(true); };
        });
    });
  }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
  function genPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const a = crypto.getRandomValues(new Uint32Array(12));
    return [...a].map((n) => chars[n % chars.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
  }
  const genKey = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  function timeAgo(iso) {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const fullDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function pathOf(url) { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } }
  function setError(form, msg) { const e = $('[data-error]', form); if (e) e.textContent = msg || ''; }

  /* ------------------------------------------------------------ auth flow */
  function show(id) {
    ['auth', 'app'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== id));
  }
  function clearToken() {
    if (impersonating) { sessionStorage.removeItem('sri_imp'); impersonating = false; }
    else localStorage.removeItem('sri_token');
    token = null; me = null;
  }
  function signOutLocal() {
    const wasImp = impersonating;
    clearToken();
    if (wasImp) { location.href = '/super'; return; }  // exit support view → back to platform panel
    boot();
  }
  function notice(title, text, { btn, btnHref, logout } = {}) {
    show('auth');
    $('#loginForm').classList.add('hidden');
    $('#noticeBox').classList.remove('hidden');
    $('#noticeTitle').textContent = title;
    $('#noticeText').textContent = text;
    $('#noticeBtn').classList.toggle('hidden', !btn);
    if (btn) { $('#noticeBtn').textContent = btn; $('#noticeBtn').href = btnHref || '/super'; }
    $('#noticeLogout').classList.toggle('hidden', !logout);
  }
  async function boot() {
    if (handoff && !boot.handled) {
      boot.handled = true;
      try {
        const r = await fetch('/api/session/clone', { method: 'POST', headers: { Authorization: `Bearer ${handoff}` } });
        if (r.ok) {
          if (token && !impersonating) fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
          token = (await r.json()).token; localStorage.setItem('sri_token', token); impersonating = false;
        }
      } catch {}
    }
    if (token) {
      try {
        const info = await api('GET', '/api/me');
        me = info.user; meInfo = info;
        if (me.role === 'superadmin' && !info.impersonated) {
          notice('You are signed in as platform admin', 'This page is the agency dashboard. Open the platform panel to manage agencies, or sign out to use an agency account here.', { btn: 'Open platform admin', btnHref: '/super', logout: true });
          return;
        }
        show('app'); startApp(); return;
      } catch (e) {
        // Subscription problems (402) shouldn't just bounce to login with no explanation.
        if (/expired|suspended|not active/i.test(e.message)) { clearToken(); notice('Account unavailable', e.message, { logout: false }); return; }
        clearToken();
      }
    }
    const s = await api('GET', '/api/setup-status');
    if (s.needsPlatformSetup) { notice('Platform not set up yet', 'The tool provider needs to create the platform admin first.', { btn: 'Set up platform', btnHref: '/super' }); return; }
    show('auth');
    $('#noticeBox').classList.add('hidden');
    $('#loginForm').classList.remove('hidden');
  }
  async function handleAuth(form, url) {
    setError(form, '');
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      Object.keys(body).forEach((k) => { if (body[k] === '') delete body[k]; }); // drop the inactive login field
      if (!body.password && !body.recoveryKey) { setError(form, 'Enter your password or 6-digit key.'); btn.disabled = false; return; }
      const data = await api('POST', url, body);
      if (data.user && data.user.role === 'superadmin') {
        // A platform admin typed their login here; send them to the right place.
        localStorage.setItem('sri_super_token', data.token); location.href = '/super'; return;
      }
      token = data.token; localStorage.setItem('sri_token', token); impersonating = false; form.reset();
      $$('.login-mode [data-m]', form).forEach((x) => x.classList.toggle('on', x.dataset.m === 'password'));
      $('.lf-password', form).classList.remove('hidden'); $('.lf-key', form).classList.add('hidden');
      boot();
    } catch (e) { setError(form, e.message); }
    btn.disabled = false;
  }
  $('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); handleAuth(e.target, '/api/login'); });
  $('.login-mode', $('#loginForm')).addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    const key = b.dataset.m === 'key';
    $$('.login-mode [data-m]', $('#loginForm')).forEach((x) => x.classList.toggle('on', x === b));
    $('.lf-password', $('#loginForm')).classList.toggle('hidden', key);
    $('.lf-key', $('#loginForm')).classList.toggle('hidden', !key);
    const inp = $(key ? '.lf-key input' : '.lf-password input', $('#loginForm')); if (inp) inp.focus();
  });
  $('#forgotLink').addEventListener('click', (e) => { e.preventDefault(); forgotPassword(); });

  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-action]'); if (!a) return;
    const act = a.dataset.action;
    if (act === 'logout') { try { await api('POST', '/api/logout'); } catch {} signOutLocal(); }
    if (act === 'account') accountAndPlan();
    if (act === 'change-password') changePassword();
    if (act === 'change-email') requestEmailChange();
    if (act === 'change-key') changeKey();
    if (act === 'gen-pass') { $('#addUserForm [name=password]').value = genPassword(); }
    if (act === 'gen-key') { $('#addUserForm [name=recoveryKey]').value = genKey(); }
    if (act === 'copy-invite') { navigator.clipboard.writeText($('#inviteText').textContent); toast('Invite copied'); }
    if (act === 'exit-imp') signOutLocal();
  });
  // Forgot both password and key → ask the tier above. Works without being signed in.
  function forgotPassword() {
    modal(`<h2>Request a new password</h2><p>Forgot both your password and 6-digit key? Send a request to your admin (or provider). They'll set you a new password and pass it to you directly — no email is sent by the tool.</p>
      <form id="fp"><label>Your email<input name="email" type="email" required></label><label>Note <span class="opt">optional</span><textarea name="message" rows="2" maxlength="500" placeholder="e.g. forgot both, please reset"></textarea></label>
      <p class="error" data-error></p><div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Send request</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      $('#fp', el).onsubmit = async (ev) => {
        ev.preventDefault();
        try { const r = await api('POST', '/api/password-reset-request', Object.fromEntries(new FormData(ev.target))); close(); toast(r.message || 'Request sent'); }
        catch (err) { setError(ev.target, err.message); }
      };
    });
  }

  /* ------------------------------------------------------------ app shell */
  let started = false;
  function startApp() {
    $('#meName').textContent = me.name; $('#meName2').textContent = me.name; $('#meEmail').textContent = me.email;
    $('#meAvatar').textContent = initials(me.name);
    $('#serverUrl').textContent = location.origin;
    const owner = isOwner();
    const staff = isStaff();
    // Support-access banner + plan banner
    if (impersonating || meInfo.impersonated) {
      $('#impBanner').classList.remove('hidden');
      $('#impBanner').innerHTML = `<span>${icon.target}</span><span>Super-admin support access — viewing <b>${esc(meInfo.agencyName || '')}</b>. Actions you take are logged.</span><button class="btn" data-action="exit-imp">Exit support view</button>`;
    } else $('#impBanner').classList.add('hidden');
    renderPlanBanner();
    // In support view, don't let the operator change the real owner's own email/password.
    $('#emailItem').classList.toggle('hidden', !!meInfo.impersonated);
    $('#passwordItem').classList.toggle('hidden', !!meInfo.impersonated);
    $('#keyItem').classList.toggle('hidden', !!meInfo.impersonated);
    // Account & plan (subscription) is admin-only.
    $('#accountItem').classList.toggle('hidden', !owner);
    // Staff (admin + developer) see all comments and the Team tab; reviewers get a read-only "My comments" view.
    $('[data-tab=team]').classList.toggle('hidden', !staff);
    $('#exportBtn').classList.toggle('hidden', !staff);
    $('#userFilter').classList.toggle('hidden', !staff);
    $('#commentsTabLabel').textContent = staff ? 'Comments' : 'My comments';
    $('#statLastLabel').textContent = staff ? 'Reviewers' : 'Submitted';
    $('#statOpenLabel').textContent = statusLabel('open');
    $('[data-status=open]', $('#statusSeg')).textContent = statusLabel('open');
    $('#roleNote').classList.toggle('hidden', staff);
    // Only the admin picks a role when adding people; a developer adds reviewers only.
    $('#roleField').classList.toggle('hidden', !owner);
    setupSitesField();
    onRoleChange();
    if (!staff && !started) setStatusFilter('all');
    if (!started) {
      started = true;
      $('#accountBtn').onclick = (e) => { e.stopPropagation(); $('#accountMenu').classList.toggle('hidden'); };
      document.addEventListener('click', (e) => { if (!e.target.closest('.account')) $('#accountMenu').classList.add('hidden'); });
      $$('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
      if ($('#roleSelect')) $('#roleSelect').addEventListener('change', onRoleChange);
      // Keep statuses fresh: poll, and refresh as soon as the tab is looked at again.
      setInterval(() => { if (token && !document.hidden) { loadComments(true); refreshMe(); } }, 20000);
      document.addEventListener('visibilitychange', () => { if (token && !document.hidden) { loadComments(true); refreshMe(); } });
    }
    switchTab('comments');
    (staff ? loadUsers() : Promise.resolve()).then(() => loadComments());
    maybeShowEmailNotice();
  }
  // Refresh the signed-in user's own record so a decision on their email request surfaces live.
  async function refreshMe() {
    try {
      const info = await api('GET', '/api/me');
      const had = me && me.emailRequest && me.emailRequest.status;
      me = info.user; meInfo = info;
      $('#meEmail').textContent = me.email; $('#email') && ($('#email').textContent = me.email);
      if (me.emailRequest && me.emailRequest.status !== 'pending' && me.emailRequest.status !== had) maybeShowEmailNotice();
    } catch {}
  }
  const isOwner = () => me && me.role === 'owner';
  const isDeveloper = () => me && me.role === 'developer';
  const isStaff = () => isOwner() || isDeveloper();
  // The add-reviewer website field: free text for the admin, a pick-list of the developer's own domains for a developer.
  function setupSitesField() {
    const free = $('#freeSites'), dev = $('#devSites');
    if (!free || !dev) return;
    if (!isDeveloper()) { free.classList.remove('hidden'); dev.classList.add('hidden'); return; }
    const sites = me.allowedSites || [];
    free.classList.add('hidden'); dev.classList.remove('hidden');
    if (!sites.length) {
      $('#devSitesHint').textContent = 'You can review all websites, so reviewers you add can too.';
      $('#sitesChoices').innerHTML = '';
    } else {
      $('#devSitesHint').textContent = 'Pick one or more from your assigned websites — the reviewer can only review these.';
      $('#sitesChoices').innerHTML = sites.map((s) => `<label class="choice"><input type="checkbox" value="${esc(s)}"><span>${esc(s)}</span></label>`).join('');
    }
  }
  function renderPlanBanner() {
    const sub = meInfo.subscription;
    const b = $('#planBanner');
    if (!sub) { b.classList.add('hidden'); return; }
    if (sub.state === 'grace') {
      b.className = 'plan-banner grace';
      b.innerHTML = `${icon.clock}<span>Your subscription expired and is in a grace period${sub.graceLeft != null ? ` (${sub.graceLeft} day${sub.graceLeft === 1 ? '' : 's'} left)` : ''}. Please renew with your provider to avoid losing access.</span>`;
    } else if (sub.state === 'active' && sub.daysLeft != null && sub.daysLeft <= 7) {
      b.className = 'plan-banner soon';
      b.innerHTML = `${icon.clock}<span>Your ${esc(sub.plan)} subscription renews in ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'}.</span>`;
    } else { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
  }
  function accountAndPlan() {
    $('#accountMenu').classList.add('hidden');
    api('GET', '/api/account').then(({ agency, access }) => {
      const stLabel = { active: 'Active', grace: 'In grace period', expired: 'Expired', suspended: 'Suspended' }[agency.state] || agency.state;
      modal(`<h2>Account &amp; plan</h2>
        <div class="kv" style="margin-bottom:16px">
          <div>Agency</div><div>${esc(agency.name)}</div>
          <div>Plan</div><div style="text-transform:capitalize">${esc(agency.plan)}</div>
          <div>Status</div><div>${esc(stLabel)}</div>
          <div>Renews / expires</div><div>${agency.expiresAt ? esc(fullDate(agency.expiresAt)) : 'No expiry'}</div>
          ${agency.maxReviewers ? `<div>Reviewer limit</div><div>${agency.maxReviewers}</div>` : ''}
        </div>
        <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px">Platform access to your account</h3>
        <p class="muted" style="margin:0 0 10px;font-size:12.5px">For support and maintenance, your provider may open your panel. Every access is listed here.</p>
        ${access.length ? `<div class="logrows">${access.map((l) => `<div><span>${esc(l.by)}</span><span>${esc(fullDate(l.at))}</span></div>`).join('')}</div>` : '<p class="muted">No access by your provider yet.</p>'}
        <div class="row" style="margin-top:16px"><button class="btn primary" data-x>Close</button></div>`,
      (el, close) => { $('[data-x]', el).onclick = close; });
    }).catch((e) => toast(e.message));
  }
  // Staff think in "Open"; reviewers see the same state as "Pending" (waiting for the admin).
  const statusLabel = (s) => (s === 'resolved' ? 'Resolved' : isStaff() ? 'Open' : 'Pending');
  function setStatusFilter(s) {
    filters.status = s;
    $$('#statusSeg button').forEach((x) => x.classList.toggle('on', x.dataset.status === s));
  }
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('#tab-comments').classList.toggle('hidden', name !== 'comments');
    $('#tab-team').classList.toggle('hidden', name !== 'team');
    if (name === 'team') loadUsers();
  }
  // Reviewers, developers and admins can't change their own email — they request it from the tier above.
  function requestEmailChange() {
    $('#accountMenu').classList.add('hidden');
    const toWhom = isOwner() ? 'your provider (super admin)' : 'your agency admin';
    const pending = me.emailRequest && me.emailRequest.status === 'pending';
    modal(`<h2>Request email change</h2>
      <p>Only ${esc(toWhom)} can change your email. Enter the new email and they'll approve it. You'll be notified of their decision here.</p>
      ${pending ? `<div class="req-box pending" style="margin-bottom:14px"><div><strong>Request pending</strong> — you asked to change to <b>${esc(me.emailRequest.newEmail)}</b>. Waiting for approval.</div></div>` : ''}
      <form id="emForm"><label>Current email<input value="${esc(me.email)}" disabled></label>
      <label>New email<input name="email" type="email" required autocomplete="email" ${pending ? 'disabled' : ''}></label>
      <p class="error" data-error></p>
      <div class="row"><button type="button" class="btn" data-x>Close</button>${pending ? '' : '<button class="btn primary">Send request</button>'}</div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      const inp = $('[name=email]', el); if (inp && !pending) inp.focus();
      $('#emForm', el).onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api('POST', '/api/me/email-request', { email: inp.value });
          me = r.user; close(); toast(r.message || 'Request sent');
        } catch (err) { setError(e.target, err.message); }
      };
    });
  }
  // Show the approved/declined notification (within 24h) with an "Okay" button that clears it.
  function maybeShowEmailNotice() {
    const r = me && me.emailRequest;
    if (!r || r.status === 'pending' || !r.decidedAt) return;
    if (Date.now() - new Date(r.decidedAt) > 864e5) return;
    const approved = r.status === 'approved';
    modal(`<h2>Email change ${approved ? 'approved' : 'declined'}</h2>
      <p>${approved
        ? `Your email was changed to <b>${esc(r.newEmail)}</b>${r.decidedByName ? ' by ' + esc(r.decidedByName) : ''}. Use it to sign in from now on.`
        : `Your request to change your email to <b>${esc(r.newEmail)}</b> was declined${r.decidedByName ? ' by ' + esc(r.decidedByName) : ''}. Your email is unchanged.`}</p>
      <div class="row"><button class="btn primary" data-ok>Okay</button></div>`,
    (el, close) => {
      $('[data-ok]', el).onclick = async () => { close(); try { me = (await api('POST', '/api/me/email-request/ack', {})).user; } catch {} };
    });
  }
  function changePassword() {
    $('#accountMenu').classList.add('hidden');
    modal(`<h2>Change password</h2>
      <form id="pwForm"><label>Current password<input name="currentPassword" type="password" required></label>
      <label>New password<input name="newPassword" type="password" minlength="8" required></label>
      <p class="error" data-error></p>
      <div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      $('#pwForm', el).onsubmit = async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/me/password', Object.fromEntries(new FormData(e.target))); close(); toast('Password updated'); }
        catch (err) { setError(e.target, err.message); }
      };
    });
  }
  function changeKey() {
    $('#accountMenu').classList.add('hidden');
    modal(`<h2>Change recovery key</h2><p>The 6-digit key is an alternative way to sign in if you forget your password.</p>
      <form id="kyForm"><label>Your password<input name="password" type="password" required></label>
      <label>New 6-digit key<div class="input-row"><input name="recoveryKey" inputmode="numeric" pattern="\\d{6}" maxlength="6" required><button type="button" class="btn small" data-gk>Generate</button></div></label>
      <p class="error" data-error></p>
      <div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save key</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      $('[data-gk]', el).onclick = () => { $('[name=recoveryKey]', el).value = genKey(); };
      $('#kyForm', el).onsubmit = async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/me/recovery-key', Object.fromEntries(new FormData(e.target))); close(); toast('Recovery key updated'); }
        catch (err) { setError(e.target, err.message); }
      };
    });
  }

  /* ------------------------------------------------------------ comments */
  async function loadComments(silent) {
    try {
      comments = (await api('GET', '/api/comments?status=all')).comments;
      if (!isStaff()) noticeStatusChanges();
      if (isDeveloper()) noticeDeletionChanges();
      renderFilters(); renderComments();
    } catch (e) { if (!silent) toast(e.message); }
  }
  // Reviewers: spot comments whose status the owner changed since this browser last looked.
  const changed = new Set();
  function noticeStatusChanges() {
    const key = `sri_seen_${me.id}`;
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    const now = {};
    const newly = [];
    for (const c of comments) {
      now[c.id] = c.status;
      if (seen && seen[c.id] && seen[c.id] !== c.status) { changed.add(c.id); newly.push(c); }
    }
    try { localStorage.setItem(key, JSON.stringify(now)); } catch {}
    if (newly.length === 1) toast(`Comment #${newly[0].number} is now ${statusLabel(newly[0].status).toLowerCase()}`);
    else if (newly.length > 1) toast(`${newly.length} of your comments changed status`);
  }
  // Developers: spot deletion requests the admin has declined since this browser last looked.
  const declined = new Set();
  function noticeDeletionChanges() {
    const key = `sri_delreq_${me.id}`;
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    const now = {}; const newly = [];
    for (const c of comments) {
      const dr = c.deletionRequest;
      if (!dr || dr.by !== me.id) continue;
      now[c.id] = dr.status;
      if (seen && seen[c.id] === 'pending' && dr.status === 'cancelled') { declined.add(c.id); newly.push(c); }
    }
    try { localStorage.setItem(key, JSON.stringify(now)); } catch {}
    if (newly.length === 1) toast(`Your deletion request for #${newly[0].number} was declined by the admin`);
    else if (newly.length > 1) toast(`${newly.length} of your deletion requests were declined`);
  }
  function renderFilters() {
    const open = comments.filter((c) => c.status === 'open').length;
    $('#openCount').textContent = open;
    $('#statOpen').textContent = open;
    $('#statResolved').textContent = comments.length - open;
    const hosts = [...new Set(comments.map((c) => c.host))].sort();
    $('#statSites').textContent = hosts.length;
    $('#statReviewers').textContent = isStaff() ? users.filter((u) => u.role === 'reviewer' && u.active).length : comments.length;
    const hs = $('#siteFilter'); const cur = hs.value;
    hs.innerHTML = '<option value="">All websites</option>' + hosts.map((h) => `<option ${h === cur ? 'selected' : ''}>${esc(h)}</option>`).join('');
    const authors = new Map(); comments.forEach((c) => authors.set(c.userId, c.userName || c.userEmail));
    const us = $('#userFilter'); const curU = us.value;
    us.innerHTML = '<option value="">All reviewers</option>' + [...authors].map(([id, n]) => `<option value="${esc(id)}" ${id === curU ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }
  function visibleComments() {
    const q = filters.q.toLowerCase();
    return comments.filter((c) =>
      (filters.status === 'all' || c.status === filters.status) &&
      (!filters.host || c.host === filters.host) &&
      (!filters.userId || c.userId === filters.userId) &&
      (!q || [c.description, c.authorName, c.userEmail, c.url, c.pageTitle, c.element.selector, c.element.text].some((f) => String(f || '').toLowerCase().includes(q))));
  }
  function highlightStyle(c) {
    const v = c.viewport, r = c.element.rect;
    if (!v.width || !v.height || !r.width) return null;
    const pct = (a, b) => `${Math.max(0, Math.min(100, (a / b) * 100)).toFixed(3)}%`;
    return `left:${pct(r.x, v.width)};top:${pct(r.y, v.height)};width:${pct(Math.min(r.width, v.width - Math.max(0, r.x)), v.width)};height:${pct(Math.min(r.height, v.height - Math.max(0, r.y)), v.height)}`;
  }
  function renderComments() {
    const list = visibleComments();
    const el = $('#commentList');
    if (!list.length) {
      el.innerHTML = comments.length
        ? '<div class="empty"><strong>No comments match</strong>Try a different filter or search.</div>'
        : isStaff()
          ? '<div class="empty"><strong>No comments yet</strong>When you or a reviewer clicks an element with the extension and submits a comment, it appears here.</div>'
          : '<div class="empty"><strong>You haven\'t submitted any comments yet</strong>Open a website, click the review button at the bottom-left, click an element and submit your comment. It will show up here with its status.</div>';
      return;
    }
    el.innerHTML = list.map((c) => {
      const hl = highlightStyle(c);
      const label = c.element.tag ? `&lt;${esc(c.element.tag)}&gt;` : '';
      return `<article class="card" data-id="${c.id}">
        <div>
          <div class="card-top"><span class="num-badge">#${c.number}</span><span class="pill ${c.status}">${statusLabel(c.status)}</span>${changed.has(c.id) ? '<span class="pill updated">Updated</span>' : ''}${deletionBadge(c)}
            <span>${label} <span class="sel">${esc(c.element.selector || '—')}</span></span></div>
          <p class="desc">${esc(c.description)}</p>
          <div class="meta">
            <span>${icon.user}${esc(c.authorName)}${c.authorName !== c.userName ? ` <span class="muted-i">(${esc(c.userEmail)})</span>` : ''}</span>
            <span>${icon.globe}<span class="path">${esc(c.host)}${esc(pathOf(c.url))}</span></span>
            <span title="${esc(fullDate(c.createdAt))}">${icon.clock}${timeAgo(c.createdAt)}</span>
            ${c.status === 'resolved' && c.resolvedAt ? `<span class="resolved-at" title="${esc(fullDate(c.resolvedAt))}">${icon.check}Resolved ${timeAgo(c.resolvedAt)}</span>` : ''}
          </div>
        </div>
        <div class="thumb">${c.screenshot ? `<img loading="lazy" src="${shotUrl(c.screenshot)}" alt="">${hl ? `<div class="shot-hl" style="position:absolute;${hl};border:1.5px solid var(--accent);background:rgba(245,180,0,.18);border-radius:2px"></div>` : ''}` : '<div class="noshot">No screenshot</div>'}</div>
      </article>`;
    }).join('');
  }
  // Badge on a card for deletion requests the current viewer should notice.
  function deletionBadge(c) {
    const dr = c.deletionRequest; if (!dr) return '';
    if (isOwner() && dr.status === 'pending') return '<span class="pill req">Delete requested</span>';
    if (isDeveloper() && dr.by === me.id) {
      if (dr.status === 'pending') return '<span class="pill req">Delete requested</span>';
      if (dr.status === 'cancelled') return '<span class="pill declined">Request declined</span>';
    }
    return '';
  }
  $('#commentList').addEventListener('click', (e) => { const card = e.target.closest('.card'); if (card) openDrawer(card.dataset.id); });
  $('#q').addEventListener('input', (e) => { filters.q = e.target.value; renderComments(); });
  $('#siteFilter').addEventListener('change', (e) => { filters.host = e.target.value; renderComments(); });
  $('#userFilter').addEventListener('change', (e) => { filters.userId = e.target.value; renderComments(); });
  $('#statusSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setStatusFilter(b.dataset.status); renderComments();
  });
  $('#exportBtn').addEventListener('click', async () => {
    const res = await fetch('/api/export.csv', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return toast('Export failed');
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = 'review-comments.csv'; a.click();
  });

  /* ------------------------------------------------------------ drawer */
  function closeDrawer() { $('#drawer').classList.add('hidden'); $('#drawerBack').classList.add('hidden'); }
  $('#drawerBack').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); $('#modal').classList.add('hidden'); } });

  function colorCell(v) { return v ? `<span class="swatch" style="background:${esc(v)}"></span>${esc(v)}` : '—'; }
  function openDrawer(id) {
    const c = comments.find((x) => x.id === id); if (!c) return;
    if (changed.delete(c.id)) renderComments();
    const e = c.element, s = e.styles || {};
    const hl = highlightStyle(c);
    const rows = [
      ['Tag', e.tag ? `<code>&lt;${esc(e.tag)}&gt;</code>` : '—'],
      ['ID', e.id ? `<code>#${esc(e.id)}</code>` : '—'],
      ['Classes', e.classes.length ? e.classes.map((x) => `<code>.${esc(x)}</code>`).join(' ') : '—'],
      ['Text', e.text ? esc(e.text) : '—'],
      ['Size', `${Math.round(e.rect.width)} × ${Math.round(e.rect.height)} px`],
      ['Font', [s.fontFamily && esc(s.fontFamily.split(',')[0].replace(/["']/g, '')), s.fontSize, s.fontWeight && `weight ${s.fontWeight}`, s.lineHeight && `line ${s.lineHeight}`].filter(Boolean).join(' · ') || '—'],
      ['Color', colorCell(s.color)],
      ['Background', colorCell(s.backgroundColor)],
      ['Margin / Padding', `${esc(s.margin || '—')} / ${esc(s.padding || '—')}`],
      ['Display', esc(s.display || '—')],
      ...Object.entries(e.attributes || {}).map(([k, v]) => [esc(k), esc(v)]),
      ['XPath', e.xpath ? `<code>${esc(e.xpath)}</code>` : '—'],
    ];
    const env = [
      ['Page title', esc(c.pageTitle || '—')],
      ['Viewport', `${c.viewport.width} × ${c.viewport.height} @${c.viewport.dpr}x`],
      ['Scroll position', `${Math.round(c.viewport.scrollX)}, ${Math.round(c.viewport.scrollY)}`],
      ['Browser', esc(c.userAgent || '—')],
      ['Submitted', esc(fullDate(c.createdAt))],
      ...(c.resolvedAt ? [['Resolved', esc(fullDate(c.resolvedAt))]] : []),
    ];
    const kv = (list) => `<div class="kv">${list.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>`;
    const dr = c.deletionRequest;
    const mine = c.userId === me.id;
    // Info box about a deletion request, shown to the admin (pending) and to the requesting developer.
    let reqBox = '';
    if (dr && dr.status === 'pending' && (isOwner() || (isDeveloper() && dr.by === me.id))) {
      reqBox = `<div class="req-box pending">${icon.clock}<div><strong>Deletion requested</strong> by ${esc(dr.byName)}${dr.at ? ' · ' + timeAgo(dr.at) : ''}${dr.note ? `<div class="req-note">“${esc(dr.note)}”</div>` : ''}${isOwner() ? '<div class="req-hint">Delete the comment below to honour this, or decline the request.</div>' : '<div class="req-hint">Waiting for the admin to review.</div>'}</div></div>`;
    } else if (dr && dr.status === 'cancelled' && isDeveloper() && dr.by === me.id) {
      reqBox = `<div class="req-box declined">${icon.close}<div><strong>Deletion request declined</strong>${dr.cancelledByName ? ' by ' + esc(dr.cancelledByName) : ''}${dr.cancelledAt ? ' · ' + timeAgo(dr.cancelledAt) : ''}${dr.cancelNote ? `<div class="req-note">“${esc(dr.cancelNote)}”</div>` : ''}</div></div>`;
    }
    // Extra action button for the deletion-request workflow.
    let reqBtn = '';
    if (isOwner() && dr && dr.status === 'pending') reqBtn = '<button class="btn" data-decline>Decline request</button>';
    else if (isDeveloper() && !mine) reqBtn = (dr && dr.status === 'pending')
      ? '<button class="btn" disabled>Deletion requested</button>'
      : `<button class="btn danger" data-request-del>${dr && dr.status === 'cancelled' ? 'Request deletion again' : 'Request deletion'}</button>`;
    $('#drawer').innerHTML = `
      <div class="drawer-head">
        <div class="title">Comment #${c.number} <span class="pill ${c.status}">${statusLabel(c.status)}</span></div>
        <a class="btn small" href="${esc(c.url)}" target="_blank" rel="noopener">${icon.ext}Open page</a>
        <button class="icon-btn" data-close aria-label="Close">${icon.close}</button>
      </div>
      <div class="drawer-body">
        <div>
          <p class="quote">${esc(c.description)}</p>
          <div class="byline"><span class="avatar">${esc(initials(c.authorName))}</span><span><strong>${esc(c.authorName)}</strong> · ${esc(c.userEmail)} · ${timeAgo(c.createdAt)}</span></div>
        </div>
        ${isStaff() ? '' : `<div class="status-note ${c.status}">${c.status === 'resolved'
          ? `${icon.check}<span><strong>Resolved</strong> by the team ${c.resolvedAt ? 'on ' + esc(fullDate(c.resolvedAt)) : ''}</span>`
          : `${icon.clock}<span><strong>Pending</strong> — the team hasn't resolved this yet</span>`}</div>`}
        ${reqBox}
        <div class="section"><h3>Page</h3><a class="link" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></div>
        ${c.screenshot ? `<div class="section"><h3>Screenshot</h3><div class="shot"><img src="${shotUrl(c.screenshot)}" alt="Screenshot of the page">${hl ? `<div class="hl" style="${hl}"></div>` : ''}</div></div>` : ''}
        <div class="section"><h3>CSS selector</h3><div class="copy-row"><code>${esc(e.selector || '—')}</code><button class="btn small" data-copy="${esc(e.selector)}">Copy</button></div></div>
        <div class="section"><h3>Element</h3>${kv(rows)}</div>
        ${e.html ? `<div class="section"><h3>HTML</h3><pre class="html">${esc(e.html)}</pre></div>` : ''}
        <div class="section"><h3>Environment</h3>${kv(env)}</div>
        <div class="actions ${isStaff() ? '' : 'hidden'}">
          ${c.status === 'open' ? `<button class="btn accent" data-status="resolved">${icon.check}Mark resolved</button>` : '<button class="btn" data-status="open">Reopen</button>'}
          ${(isOwner() || (isDeveloper() && mine)) ? '<button class="btn danger" data-delete>Delete comment</button>' : ''}
          ${reqBtn}
        </div>
      </div>`;
    const d = $('#drawer');
    d.classList.remove('hidden'); $('#drawerBack').classList.remove('hidden'); d.scrollTop = 0;
    $('[data-close]', d).onclick = closeDrawer;
    $$('[data-copy]', d).forEach((b) => (b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); toast('Selector copied'); }));
    $$('[data-status]', d).forEach((b) => (b.onclick = async () => {
      try {
        const { comment } = await api('PATCH', `/api/comments/${c.id}`, { status: b.dataset.status });
        Object.assign(c, comment); renderFilters(); renderComments(); openDrawer(c.id);
        toast(comment.status === 'resolved' ? 'Marked resolved' : 'Reopened');
      } catch (err) { toast(err.message); }
    }));
    const delBtn = $('[data-delete]', d);
    if (delBtn) delBtn.onclick = async () => {
      if (!(await confirmBox('Delete this comment?', 'The comment and its screenshot will be permanently removed.', 'Delete'))) return;
      try { await api('DELETE', `/api/comments/${c.id}`); comments = comments.filter((x) => x.id !== c.id); closeDrawer(); renderFilters(); renderComments(); toast('Comment deleted'); }
      catch (err) { toast(err.message); }
    };
    const reqDelBtn = $('[data-request-del]', d);
    if (reqDelBtn) reqDelBtn.onclick = async () => {
      const r = await notePrompt('Request deletion', 'Ask the admin to delete this comment. Add a note explaining why — the admin will see it.', 'Send request', true);
      if (!r) return;
      try { const { comment } = await api('POST', `/api/comments/${c.id}/deletion-request`, { note: r.note }); Object.assign(c, comment); renderComments(); openDrawer(c.id); toast('Deletion request sent to the admin'); }
      catch (err) { toast(err.message); }
    };
    const declineBtn = $('[data-decline]', d);
    if (declineBtn) declineBtn.onclick = async () => {
      const r = await notePrompt('Decline deletion request', 'The comment stays. Optionally add a note the developer will see.', 'Decline request', false);
      if (!r) return;
      try { const { comment } = await api('POST', `/api/comments/${c.id}/cancel-deletion-request`, { note: r.note }); Object.assign(c, comment); renderFilters(); renderComments(); openDrawer(c.id); toast('Request declined'); }
      catch (err) { toast(err.message); }
    };
  }
  // Small modal asking for a note; resolves to {note} or null if cancelled.
  function notePrompt(title, text, okLabel, required) {
    return new Promise((resolve) => {
      modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><form id="np"><label>Note${required ? '' : ' <span class="opt">optional</span>'}<textarea name="note" rows="3" maxlength="1000" ${required ? 'required' : ''} placeholder="${required ? 'Reason for deletion…' : 'Optional note…'}"></textarea></label><p class="error" data-error></p><div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${esc(okLabel)}</button></div></form>`,
      (el, close) => {
        $('[data-x]', el).onclick = () => { close(); resolve(null); };
        $('[name=note]', el).focus();
        $('#np', el).onsubmit = (e) => {
          e.preventDefault();
          const note = $('[name=note]', el).value.trim();
          if (required && !note) { setError(e.target, 'Please add a note.'); return; }
          close(); resolve({ note });
        };
      });
    });
  }

  /* ------------------------------------------------------------ team */
  async function loadUsers() {
    try { users = (await api('GET', '/api/users')).users; renderUsers(); renderFilters(); }
    catch (e) { toast(e.message); }
  }
  const roleBadge = (u) => u.role === 'owner' ? '<span class="pill owner">Admin</span>'
    : u.role === 'developer' ? `<span class="pill dev">Developer</span>${u.active ? '' : ' <span class="pill off">Disabled</span>'}`
    : (u.active ? '' : '<span class="pill off">Disabled</span>');
  function renderUsers() {
    const order = { owner: 0, developer: 1, reviewer: 2 };
    const sorted = [...users].sort((a, b) => (order[a.role] - order[b.role]) || a.name.localeCompare(b.name));
    // Developers see the team read-only (so they know who the admin is); only the admin gets action buttons.
    const canManage = isOwner();
    $('#userList').innerHTML = sorted.map((u) => `
      <div class="user" data-id="${u.id}">
        <span class="avatar">${esc(initials(u.name))}</span>
        <div class="who">
          <strong>${esc(u.name)} ${roleBadge(u)}${u.resetRequestedAt ? '<span class="pill req">Password reset requested</span>' : ''}</strong>
          <div class="sub">${esc(u.email)} · ${u.commentCount} comment${u.commentCount === 1 ? '' : 's'} · ${u.lastLoginAt ? 'last sign-in ' + timeAgo(u.lastLoginAt) : 'never signed in'}</div>
          ${u.resetRequestedAt && canManage ? `<div class="reset-note">Forgot their login${u.resetRequestNote ? `: “${esc(u.resetRequestNote)}”` : ''} — use <b>Reset password</b>, then send them the new details.</div>` : ''}
          ${u.emailRequest && u.emailRequest.status === 'pending' && canManage ? `<div class="email-req">Wants their email changed to <b>${esc(u.emailRequest.newEmail)}</b> <button class="btn small accent" data-u="email-approve">Approve</button> <button class="btn small" data-u="email-cancel">Cancel</button></div>` : ''}
          ${u.role !== 'owner' ? `<div class="sites">${u.allowedSites.length ? u.allowedSites.map((s) => `<span>${esc(s)}</span>`).join('') : '<span>All websites</span>'}</div>` : ''}
        </div>
        <div class="acts">${(canManage && u.role !== 'owner') ? `
          <button class="btn small" data-u="sites">Websites</button>
          <button class="btn small" data-u="reset">Reset password</button>
          <button class="btn small" data-u="toggle">${u.active ? 'Disable' : 'Enable'}</button>
          <button class="btn small danger" data-u="remove">Remove</button>` : ''}
        </div>
      </div>`).join('');
  }
  $('#userList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-u]'); if (!b) return;
    const u = users.find((x) => x.id === b.closest('.user').dataset.id);
    const act = b.dataset.u;
    try {
      if (act === 'toggle') {
        if (u.active && !(await confirmBox(`Disable ${u.name}?`, 'They will be signed out of the extension and cannot submit comments until you enable them again.', 'Disable'))) return;
        await api('PATCH', `/api/users/${u.id}`, { active: !u.active }); toast(u.active ? 'Access disabled' : 'Access enabled');
      }
      if (act === 'remove') {
        if (!(await confirmBox(`Remove ${u.name}?`, 'Their access is removed permanently. Comments they already submitted are kept.', 'Remove'))) return;
        await api('DELETE', `/api/users/${u.id}`); toast('Removed');
      }
      if (act === 'reset') return resetPassword(u);
      if (act === 'sites') return editSites(u);
      if (act === 'email-approve') { await api('POST', `/api/users/${u.id}/email-request`, { action: 'approve' }); toast(`Email changed to ${u.emailRequest.newEmail}`); }
      if (act === 'email-cancel') { await api('POST', `/api/users/${u.id}/email-request`, { action: 'cancel' }); toast('Email change declined'); }
      loadUsers();
    } catch (err) { toast(err.message); }
  });
  function inviteText(name, email, password, key) {
    return `Hi ${name}, you've been given access to review our website.\n\n1. Install the Site Review Inspector extension in Chrome.\n2. Click the extension icon and sign in:\n   Server: ${location.origin}\n   Email: ${email}\n   Password: ${password}${key ? `\n   6-digit key: ${key}  (use this if you forget your password)` : ''}\n3. Open the website, click the review button (bottom-left), click any element and leave your comment.`;
  }
  function resetPassword(u) {
    modal(`<h2>Reset password for ${esc(u.name)}</h2><p>They'll be signed out and need the new details. Send them these yourself.</p>
      <form id="rpForm"><label>New password<div class="input-row"><input name="password" value="${genPassword()}" minlength="8" required><button type="button" class="btn small" data-g>Generate</button></div></label>
      <label>New 6-digit key <span class="opt">optional — blank keeps the old one</span><div class="input-row"><input name="recoveryKey" inputmode="numeric" pattern="\\d{6}" maxlength="6" placeholder="(unchanged)"><button type="button" class="btn small" data-gk>Generate</button></div></label>
      <p class="error" data-error></p><div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Reset &amp; show details</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      $('[data-g]', el).onclick = () => { $('[name=password]', el).value = genPassword(); };
      $('[data-gk]', el).onclick = () => { $('[name=recoveryKey]', el).value = genKey(); };
      $('#rpForm', el).onsubmit = async (e) => {
        e.preventDefault();
        const password = $('[name=password]', el).value;
        const recoveryKey = $('[name=recoveryKey]', el).value.trim();
        try {
          await api('PATCH', `/api/users/${u.id}`, recoveryKey ? { password, recoveryKey } : { password }); close();
          showInvite(u.name, u.email, password, recoveryKey); toast('Password reset'); switchTab('team'); loadUsers();
        } catch (err) { setError(e.target, err.message); }
      };
    });
  }
  function editSites(u) {
    modal(`<h2>Websites for ${esc(u.name)}</h2><p>Comma-separated domains. Leave empty to allow every website. Subdomains are included.</p>
      <form id="stForm"><label>Allowed websites<input name="allowedSites" value="${esc(u.allowedSites.join(', '))}" placeholder="example.com"></label>
      <p class="error" data-error></p><div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      $('#stForm', el).onsubmit = async (e) => {
        e.preventDefault();
        try { await api('PATCH', `/api/users/${u.id}`, { allowedSites: $('[name=allowedSites]', el).value }); close(); toast('Saved'); loadUsers(); }
        catch (err) { setError(e.target, err.message); }
      };
    });
  }
  function showInvite(name, email, password, key) {
    $('#inviteText').textContent = inviteText(name, email, password, key);
    $('#inviteBox').classList.remove('hidden');
  }
  $('#addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; setError(f, '');
    const body = Object.fromEntries(new FormData(f));
    // Only the admin may pick a role; a developer can add reviewers only.
    if (!isOwner()) body.role = 'reviewer';
    // A developer assigns websites by ticking from their own domains.
    if (isDeveloper()) {
      const sites = me.allowedSites || [];
      if (sites.length) {
        const picked = $$('#sitesChoices input:checked').map((c) => c.value);
        if (!picked.length) { setError(f, 'Pick at least one website for this reviewer.'); return; }
        body.allowedSites = picked;
      } else { delete body.allowedSites; }
    }
    try {
      await api('POST', '/api/users', body);
      showInvite(body.name, body.email.trim().toLowerCase(), body.password, body.recoveryKey);
      f.reset(); if ($('#roleSelect')) $('#roleSelect').value = 'reviewer'; onRoleChange(); setupSitesField();
      toast(body.role === 'developer' ? 'Developer added' : 'Reviewer added'); loadUsers();
    } catch (err) { setError(f, err.message); }
  });
  // Toggle the website-restriction hint and heading as the chosen role changes.
  function onRoleChange() {
    const dev = $('#roleSelect') && $('#roleSelect').value === 'developer';
    if ($('#addFormTitle')) $('#addFormTitle').textContent = dev ? 'Add a developer' : 'Add a reviewer';
    if ($('#addFormHint')) $('#addFormHint').textContent = dev
      ? 'Developers can see all comments, resolve them and add reviewers. They cannot edit or remove people, delete others’ comments, or see billing.'
      : 'Reviewers sign in to the extension with this email and password, then can inspect pages and leave comments.';
  }

  boot().catch((e) => { document.body.innerHTML = `<p style="padding:24px">Could not reach the server: ${esc(e.message)}</p>`; });
})();
