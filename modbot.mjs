#!/usr/bin/env node
/**
 * modbot.mjs - a moderation bot for Yapper, written for Node.js 18+.
 * No npm packages needed.
 *
 * It talks to Yapper's bot HTTP API directly (the same endpoints the YapPy
 * Python library uses), so none of YapPy's bugs apply here.
 *
 * Features
 *   - Auto-mod: banned words, spam, mass mentions, link filter
 *   - Warning system with automatic timeout escalation
 *   - Commands: warn, warnings, clearwarns, timeout, ban, unban,
 *               addword, delword, words, links, allowdomain, setlog, modhelp
 *   - Optional mod-log channel
 *   - Settings and warnings saved in modbot_data.json (same format as the
 *     Python version, so you can switch between them)
 *
 * Run:  node modbot.mjs     (needs TOKEN in the environment or a .env file)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------
// Settings you can tweak
// --------------------------------------------------------------------------
const PREFIX = "!";
const SPAM_MESSAGES = 5;          // this many messages...
const SPAM_SECONDS = 6;           // ...within this many seconds counts as spam
const MAX_MENTIONS = 5;           // more mentions than this in one message is removed
const MAX_TIMEOUT_MINUTES = 10080; // 7 days
// When a user reaches this many warnings, they are timed out for N minutes.
const ESCALATION = { 3: 10, 5: 60 };

const GUILD_TTL_MS = 60_000;      // how long server/role info is cached
const MEMBER_TTL_MS = 300_000;    // how long member info is cached (auto-mod only)

const BASE_URL = process.env.YAPPER_API_URL ?? "https://www.yapper.website/api/bot/v1";

// --------------------------------------------------------------------------
// Tiny helpers: logging, .env loading
// --------------------------------------------------------------------------
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(stamp(), ...a);
const logErr = (...a) => console.error(stamp(), "ERROR", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
loadEnv(path.join(HERE, ".env"));
loadEnv(path.join(process.cwd(), ".env"));

const TOKEN = process.env.TOKEN;

// --------------------------------------------------------------------------
// Storage (one JSON file; fine for small/medium servers)
// --------------------------------------------------------------------------
const DATA_FILE = process.env.MODBOT_DATA ?? path.join(HERE, "modbot_data.json");
let data = {};
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") logErr(`Couldn't read ${DATA_FILE}, starting fresh:`, e.message);
}

function guildCfg(gid) {
  const g = (data[gid] ??= {});
  g.banned_words ??= [];
  g.log_channel ??= null;
  g.block_links ??= false;
  g.allowed_domains ??= [];
  g.warnings ??= {};
  g.audit ??= [];
  g.notes ??= {};
  g.rules ??= "";
  const s = (g.settings ??= {});
  s.automod_words ??= true;
  s.automod_spam ??= true;
  s.automod_mentions ??= true;
  s.spam_messages ??= SPAM_MESSAGES;
  s.spam_seconds ??= SPAM_SECONDS;
  s.max_mentions ??= MAX_MENTIONS;
  s.escalation ??= { ...ESCALATION };
  return g;
}

function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/** Records an action for the dashboard's activity feed (last 200 per server). */
function audit(gid, entry) {
  const cfg = guildCfg(gid);
  cfg.audit.push({ time: Math.floor(Date.now() / 1000), ...entry });
  if (cfg.audit.length > 200) cfg.audit.splice(0, cfg.audit.length - 200);
  save();
}

// --------------------------------------------------------------------------
// Yapper API client
// --------------------------------------------------------------------------
class ApiError extends Error {
  constructor(method, p, status, message) {
    super(`${method} ${p} failed (${status}): ${message}`);
    this.status = status;
  }
}

async function api(method, p, body, tries = 3) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });

  // Some endpoints may answer with an empty body; that's fine.
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }

  if (!res.ok) {
    const retryAfter = Number(res.headers.get("Retry-After") || 0);
    const busy = res.status === 503 && json && "retry_after" in json;
    if ((res.status === 429 || busy) && retryAfter > 0 && retryAfter <= 60 && tries > 1) {
      const delay = retryAfter * 1000 * (1 + Math.random() * 0.5);
      log(`${busy ? "Server busy" : "Rate limited"} on ${method} ${p}, retrying in ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
      return api(method, p, body, tries - 1);
    }
    throw new ApiError(method, p, res.status, json?.error ?? res.statusText);
  }
  return json;
}

const send = (channelId, content, replyTo = null) =>
  api("POST", `/channels/${channelId}/messages`, {
    content, embeds: [], components: [], reply_to: replyTo,
  });

const deleteMessage = (channelId, messageId) =>
  api("DELETE", `/channels/${channelId}/messages/${messageId}`);

const doTimeout = (guildId, userId, minutes, reason) =>
  api("POST", `/servers/${guildId}/timeouts`, { user_id: userId, minutes, reason });

const doBan = (guildId, userId) =>
  api("POST", `/servers/${guildId}/bans`, { user_id: userId });

const doUnban = (guildId, userId) =>
  api("DELETE", `/servers/${guildId}/bans/${userId}`);

// --------------------------------------------------------------------------
// Caches (channels, servers + roles, members)
// --------------------------------------------------------------------------
const channels = new Map();
const guilds = new Map();
const members = new Map();
const inflight = new Map();

// Concurrent lookups of the same thing share one request.
function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function getChannel(id) {
  id = String(id);
  if (channels.has(id)) return channels.get(id);
  return once(`channel:${id}`, async () => {
    const c = (await api("GET", `/channels/${id}`)).channel;
    channels.set(id, c);
    return c;
  });
}

async function getGuild(id, fresh = false) {
  id = String(id);
  const cached = guilds.get(id);
  if (cached && !fresh && Date.now() - cached.at < GUILD_TTL_MS) return cached;
  return once(`guild:${id}:${fresh}`, async () => {
    const [server, rolesData] = await Promise.all([
      api("GET", `/servers/${id}`),
      api("GET", `/servers/${id}/roles`),
    ]);
    const roles = new Map();
    for (const r of rolesData.roles ?? []) roles.set(String(r.id), r);
    const guild = {
      id,
      name: server.server.name,
      ownerId: String(server.server.owner_id),
      roles,
      at: Date.now(),
    };
    guilds.set(id, guild);
    return guild;
  });
}

async function getMember(guild, userId, fresh = false) {
  userId = String(userId);
  const key = `${guild.id}:${userId}`;
  const cached = members.get(key);
  if (cached && !fresh && Date.now() - cached.at < MEMBER_TTL_MS) return cached.member;
  return once(`member:${key}:${fresh}`, async () => {
    const d = (await api("GET", `/servers/${guild.id}/members/${userId}`)).member;
    const member = {
      id: userId,
      name: d.username,
      displayName: d.nickname || d.display_name || d.username,
      roleIds: (d.roles ?? []).map(String),
    };
    members.set(key, { member, at: Date.now() });
    return member;
  });
}

// --------------------------------------------------------------------------
// Permissions
// --------------------------------------------------------------------------
const isOwner = (member, guild) => guild.ownerId === member.id;

const hasPerm = (member, guild, perm) =>
  member.roleIds.some((id) => {
    const r = guild.roles.get(id);
    return r && (r[perm] === true || r.perms?.[perm] === true);
  });

/** Server owner, or any role with manage_messages / manage_server. */
const canModerate = (member, guild) =>
  isOwner(member, guild) || hasPerm(member, guild, "manage_messages") || hasPerm(member, guild, "manage_server");

/** Server owner, or any role with manage_server. */
const canManage = (member, guild) =>
  isOwner(member, guild) || hasPerm(member, guild, "manage_server");

/** Checks the command author's permissions (re-fetched, so role changes count). */
async function guard(ctx, level) {
  try {
    ctx.guild = await getGuild(ctx.guild.id, true);
    ctx.author = await getMember(ctx.guild, ctx.author.id, true);
  } catch (e) {
    logErr("Fresh permission lookup failed, using cached data:", e.message);
  }
  const ok = level === "manage" ? canManage(ctx.author, ctx.guild) : canModerate(ctx.author, ctx.guild);
  if (!ok) await ctx.reply("You don't have permission to use that command.");
  return ok;
}

/** Checks whether `actor` may act on `userId`. Returns { target } or { error }. */
async function checkTarget(guild, actor, userId, override = false) {
  if (userId === String(me.id)) return { error: "I can't moderate myself." };
  if (userId === actor.id) return { error: "You can't do that to yourself." };
  let target;
  try {
    target = await getMember(guild, userId, true);
  } catch {
    return { error: "That user isn't in this server." };
  }
  if (isOwner(target, guild)) return { error: "You can't moderate the server owner." };
  if (!override && canModerate(target, guild) && !isOwner(actor, guild)) {
    return { error: "You can't moderate another moderator." };
  }
  return { target };
}

/** Returns the member to act on, or null (after replying why not). */
async function resolveTarget(ctx, userId) {
  const r = await checkTarget(ctx.guild, ctx.author, userId);
  if (r.error) { await ctx.reply(r.error); return null; }
  return r.target;
}

// --------------------------------------------------------------------------
// Warnings + mod log
// --------------------------------------------------------------------------
async function modLog(guild, text) {
  const cid = guildCfg(guild.id).log_channel;
  if (!cid) return;
  try {
    await send(cid, text);
  } catch (e) {
    logErr("Couldn't write to the mod-log channel:", e.message);
  }
}

async function addWarning(guild, channelId, userId, reason, moderator, source = "chat") {
  const cfg = guildCfg(guild.id);
  const warns = (cfg.warnings[userId] ??= []);
  warns.push({ reason, mod: moderator, time: Math.floor(Date.now() / 1000) });
  save();
  const count = warns.length;
  audit(guild.id, { type: "warn", target: userId, mod: moderator, reason, source });

  const msg = `<@${userId}> has been warned (${count} total). Reason: ${reason}`;
  if (channelId) await send(channelId, msg);
  await modLog(guild, `[warn] ${msg} - by ${moderator}`);

  const minutes = cfg.settings.escalation[count];
  if (minutes) {
    try {
      await doTimeout(guild.id, userId, minutes, `Reached ${count} warnings`);
      const note = `<@${userId}> was timed out for ${minutes} minutes (reached ${count} warnings).`;
      audit(guild.id, { type: "timeout", target: userId, mod: "AutoMod", reason: `${minutes} min: reached ${count} warnings`, source: "automod" });
      if (channelId) await send(channelId, note);
      await modLog(guild, `[timeout] ${note}`);
    } catch (e) {
      logErr("Auto-timeout failed:", e.message);
      await modLog(guild, `[error] Couldn't auto-timeout <@${userId}> at ${count} warnings.`);
    }
  }
  return count;
}

async function timeoutUser(guild, actor, userId, minutes, reason, source = "chat") {
  await doTimeout(guild.id, userId, minutes, reason);
  const note = `<@${userId}> was timed out for ${minutes} minutes. Reason: ${reason}`;
  audit(guild.id, { type: "timeout", target: userId, mod: actor, reason: `${minutes} min: ${reason}`, source });
  await modLog(guild, `[timeout] ${note} - by ${actor}`);
  return note;
}

async function banUser(guild, actor, target, reason, source = "chat") {
  await doBan(guild.id, target.id);
  const note = `${target.displayName} was banned. Reason: ${reason}`;
  audit(guild.id, { type: "ban", target: target.id, mod: actor, reason, source });
  await modLog(guild, `[ban] ${note} - by ${actor}`);
  return note;
}

async function unbanUser(guild, actor, userId, source = "chat") {
  await doUnban(guild.id, userId);
  audit(guild.id, { type: "unban", target: userId, mod: actor, reason: "", source });
  await modLog(guild, `[unban] ${userId} unbanned by ${actor}`);
  return `Unbanned ${userId}.`;
}

async function clearWarnings(guild, actor, userId, source = "chat") {
  const cfg = guildCfg(guild.id);
  const n = (cfg.warnings[userId] ?? []).length;
  delete cfg.warnings[userId];
  save();
  audit(guild.id, { type: "clearwarns", target: userId, mod: actor, reason: `${n} warning(s) cleared`, source });
  await modLog(guild, `[clearwarns] <@${userId}> cleared by ${actor}`);
  return n;
}

/** Removes warning number `index` (1-based). Returns the removed warning, or null. */
async function removeWarning(guild, actor, userId, index, source = "chat") {
  const cfg = guildCfg(guild.id);
  const warns = cfg.warnings[userId] ?? [];
  if (!Number.isInteger(index) || index < 1 || index > warns.length) return null;
  const [removed] = warns.splice(index - 1, 1);
  if (!warns.length) delete cfg.warnings[userId];
  save();
  audit(guild.id, { type: "unwarn", target: userId, mod: actor, reason: removed.reason, source });
  await modLog(guild, `[unwarn] warning #${index} removed from <@${userId}> by ${actor}`);
  return removed;
}

// --------------------------------------------------------------------------
// Auto-moderation
// --------------------------------------------------------------------------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const URL_RE = /(?:https?:\/\/|www\.)([^\s/<>]+)/gi;

function findBannedWord(content, words) {
  const text = content.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "").toLowerCase();
  for (const w of words) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, "u");
    if (re.test(text)) return w;
  }
  return null;
}

function findBadLink(content, cfg) {
  if (!cfg.block_links) return null;
  for (const m of content.matchAll(URL_RE)) {
    const host = m[1].toLowerCase().split(":")[0];
    const allowed = cfg.allowed_domains.some((d) => host === d || host.endsWith("." + d));
    if (!allowed) return host;
  }
  return null;
}

const recent = new Map();
function isSpam(guildId, userId, limit = SPAM_MESSAGES, seconds = SPAM_SECONDS) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const q = recent.get(key) ?? [];
  q.push(now);
  while (q.length > limit) q.shift();
  recent.set(key, q);
  if (q.length >= limit && now - q[0] <= seconds * 1000) {
    recent.delete(key);
    return true;
  }
  return false;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000; // spam windows are capped at 60s
  for (const [k, q] of recent) if (q[q.length - 1] < cutoff) recent.delete(k);
}, 60_000).unref();

/** Returns true if the message is fine, false if it was removed. */
async function automod(ctx) {
  if (canModerate(ctx.author, ctx.guild)) return true; // moderators are exempt

  const cfg = guildCfg(ctx.guild.id);
  const content = ctx.content;

  const s = cfg.settings;
  let reason = null;
  if (s.automod_words && findBannedWord(content, cfg.banned_words)) {
    reason = "Used a banned word";
  } else {
    const host = findBadLink(content, cfg);
    if (host) reason = `Posted a link that isn't allowed (${host})`;
    else if (s.automod_mentions && (content.match(/<@/g) ?? []).length > s.max_mentions) reason = "Mass mentioning";
    else if (s.automod_spam && isSpam(ctx.guild.id, ctx.author.id, s.spam_messages, s.spam_seconds)) reason = "Spamming";
  }
  if (reason === null) return true;

  try {
    await ctx.del();
  } catch (e) {
    logErr("Couldn't delete a message (does the bot have permission?):", e.message);
  }
  await addWarning(ctx.guild, ctx.channelId, ctx.author.id, `[auto] ${reason}`, "AutoMod", "automod");
  return false;
}

// --------------------------------------------------------------------------
// Command parsing helpers
// --------------------------------------------------------------------------
class UsageError extends Error {}

/** Splits off the first whitespace-separated token. */
function takeToken(s) {
  const m = s.trimStart().match(/^(\S+)\s*([\s\S]*)$/);
  return m ? [m[1], m[2]] : [null, ""];
}

/** Accepts <@123>, <@!123> or a bare id. Role mentions (<@&..>) are rejected. */
function parseId(tok, kind = "user") {
  if (!tok) return null;
  const re = kind === "channel" ? /^<#([^\s>]+)>$/ : /^<@!?([^\s>&][^\s>]*)>$/;
  const m = tok.match(re);
  if (m) return m[1];
  return /^[\w-]+$/.test(tok) ? tok : null;
}

function parseBool(tok) {
  const w = (tok ?? "").toLowerCase();
  if (["on", "true", "yes", "y", "1"].includes(w)) return true;
  if (["off", "false", "no", "n", "0"].includes(w)) return false;
  return null;
}

const reasonOf = (s) => s.trim() || "No reason given";

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------
const commands = new Map();
function command(name, usage, description, handler) {
  commands.set(name, { name, usage, description, handler });
}

command("warn", "warn <user> [reason]", "Warn a user", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const [tok, reason] = takeToken(rest);
  const uid = parseId(tok);
  if (!uid) throw new UsageError();
  const target = await resolveTarget(ctx, uid);
  if (!target) return;
  await addWarning(ctx.guild, ctx.channelId, target.id, reasonOf(reason), ctx.author.name);
});

command("warnings", "warnings <user>", "Show a user's warnings", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const uid = parseId(takeToken(rest)[0]);
  if (!uid) throw new UsageError();
  const warns = guildCfg(ctx.guild.id).warnings[uid] ?? [];
  if (!warns.length) return void (await ctx.reply(`<@${uid}> has no warnings.`));
  const start = Math.max(0, warns.length - 10);
  const lines = [`<@${uid}> has ${warns.length} warning(s):`];
  warns.slice(start).forEach((w, i) => {
    const when = new Date(w.time * 1000).toISOString().slice(0, 10);
    lines.push(`${start + i + 1}. ${w.reason} (by ${w.mod}, ${when})`);
  });
  await ctx.reply(lines.join("\n"));
});

command("clearwarns", "clearwarns <user>", "Clear all of a user's warnings", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const uid = parseId(takeToken(rest)[0]);
  if (!uid) throw new UsageError();
  await clearWarnings(ctx.guild, ctx.author.name, uid);
  await ctx.reply(`Cleared all warnings for <@${uid}>.`);
});

command("timeout", "timeout <user> <minutes> [reason]", "Time a user out", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const [uTok, r1] = takeToken(rest);
  const [mTok, reason] = takeToken(r1);
  const uid = parseId(uTok);
  if (!uid || !/^\d+$/.test(mTok ?? "")) throw new UsageError();
  const minutes = parseInt(mTok, 10);
  if (minutes < 1 || minutes > MAX_TIMEOUT_MINUTES) {
    return void (await ctx.reply(`Minutes must be between 1 and ${MAX_TIMEOUT_MINUTES}.`));
  }
  const target = await resolveTarget(ctx, uid);
  if (!target) return;
  const why = reasonOf(reason);
  let note;
  try {
    note = await timeoutUser(ctx.guild, ctx.author.name, target.id, minutes, why);
  } catch (e) {
    logErr("timeout failed:", e.message);
    return void (await ctx.reply(`Couldn't time them out: ${e.message}`));
  }
  await ctx.reply(note);
});

command("ban", "ban <user> [reason]", "Ban a user", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const [tok, reason] = takeToken(rest);
  const uid = parseId(tok);
  if (!uid) throw new UsageError();
  const target = await resolveTarget(ctx, uid);
  if (!target) return;
  const why = reasonOf(reason);
  let note;
  try {
    note = await banUser(ctx.guild, ctx.author.name, target, why);
  } catch (e) {
    logErr("ban failed:", e.message);
    return void (await ctx.reply(`Couldn't ban them: ${e.message}`));
  }
  await ctx.reply(note);
});

command("unban", "unban <user id>", "Unban a user", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const uid = parseId(takeToken(rest)[0]);
  if (!uid) throw new UsageError();
  try {
    await ctx.reply(await unbanUser(ctx.guild, ctx.author.name, uid));
  } catch (e) {
    logErr("unban failed:", e.message);
    await ctx.reply(`Couldn't unban that user: ${e.message}`);
  }
});

command("addword", "addword <word>", "Add a banned word", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const word = takeToken(rest)[0];
  if (!word) throw new UsageError();
  const cfg = guildCfg(ctx.guild.id);
  const w = word.toLowerCase();
  if (!cfg.banned_words.includes(w)) {
    cfg.banned_words.push(w);
    save();
    audit(ctx.guild.id, { type: "addword", target: "", mod: ctx.author.name, reason: "(word hidden)", source: "chat" });
  }
  await ctx.reply("Added to the banned word list.");
  try { await ctx.del(); } catch { /* don't leave the word sitting in chat */ }
});

command("delword", "delword <word>", "Remove a banned word", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const word = takeToken(rest)[0]?.toLowerCase();
  if (!word) throw new UsageError();
  const cfg = guildCfg(ctx.guild.id);
  const i = cfg.banned_words.indexOf(word);
  if (i === -1) return void (await ctx.reply("That word isn't on the list."));
  cfg.banned_words.splice(i, 1);
  save();
  audit(ctx.guild.id, { type: "delword", target: "", mod: ctx.author.name, reason: "(word hidden)", source: "chat" });
  await ctx.reply("Removed from the banned word list.");
});

command("words", "words", "Show how many words are banned", async (ctx) => {
  if (!(await guard(ctx, "manage"))) return;
  const n = guildCfg(ctx.guild.id).banned_words.length;
  await ctx.reply(`${n} banned word(s). (The list itself isn't shown in chat.)`);
});

command("links", "links on|off", "Turn link blocking on or off", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const on = parseBool(takeToken(rest)[0]);
  if (on === null) throw new UsageError();
  guildCfg(ctx.guild.id).block_links = on;
  save();
  audit(ctx.guild.id, { type: "links", target: "", mod: ctx.author.name, reason: `Link blocking ${on ? "on" : "off"}`, source: "chat" });
  await ctx.reply(`Link blocking is now ${on ? "ON" : "OFF"}.`);
});

command("allowdomain", "allowdomain <domain>", "Allow a domain when links are blocked", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const tok = takeToken(rest)[0];
  if (!tok) throw new UsageError();
  const d = tok.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const cfg = guildCfg(ctx.guild.id);
  if (!cfg.allowed_domains.includes(d)) {
    cfg.allowed_domains.push(d);
    save();
    audit(ctx.guild.id, { type: "allowdomain", target: "", mod: ctx.author.name, reason: d, source: "chat" });
  }
  await ctx.reply(`Links to ${d} are now allowed.`);
});

command("setlog", "setlog <#channel>", "Set the mod-log channel", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const cid = parseId(takeToken(rest)[0], "channel");
  if (!cid) throw new UsageError();
  try {
    await getChannel(cid);
  } catch {
    return void (await ctx.reply("I couldn't find that channel."));
  }
  guildCfg(ctx.guild.id).log_channel = cid;
  save();
  audit(ctx.guild.id, { type: "setlog", target: "", mod: ctx.author.name, reason: `Mod log set to channel ${cid}`, source: "chat" });
  await ctx.reply(`Mod log set to <#${cid}>.`);
});

// Who can use what (commands not listed are for everyone). Used by !help and the dashboard.
const LEVELS = {
  warn: "mod", warnings: "mod", unwarn: "mod", timeout: "mod", automod: "mod", dashboard: "mod", modhelp: "mod",
  ban: "manage", unban: "manage", clearwarns: "manage", addword: "manage", delword: "manage",
  words: "manage", links: "manage", allowdomain: "manage", setlog: "manage",
  history: "mod", modlog: "mod", topwarned: "mod", stats: "mod", note: "mod", notes: "mod", delnote: "mod", say: "mod",
  setrules: "manage", filter: "manage", setspam: "manage", setmentions: "manage", escalate: "manage",
};
const RANK = { all: 0, mod: 1, manage: 2 };
const LEVEL_LABEL = { all: "Everyone", mod: "Moderators", manage: "Server managers" };
const levelOf = (ctx) => (canManage(ctx.author, ctx.guild) ? "manage" : canModerate(ctx.author, ctx.guild) ? "mod" : "all");
const cmdLevel = (c) => LEVELS[c.name] ?? "all";

command("help", "help [command]", "Show the commands you can use", async (ctx, rest) => {
  const mine = RANK[levelOf(ctx)];
  const asked = takeToken(rest)[0]?.toLowerCase().replace(/^[^\w]+/, "");
  if (asked) {
    const cmd = commands.get(asked);
    if (!cmd) return void (await ctx.reply(`I don't have a command called "${asked}". Try ${PREFIX}help.`));
    return void (await ctx.reply(`**${PREFIX}${cmd.usage}**\n${cmd.description}\nWho can use it: ${LEVEL_LABEL[cmdLevel(cmd)]}`));
  }
  const lines = ["**Commands**"];
  for (const lvl of ["all", "mod", "manage"]) {
    if (RANK[lvl] > mine) continue;
    const list = [...commands.values()].filter((c) => cmdLevel(c) === lvl);
    if (list.length) lines.push(`**${LEVEL_LABEL[lvl]}**`, ...list.map((c) => `${PREFIX}${c.usage} - ${c.description}`));
  }
  lines.push(`Type ${PREFIX}help <command> for details on one command.`);
  if (mine === 0) lines.push("Moderators and server managers have extra commands.");
  await ctx.reply(lines.join("\n"));
});

command("modhelp", "modhelp", "List moderation commands", async (ctx) => {
  if (!(await guard(ctx, "mod"))) return;
  await commands.get("help").handler(ctx, "");
});

command("ping", "ping", "Check that the bot is alive", async (ctx) => {
  const t = Date.now();
  try { await api("GET", "/me"); } catch { /* still answer */ }
  await ctx.reply(`Pong! API round trip: ${Date.now() - t}ms`);
});

command("about", "about", "About this bot", async (ctx) => {
  const s = Math.floor(process.uptime());
  const up = `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  const lines = [`**${me.username}** - moderation bot for Yapper`, `Uptime: ${up}`, `Servers: ${knownGuildIds().size}`];
  if (process.env.DASHBOARD_URL) lines.push(`Dashboard: ${process.env.DASHBOARD_URL}`);
  lines.push(`Type ${PREFIX}help to see what I can do.`);
  await ctx.reply(lines.join("\n"));
});

command("dashboard", "dashboard", "Get the link to the web dashboard", async (ctx) => {
  if (!(await guard(ctx, "mod"))) return;
  const url = process.env.DASHBOARD_URL;
  await ctx.reply(url ? `Dashboard: ${url}` : "The web dashboard isn't set up yet.");
});

command("serverinfo", "serverinfo", "Show info about this server", async (ctx) => {
  const g = ctx.guild;
  await ctx.reply([`**${g.name}**`, `ID: ${g.id}`, `Owner: <@${g.ownerId}>`, `Roles: ${g.roles.size}`].join("\n"));
});

command("userinfo", "userinfo [user]", "Show info about a member", async (ctx, rest) => {
  const uid = parseId(takeToken(rest)[0]) ?? ctx.author.id;
  let m;
  try { m = await getMember(ctx.guild, uid); } catch { return void (await ctx.reply("That user isn't in this server.")); }
  const roles = m.roleIds.map((id) => ctx.guild.roles.get(id)?.name).filter(Boolean);
  const lines = [`**${m.displayName}** (@${m.name})`, `ID: ${m.id}`, `Roles: ${roles.length ? roles.join(", ") : "none"}`];
  if (isOwner(m, ctx.guild)) lines.push("Server owner");
  if (canModerate(ctx.author, ctx.guild)) lines.push(`Warnings: ${(guildCfg(ctx.guild.id).warnings[m.id] ?? []).length}`);
  await ctx.reply(lines.join("\n"));
});

command("mywarnings", "mywarnings", "Show your own warnings", async (ctx) => {
  const warns = guildCfg(ctx.guild.id).warnings[ctx.author.id] ?? [];
  if (!warns.length) return void (await ctx.reply("You have no warnings."));
  const start = Math.max(0, warns.length - 10);
  const lines = [`You have ${warns.length} warning(s):`];
  warns.slice(start).forEach((w, i) => {
    lines.push(`${start + i + 1}. ${w.reason} (${new Date(w.time * 1000).toISOString().slice(0, 10)})`);
  });
  await ctx.reply(lines.join("\n"));
});

command("unwarn", "unwarn <user> [number]", "Remove one warning (default: the latest)", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const [uTok, r1] = takeToken(rest);
  const uid = parseId(uTok);
  if (!uid) throw new UsageError();
  const nTok = takeToken(r1)[0];
  if (nTok && !/^\d+$/.test(nTok)) throw new UsageError();
  const warns = guildCfg(ctx.guild.id).warnings[uid] ?? [];
  if (!warns.length) return void (await ctx.reply(`<@${uid}> has no warnings.`));
  const idx = nTok ? parseInt(nTok, 10) : warns.length;
  if (idx < 1 || idx > warns.length) return void (await ctx.reply(`They only have ${warns.length} warning(s).`));
  await removeWarning(ctx.guild, ctx.author.name, uid, idx);
  await ctx.reply(`Removed warning #${idx} from <@${uid}>.`);
});

command("automod", "automod", "Show this server's auto-mod settings", async (ctx) => {
  if (!(await guard(ctx, "mod"))) return;
  const c = guildCfg(ctx.guild.id);
  const s = c.settings;
  const on = (v) => (v ? "ON" : "OFF");
  const esc = Object.entries(s.escalation).sort((a, b) => a[0] - b[0])
    .map(([w, m]) => `${w} warnings -> ${m} min timeout`).join(", ") || "off";
  await ctx.reply([
    "**Auto-mod settings**",
    `Banned words: ${on(s.automod_words)} (${c.banned_words.length} word(s))`,
    `Link blocking: ${on(c.block_links)} (${c.allowed_domains.length} allowed domain(s))`,
    `Spam: ${on(s.automod_spam)} (${s.spam_messages} messages in ${s.spam_seconds}s)`,
    `Mass mentions: ${on(s.automod_mentions)} (more than ${s.max_mentions})`,
    `Warning escalation: ${esc}`,
    `Mod log: ${c.log_channel ? `<#${c.log_channel}>` : "not set"}`,
  ].join("\n"));
});


// ---- More commands ---------------------------------------------------------
const fmtDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cleanOut = (s) => s.replace(/<@/g, "<\u200b@"); // stop the bot from pinging people by accident

command("rules", "rules", "Show this server's rules", async (ctx) => {
  const r = guildCfg(ctx.guild.id).rules;
  await ctx.reply(r ? `**Rules for ${ctx.guild.name}**\n${r}` : "No rules have been set yet. A server manager can add them with !setrules.");
});

command("setrules", "setrules <text>", "Set the rules shown by !rules", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const text = rest.trim();
  if (!text || text.length > 1500) throw new UsageError();
  guildCfg(ctx.guild.id).rules = text;
  save();
  audit(ctx.guild.id, { type: "settings", target: "", mod: ctx.author.name, reason: "Changed: rules", source: "chat" });
  await ctx.reply("Rules updated. Members can read them with !rules.");
});

command("history", "history <user>", "Show moderation actions taken against a user", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const uid = parseId(takeToken(rest)[0]);
  if (!uid) throw new UsageError();
  const rows = guildCfg(ctx.guild.id).audit.filter((e) => e.target === uid).slice(-10);
  if (!rows.length) return void (await ctx.reply(`Nothing on record for <@${uid}>.`));
  await ctx.reply([`Last ${rows.length} action(s) for <@${uid}>:`, ...rows.map((e) => `${fmtDay(e.time)} - ${e.type} by ${e.mod}${e.reason ? `: ${e.reason}` : ""}`)].join("\n"));
});

command("modlog", "modlog [count]", "Show the latest moderation actions (default 5)", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const n = Math.min(15, Math.max(1, parseInt(takeToken(rest)[0] ?? "5", 10) || 5));
  const rows = guildCfg(ctx.guild.id).audit.slice(-n).reverse();
  if (!rows.length) return void (await ctx.reply("No actions recorded yet."));
  await ctx.reply(["**Latest actions**", ...rows.map((e) => `${fmtDay(e.time)} - ${e.type}${e.target ? ` <@${e.target}>` : ""} by ${e.mod}${e.reason ? `: ${e.reason}` : ""}`)].join("\n"));
});

command("topwarned", "topwarned", "Show the members with the most warnings", async (ctx) => {
  if (!(await guard(ctx, "mod"))) return;
  const list = Object.entries(guildCfg(ctx.guild.id).warnings).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  if (!list.length) return void (await ctx.reply("Nobody has any warnings."));
  await ctx.reply(["**Most warned**", ...list.map(([id, w], i) => `${i + 1}. <@${id}> - ${w.length} warning(s)`)].join("\n"));
});

command("stats", "stats", "Show moderation numbers for this server", async (ctx) => {
  if (!(await guard(ctx, "mod"))) return;
  const c = guildCfg(ctx.guild.id);
  const week = Date.now() / 1000 - 7 * 86400;
  const recent = c.audit.filter((e) => e.time >= week);
  const count = (t) => recent.filter((e) => e.type === t).length;
  await ctx.reply([
    "**Moderation stats**",
    `Members with warnings: ${Object.keys(c.warnings).length}`,
    `Total warnings: ${Object.values(c.warnings).reduce((n, w) => n + w.length, 0)}`,
    `Last 7 days: ${count("warn")} warnings, ${count("timeout")} timeouts, ${count("ban")} bans`,
    `Done by AutoMod (7 days): ${recent.filter((e) => e.source === "automod").length}`,
  ].join("\n"));
});

command("note", "note <user> <text>", "Add a private moderator note about a user", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const [tok, text] = takeToken(rest);
  const uid = parseId(tok);
  if (!uid || !text.trim() || text.length > 300) throw new UsageError();
  const c = guildCfg(ctx.guild.id);
  (c.notes[uid] ??= []).push({ text: text.trim(), mod: ctx.author.name, time: Math.floor(Date.now() / 1000) });
  save();
  await ctx.reply(`Note saved for <@${uid}>. Your message will be removed so the note stays private.`);
  try { await ctx.del(); } catch { /* ignore */ }
});

command("notes", "notes <user>", "Show moderator notes about a user", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const uid = parseId(takeToken(rest)[0]);
  if (!uid) throw new UsageError();
  const list = guildCfg(ctx.guild.id).notes[uid] ?? [];
  if (!list.length) return void (await ctx.reply(`No notes for <@${uid}>.`));
  await ctx.reply([`Notes for <@${uid}>:`, ...list.slice(-10).map((n, i) => `${Math.max(0, list.length - 10) + i + 1}. ${cleanOut(n.text)} (${n.mod}, ${fmtDay(n.time)})`)].join("\n"));
});

command("delnote", "delnote <user> <number>", "Delete a moderator note", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const [tok, r1] = takeToken(rest);
  const uid = parseId(tok);
  const n = parseInt(takeToken(r1)[0] ?? "", 10);
  if (!uid || !n) throw new UsageError();
  const c = guildCfg(ctx.guild.id);
  const list = c.notes[uid] ?? [];
  if (n < 1 || n > list.length) return void (await ctx.reply(`They only have ${list.length} note(s).`));
  list.splice(n - 1, 1);
  if (!list.length) delete c.notes[uid];
  save();
  await ctx.reply("Note deleted.");
});

command("say", "say <text>", "Make the bot post a message", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const text = rest.trim();
  if (!text || text.length > 1500) throw new UsageError();
  await send(ctx.channelId, cleanOut(text));
  try { await ctx.del(); } catch { /* ignore */ }
});

command("filter", "filter <words|spam|mentions|links> on|off", "Turn one auto-mod filter on or off", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const [what, r1] = takeToken(rest);
  const on = parseBool(takeToken(r1)[0]);
  const key = { words: "automod_words", spam: "automod_spam", mentions: "automod_mentions" }[(what ?? "").toLowerCase()];
  const c = guildCfg(ctx.guild.id);
  if (on === null || (!key && (what ?? "").toLowerCase() !== "links")) throw new UsageError();
  if (key) c.settings[key] = on; else c.block_links = on;
  save();
  audit(ctx.guild.id, { type: "settings", target: "", mod: ctx.author.name, reason: `Changed: ${what} ${on ? "on" : "off"}`, source: "chat" });
  await ctx.reply(`${what} filter is now ${on ? "ON" : "OFF"}.`);
});

command("setspam", "setspam <messages> <seconds>", "Set how much chatter counts as spam", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const [a, r1] = takeToken(rest);
  const m = parseInt(a ?? "", 10), sec = parseInt(takeToken(r1)[0] ?? "", 10);
  if (!(m >= 2 && m <= 30 && sec >= 2 && sec <= 60)) return void (await ctx.reply(`Usage: ${PREFIX}setspam <2-30 messages> <2-60 seconds>`));
  const s = guildCfg(ctx.guild.id).settings;
  s.spam_messages = m; s.spam_seconds = sec;
  save();
  await ctx.reply(`Spam rule: ${m} messages in ${sec} seconds.`);
});

command("setmentions", "setmentions <number>", "Set the most mentions allowed in one message", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const n = parseInt(takeToken(rest)[0] ?? "", 10);
  if (!(n >= 1 && n <= 50)) return void (await ctx.reply(`Usage: ${PREFIX}setmentions <1-50>`));
  guildCfg(ctx.guild.id).settings.max_mentions = n;
  save();
  await ctx.reply(`Messages with more than ${n} mentions will now be removed.`);
});

command("escalate", "escalate <warnings> <minutes|off>", "Set the timeout given at a warning count", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const [a, r1] = takeToken(rest);
  const w = parseInt(a ?? "", 10);
  const t = (takeToken(r1)[0] ?? "").toLowerCase();
  if (!(w >= 1 && w <= 50) || !t) throw new UsageError();
  const esc = guildCfg(ctx.guild.id).settings.escalation;
  if (t === "off") { delete esc[w]; save(); return void (await ctx.reply(`No automatic timeout at ${w} warnings.`)); }
  const mins = parseInt(t, 10);
  if (!(mins >= 1 && mins <= MAX_TIMEOUT_MINUTES)) return void (await ctx.reply(`Minutes must be between 1 and ${MAX_TIMEOUT_MINUTES}.`));
  esc[w] = mins; save();
  await ctx.reply(`At ${w} warnings, members get a ${mins} minute timeout.`);
});

command("uptime", "uptime", "Show how long the bot has been running", async (ctx) => {
  const s = Math.floor(process.uptime());
  await ctx.reply(`Up for ${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m.`);
});

command("roll", "roll [sides]", "Roll a dice (default 6 sides)", async (ctx, rest) => {
  const n = Math.min(1000000, Math.max(2, parseInt(takeToken(rest)[0] ?? "6", 10) || 6));
  await ctx.reply(`You rolled a ${1 + Math.floor(Math.random() * n)} (1-${n}).`);
});

command("flip", "flip", "Flip a coin", async (ctx) => { await ctx.reply(Math.random() < 0.5 ? "Heads." : "Tails."); });

command("choose", "choose <a | b | c>", "Pick one option at random", async (ctx, rest) => {
  const opts = rest.split("|").map((x) => x.trim()).filter(Boolean);
  if (opts.length < 2) throw new UsageError();
  await ctx.reply(`I pick: ${cleanOut(pick(opts))}`);
});

command("eightball", "eightball <question>", "Ask the magic 8-ball", async (ctx, rest) => {
  if (!rest.trim()) throw new UsageError();
  await ctx.reply(pick(["Yes.", "No.", "Definitely.", "Not a chance.", "Ask again later.", "Probably.", "I wouldn't count on it.", "Signs point to yes."]));
});

async function runCommand(ctx) {
  if (!ctx.content.startsWith(PREFIX)) return;
  const [name, rest] = takeToken(ctx.content.slice(PREFIX.length));
  const cmd = name && commands.get(name.toLowerCase());
  if (!cmd) return; // unknown commands are ignored
  try {
    await cmd.handler(ctx, rest);
  } catch (e) {
    if (e instanceof UsageError) {
      await ctx.reply(`Usage: \`${PREFIX}${cmd.usage}\``);
    } else {
      logErr(`Command '${cmd.name}' failed:`, e);
    }
  }
}

// --------------------------------------------------------------------------
// Event handling + main loop
// --------------------------------------------------------------------------
let me = null;

async function handleMessage(ev) {
  const d = ev.data;
  if (ev.author_bot || String(d.author_id) === String(me.id)) return;

  const channel = await getChannel(d.channel_id);
  if (!channel.server_id) return; // not a server channel
  seenGuilds.add(String(channel.server_id));
  const guild = await getGuild(channel.server_id);
  const author = await getMember(guild, d.author_id);

  const ctx = {
    guild,
    author,
    channelId: String(d.channel_id),
    messageId: String(d.id),
    content: d.content ?? "",
    reply: (text) => send(d.channel_id, text, d.id),
    del: () => deleteMessage(d.channel_id, d.id),
  };

  if (!(await automod(ctx))) return;
  await runCommand(ctx);
}

function dispatch(ev) {
  if (ev.type !== "message") return;
  handleMessage(ev).catch((e) => logErr("Unhandled error in message handler:", e));
}

const botStatus = { state: "stopped", error: null, since: null };
const seenGuilds = new Set();
const markGuildSeen = (id) => seenGuilds.add(String(id));
const knownGuildIds = () => new Set([...Object.keys(data), ...seenGuilds]);
const getMe = () => me;

function fatal(msg, embedded) {
  console.error(msg);
  botStatus.state = "error";
  botStatus.error = msg;
  if (embedded) throw new Error(msg);
  process.exit(1);
}

async function startBot({ embedded = false } = {}) {
  botStatus.state = "starting";
  if (!TOKEN) fatal("Set TOKEN in your environment or in a .env file next to modbot.mjs.", embedded);

  try {
    me = await api("GET", "/me");
  } catch (e) {
    if (e.status === 401) fatal("Yapper rejected the token. Check that TOKEN is correct.", embedded);
    fatal(`Couldn't reach Yapper: ${e.message}`, embedded);
  }
  log(`Logged in as ${me.username} (id ${me.id})`);

  try {
    await api("PUT", "/commands", {
      commands: [...commands.values()].map((c) => ({ name: c.name, description: c.description })),
    });
    log(`Registered ${commands.size} command(s)`);
  } catch (e) {
    logErr("Couldn't register commands (the bot will still work):", e.message);
  }

  const init = await api("GET", "/events?after=0&wait=0");
  let last = init.last;
  botStatus.state = "online";
  botStatus.since = Date.now();
  log("ModBot ready. Press Ctrl+C to stop.");

  let fails = 0;
  while (true) {
    let out;
    try {
      out = await api("GET", `/events?after=${last}&wait=25`);
      if (fails) log("Connection to Yapper restored");
      fails = 0;
      botStatus.state = "online";
    } catch (e) {
      if (e.status === 401) fatal("Yapper rejected the token. Check that TOKEN is correct.", embedded);
      fails++;
      if (fails >= 3) botStatus.state = "reconnecting";
      const wait = Math.min(30, 2 ** fails);
      log(`Problem reaching Yapper: ${e.message}. Retrying in ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    for (const ev of out.events ?? []) {
      if (ev.id <= last) continue;
      last = ev.id;
      dispatch(ev); // each event runs on its own, so a slow one never blocks polling
    }
  }
}

// Used by the dashboard server (server.mjs) and by tests.
export {
  findBannedWord, findBadLink, parseId, takeToken,
  data, guildCfg, save, audit, api, startBot, botStatus, getMe,
  getGuild, getMember, getChannel, canManage, canModerate, isOwner, checkTarget,
  addWarning, timeoutUser, banUser, unbanUser, clearWarnings, removeWarning, modLog,
  knownGuildIds, markGuildSeen, commands, LEVELS, LEVEL_LABEL, PREFIX, MAX_TIMEOUT_MINUTES,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on("unhandledRejection", (e) => logErr("Unhandled rejection:", e));
  process.on("SIGINT", () => { log("Shutting down"); process.exit(0); });
  startBot();
}
