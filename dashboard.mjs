import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'yapper_dashboard_session';
const STATE_COOKIE = 'yapper_oauth_state';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const API_BASE = (process.env.YAPPER_API_URL || 'https://www.yapper.website/api/bot/v1').replace(/\/$/, '');

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}
function encodeSession(user, secret) {
  const payload = Buffer.from(JSON.stringify({
    id: String(user.id), username: String(user.username || 'Discord user'),
    avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null,
    exp: Date.now() + SESSION_TTL,
  })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}
function decodeSession(token, secret, allowedIds) {
  if (!token) return null;
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length || !safeEqual(signature, sign(payload, secret))) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!user.id || !Number.isFinite(user.exp) || user.exp < Date.now() || !allowedIds.has(String(user.id))) return null;
    return user;
  } catch { return null; }
}
function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

export async function startDashboard({ getData, guildCfg, save }) {
  const secret = process.env.DASHBOARD_SECRET || '';
  const clientId = process.env.DISCORD_CLIENT_ID || '';
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
  const redirectUri = process.env.DASHBOARD_REDIRECT_URI || '';
  const allowedIds = new Set((process.env.DASHBOARD_ALLOWED_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const dashboardPassword = process.env.DASHBOARD_PASSWORD || '';
  const discordOAuthEnabled = Boolean(clientId && clientSecret && redirectUri && allowedIds.size);
  const token = process.env.TOKEN || '';
  if (secret.length < 32) throw new Error('Set DASHBOARD_SECRET to a random secret of at least 32 characters.');
  if (!dashboardPassword && !discordOAuthEnabled) throw new Error('Set DASHBOARD_PASSWORD (recommended) or configure all Discord OAuth environment variables and the Discord user allowlist.');
  if (dashboardPassword && dashboardPassword.length < 12) throw new Error('DASHBOARD_PASSWORD must be at least 12 characters.');
  if (dashboardPassword) allowedIds.add('password-admin');
  if (!token) throw new Error('Set TOKEN to your Yapper bot token.');

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked.' }); }
      catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
    }
    next();
  });

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sessionCookie = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure}`;
  const stateCookie = `Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
  const currentUser = req => decodeSession(cookie(req, COOKIE), secret, allowedIds);
  const auth = (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in to the dashboard first.' });
    req.dashboardUser = user;
    next();
  };

  async function yapper(method, apiPath, body) {
    const response = await fetch(API_BASE + apiPath, {
      method,
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    const raw = await response.text();
    const result = parseJson(raw);
    if (!response.ok) {
      const error = new Error(result?.error || result?.message || `Yapper API returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return result;
  }
  const route = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status >= 500) console.error('Dashboard route error:', e.message);
      res.status(status).json({ error: status === 500 ? 'Dashboard could not complete that request. Check the service logs.' : e.message });
    }
  };
  const serverId = req => String(req.params.id || '');
  const safeId = id => /^[\w-]{1,100}$/.test(String(id));
  async function ensureServer(id) {
    if (!safeId(id)) { const e = new Error('Invalid server ID.'); e.status = 400; throw e; }
    const result = await yapper('GET', '/servers');
    const servers = Array.isArray(result) ? result : (result?.servers || []);
    const found = servers.find(s => String(s.id) === id);
    if (!found) { const e = new Error('This bot is not in that server, or the server is not visible to it.'); e.status = 404; throw e; }
    return found;
  }
  const localCfg = id => guildCfg(id);
  function listWarnings(cfg, id) {
    const warnings = [];
    for (const [userId, list] of Object.entries(cfg.warnings || {})) {
      if (!Array.isArray(list)) continue;
      list.forEach((w, i) => warnings.push({ caseId: w.case_id || `LEGACY-${id}-${userId}-${i + 1}`, userId, action: w.action || 'warn', reason: String(w.reason || 'No reason recorded'), moderator: String(w.mod || 'Unknown'), timestamp: Number(w.time || 0) }));
    }
    return warnings.sort((a, b) => b.timestamp - a.timestamp).slice(0, 250);
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'yapper-modbot-dashboard' }));
  app.get('/', (_req, res) => res.sendFile(path.join(HERE, 'public', 'dashboard.html')));
  app.get('/auth/discord', (req, res) => {
    if (!discordOAuthEnabled) return res.status(404).send('Discord OAuth is not configured. Use the dashboard password login.');
    const state = crypto.randomBytes(24).toString('base64url');
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=${encodeURIComponent(`${state}.${sign(state, secret)}`)}; ${stateCookie}`);
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });
  app.get('/auth/discord/callback', route(async (req, res) => {
    if (!discordOAuthEnabled) return res.status(404).send('Discord OAuth is not configured.');
    const stateToken = cookie(req, STATE_COOKIE);
    const [storedState, signature, ...extra] = stateToken.split('.');
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=; Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    if (!req.query.code || !req.query.state || extra.length || !storedState || !safeEqual(String(req.query.state), storedState) || !safeEqual(signature || '', sign(storedState, secret))) {
      return res.status(400).send('OAuth state check failed. Please return to the dashboard and try again.');
    }
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri });
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) return res.status(502).send('Discord sign-in failed. Check the OAuth app settings and callback URL.');
    const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenData.access_token}` }, signal: AbortSignal.timeout(15000) });
    const user = await userRes.json().catch(() => ({}));
    if (!userRes.ok || !user.id) return res.status(502).send('Could not read your Discord profile. Please try again.');
    if (!allowedIds.has(String(user.id))) return res.status(403).send('This Discord account is not on the dashboard allowlist. Ask the dashboard owner to add your Discord user ID.');
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(encodeSession(user, secret))}; ${sessionCookie}`);
    res.redirect('/');
  }));
  const loginAttempts = new Map();
  app.post('/api/login', (req, res) => {
    if (!dashboardPassword) return res.status(404).json({ error: 'Password login is not enabled.' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (record && record.until > now && record.count >= 10) return res.status(429).json({ error: 'Too many login attempts. Wait 10 minutes and try again.' });
    if (!safeEqual(String(req.body?.password || ''), dashboardPassword)) {
      const next = record && record.until > now ? record : { count: 0, until: now + 10 * 60 * 1000 };
      next.count += 1; loginAttempts.set(ip, next);
      return res.status(401).json({ error: 'Incorrect dashboard password.' });
    }
    loginAttempts.delete(ip);
    const user = { id: 'password-admin', username: 'Dashboard Admin', avatar: null };
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(encodeSession(user, secret))}; ${sessionCookie}`);
    res.json({ ok: true, user: { id: user.id, username: user.username, avatar: null } });
  });
  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => {
    const user = currentUser(req);
    res.json({ authenticated: !!user, user: user ? { id: user.id, username: user.username, avatar: user.avatar } : null, loginOptions: { password: Boolean(dashboardPassword), discord: discordOAuthEnabled } });
  });
  app.get('/api/yapper-status', auth, route(async (_req, res) => {
    const profile = await yapper('GET', '/me');
    res.json({ connected: true, bot: profile?.bot?.name || profile?.display_name || profile?.username || 'Yapper bot', profile });
  }));

  app.get('/api/overview', auth, route(async (_req, res) => {
    const result = await yapper('GET', '/servers');
    const servers = (Array.isArray(result) ? result : result?.servers || []).map(s => {
      const cfg = (getData() || {})[String(s.id)] || {};
      const warningCount = Object.values(cfg.warnings || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
      return { id: String(s.id), name: s.name || s.display_name || 'Unnamed server', icon_path: s.icon_path || null, member_count: Number(s.member_count || s.memberCount || 0), warningCount, reportCount: Array.isArray(cfg.reports) ? cfg.reports.length : 0, bannedWords: Array.isArray(cfg.banned_words) ? cfg.banned_words.length : 0, linkBlocking: Boolean(cfg.block_links), logChannel: cfg.log_channel || null };
    });
    res.json({ servers, totals: { servers: servers.length, warnings: servers.reduce((n, s) => n + s.warningCount, 0), reports: servers.reduce((n, s) => n + s.reportCount, 0) } });
  }));

  app.get('/api/servers/:id', auth, route(async (req, res) => {
    const id = serverId(req); const server = await ensureServer(id);
    const [roleResult, channelResult] = await Promise.all([yapper('GET', `/servers/${encodeURIComponent(id)}/roles`), yapper('GET', `/servers/${encodeURIComponent(id)}/channels`)]);
    const cfg = localCfg(id);
    const roles = (Array.isArray(roleResult) ? roleResult : roleResult?.roles || []).map(r => ({ id: String(r.id), name: r.name || 'Role', color: r.color || null, position: Number(r.position || 0), perms: r.perms || r.permissions || {} })).sort((a,b) => b.position-a.position);
    const channels = (Array.isArray(channelResult) ? channelResult : channelResult?.channels || []).map(c => ({ id: String(c.id), name: c.name || 'channel', type: c.type || c.kind || 'text' }));
    res.json({ server: { id: String(server.id), name: server.name || server.display_name || 'Unnamed server', icon_path: server.icon_path || null, owner_id: server.owner_id || null, member_count: Number(server.member_count || 0) }, roles, channels, settings: { banned_words: cfg.banned_words || [], block_links: Boolean(cfg.block_links), allowed_domains: cfg.allowed_domains || [], log_channel: cfg.log_channel || '' }, warnings: listWarnings(cfg, id), reports: (cfg.reports || []).slice(-100).reverse() });
  }));

  app.get('/api/servers/:id/members', auth, route(async (req, res) => {
    const id = serverId(req); await ensureServer(id);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    const suffix = new URLSearchParams({ limit: String(limit) }); if (after) suffix.set('after', after);
    const result = await yapper('GET', `/servers/${encodeURIComponent(id)}/members?${suffix}`);
    const members = Array.isArray(result) ? result : (result?.members || []);
    res.json({ members: members.map(m => ({ id: String(m.id || m.user_id), username: m.username || m.name || 'Unknown member', display_name: m.nickname || m.display_name || m.username || m.name || 'Unknown member', avatar_path: m.avatar_path || null, role_ids: (m.roles || m.role_ids || []).map(String), timeout: m.timeout || null })), nextAfter: members.length ? String(members[members.length - 1].id || members[members.length - 1].user_id) : null, hasMore: members.length === limit });
  }));

  app.put('/api/servers/:id/settings', auth, route(async (req, res) => {
    const id = serverId(req); await ensureServer(id); const body = req.body || {};
    if (typeof body.block_links !== 'boolean') { const e = new Error('block_links must be true or false.'); e.status = 400; throw e; }
    const cleanList = (value, max, label) => {
      if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 120)) { const e = new Error(`${label} must be a list of up to ${max} short text values.`); e.status = 400; throw e; }
      return [...new Set(value.map(v => v.trim().toLowerCase()))];
    };
    const cfg = localCfg(id); cfg.block_links = body.block_links;
    cfg.banned_words = cleanList(body.banned_words, 200, 'banned_words');
    cfg.allowed_domains = cleanList(body.allowed_domains, 100, 'allowed_domains').map(d => d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, ''));
    const channel = typeof body.log_channel === 'string' ? body.log_channel.trim() : '';
    if (channel && !/^[\w-]+$/.test(channel)) { const e = new Error('log_channel must be a channel ID or blank.'); e.status = 400; throw e; }
    cfg.log_channel = channel || null; save(); res.json({ ok: true });
  }));

  app.patch('/api/servers/:id/members/:uid/nickname', auth, route(async (req, res) => {
    const id = serverId(req), uid = String(req.params.uid); await ensureServer(id);
    const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname.trim() : null;
    if (nickname === null || nickname.length > 32) { const e = new Error('Nickname must be 0–32 characters.'); e.status = 400; throw e; }
    await yapper('PATCH', `/servers/${encodeURIComponent(id)}/members/${encodeURIComponent(uid)}`, { nickname }); res.json({ ok: true });
  }));
  app.put('/api/servers/:id/members/:uid/roles/:rid', auth, route(async (req, res) => {
    const { id } = req.params; await ensureServer(id); await yapper('PUT', `/servers/${encodeURIComponent(id)}/members/${encodeURIComponent(req.params.uid)}/roles/${encodeURIComponent(req.params.rid)}`); res.json({ ok: true });
  }));
  app.delete('/api/servers/:id/members/:uid/roles/:rid', auth, route(async (req, res) => {
    const { id } = req.params; await ensureServer(id); await yapper('DELETE', `/servers/${encodeURIComponent(id)}/members/${encodeURIComponent(req.params.uid)}/roles/${encodeURIComponent(req.params.rid)}`); res.json({ ok: true });
  }));
  app.post('/api/servers/:id/members/:uid/timeout', auth, route(async (req, res) => {
    const id = serverId(req); await ensureServer(id);
    const minutes = Number(req.body?.minutes); const reason = String(req.body?.reason || 'Dashboard moderation').slice(0, 200);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 40320) { const e = new Error('Timeout must be 0 (clear) to 40320 minutes.'); e.status = 400; throw e; }
    await yapper('POST', `/servers/${encodeURIComponent(id)}/timeouts`, { user_id: String(req.params.uid), minutes, reason }); res.json({ ok: true });
  }));
  app.post('/api/servers/:id/members/:uid/kick', auth, route(async (req, res) => {
    const id = serverId(req); await ensureServer(id); await yapper('POST', `/servers/${encodeURIComponent(id)}/kick`, { user_id: String(req.params.uid) }); res.json({ ok: true });
  }));
  app.post('/api/servers/:id/members/:uid/ban', auth, route(async (req, res) => {
    const id = serverId(req); await ensureServer(id); await yapper('POST', `/servers/${encodeURIComponent(id)}/bans`, { user_id: String(req.params.uid) }); res.json({ ok: true });
  }));
  app.delete('/api/servers/:id/members/:uid/ban', auth, route(async (req, res) => {
    const id = serverId(req); await ensureServer(id); await yapper('DELETE', `/servers/${encodeURIComponent(id)}/bans/${encodeURIComponent(req.params.uid)}`); res.json({ ok: true });
  }));

  app.use((err, _req, res, _next) => { console.error('Dashboard error:', err.message); res.status(500).json({ error: 'Internal dashboard error.' }); });
  const port = Number(process.env.PORT || 10000);
  await new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => { console.log(`Yapper dashboard listening on 0.0.0.0:${port}`); resolve(); });
    server.once('error', reject);
  });
}
