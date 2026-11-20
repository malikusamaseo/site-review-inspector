(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  let token = localStorage.getItem('sri_super_token');
  let me = null;
  let agencies = [];
  const filters = { q: '', state: 'all' };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) { signOutLocal(); throw new Error(data.error || 'Signed out'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600); }
  function modal(html, bind) {
    $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden');
    const close = () => $('#modal').classList.add('hidden');
    bind && bind($('#modalBody'), close);
    return close;
  }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
  const setError = (form, msg) => { const e = $('[data-error]', form); if (e) e.textContent = msg || ''; };
  function genPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const a = crypto.getRandomValues(new Uint32Array(12));
    return [...a].map((n) => chars[n % chars.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
  }
  const genKey = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function fmtDateTime(iso) { return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }

  /* ---------------------------------------------------------- auth */
  function show(id) { ['auth', 'app'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== id)); }
  function signOutLocal() { token = null; me = null; localStorage.removeItem('sri_super_token'); boot(); }
  async function boot() {
    if (token) {
      try {
        const r = await api('GET', '/api/me');
        if (r.user.role !== 'superadmin') { throw new Error('not super'); }
        me = r.user; show('app'); startApp(); return;
      } catch { token = null; localStorage.removeItem('sri_super_token'); }
    }
    const { needsSetup } = await api('GET', '/api/platform/status');
    show('auth');
    $('#setupForm').classList.toggle('hidden', !needsSetup);
    $('#loginForm').classList.toggle('hidden', needsSetup);
  }
  async function handleAuth(form, url) {
    setError(form, ''); const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      Object.keys(body).forEach((k) => { if (body[k] === '') delete body[k]; }); // don't send the inactive login field
      if (url === '/api/login' && !body.password && !body.recoveryKey) { setError(form, 'Enter your password or 6-digit key.'); btn.disabled = false; return; }
      const data = await api('POST', url, body);
      if (data.user && data.user.role !== 'superadmin') { setError(form, 'This is not a platform-admin account. Use the agency sign-in.'); btn.disabled = false; return; }
      token = data.token; localStorage.setItem('sri_super_token', token); form.reset(); boot();
    } catch (e) { setError(form, e.message); }
    btn.disabled = false;
  }
  $('#setupForm').addEventListener('submit', (e) => { e.preventDefault(); handleAuth(e.target, '/api/platform/setup'); });
  $('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); handleAuth(e.target, '/api/login'); });
  // Password / recovery-key toggle on the login form.
  $('.login-mode', $('#loginForm')).addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    const key = b.dataset.m === 'key';
    $$('.login-mode [data-m]', $('#loginForm')).forEach((x) => x.classList.toggle('on', x === b));
    $('.lf-password', $('#loginForm')).classList.toggle('hidden', key);
    $('.lf-key', $('#loginForm')).classList.toggle('hidden', !key);
    const inp = $(key ? '.lf-key input' : '.lf-password input', $('#loginForm')); if (inp) inp.focus();
  });
  // Generate buttons on any form that has a recovery-key field.
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-genkey]'); if (!g) return;
    const inp = g.closest('.input-row') ? $('input', g.closest('.input-row')) : null;
    if (inp) inp.value = genKey();
  });

  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-action]'); if (!a) return;
    if (a.dataset.action === 'logout') { try { await api('POST', '/api/logout'); } catch {} signOutLocal(); }
    if (a.dataset.action === 'change-email') accountForm('email');
    if (a.dataset.action === 'change-password') accountForm('password');
    if (a.dataset.action === 'change-key') accountForm('key');
  });

  /* ---------------------------------------------------------- app */
  let started = false;
  function startApp() {
    $('#meName').textContent = me.name; $('#meName2').textContent = me.name; $('#meEmail').textContent = me.email; $('#meAvatar').textContent = initials(me.name);
    if (!started) {
      started = true;
      $('#accountBtn').onclick = (e) => { e.stopPropagation(); $('#accountMenu').classList.toggle('hidden'); };
      document.addEventListener('click', (e) => { if (!e.target.closest('.account')) $('#accountMenu').classList.add('hidden'); });
      $('#q').addEventListener('input', (e) => { filters.q = e.target.value; render(); });
      $('#stateSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; filters.state = b.dataset.state; $$('#stateSeg button').forEach((x) => x.classList.toggle('on', x === b)); render(); });
      $('#addBtn').addEventListener('click', addAgency);
      setInterval(() => { if (token && !document.hidden) load(true); }, 30000);
    }
    load();
  }
  function accountForm(kind) {
    $('#accountMenu').classList.add('hidden');
    const title = kind === 'email' ? 'Change email' : kind === 'key' ? 'Change recovery key' : 'Change password';
    const fields = kind === 'email'
      ? `<label>New email<input name="email" type="email" required></label><label>Your password<input name="password" type="password" required></label>`
      : kind === 'key'
        ? `<label>Your password<input name="password" type="password" required></label><label>New 6-digit recovery key<div class="input-row"><input name="recoveryKey" inputmode="numeric" pattern="\\d{6}" maxlength="6" required><button type="button" class="btn small" data-genkey>Generate</button></div></label>`
        : `<label>Current password<input name="currentPassword" type="password" required></label><label>New password<input name="newPassword" type="password" minlength="8" required></label>`;
    const path = kind === 'email' ? '/api/me/email' : kind === 'key' ? '/api/me/recovery-key' : '/api/me/password';
    modal(`<h2>${title}</h2><form id="acc">${fields}
      <p class="error" data-error></p><div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      $('#acc', el).onsubmit = async (ev) => {
        ev.preventDefault();
        try { const r = await api('POST', path, Object.fromEntries(new FormData(ev.target))); if (r.user) { me = r.user; startApp(); } close(); toast('Saved'); }
        catch (err) { setError(ev.target, err.message); }
      };
    });
  }

  async function load(silent) {
    try {
      const [ov, ag] = await Promise.all([api('GET', '/api/platform/overview'), api('GET', '/api/agencies')]);
      $('#stAgencies').textContent = ov.agencies; $('#stActive').textContent = ov.active;
      $('#stSoon').textContent = ov.expiringSoon; $('#stExpired').textContent = ov.expired + ov.suspended;
      $('#stReviewers').textContent = ov.reviewers; $('#stComments').textContent = ov.comments;
      agencies = ag.agencies; render();
    } catch (e) { if (!silent) toast(e.message); }
  }

  const stateMeta = {
    active: ['Active', 'resolved'], grace: ['In grace', 'grace'], expired: ['Expired', 'off'], suspended: ['Suspended', 'off'],
  };
  function render() {
    const q = filters.q.toLowerCase();
    const list = agencies.filter((a) =>
      (filters.state === 'all' || a.state === filters.state) &&
      (!q || [a.name, a.ownerName, a.ownerEmail].some((f) => String(f || '').toLowerCase().includes(q))));
    const el = $('#agencyList');
    if (!list.length) { el.innerHTML = `<div class="empty"><strong>${agencies.length ? 'No agencies match' : 'No agencies yet'}</strong>${agencies.length ? 'Try another filter.' : 'Click “Add agency” to create your first subscriber.'}</div>`; return; }
    el.innerHTML = list.map((a) => {
      const [label, cls] = stateMeta[a.state] || ['—', 'off'];
      const renew = a.state === 'active' && a.daysLeft != null
        ? `${a.daysLeft}d left` : a.state === 'grace' ? `grace: ${a.daysLeft != null ? Math.abs(a.daysLeft) : 0}d over`
        : a.state === 'expired' ? `expired ${fmtDate(a.expiresAt)}` : a.state === 'suspended' ? 'suspended' : '';
      return `<article class="agency" data-id="${a.id}">
        <div class="ag-main">
          <div class="ag-top"><strong>${esc(a.name)}</strong><span class="pill ${cls}">${label}</span><span class="plan">${esc(a.plan)}</span>${a.ownerResetRequestedAt ? '<span class="pill req">Password reset requested</span>' : ''}${a.ownerEmailRequest && a.ownerEmailRequest.status === 'pending' ? '<span class="pill req">Email change requested</span>' : ''}</div>
          <div class="ag-sub">${esc(a.ownerName || '—')} · ${esc(a.ownerEmail || 'no owner')}</div>
          <div class="ag-meta">
            <span>Renews/expires: <b>${fmtDate(a.expiresAt)}</b> ${renew ? `· ${esc(renew)}` : ''}</span>
            <span>${a.reviewerCount} reviewer${a.reviewerCount === 1 ? '' : 's'}${a.maxReviewers ? ` / ${a.maxReviewers}` : ''}${a.developerCount ? ` · ${a.developerCount} developer${a.developerCount === 1 ? '' : 's'}` : ''}</span>
            <span>${a.commentCount} comment${a.commentCount === 1 ? '' : 's'}</span>
            ${a.lastAccessAt ? `<span title="Your last support access">last opened ${fmtDate(a.lastAccessAt)}</span>` : ''}
          </div>
        </div>
        <div class="ag-acts">
          <button class="btn accent" data-a="open">Open panel</button>
          <button class="btn" data-a="renew">Renew</button>
          <button class="btn" data-a="edit">Edit</button>
          <button class="btn" data-a="log">Access log</button>
          <button class="btn danger" data-a="delete">Delete</button>
        </div>
      </article>`;
    }).join('');
  }
  $('#agencyList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-a]'); if (!btn) return;
    const a = agencies.find((x) => x.id === btn.closest('.agency').dataset.id); if (!a) return;
    ({ open: openPanel, renew: renewAgency, edit: editAgency, log: showLog, delete: deleteAgency })[btn.dataset.a](a);
  });

  async function openPanel(a) {
    try {
      const r = await api('POST', `/api/agencies/${a.id}/impersonate`, {});
      // Hand the support session to the agency dashboard in a new tab (tab-scoped, visible banner there).
      window.open('/#imp=' + encodeURIComponent(r.token), '_blank');
      toast(`Opened ${a.name} — this access is logged and visible to the agency`);
      load(true);
    } catch (e) { toast(e.message); }
  }

  function planFields(a) {
    return `<div class="two"><label>Plan<select name="plan">
      <option value="monthly"${!a || a.plan === 'monthly' ? ' selected' : ''}>Monthly</option>
      <option value="yearly"${a && a.plan === 'yearly' ? ' selected' : ''}>Yearly</option></select></label>
      <label>Max reviewers <span class="opt">blank = unlimited</span><input name="maxReviewers" type="number" min="1" value="${a && a.maxReviewers ? a.maxReviewers : ''}"></label></div>
      <div class="two"><label>Expiry date<input name="expiresAt" type="date" value="${a && a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0, 10) : ''}"></label>
      <label>Grace days after expiry<input name="graceDays" type="number" min="0" max="90" value="${a ? a.graceDays : 7}"></label></div>`;
  }
  function addAgency() {
    const pw = genPassword();
    modal(`<h2>Add agency</h2><p class="muted">Creates the agency and its owner login. New plan defaults to a full period from today.</p>
      <form id="ag"><label>Agency name<input name="name" required placeholder="Acme Marketing"></label>
      <div class="two"><label>Owner name<input name="ownerName" required></label><label>Owner email<input name="ownerEmail" type="email" required></label></div>
      <div class="two"><label>Owner password<div class="input-row"><input name="ownerPassword" value="${pw}" minlength="8" required><button type="button" class="btn small" data-g>Generate</button></div></label>
      <label>Owner 6-digit key<div class="input-row"><input name="ownerRecoveryKey" inputmode="numeric" pattern="\\d{6}" maxlength="6" value="${genKey()}" required><button type="button" class="btn small" data-genkey>Generate</button></div></label></div>
      ${planFields(null)}
      <p class="error" data-error></p>
      <div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Create agency</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      $('[data-g]', el).onclick = () => { $('[name=ownerPassword]', el).value = genPassword(); };
      $('#ag', el).onsubmit = async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target));
        try { const r = await api('POST', '/api/agencies', body); close(); load(); showInvite(r.agency, body.ownerEmail, body.ownerPassword, body.ownerRecoveryKey); }
        catch (err) { setError(e.target, err.message); }
      };
    });
  }
  function showInvite(a, email, password, key) {
    const keyLine = key ? `\n   6-digit key: ${key}  (use this if you forget your password)` : '';
    const text = `Hi ${a.ownerName || ''}, your Site Review account is ready.\n\n1. Install the Site Review Inspector extension in Chrome.\n2. Dashboard: ${location.origin}/\n   Email: ${email}\n   Password: ${password}${keyLine}\n3. In the extension, sign in with the same details (server ${location.origin}).\n\nPlan: ${a.plan}. Renews/expires ${fmtDate(a.expiresAt)}.`;
    modal(`<h2>Agency created</h2><p class="muted">Send these sign-in details to the agency owner.</p>
      <pre class="invite-pre">${esc(text)}</pre>
      <div class="row"><button class="btn" data-copy>Copy</button><button class="btn primary" data-x>Done</button></div>`,
    (el, close) => { $('[data-x]', el).onclick = close; $('[data-copy]', el).onclick = () => { navigator.clipboard.writeText(text); toast('Copied'); }; });
  }
  function renewAgency(a) {
    modal(`<h2>Renew ${esc(a.name)}</h2><p class="muted">Extends from ${a.state === 'active' ? 'the current expiry' : 'today'}. Also reactivates a suspended agency.</p>
      <form id="rn"><label>Renew for<select name="plan"><option value="monthly"${a.plan === 'monthly' ? ' selected' : ''}>1 month</option><option value="yearly"${a.plan === 'yearly' ? ' selected' : ''}>1 year</option></select></label>
      <p class="error" data-error></p><div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Renew</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      $('#rn', el).onsubmit = async (e) => { e.preventDefault(); try { const r = await api('POST', `/api/agencies/${a.id}/renew`, { plan: $('[name=plan]', el).value }); close(); load(); toast(`Renewed until ${fmtDate(r.agency.expiresAt)}`); } catch (err) { setError(e.target, err.message); } };
    });
  }
  function editAgency(a) {
    const req = a.ownerResetRequestedAt
      ? `<div class="req-box pending" style="margin-bottom:14px"><div><strong>Owner requested a new password</strong> · ${fmtDate(a.ownerResetRequestedAt)}${a.ownerResetRequestNote ? `<div class="req-note">“${esc(a.ownerResetRequestNote)}”</div>` : ''}<div class="req-hint">Set a new password (and key) below, then send it to them yourself. Saving clears this request.</div></div></div>`
      : '';
    const emReq = a.ownerEmailRequest && a.ownerEmailRequest.status === 'pending'
      ? `<div class="req-box pending" style="margin-bottom:14px"><div><strong>Owner requested an email change</strong> to <b>${esc(a.ownerEmailRequest.newEmail)}</b><div class="req-hint">Approve to apply it, or cancel to decline. The owner is notified either way.</div><div class="actions" style="margin-top:8px"><button type="button" class="btn accent" data-emapprove>Approve change</button><button type="button" class="btn" data-emcancel>Cancel request</button></div></div></div>`
      : '';
    modal(`<h2>Edit ${esc(a.name)}</h2>${req}${emReq}
      <form id="ed"><label>Agency name<input name="name" value="${esc(a.name)}" required></label>
      <div class="two"><label>Owner name<input name="ownerName" value="${esc(a.ownerName || '')}"></label><label>Owner email<input name="ownerEmail" type="email" value="${esc(a.ownerEmail || '')}"></label></div>
      <div class="two"><label>Reset owner password <span class="opt">blank = keep</span><div class="input-row"><input name="ownerPassword" placeholder="(unchanged)"><button type="button" class="btn small" data-g>Generate</button></div></label>
      <label>Reset owner key <span class="opt">blank = keep</span><div class="input-row"><input name="ownerRecoveryKey" inputmode="numeric" pattern="\\d{6}" maxlength="6" placeholder="(unchanged)"><button type="button" class="btn small" data-genkey>Generate</button></div></label></div>
      ${planFields(a)}
      <label class="check"><input type="checkbox" name="suspend" ${a.status === 'suspended' ? 'checked' : ''}> Suspend this agency (blocks their logins)</label>
      <p class="error" data-error></p>
      <div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save changes</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      $('[data-g]', el).onclick = () => { $('[name=ownerPassword]', el).value = genPassword(); };
      const decide = async (action) => { try { await api('POST', `/api/agencies/${a.id}/email-request`, { action }); close(); load(); toast(action === 'approve' ? 'Email change approved' : 'Email change declined'); } catch (err) { toast(err.message); } };
      if ($('[data-emapprove]', el)) $('[data-emapprove]', el).onclick = () => decide('approve');
      if ($('[data-emcancel]', el)) $('[data-emcancel]', el).onclick = () => decide('cancel');
      $('#ed', el).onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target); const body = Object.fromEntries(f);
        body.status = f.get('suspend') ? 'suspended' : 'active';
        if (!body.ownerPassword) delete body.ownerPassword;
        if (!body.ownerRecoveryKey) delete body.ownerRecoveryKey;
        try { const r = await api('PATCH', `/api/agencies/${a.id}`, body); close(); load(); toast('Saved'); if (body.ownerPassword || body.ownerRecoveryKey) showInvite(r.agency, r.agency.ownerEmail, body.ownerPassword || '(unchanged)', body.ownerRecoveryKey); }
        catch (err) { setError(e.target, err.message); }
      };
    });
  }
  async function showLog(a) {
    try {
      const { log } = await api('GET', `/api/agencies/${a.id}/access-log`);
      modal(`<h2>Support access log — ${esc(a.name)}</h2><p class="muted">Every time a platform admin opened this agency's panel. The agency can see this too.</p>
        ${log.length ? `<div class="logrows">${log.map((l) => `<div><span>${esc(l.superadminName || l.superadminEmail)}</span><span>${fmtDateTime(l.at)}</span></div>`).join('')}</div>` : '<p class="muted">No access yet.</p>'}
        <div class="row"><button class="btn primary" data-x>Close</button></div>`,
      (el, close) => { $('[data-x]', el).onclick = close; });
    } catch (e) { toast(e.message); }
  }
  async function deleteAgency(a) {
    modal(`<h2>Delete ${esc(a.name)}?</h2><p>This permanently removes the agency, its owner and reviewers, and all ${a.commentCount} of their comments and screenshots. This cannot be undone.</p>
      <form id="del"><label>Type the agency name to confirm<input name="confirm" autocomplete="off"></label>
      <div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn danger" disabled data-ok>Delete agency</button></div></form>`,
    (el, close) => {
      $('[data-x]', el).onclick = close;
      const ok = $('[data-ok]', el);
      $('[name=confirm]', el).addEventListener('input', (e) => { ok.disabled = e.target.value.trim() !== a.name; });
      $('#del', el).onsubmit = async (e) => { e.preventDefault(); try { await api('DELETE', `/api/agencies/${a.id}`); close(); load(); toast('Agency deleted'); } catch (err) { toast(err.message); } };
    });
  }

  boot().catch((e) => { document.body.innerHTML = `<p style="padding:24px">Could not reach the server: ${esc(e.message)}</p>`; });
})();
