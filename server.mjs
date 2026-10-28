#!/usr/bin/env node
/**
 * server.mjs - web dashboard + bot launcher for Yapper ModBot (Node 18+, no npm packages).
 *
 * Runs the bot and the dashboard in ONE process so they share the same settings and
 * warnings. Login is "Login with Yapin'" (OAuth2 authorization-code flow).
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as bot from "./modbot.mjs"; // also loads .env before anything below runs

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT ?? 3000);
const BASE_URL = (env.BASE_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const SECURE = BASE_URL.startsWith("https://");
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
env.DASHBOARD_URL ??= BASE_URL;

const CLIENT_ID = env.YAPIN_CLIENT_ID ?? env.YAPPER_CLIENT_ID;
const CLIENT_SECRET = env.YAPIN_CLIENT_SECRET ?? env.YAPPER_CLIENT_SECRET;
const AUTHORIZE_URL = env.YAPIN_OAUTH_AUTHORIZE ?? "https://www.yapin.gg/oauth/authorize";
const TOKEN_URL = env.YAPIN_OAUTH_TOKEN ?? "https://www.yapin.gg/api/oauth/token";
const ME_URL = env.YAPIN_OAUTH_ME ?? "https://www.yapin.gg/api/oauth/me";
const OWNER_IDS = new Set((env.OWNER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

let SESSION_SECRET = env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET isn't set: everyone will be logged out whenever the server restarts.");
}
if (!CLIENT_ID || !CLIENT_SECRET) console.warn("YAPIN_CLIENT_ID / YAPIN_CLIENT_SECRET aren't set: logging in won't work yet.");

const SESSION_DAYS = 7;
const ts = () => new Date().toTimeString().slice(0, 8);
const b64 = (buf) => Buffer.from(buf).toString("base64url");
const sign = (s) => crypto.createHmac("sha256", SESSION_SECRET).update(s).digest("base64url");

// ---------------------------------------------------------------- cookies / sessions
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? "; Secure" : ""}`;
}
function makeSession(user) {
  const body = b64(JSON.stringify({ ...user, exp: Date.now() + SESSION_DAYS * 86400_000 }));
  return `${body}.${sign(body)}`;
}
function readSession(req) {
  const raw = parseCookies(req).ym_session;
  if (!raw) return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const u = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return u.exp > Date.now() ? u : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- tiny rate limiter
const hits = new Map();
function limited(req, bucket, max, windowMs = 60_000) {
  const ip = (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").toString().split(",")[0].trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const c = Date.now() - 120_000; for (const [k, a] of hits) if (a[a.length - 1] < c) hits.delete(k); }, 60_000).unref();

// ---------------------------------------------------------------- Login with Yapin'
async function exchangeCode(code) {
  // Documented request: form-encoded POST. The code works once, for 60 seconds, so no retries.
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    signal: AbortSignal.timeout(15_000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !json?.access_token) {
    throw new Error(`token exchange failed (${res.status}) ${json?.error ?? ""} ${json?.error_description ?? ""}`.trim());
  }
  return json.access_token;
}

async function fetchIdentity(token) {
  const res = await fetch(ME_URL, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`profile lookup failed (${res.status})`);
  const j = await res.json();
  const u = j.user ?? j;
  const id = u.id != null ? String(u.id) : null;
  if (!id) throw new Error("profile had no id");
  let avatar = u.avatarURL ?? u.avatar_url ?? u.avatar ?? null;
  if (typeof avatar === "string" && avatar.startsWith("/")) avatar = new URL(avatar, ME_URL).href;
  if (typeof avatar !== "string" || !/^https:\/\//.test(avatar)) avatar = null;
  return { id, username: String(u.username ?? id), displayName: u.displayName ?? u.display_name ?? null, avatar };
}

// ---------------------------------------------------------------- server access
const sessionName = (u) => u.displayName || u.username;

async function access(user, gid, fresh = false) {
  if (!/^[\w-]+$/.test(gid) || !bot.knownGuildIds().has(gid)) return null;
  let guild;
  try { guild = await bot.getGuild(gid, fresh); } catch { return null; }
  if (OWNER_IDS.has(user.id)) {
    return { guild, level: "manage", override: true, member: { id: user.id, name: user.username, displayName: sessionName(user), roleIds: [] } };
  }
  let member;
  try { member = await bot.getMember(guild, user.id, fresh); } catch { return null; }
  const level = bot.canManage(member, guild) ? "manage" : bot.canModerate(member, guild) ? "mod" : null;
  return level ? { guild, member, level, override: false } : null;
}

const listCache = new Map();
async function serversFor(user) {
  const hit = listCache.get(user.id);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const ids = [...bot.knownGuildIds()];
  const results = await Promise.allSettled(ids.map((id) => access(user, id)));
  const list = [];
  results.forEach((r, i) => { if (r.status === "fulfilled" && r.value) list.push({ id: ids[i], name: r.value.guild.name, level: r.value.level }); });
  list.sort((a, b) => a.name.localeCompare(b.name));
  listCache.set(user.id, { at: Date.now(), list });
  return list;
}

async function discoverGuilds() {
  // Best effort: lets servers show up before anyone has chatted in them. Ignored if the API has no such endpoint.
  try {
    const r = await bot.api("GET", "/servers");
    for (const s of r?.servers ?? (Array.isArray(r) ? r : [])) if (s?.id != null) bot.markGuildSeen(s.id);
  } catch { /* not available */ }
}

// ---------------------------------------------------------------- helpers
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const need = (a, level) => { if (level === "manage" && a.level !== "manage") throw new HttpError(403, "You need the Manage Server permission for that."); };

const str = (v, max, what) => {
  if (typeof v !== "string") throw bad(`${what} is required.`);
  const s = v.trim();
  if (!s) throw bad(`${what} is required.`);
  if (s.length > max) throw bad(`${what} is too long.`);
  return s;
};
const int = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
};
const userIdOf = (v) => {
  const id = bot.parseId(typeof v === "string" ? v.trim() : "");
  if (!id) throw bad("Enter a user id or @mention.");
  return id;
};
const reasonOf = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : "No reason given");

async function namesFor(guild, ids, max = 40) {
  const out = {};
  await Promise.allSettled(ids.slice(0, max).map(async (id) => {
    try { out[id] = (await bot.getMember(guild, id)).displayName; } catch { /* left the server */ }
  }));
  return out;
}

// ---------------------------------------------------------------- API routes
const SETTING_BOOLS = ["automod_words", "automod_spam", "automod_mentions"];

function view(gid, a) {
  const cfg = bot.guildCfg(gid);
  const warnings = Object.values(cfg.warnings);
  const out = {
    id: gid, name: a.guild.name, level: a.level,
    stats: { warnedUsers: warnings.length, totalWarnings: warnings.reduce((n, w) => n + w.length, 0), bannedWords: cfg.banned_words.length },
    log_channel: cfg.log_channel, block_links: cfg.block_links, allowed_domains: cfg.allowed_domains,
    settings: cfg.settings, rules: cfg.rules,
  };
  if (a.level === "manage") out.banned_words = cfg.banned_words;
  return out;
}

async function route(req, url, user) {
  const m = req.method;
  const p = url.pathname;
  let r;

  if (m === "GET" && p === "/api/me") return { user, botState: bot.botStatus.state, prefix: bot.PREFIX, isOwner: OWNER_IDS.has(user.id) };
  if (m === "GET" && p === "/api/commands") {
    return { prefix: bot.PREFIX, labels: bot.LEVEL_LABEL, commands: [...bot.commands.values()].map((c) => ({ name: c.name, usage: c.usage, description: c.description, level: bot.LEVELS[c.name] ?? "all" })) };
  }
  if (m === "GET" && p === "/api/servers") return { servers: await serversFor(user), botState: bot.botStatus.state };

  if (m === "GET" && p === "/api/status") {
    return {
      botState: bot.botStatus.state, botError: bot.botStatus.error, botSince: bot.botStatus.since,
      restarts: runtime.restarts, uptimeSeconds: Math.floor(process.uptime()),
      servers: bot.knownGuildIds().size, memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      keepAlive: runtime.keepAlive, lastSelfPing: runtime.lastPing, lastSelfPingOk: runtime.lastPingOk,
      persistent: /^\/var\/data\//.test(env.MODBOT_DATA ?? ""), baseUrl: BASE_URL,
    };
  }
  if (!(r = p.match(/^\/api\/servers\/([\w-]+)(\/.*)?$/))) throw new HttpError(404, "Not found");
  const gid = r[1];
  const sub = r[2] ?? "";
  const a = await access(user, gid, m !== "GET");
  if (!a) throw new HttpError(403, "You don't have access to that server (or I'm not in it).");
  const cfg = bot.guildCfg(gid);
  const body = req.body ?? {};
  const actor = user.username;
  let x;

  if (m === "GET" && sub === "") return view(gid, a);
  if (m === "GET" && sub === "/activity") {
    const entries = cfg.audit.slice(-100).reverse();
    return { entries, names: await namesFor(a.guild, [...new Set(entries.map((e) => e.target).filter(Boolean))], 25) };
  }
  if (m === "GET" && sub === "/warnings") {
    const ids = Object.keys(cfg.warnings).sort((p1, p2) => cfg.warnings[p2].length - cfg.warnings[p1].length);
    return { users: ids.map((id) => ({ id, warnings: cfg.warnings[id] })), names: await namesFor(a.guild, ids) };
  }

  if (m === "GET" && sub.startsWith("/member/")) {
    const uid = userIdOf(decodeURIComponent(sub.slice(8)));
    let mem;
    try { mem = await bot.getMember(a.guild, uid, true); } catch { throw new HttpError(404, "That user isn't in this server."); }
    return {
      member: { id: mem.id, name: mem.name, displayName: mem.displayName, isOwner: bot.isOwner(mem, a.guild), isMod: bot.canModerate(mem, a.guild),
        roles: mem.roleIds.map((id) => a.guild.roles.get(id)?.name).filter(Boolean) },
      warnings: cfg.warnings[uid] ?? [], notes: cfg.notes[uid] ?? [],
      history: cfg.audit.filter((e) => e.target === uid).slice(-20).reverse(),
    };
  }
  if (m === "POST" && sub === "/notes") {
    const uid = userIdOf(body.userId);
    (cfg.notes[uid] ??= []).push({ text: str(body.text, 300, "Note"), mod: actor, time: Math.floor(Date.now() / 1000) });
    bot.save();
    return { ok: true, message: "Note saved." };
  }
  if (m === "DELETE" && (x = sub.match(/^\/notes\/([\w-]+)\/(\d+)$/))) {
    const list = cfg.notes[x[1]] ?? [];
    const i = Number(x[2]);
    if (i < 0 || i >= list.length) throw new HttpError(404, "That note no longer exists.");
    list.splice(i, 1);
    if (!list.length) delete cfg.notes[x[1]];
    bot.save();
    return { ok: true, message: "Note deleted." };
  }

  // ----- settings (managers)
  if (m === "PATCH" && sub === "/settings") {
    need(a, "manage");
    const changed = [];
    const s = cfg.settings;
    for (const k of SETTING_BOOLS) if (k in body) { if (typeof body[k] !== "boolean") throw bad(`${k} must be on or off.`); s[k] = body[k]; changed.push(k); }
    if ("block_links" in body) { if (typeof body.block_links !== "boolean") throw bad("block_links must be on or off."); cfg.block_links = body.block_links; changed.push("block_links"); }
    if ("spam_messages" in body) { s.spam_messages = int(body.spam_messages, 2, 30, "Spam message count"); changed.push("spam_messages"); }
    if ("spam_seconds" in body) { s.spam_seconds = int(body.spam_seconds, 2, 60, "Spam window"); changed.push("spam_seconds"); }
    if ("max_mentions" in body) { s.max_mentions = int(body.max_mentions, 1, 50, "Mention limit"); changed.push("max_mentions"); }
    if ("escalation" in body) {
      if (!Array.isArray(body.escalation) || body.escalation.length > 10) throw bad("Escalation can have up to 10 steps.");
      const esc = {};
      for (const row of body.escalation) {
        const w = int(row?.warnings, 1, 50, "Warning count");
        if (w in esc) throw bad("Each warning count can only appear once.");
        esc[w] = int(row?.minutes, 1, bot.MAX_TIMEOUT_MINUTES, "Timeout minutes");
      }
      s.escalation = esc; changed.push("escalation");
    }
    if ("log_channel" in body) {
      if (body.log_channel === null || body.log_channel === "") cfg.log_channel = null;
      else {
        const cid = bot.parseId(String(body.log_channel).trim(), "channel");
        if (!cid) throw bad("Enter a channel id or #channel mention.");
        try { await bot.getChannel(cid); } catch { throw bad("I couldn't find that channel."); }
        cfg.log_channel = cid;
      }
      changed.push("log_channel");
    }
    if ("rules" in body) {
      if (typeof body.rules !== "string" || body.rules.length > 1500) throw bad("Rules must be text of up to 1500 characters.");
      cfg.rules = body.rules.trim(); changed.push("rules");
    }
    if (!changed.length) throw bad("Nothing to change.");
    bot.audit(gid, { type: "settings", target: "", mod: actor, reason: `Changed: ${changed.join(", ")}`, source: "dashboard" });
    return view(gid, a);
  }

  if (m === "POST" && sub === "/words") {
    need(a, "manage");
    const w = str(body.word, 64, "Word").toLowerCase().replace(/\s+/g, " ");
    if (!cfg.banned_words.includes(w)) { cfg.banned_words.push(w); bot.audit(gid, { type: "addword", target: "", mod: actor, reason: "(word hidden)", source: "dashboard" }); }
    return view(gid, a);
  }
  if (m === "DELETE" && (x = sub.match(/^\/words\/(.+)$/))) {
    need(a, "manage");
    const w = decodeURIComponent(x[1]).toLowerCase();
    const i = cfg.banned_words.indexOf(w);
    if (i === -1) throw new HttpError(404, "That word isn't on the list.");
    cfg.banned_words.splice(i, 1);
    bot.audit(gid, { type: "delword", target: "", mod: actor, reason: "(word hidden)", source: "dashboard" });
    return view(gid, a);
  }
  if (m === "POST" && sub === "/domains") {
    need(a, "manage");
    const d = str(body.domain, 100, "Domain").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw bad("That doesn't look like a domain (try example.com).");
    if (!cfg.allowed_domains.includes(d)) { cfg.allowed_domains.push(d); bot.audit(gid, { type: "allowdomain", target: "", mod: actor, reason: d, source: "dashboard" }); }
    return view(gid, a);
  }
  if (m === "DELETE" && (x = sub.match(/^\/domains\/(.+)$/))) {
    need(a, "manage");
    const d = decodeURIComponent(x[1]).toLowerCase();
    const i = cfg.allowed_domains.indexOf(d);
    if (i === -1) throw new HttpError(404, "That domain isn't on the list.");
    cfg.allowed_domains.splice(i, 1);
    bot.audit(gid, { type: "allowdomain", target: "", mod: actor, reason: `removed ${d}`, source: "dashboard" });
    return view(gid, a);
  }

  // ----- moderation actions
  const target = async (id) => {
    const t = await bot.checkTarget(a.guild, a.member, id, a.override);
    if (t.error) throw bad(t.error);
    return t.target;
  };
  if (m === "POST" && sub === "/warnings") {
    const t = await target(userIdOf(body.userId));
    const count = await bot.addWarning(a.guild, null, t.id, reasonOf(body.reason), actor, "dashboard");
    return { ok: true, message: `Warned ${t.displayName} (${count} total).` };
  }
  if (m === "DELETE" && (x = sub.match(/^\/warnings\/([\w-]+)\/(\d+)$/))) {
    const removed = await bot.removeWarning(a.guild, actor, x[1], Number(x[2]), "dashboard");
    if (!removed) throw new HttpError(404, "That warning no longer exists.");
    return { ok: true, message: "Warning removed." };
  }
  if (m === "DELETE" && (x = sub.match(/^\/warnings\/([\w-]+)$/))) {
    need(a, "manage");
    const n = await bot.clearWarnings(a.guild, actor, x[1], "dashboard");
    return { ok: true, message: `Cleared ${n} warning(s).` };
  }
  if (m === "POST" && sub === "/timeout") {
    const id = userIdOf(body.userId);
    const minutes = int(body.minutes, 1, bot.MAX_TIMEOUT_MINUTES, "Minutes");
    const t = await target(id);
    try { await bot.timeoutUser(a.guild, actor, t.id, minutes, reasonOf(body.reason), "dashboard"); }
    catch (e) { throw bad(`Couldn't time them out: ${e.message}`); }
    return { ok: true, message: `Timed out ${t.displayName} for ${minutes} minutes.` };
  }
  if (m === "POST" && sub === "/ban") {
    need(a, "manage");
    const t = await target(userIdOf(body.userId));
    try { await bot.banUser(a.guild, actor, t, reasonOf(body.reason), "dashboard"); }
    catch (e) { throw bad(`Couldn't ban them: ${e.message}`); }
    return { ok: true, message: `Banned ${t.displayName}.` };
  }
  if (m === "POST" && sub === "/unban") {
    need(a, "manage");
    try { await bot.unbanUser(a.guild, actor, userIdOf(body.userId), "dashboard"); }
    catch (e) { throw bad(`Couldn't unban that user: ${e.message}`); }
    return { ok: true, message: "User unbanned." };
  }
  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------- http plumbing
const STATIC = {
  "/": ["landing.html", "text/html; charset=utf-8"],
  "/dashboard": ["index.html", "text/html; charset=utf-8"],
  "/landing.css": ["landing.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/logo.svg": ["logo.svg", "image/svg+xml"],
  "/logo-wordmark.svg": ["logo-wordmark.svg", "image/svg+xml"],
  "/logo-512.png": ["logo-512.png", "image/png"],
};
const HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...HEADERS, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 20_000) { reject(new HttpError(413, "Request too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(bad("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;

  if (p === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });

  if (req.method === "GET" && STATIC[p]) {
    const [file, type] = STATIC[p];
    try { return send(res, 200, fs.readFileSync(path.join(HERE, "public", file)), { "Content-Type": type, "Cache-Control": "no-cache" }); }
    catch { return send(res, 404, "Not found"); }
  }

  if (req.method === "GET" && p === "/auth/login") {
    if (limited(req, "auth", 30)) return send(res, 429, "Too many attempts, try again in a minute.");
    if (!CLIENT_ID) return send(res, 500, "Login isn't configured: set YAPIN_CLIENT_ID and YAPIN_CLIENT_SECRET.");
    const state = crypto.randomBytes(16).toString("hex");
    const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: "identify", state });
    return send(res, 302, "", { Location: `${AUTHORIZE_URL}?${q}`, "Set-Cookie": cookie("ym_state", state, 600) });
  }

  if (req.method === "GET" && p === "/auth/callback") {
    if (limited(req, "auth", 30)) return send(res, 429, "Too many attempts, try again in a minute.");
    const clear = cookie("ym_state", "", 0);
    const fail = (why) => send(res, 302, "", { Location: `/dashboard?login_error=${encodeURIComponent(why)}`, "Set-Cookie": clear });
    if (url.searchParams.get("error")) return fail("Login was cancelled.");
    const want = parseCookies(req).ym_state;
    const got = url.searchParams.get("state");
    if (!want || !got || want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) return fail("Login expired. Please try again.");
    try {
      const token = await exchangeCode(url.searchParams.get("code") ?? "");
      const u = await fetchIdentity(token);
      console.log(ts(), `Dashboard login: ${u.username} (${u.id})`);
      return send(res, 302, "", { Location: "/dashboard", "Set-Cookie": [clear, cookie("ym_session", makeSession(u), SESSION_DAYS * 86400)] });
    } catch (e) {
      console.error(ts(), "ERROR login failed:", e.message);
      return fail("Couldn't finish logging in. Please try again.");
    }
  }

  if (req.method === "POST" && p === "/auth/logout") {
    return send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json", "Set-Cookie": cookie("ym_session", "", 0) });
  }

  if (p.startsWith("/api/")) {
    if (limited(req, "api", 240)) return sendJson(res, 429, { error: "Slow down a little." });
    const user = readSession(req);
    if (!user) return sendJson(res, 401, { error: "Please log in." });
    if (req.method !== "GET") { // CSRF: browsers always send Origin on cross-site POSTs
      const origin = req.headers.origin;
      if (origin && origin !== new URL(BASE_URL).origin) return sendJson(res, 403, { error: "Bad origin" });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json") && req.headers["content-length"] !== "0" && req.headers["content-length"] !== undefined) return sendJson(res, 415, { error: "JSON only" });
    }
    try {
      req.body = req.method === "GET" ? {} : await readBody(req);
      return sendJson(res, 200, await route(req, url, user));
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      console.error(ts(), "ERROR", req.method, p, e);
      return sendJson(res, 500, { error: "Something went wrong." });
    }
  }
  return send(res, 404, "Not found", { "Content-Type": "text/plain" });
}

http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(ts(), "ERROR", e); if (!res.headersSent) send(res, 500, "Server error"); }); })
  .listen(PORT, () => console.log(ts(), `Dashboard on ${BASE_URL} (port ${PORT}); OAuth redirect URL: ${REDIRECT_URI}`));

process.on("unhandledRejection", (e) => console.error(ts(), "ERROR Unhandled rejection:", e));
process.on("SIGTERM", () => { console.log(ts(), "Shutting down"); process.exit(0); });

// ---------------------------------------------------------------- keep the bot + site online
const runtime = { restarts: 0, keepAlive: false, lastPing: null, lastPingOk: null };

// 1) If the bot ever stops (bad network, API hiccup), start it again instead of staying dead.
async function superviseBot() {
  while (true) {
    try { await bot.startBot({ embedded: true }); } catch (e) { console.error(ts(), "Bot stopped:", e.message); }
    runtime.restarts++;
    const wait = Math.min(300, 15 * runtime.restarts);
    console.log(ts(), `Restarting the bot in ${wait}s (restart #${runtime.restarts})`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

// 2) Ping our own public address every 10 minutes so Render doesn't see the service as idle.
//    (This keeps an awake service awake. It can't wake one that is already asleep: see UptimeRobot in the README.)
function startKeepAlive() {
  const off = (env.KEEP_ALIVE ?? "").toLowerCase() === "off";
  if (off || !BASE_URL.startsWith("https://")) return;
  runtime.keepAlive = true;
  const ping = async () => {
    runtime.lastPing = Date.now();
    try { const r = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(20_000) }); runtime.lastPingOk = r.ok; }
    catch { runtime.lastPingOk = false; }
  };
  setTimeout(ping, 60_000).unref();
  setInterval(ping, 10 * 60_000).unref();
}
startKeepAlive();

if (env.TOKEN) {
  superviseBot();
  setTimeout(discoverGuilds, 5000).unref();
  setInterval(discoverGuilds, 30 * 60_000).unref();
} else {
  console.warn("TOKEN isn't set: starting the dashboard only (the bot is not running).");
}
