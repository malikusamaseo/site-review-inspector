/**
 * Site Review Inspector — server (multi-tenant SaaS)
 *
 * Roles:
 *   - superadmin : platform operator. Manages agencies and their subscriptions.
 *                  Can open ("impersonate") any agency panel for support — this is
 *                  LOGGED and VISIBLE to the agency in their account access log.
 *   - owner      : an agency's subscriber. Manages their reviewers and sees their comments.
 *   - reviewer   : added by an owner; leaves comments, sees only their own.
 *
 * Each agency is an isolated tenant: its users and comments are scoped by agencyId,
 * so one agency can never see another's data.
 *
 * Storage is a JSON file (data/db.json) plus screenshot files (data/screenshots).
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_DAYS = 30;
const DAY = 864e5;
const PLAN_DAYS = { monthly: 30, yearly: 365 };

fs.mkdirSync(SHOTS_DIR, { recursive: true });

/* ---------------------------------------------------------------- storage */
let db = { agencies: [], users: [], sessions: [], comments: [], accessLog: [], seq: 0 };
if (fs.existsSync(DB_FILE)) {
  try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch (e) { console.error('Could not read db.json:', e.message); process.exit(1); }
}
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 100); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (saveTimer) flush(); process.exit(0); });

/* ---------------------------------------------------------------- helpers */
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const str = (v, max) => (v == null ? '' : String(v)).slice(0, max);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const validPassword = (pw) => typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
// A 6-digit recovery key is a second way to sign in and is mandatory on every account.
const normKey = (k) => String(k == null ? '' : k).trim();
const validKey = (k) => /^\d{6}$/.test(normKey(k));

function normalizeSites(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  return [...new Set(list.map((s) => String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '').replace(/^www\./, ''))
    .filter(Boolean))].slice(0, 50);
}
function siteAllowed(user, url) {
  if (!user.allowedSites || !user.allowedSites.length) return true;
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  return user.allowedSites.some((s) => host === s || host.endsWith('.' + s));
}
function pageKey(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`; }
  catch { return String(url); }
}
// Every requested domain must be covered by one of the allowed domains (same host or a subdomain).
function sitesSubset(requested, allowed) {
  if (!allowed.length) return true;
  return requested.every((r) => allowed.some((a) => r === a || r.endsWith('.' + a)));
}
const userById = (id) => db.users.find((u) => u.id === id);
const agencyById = (id) => db.agencies.find((a) => a.id === id);
const agencyOwner = (agencyId) => db.users.find((u) => u.agencyId === agencyId && u.role === 'owner');
const hasSuperadmin = () => db.users.some((u) => u.role === 'superadmin');

/** Effective subscription state of an agency. */
function agencyState(a) {
  if (!a) return { state: 'missing', ok: false, daysLeft: null };
  if (a.status === 'suspended') return { state: 'suspended', ok: false, daysLeft: null };
  if (!a.expiresAt) return { state: 'active', ok: true, daysLeft: null };
  const exp = new Date(a.expiresAt).getTime();
  const t = Date.now();
  const daysLeft = Math.ceil((exp - t) / DAY);
  if (t <= exp) return { state: 'active', ok: true, daysLeft };
  const graceEnd = exp + (a.graceDays || 0) * DAY;
  if (t <= graceEnd) return { state: 'grace', ok: true, daysLeft, graceLeft: Math.ceil((graceEnd - t) / DAY) };
  return { state: 'expired', ok: false, daysLeft };
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, agencyId: u.agencyId || null,
    active: u.active !== false, allowedSites: u.allowedSites || [], createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null, commentCount: db.comments.filter((c) => c.userId === u.id).length,
    resetRequestedAt: u.resetRequestedAt || null, resetRequestNote: u.resetRequestNote || '',
    emailRequest: u.emailRequest || null,
  };
}
function publicAgency(a) {
  const owner = agencyOwner(a.id);
  const st = agencyState(a);
  return {
    id: a.id, name: a.name, plan: a.plan, status: a.status, createdAt: a.createdAt,
    expiresAt: a.expiresAt || null, graceDays: a.graceDays || 0, maxReviewers: a.maxReviewers || null,
    ownerName: owner ? owner.name : null, ownerEmail: owner ? owner.email : null,
    state: st.state, daysLeft: st.daysLeft,
    reviewerCount: db.users.filter((u) => u.agencyId === a.id && u.role === 'reviewer').length,
    developerCount: db.users.filter((u) => u.agencyId === a.id && u.role === 'developer').length,
    commentCount: db.comments.filter((c) => c.agencyId === a.id).length,
    lastAccessAt: (db.accessLog.filter((l) => l.agencyId === a.id).slice(-1)[0] || {}).at || null,
    ownerResetRequestedAt: owner ? (owner.resetRequestedAt || null) : null,
    ownerResetRequestNote: owner ? (owner.resetRequestNote || '') : '',
    ownerEmailRequest: owner ? (owner.emailRequest || null) : null,
  };
}

function createSession(user, imp) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions.push({
    tokenHash: sha256(token), userId: user.id, createdAt: now(),
    expiresAt: new Date(Date.now() + SESSION_DAYS * DAY).toISOString(),
    ...(imp ? { imp } : {}),
  });
  if (!imp) { user.lastLoginAt = now(); }
  save();
  return token;
}
function revokeSessions(userId) { db.sessions = db.sessions.filter((s) => s.userId !== userId); save(); }

/** One-time migration: wrap pre-SaaS single-tenant data into a default agency. */
function migrate() {
  const legacyOwners = db.users.filter((u) => u.role === 'owner' && !u.agencyId);
  if (!db.agencies.length && (legacyOwners.length || db.users.some((u) => !u.agencyId && u.role !== 'superadmin'))) {
    const agency = { id: newId(), name: 'My Agency', plan: 'yearly', status: 'active',
      expiresAt: null, graceDays: 7, maxReviewers: null, createdAt: now() };
    db.agencies.push(agency);
    for (const u of db.users) if (u.role !== 'superadmin' && !u.agencyId) u.agencyId = agency.id;
    for (const c of db.comments) if (!c.agencyId) c.agencyId = agency.id;
    save();
    console.log('Migrated existing data into a default agency ("My Agency").');
  }
}
migrate();

/* ---------------------------------------------------------------- app */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.allowQueryToken ? req.query.token : null);
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const s = db.sessions.find((x) => x.tokenHash === sha256(String(token)));
  if (!s || new Date(s.expiresAt) < new Date()) return res.status(401).json({ error: 'Session expired, please sign in again' });

  if (s.imp) {
    // Super-admin acting inside an agency panel.
    const superUser = userById(s.imp.superadminId);
    const owner = agencyOwner(s.imp.agencyId);
    const agency = agencyById(s.imp.agencyId);
    if (!superUser || superUser.role !== 'superadmin' || !owner || !agency) return res.status(401).json({ error: 'This support session is no longer valid' });
    req.user = owner;               // act with the owner's powers
    req.agencyId = agency.id;
    req.agency = agency;
    req.impersonated = true;
    req.superadmin = superUser;
    return next();
  }

  const user = userById(s.userId);
  if (!user || user.active === false) return res.status(401).json({ error: 'Your access has been removed' });
  req.user = user;
  req.sessionToken = token;
  if (user.role === 'superadmin') { req.agencyId = null; return next(); }

  // owner / reviewer: enforce the agency's subscription
  const agency = agencyById(user.agencyId);
  const st = agencyState(agency);
  if (!st.ok) return res.status(402).json({ error: subscriptionMessage(st), subscription: st.state });
  req.agencyId = user.agencyId;
  req.agency = agency;
  next();
}
function subscriptionMessage(st) {
  if (st.state === 'suspended') return 'This account has been suspended. Please contact your provider.';
  if (st.state === 'expired') return 'This subscription has expired. Please renew to continue.';
  return 'This account is not active.';
}
const requireSuper = (req, res, next) =>
  (req.user.role === 'superadmin' && !req.impersonated) ? next() : res.status(403).json({ error: 'Super-admin only' });
const ownerOnly = (req, res, next) =>
  (req.user.role === 'owner') ? next() : res.status(403).json({ error: 'Only the agency admin can do this' });
// "Staff" = admin (owner) + developer: both see all of the agency's comments and the team.
const isStaff = (u) => u.role === 'owner' || u.role === 'developer';
const staffOnly = (req, res, next) =>
  isStaff(req.user) ? next() : res.status(403).json({ error: 'Not allowed' });
const needAgency = (req, res, next) =>
  req.agencyId ? next() : res.status(400).json({ error: 'No agency selected. Open an agency panel first.' });

/* ================================================================ platform / auth */
app.get('/api/platform/status', (req, res) => res.json({ needsSetup: !hasSuperadmin() }));

app.post('/api/platform/setup', (req, res) => {
  if (hasSuperadmin()) return res.status(400).json({ error: 'A super-admin already exists' });
  const name = str(req.body.name, 100).trim(); const email = normEmail(req.body.email);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (!validPassword(req.body.password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!validKey(req.body.recoveryKey)) return res.status(400).json({ error: 'Recovery key must be exactly 6 digits' });
  const user = { id: newId(), name, email, role: 'superadmin', agencyId: null, active: true,
    passwordHash: hashPassword(req.body.password), recoveryKeyHash: hashPassword(normKey(req.body.recoveryKey)), createdAt: now() };
  db.users.push(user);
  res.json({ token: createSession(user), user: publicUser(user) });
});

// Tells the agency login page whether the platform is set up and whether any agency exists yet.
app.get('/api/setup-status', (req, res) =>
  res.json({ needsPlatformSetup: !hasSuperadmin(), hasAgencies: db.agencies.length > 0 }));

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const email = normEmail(req.body.email);
  const key = `${req.ip}|${email}`;
  const a = attempts.get(key);
  if (a && a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const user = db.users.find((u) => u.email === email);
  // Sign in with the password, or with the 6-digit recovery key as an alternative.
  const usingKey = req.body.recoveryKey != null && req.body.recoveryKey !== '';
  const ok = user && (usingKey
    ? (user.recoveryKeyHash && verifyPassword(normKey(req.body.recoveryKey), user.recoveryKeyHash))
    : verifyPassword(req.body.password || '', user.passwordHash));
  if (!ok) {
    const count = (a && a.until <= Date.now() ? 0 : (a?.count || 0)) + 1;
    attempts.set(key, { count, until: count >= 8 ? Date.now() + 10 * 60e3 : 0 });
    return res.status(401).json({ error: usingKey ? 'Wrong email or recovery key' : 'Wrong email or password' });
  }
  if (user.active === false) return res.status(403).json({ error: 'Your access has been disabled' });
  if (user.role !== 'superadmin') {
    const st = agencyState(agencyById(user.agencyId));
    if (!st.ok) return res.status(402).json({ error: subscriptionMessage(st), subscription: st.state });
  }
  attempts.delete(key);
  // Signing in resolves any pending "forgot password" request.
  if (user.resetRequestedAt) { delete user.resetRequestedAt; delete user.resetRequestNote; save(); }
  res.json({ token: createSession(user), user: publicUser(user) });
});

// Forgot both password and key: ask the tier above for a new password (no email is sent).
const resetAttempts = new Map();
app.post('/api/password-reset-request', (req, res) => {
  const email = normEmail(req.body.email);
  const rl = resetAttempts.get(req.ip);
  if (rl && rl.until > Date.now()) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  resetAttempts.set(req.ip, { until: (rl && rl.count >= 10 ? Date.now() + 10 * 60e3 : 0), count: ((rl && rl.until <= Date.now() ? 0 : rl?.count) || 0) + 1 });
  const user = db.users.find((u) => u.email === email);
  // Super-admins are the top tier — there's no one to request from.
  if (user && user.role !== 'superadmin') {
    user.resetRequestedAt = now();
    user.resetRequestNote = str(req.body.message, 500).trim();
    save();
  }
  // Generic response so the form never reveals which emails exist.
  const who = user && user.role === 'owner' ? 'your provider'
    : user && (user.role === 'reviewer' || user.role === 'developer') ? 'your agency admin' : 'your administrator';
  res.json({ ok: true, message: `If that account exists, ${who} has been notified and can set you a new password.` });
});

app.post('/api/logout', auth, (req, res) => {
  const token = (req.get('authorization') || '').slice(7);
  db.sessions = db.sessions.filter((s) => s.tokenHash !== sha256(token)); save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  // A decided email-change notification clears itself 24h after the decision.
  const er = req.user.emailRequest;
  if (er && er.status !== 'pending' && er.decidedAt && Date.now() - new Date(er.decidedAt) > DAY) { delete req.user.emailRequest; save(); }
  const out = { user: publicUser(req.user), impersonated: !!req.impersonated };
  if (req.impersonated) { out.agencyName = req.agency.name; out.superadminEmail = req.superadmin.email; }
  if (req.agency) { const st = agencyState(req.agency); out.subscription = { plan: req.agency.plan, ...st }; }
  res.json(out);
});

// The extension hands its session to the dashboard; give the dashboard its own session.
app.post('/api/session/clone', auth, (req, res) => {
  if (req.impersonated) return res.status(400).json({ error: 'Cannot clone a support session' });
  res.json({ token: createSession(req.user), user: publicUser(req.user) });
});

// Only the super-admin (top tier) changes their own email directly. Everyone else must request it.
app.post('/api/me/email', auth, (req, res) => {
  if (req.impersonated) return res.status(403).json({ error: 'Not available in super-admin view' });
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Email changes must be requested from your admin' });
  if (!verifyPassword(req.body.password || '', req.user.passwordHash)) return res.status(400).json({ error: 'Password is wrong' });
  const email = normEmail(req.body.email);
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (db.users.some((u) => u.email === email && u.id !== req.user.id)) return res.status(400).json({ error: 'Another account already uses this email' });
  req.user.email = email; save();
  res.json({ user: publicUser(req.user) });
});

// Owner / reviewer / developer: ask the tier above to change their email.
app.post('/api/me/email-request', auth, (req, res) => {
  if (req.impersonated) return res.status(403).json({ error: 'Not available in super-admin view' });
  if (req.user.role === 'superadmin') return res.status(403).json({ error: 'You can change your email directly' });
  const email = normEmail(req.body.email);
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (db.users.some((u) => u.email === email && u.id !== req.user.id)) return res.status(400).json({ error: 'Another account already uses this email' });
  if (req.user.emailRequest && req.user.emailRequest.status === 'pending') return res.status(400).json({ error: 'You already have an email change pending' });
  req.user.emailRequest = { newEmail: email, at: now(), status: 'pending' };
  save();
  const who = req.user.role === 'owner' ? 'your provider' : 'your agency admin';
  res.json({ user: publicUser(req.user), message: `Request sent to ${who}.` });
});

// The requester dismisses the approved/declined notification ("Okay").
app.post('/api/me/email-request/ack', auth, (req, res) => {
  if (req.user.emailRequest && req.user.emailRequest.status !== 'pending') { delete req.user.emailRequest; save(); }
  res.json({ user: publicUser(req.user) });
});

// Decide an email-change request for a user (the tier above applies or declines it).
function decideEmailRequest(user, action, decidedByName, res) {
  const r = user.emailRequest;
  if (!r || r.status !== 'pending') { res.status(400).json({ error: 'There is no pending email request' }); return false; }
  if (action === 'approve') {
    if (db.users.some((u) => u.email === r.newEmail && u.id !== user.id)) { res.status(400).json({ error: 'That email is now used by another account' }); return false; }
    user.email = r.newEmail;
    user.emailRequest = { ...r, status: 'approved', decidedAt: now(), decidedByName };
  } else {
    user.emailRequest = { ...r, status: 'cancelled', decidedAt: now(), decidedByName };
  }
  save();
  return true;
}
app.post('/api/me/password', auth, (req, res) => {
  if (req.impersonated) return res.status(403).json({ error: 'Not available in super-admin view' });
  if (!verifyPassword(req.body.currentPassword || '', req.user.passwordHash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!validPassword(req.body.newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  req.user.passwordHash = hashPassword(req.body.newPassword); save();
  res.json({ ok: true });
});
app.post('/api/me/recovery-key', auth, (req, res) => {
  if (req.impersonated) return res.status(403).json({ error: 'Not available in super-admin view' });
  if (!verifyPassword(req.body.password || '', req.user.passwordHash)) return res.status(400).json({ error: 'Password is wrong' });
  if (!validKey(req.body.recoveryKey)) return res.status(400).json({ error: 'Recovery key must be exactly 6 digits' });
  req.user.recoveryKeyHash = hashPassword(normKey(req.body.recoveryKey)); save();
  res.json({ ok: true });
});

/* ================================================================ super-admin: agencies */
app.get('/api/platform/overview', auth, requireSuper, (req, res) => {
  const list = db.agencies.map(agencyState);
  res.json({
    agencies: db.agencies.length,
    active: list.filter((s) => s.state === 'active').length,
    grace: list.filter((s) => s.state === 'grace').length,
    expired: list.filter((s) => s.state === 'expired').length,
    suspended: list.filter((s) => s.state === 'suspended').length,
    expiringSoon: list.filter((s) => s.state === 'active' && s.daysLeft != null && s.daysLeft <= 7).length,
    reviewers: db.users.filter((u) => u.role === 'reviewer').length,
    comments: db.comments.length,
  });
});

app.get('/api/agencies', auth, requireSuper, (req, res) =>
  res.json({ agencies: db.agencies.map(publicAgency).sort((a, b) => a.name.localeCompare(b.name)) }));

function planExpiry(plan, from) {
  const days = PLAN_DAYS[plan];
  if (!days) return null;
  return new Date((from ? new Date(from).getTime() : Date.now()) + days * DAY).toISOString();
}

app.post('/api/agencies', auth, requireSuper, (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 120).trim();
  const ownerName = str(b.ownerName, 100).trim();
  const ownerEmail = normEmail(b.ownerEmail);
  const plan = PLAN_DAYS[b.plan] ? b.plan : 'monthly';
  if (!name) return res.status(400).json({ error: 'Agency name is required' });
  if (!ownerName) return res.status(400).json({ error: 'Owner name is required' });
  if (!isEmail(ownerEmail)) return res.status(400).json({ error: 'Enter a valid owner email' });
  if (db.users.some((u) => u.email === ownerEmail)) return res.status(400).json({ error: 'A user with this email already exists' });
  if (!validPassword(b.ownerPassword)) return res.status(400).json({ error: 'Owner password must be at least 8 characters' });
  if (!validKey(b.ownerRecoveryKey)) return res.status(400).json({ error: 'Owner recovery key must be exactly 6 digits' });

  const agency = {
    id: newId(), name, plan, status: 'active',
    expiresAt: b.expiresAt ? new Date(b.expiresAt).toISOString() : planExpiry(plan),
    graceDays: Number.isFinite(+b.graceDays) ? Math.max(0, Math.min(90, +b.graceDays)) : 7,
    maxReviewers: b.maxReviewers ? Math.max(1, Math.min(1000, +b.maxReviewers)) : null,
    createdAt: now(),
  };
  db.agencies.push(agency);
  const owner = { id: newId(), name: ownerName, email: ownerEmail, role: 'owner', agencyId: agency.id,
    active: true, allowedSites: [], passwordHash: hashPassword(b.ownerPassword),
    recoveryKeyHash: hashPassword(normKey(b.ownerRecoveryKey)), createdAt: now() };
  db.users.push(owner);
  save();
  res.json({ agency: publicAgency(agency) });
});

app.patch('/api/agencies/:id', auth, requireSuper, (req, res) => {
  const a = agencyById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Agency not found' });
  const b = req.body || {};
  if (b.name !== undefined) { const n = str(b.name, 120).trim(); if (n) a.name = n; }
  if (b.plan !== undefined && PLAN_DAYS[b.plan]) a.plan = b.plan;
  if (b.status === 'active' || b.status === 'suspended') a.status = b.status;
  if (b.expiresAt !== undefined) a.expiresAt = b.expiresAt ? new Date(b.expiresAt).toISOString() : null;
  if (b.graceDays !== undefined) a.graceDays = Math.max(0, Math.min(90, +b.graceDays || 0));
  if (b.maxReviewers !== undefined) a.maxReviewers = b.maxReviewers ? Math.max(1, Math.min(1000, +b.maxReviewers)) : null;

  const owner = agencyOwner(a.id);
  if (owner) {
    if (b.ownerName !== undefined) { const n = str(b.ownerName, 100).trim(); if (n) owner.name = n; }
    if (b.ownerEmail !== undefined) {
      const email = normEmail(b.ownerEmail);
      if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid owner email' });
      if (db.users.some((u) => u.email === email && u.id !== owner.id)) return res.status(400).json({ error: 'Another user already uses this email' });
      owner.email = email;
    }
    if (b.ownerPassword !== undefined && b.ownerPassword !== '') {
      if (!validPassword(b.ownerPassword)) return res.status(400).json({ error: 'Owner password must be at least 8 characters' });
      owner.passwordHash = hashPassword(b.ownerPassword); revokeSessions(owner.id);
      // Resetting the owner's password clears any pending "forgot password" request.
      delete owner.resetRequestedAt; delete owner.resetRequestNote;
    }
    if (b.ownerRecoveryKey !== undefined && b.ownerRecoveryKey !== '') {
      if (!validKey(b.ownerRecoveryKey)) return res.status(400).json({ error: 'Owner recovery key must be exactly 6 digits' });
      owner.recoveryKeyHash = hashPassword(normKey(b.ownerRecoveryKey));
    }
  }
  save();
  res.json({ agency: publicAgency(a) });
});

app.post('/api/agencies/:id/renew', auth, requireSuper, (req, res) => {
  const a = agencyById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Agency not found' });
  const plan = PLAN_DAYS[req.body.plan] ? req.body.plan : a.plan;
  a.plan = plan;
  if (a.status === 'suspended') a.status = 'active';
  // Extend from the later of now or the current expiry, so early renewals don't lose time.
  const base = a.expiresAt && new Date(a.expiresAt) > new Date() ? a.expiresAt : now();
  a.expiresAt = planExpiry(plan, base);
  save();
  res.json({ agency: publicAgency(a) });
});

// Super-admin approves/cancels the agency owner's email-change request.
app.post('/api/agencies/:id/email-request', auth, requireSuper, (req, res) => {
  const a = agencyById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Agency not found' });
  const owner = agencyOwner(a.id);
  if (!owner) return res.status(400).json({ error: 'This agency has no owner account' });
  if (decideEmailRequest(owner, req.body.action === 'approve' ? 'approve' : 'cancel', req.user.name, res))
    res.json({ agency: publicAgency(a) });
});

app.delete('/api/agencies/:id', auth, requireSuper, (req, res) => {
  const a = agencyById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Agency not found' });
  for (const c of db.comments.filter((c) => c.agencyId === a.id)) if (c.screenshot) fs.rm(path.join(SHOTS_DIR, c.screenshot), { force: true }, () => {});
  const uids = new Set(db.users.filter((u) => u.agencyId === a.id).map((u) => u.id));
  db.comments = db.comments.filter((c) => c.agencyId !== a.id);
  db.users = db.users.filter((u) => u.agencyId !== a.id);
  db.sessions = db.sessions.filter((s) => !uids.has(s.userId) && !(s.imp && s.imp.agencyId === a.id));
  db.accessLog = db.accessLog.filter((l) => l.agencyId !== a.id);
  db.agencies = db.agencies.filter((x) => x.id !== a.id);
  save();
  res.json({ ok: true });
});

// Open an agency panel for support. Logged + visible to the agency.
app.post('/api/agencies/:id/impersonate', auth, requireSuper, (req, res) => {
  const a = agencyById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Agency not found' });
  const owner = agencyOwner(a.id);
  if (!owner) return res.status(400).json({ error: 'This agency has no owner account' });
  db.accessLog.push({ id: newId(), agencyId: a.id, superadminId: req.user.id, superadminEmail: req.user.email, superadminName: req.user.name, at: now() });
  if (db.accessLog.length > 5000) db.accessLog = db.accessLog.slice(-5000);
  const token = createSession(owner, { superadminId: req.user.id, agencyId: a.id });
  res.json({ token, agency: publicAgency(a) });
});

app.get('/api/agencies/:id/access-log', auth, requireSuper, (req, res) =>
  res.json({ log: db.accessLog.filter((l) => l.agencyId === req.params.id).slice(-200).reverse() }));

/* ================================================================ owner: account & plan */
app.get('/api/account', auth, needAgency, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const a = req.agency; const st = agencyState(a);
  res.json({
    agency: { name: a.name, plan: a.plan, status: a.status, expiresAt: a.expiresAt, graceDays: a.graceDays,
      maxReviewers: a.maxReviewers, state: st.state, daysLeft: st.daysLeft },
    access: db.accessLog.filter((l) => l.agencyId === a.id).slice(-50).reverse()
      .map((l) => ({ at: l.at, by: l.superadminName || l.superadminEmail })),
  });
});

/* ================================================================ users (reviewers + developers) */
// Admin (owner) and developers can see the team; developers use it read-only.
app.get('/api/users', auth, needAgency, staffOnly, (req, res) =>
  res.json({ users: db.users.filter((u) => u.agencyId === req.agencyId).map(publicUser) }));

app.post('/api/users', auth, needAgency, staffOnly, (req, res) => {
  const name = str(req.body.name, 100).trim(); const email = normEmail(req.body.email);
  // Admin can add a reviewer or a developer; a developer can add reviewers only.
  const role = req.body.role === 'developer' ? 'developer' : 'reviewer';
  if (role === 'developer' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only the admin can add developers' });
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (db.users.some((u) => u.email === email)) return res.status(400).json({ error: 'A user with this email already exists' });
  if (!validPassword(req.body.password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!validKey(req.body.recoveryKey)) return res.status(400).json({ error: 'Recovery key must be exactly 6 digits' });
  const max = req.agency.maxReviewers;
  if (role === 'reviewer' && max && db.users.filter((u) => u.agencyId === req.agencyId && u.role === 'reviewer').length >= max)
    return res.status(403).json({ error: `Your plan allows up to ${max} reviewers. Contact your provider to add more.` });
  let allowedSites = normalizeSites(req.body.allowedSites);
  // A developer may only assign websites that fall within their own assigned websites.
  if (req.user.role === 'developer') {
    const dev = req.user.allowedSites || [];
    if (dev.length) {
      if (!allowedSites.length) return res.status(400).json({ error: 'Choose at least one website for this reviewer from your assigned websites' });
      if (!sitesSubset(allowedSites, dev)) return res.status(403).json({ error: 'You can only assign websites from your own allowed list' });
    }
  }
  const user = { id: newId(), name, email, role, agencyId: req.agencyId, active: true,
    allowedSites, passwordHash: hashPassword(req.body.password),
    recoveryKeyHash: hashPassword(normKey(req.body.recoveryKey)), createdAt: now() };
  db.users.push(user); save();
  res.json({ user: publicUser(user) });
});

function agencyUser(req, res) {
  const u = db.users.find((x) => x.id === req.params.id && x.agencyId === req.agencyId);
  if (!u) { res.status(404).json({ error: 'User not found' }); return null; }
  return u;
}
app.patch('/api/users/:id', auth, needAgency, ownerOnly, (req, res) => {
  const user = agencyUser(req, res); if (!user) return;
  const b = req.body;
  if (b.name !== undefined) { const n = str(b.name, 100).trim(); if (n) user.name = n; }
  if (b.allowedSites !== undefined && user.role !== 'owner') user.allowedSites = normalizeSites(b.allowedSites);
  if (b.active !== undefined && user.role !== 'owner') { user.active = !!b.active; if (!user.active) revokeSessions(user.id); }
  if (b.password !== undefined) {
    if (!validPassword(b.password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    user.passwordHash = hashPassword(b.password);
    if (user.id !== req.user.id) revokeSessions(user.id);
    // Resetting their password clears any pending "forgot password" request.
    delete user.resetRequestedAt; delete user.resetRequestNote;
  }
  if (b.recoveryKey !== undefined && b.recoveryKey !== '') {
    if (!validKey(b.recoveryKey)) return res.status(400).json({ error: 'Recovery key must be exactly 6 digits' });
    user.recoveryKeyHash = hashPassword(normKey(b.recoveryKey));
  }
  if (b.clearResetRequest) { delete user.resetRequestedAt; delete user.resetRequestNote; }
  save();
  res.json({ user: publicUser(user) });
});
// Admin approves/cancels a reviewer's or developer's email-change request.
app.post('/api/users/:id/email-request', auth, needAgency, ownerOnly, (req, res) => {
  const user = agencyUser(req, res); if (!user) return;
  if (decideEmailRequest(user, req.body.action === 'approve' ? 'approve' : 'cancel', req.user.name, res))
    res.json({ user: publicUser(user) });
});
app.delete('/api/users/:id', auth, needAgency, ownerOnly, (req, res) => {
  const user = agencyUser(req, res); if (!user) return;
  if (user.role === 'owner') return res.status(400).json({ error: 'The owner account cannot be removed' });
  db.users = db.users.filter((u) => u.id !== user.id);
  revokeSessions(user.id);
  res.json({ ok: true });
});

/* ================================================================ comments */
const STYLE_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'margin', 'padding', 'display', 'textAlign', 'borderRadius'];
function cleanElement(e = {}) {
  const r = e.rect || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
  const styles = {};
  for (const k of STYLE_KEYS) if (e.styles && e.styles[k] != null) styles[k] = str(e.styles[k], 200);
  const attrs = {};
  if (e.attributes && typeof e.attributes === 'object') for (const [k, v] of Object.entries(e.attributes).slice(0, 15)) attrs[str(k, 50)] = str(v, 300);
  return {
    selector: str(e.selector, 1000), xpath: str(e.xpath, 1000), tag: str(e.tag, 40), id: str(e.id, 200),
    classes: Array.isArray(e.classes) ? e.classes.slice(0, 30).map((c) => str(c, 100)) : [],
    text: str(e.text, 500), html: str(e.html, 2000), attributes: attrs, styles,
    rect: { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) },
  };
}

app.post('/api/comments', auth, needAgency, (req, res) => {
  const b = req.body || {};
  let url;
  try { url = new URL(b.url); if (!/^https?:$/.test(url.protocol)) throw 0; } catch { return res.status(400).json({ error: 'Invalid page URL' }); }
  if (!siteAllowed(req.user, url.href)) return res.status(403).json({ error: `You don't have access to review ${url.hostname}` });
  const description = str(b.description, 5000).trim();
  const authorName = str(b.authorName, 100).trim() || req.user.name;
  if (!description) return res.status(400).json({ error: 'Please write a comment' });

  const id = newId();
  let screenshot = null;
  const m = typeof b.screenshot === 'string' && b.screenshot.match(/^data:image\/(jpeg|png);base64,(.+)$/);
  if (m) {
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 12 * 1024 * 1024) { screenshot = `${id}.${m[1] === 'png' ? 'png' : 'jpg'}`; fs.writeFileSync(path.join(SHOTS_DIR, screenshot), buf); }
  }
  const v = b.viewport || {};
  const comment = {
    id, number: ++db.seq, status: 'open', agencyId: req.agencyId,
    userId: req.user.id, userEmail: req.user.email, userName: req.user.name, authorName, description,
    url: url.href, pageKey: pageKey(url.href), host: url.hostname, pageTitle: str(b.pageTitle, 300),
    element: cleanElement(b.element),
    viewport: { width: Number(v.width) || 0, height: Number(v.height) || 0, dpr: Number(v.dpr) || 1, scrollX: Number(v.scrollX) || 0, scrollY: Number(v.scrollY) || 0 },
    userAgent: str(req.get('user-agent'), 300), screenshot, createdAt: now(), resolvedAt: null, deletionRequest: null,
  };
  db.comments.push(comment); save();
  res.json({ comment });
});

app.get('/api/comments', auth, needAgency, (req, res) => {
  const { page, status, host, q, userId } = req.query;
  let list = db.comments.filter((c) => c.agencyId === req.agencyId);
  if (!isStaff(req.user)) list = list.filter((c) => c.userId === req.user.id);
  if (page) { const k = pageKey(page); list = list.filter((c) => c.pageKey === k); }
  if (status && status !== 'all') list = list.filter((c) => c.status === status);
  if (host) list = list.filter((c) => c.host === host);
  if (userId) list = list.filter((c) => c.userId === userId);
  if (q) {
    const s = String(q).toLowerCase();
    list = list.filter((c) => [c.description, c.authorName, c.userEmail, c.url, c.pageTitle, c.element.selector, c.element.text].some((f) => String(f || '').toLowerCase().includes(s)));
  }
  res.json({ comments: [...list].sort((a, b) => b.number - a.number) });
});

function findComment(req, res) {
  const c = db.comments.find((x) => x.id === req.params.id && x.agencyId === req.agencyId);
  if (!c || (!isStaff(req.user) && c.userId !== req.user.id)) { res.status(404).json({ error: 'Comment not found' }); return null; }
  return c;
}
app.get('/api/comments/:id', auth, needAgency, (req, res) => { const c = findComment(req, res); if (c) res.json({ comment: c }); });
// Admin and developers can resolve/reopen any comment in the agency.
app.patch('/api/comments/:id', auth, needAgency, staffOnly, (req, res) => {
  const c = findComment(req, res); if (!c) return;
  if (req.body.status === 'open' || req.body.status === 'resolved') { c.status = req.body.status; c.resolvedAt = c.status === 'resolved' ? now() : null; }
  save();
  res.json({ comment: c });
});
app.delete('/api/comments/:id', auth, needAgency, staffOnly, (req, res) => {
  const c = findComment(req, res); if (!c) return;
  // The admin can delete any comment; a developer can delete only their own.
  if (req.user.role !== 'owner' && c.userId !== req.user.id) return res.status(403).json({ error: 'You can only delete your own comments' });
  if (c.screenshot) fs.rm(path.join(SHOTS_DIR, c.screenshot), { force: true }, () => {});
  db.comments = db.comments.filter((x) => x.id !== c.id); save();
  res.json({ ok: true });
});

// A developer asks the admin to delete a comment they can't delete themselves, with a reason note.
app.post('/api/comments/:id/deletion-request', auth, needAgency, staffOnly, (req, res) => {
  if (req.user.role !== 'developer') return res.status(403).json({ error: 'Only developers request deletions' });
  const c = findComment(req, res); if (!c) return;
  if (c.userId === req.user.id) return res.status(400).json({ error: 'You can delete your own comments directly' });
  if (c.deletionRequest && c.deletionRequest.status === 'pending') return res.status(400).json({ error: 'A deletion request is already pending for this comment' });
  c.deletionRequest = { by: req.user.id, byName: req.user.name, byEmail: req.user.email, note: str(req.body.note, 1000).trim(), at: now(), status: 'pending' };
  save();
  res.json({ comment: c });
});

// The admin declines a pending deletion request (keeps the comment), optionally with a note back.
app.post('/api/comments/:id/cancel-deletion-request', auth, needAgency, ownerOnly, (req, res) => {
  const c = findComment(req, res); if (!c) return;
  if (!c.deletionRequest || c.deletionRequest.status !== 'pending') return res.status(400).json({ error: 'There is no pending deletion request' });
  c.deletionRequest = { ...c.deletionRequest, status: 'cancelled', cancelNote: str(req.body.note, 1000).trim(), cancelledAt: now(), cancelledByName: req.user.name };
  save();
  res.json({ comment: c });
});

app.get('/api/export.csv', auth, needAgency, staffOnly, (req, res) => {
  const cols = ['number', 'status', 'createdAt', 'authorName', 'userEmail', 'host', 'url', 'pageTitle', 'description', 'selector', 'tag', 'elementText'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = db.comments.filter((c) => c.agencyId === req.agencyId).sort((a, b) => a.number - b.number).map((c) =>
    [c.number, c.status, c.createdAt, c.authorName, c.userEmail, c.host, c.url, c.pageTitle, c.description, c.element.selector, c.element.tag, c.element.text].map(esc).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="review-comments.csv"');
  res.send([cols.join(','), ...rows].join('\n'));
});

app.get('/api/screenshots/:file', (req, res, next) => { req.allowQueryToken = true; next(); }, auth, needAgency, (req, res) => {
  const file = req.params.file;
  if (!/^[0-9a-f-]{36}\.(jpg|png)$/.test(file)) return res.sendStatus(404);
  const c = db.comments.find((x) => x.screenshot === file && x.agencyId === req.agencyId);
  if (!c || (!isStaff(req.user) && c.userId !== req.user.id)) return res.sendStatus(404);
  res.sendFile(path.join(SHOTS_DIR, file));
});

/* ---------------------------------------------------------------- static */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('/super', (req, res) => res.sendFile(path.join(__dirname, 'public', 'super.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Site Review Inspector server running on http://localhost:${PORT}`);
  if (!hasSuperadmin()) console.log(`No super-admin yet — open http://localhost:${PORT}/super to create the platform account.`);
});
