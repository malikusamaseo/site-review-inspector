// Site Review Inspector — background service worker.
// Holds the session token and makes every server call, so web pages never see the token.

const DEFAULT_SERVER = 'http://localhost:4000';

async function getState() {
  const s = await chrome.storage.local.get(['server', 'token', 'user', 'enabled']);
  return { server: s.server || DEFAULT_SERVER, token: s.token || null, user: s.user || null, enabled: s.enabled !== false };
}

async function api(method, path, body) {
  const { server, token } = await getState();
  let res;
  try {
    res = await fetch(server.replace(/\/+$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, error: `Can't reach the review server (${server}). Check the server URL or your connection.` };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && path !== '/api/login') {
    await chrome.storage.local.remove(['token', 'user']); // access removed/expired → sign out everywhere
  }
  return res.ok ? { ok: true, status: res.status, data } : { ok: false, status: res.status, error: data.error || `Request failed (${res.status})` };
}

async function login({ server, email, password, recoveryKey }) {
  server = String(server || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(server)) return { ok: false, error: 'Server URL must start with http:// or https://' };
  await chrome.storage.local.set({ server });
  const r = await api('POST', '/api/login', { email, password, recoveryKey });
  if (!r.ok) return r;
  await chrome.storage.local.set({ token: r.data.token, user: r.data.user, enabled: true });
  return { ok: true, user: r.data.user };
}

async function resetRequest({ server, email }) {
  server = String(server || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(server)) await chrome.storage.local.set({ server });
  const r = await api('POST', '/api/password-reset-request', { email });
  return r.ok ? { ok: true, message: r.data.message } : r;
}

async function logout() {
  await api('POST', '/api/logout');
  await chrome.storage.local.remove(['token', 'user']);
  return { ok: true };
}

async function capture(windowId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 72 });
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Make sure the content script is in the tab (pages opened before install/update don't have it yet).
async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (r && r.pong) return true;
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch { return false; }
}

async function sendToTab(tabId, message) {
  if (!(await ensureContentScript(tabId))) return { ok: false, error: "This page can't be inspected (browser pages and the Web Store are blocked by Chrome)." };
  try { return (await chrome.tabs.sendMessage(tabId, message)) || { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'getState': {
        const s = await getState();
        return { loggedIn: !!s.token, user: s.user, enabled: s.enabled, server: s.server };
      }
      case 'api': return api(msg.method, msg.path, msg.body);
      case 'login': return login(msg);
      case 'resetRequest': return resetRequest(msg);
      case 'logout': return logout();
      case 'refreshMe': {
        const r = await api('GET', '/api/me');
        if (r.ok) await chrome.storage.local.set({ user: r.data.user });
        return r;
      }
      case 'capture': return capture(sender.tab ? sender.tab.windowId : undefined);
      case 'openDashboard': {
        const { server, token } = await getState();
        // Pass the session in the URL fragment (never sent to the server or logged) so the dashboard opens signed in.
        await chrome.tabs.create({ url: server.replace(/\/+$/, '') + '/' + (token ? `#session=${encodeURIComponent(token)}` : '') });
        return { ok: true };
      }
      case 'startInTab': return sendToTab(msg.tabId, { type: 'startInspect' });
      default: return { ok: false, error: 'Unknown message' };
    }
  })().then(sendResponse);
  return true; // async response
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-inspect') return;
  const { token } = await getState();
  if (!token) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) sendToTab(tab.id, { type: 'toggleInspect' });
});
