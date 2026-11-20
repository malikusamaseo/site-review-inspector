const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

async function render() {
  const state = await send({ type: 'getState' });
  $('#loginView').classList.toggle('hidden', state.loggedIn);
  $('#mainView').classList.toggle('hidden', !state.loggedIn);
  if (!state.loggedIn) {
    $('#loginView [name=server]').value = state.server;
    $('#loginView [name=email]').focus();
    return;
  }
  const u = state.user || {};
  $('#avatar').textContent = initials(u.name);
  $('#name').textContent = u.name || '';
  $('#email').textContent = u.email || '';
  const owner = u.role === 'owner';
  const developer = u.role === 'developer';
  const staff = owner || developer;
  const superadmin = u.role === 'superadmin';
  $('#role').textContent = superadmin ? 'Platform admin' : owner ? 'Admin' : developer ? 'Developer' : 'Reviewer';
  $('#role').classList.toggle('owner', staff || superadmin);
  // A platform-admin account has no agency, so it can't inspect — point them to the panel.
  $('#inspectBtn').classList.toggle('hidden', superadmin);
  $('#myStats').classList.toggle('hidden', superadmin);
  $('#dashBtn').classList.toggle('hidden', superadmin && false);
  $('#mainError').textContent = superadmin ? 'This is a platform-admin account. Open an agency panel from the platform dashboard to inspect, or sign in here with an agency login.' : '';
  if (superadmin) { $('#dashLabel').textContent = 'Open platform admin'; return; }
  $('#dashLabel').textContent = staff ? 'Open dashboard' : 'My comments';
  $('#pendingLabel').textContent = staff ? 'Open' : 'Pending';
  send({ type: 'api', method: 'GET', path: '/api/comments?status=all' }).then((r) => {
    if (!r.ok) return;
    const list = r.data.comments;
    const pending = list.filter((c) => c.status === 'open').length;
    $('#cntPending').textContent = pending;
    $('#cntResolved').textContent = list.length - pending;
    $('#myStats').classList.remove('hidden');
  });
  $('#enabled').checked = state.enabled;
  $('#serverLabel').textContent = state.server.replace(/^https?:\/\//, '');
  // Refresh in the background so a removed/disabled reviewer gets signed out promptly.
  send({ type: 'refreshMe' }).then((r) => { if (!r.ok && r.status === 401) render(); });
}

// Password / recovery-key toggle.
$('.login-mode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  const key = b.dataset.m === 'key';
  document.querySelectorAll('.login-mode [data-m]').forEach((x) => x.classList.toggle('on', x === b));
  $('.lf-password').classList.toggle('hidden', key);
  $('.lf-key').classList.toggle('hidden', !key);
  const inp = (key ? $('.lf-key input') : $('.lf-password input')); if (inp) inp.focus();
});

$('#loginView').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const password = (f.get('password') || '').trim();
  const recoveryKey = (f.get('recoveryKey') || '').trim();
  if (!password && !recoveryKey) { $('#loginError').textContent = 'Enter your password or 6-digit key.'; return; }
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Signing in…'; $('#loginError').textContent = '';
  const r = await send({ type: 'login', server: f.get('server'), email: f.get('email'), password: password || undefined, recoveryKey: recoveryKey || undefined });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (!r.ok) {
    $('#loginError').textContent = r.error;
    if (r.status === 0) $('#serverBox').open = true;
    return;
  }
  render();
});

// Forgot both → send a reset request to the tier above (no email is sent by the tool).
$('#forgotLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const email = ($('#loginView [name=email]').value || '').trim();
  if (!email) { $('#loginError').textContent = 'Enter your email first, then click again.'; return; }
  $('#loginError').textContent = '';
  const r = await send({ type: 'resetRequest', server: $('#loginView [name=server]').value, email });
  $('#loginError').style.color = r.ok ? 'var(--muted)' : '';
  $('#loginError').textContent = r.ok ? (r.message || 'Request sent to your admin.') : r.error;
});

$('#inspectBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) { $('#mainError').textContent = "This page can't be inspected. Open a website first."; return; }
  const r = await send({ type: 'startInTab', tabId: tab.id });
  if (!r.ok) { $('#mainError').textContent = r.error; return; }
  window.close();
});

$('#enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));
$('#dashBtn').addEventListener('click', async () => { await send({ type: 'openDashboard' }); window.close(); });
$('#logoutBtn').addEventListener('click', async () => { await send({ type: 'logout' }); render(); });

render();
