import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = "modbot_session";
const SESSION_TTL = 8 * 60 * 60;

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}
function makeSession(secret) {
  const payload = `${Date.now() + SESSION_TTL * 1000}.${crypto.randomBytes(24).toString("base64url")}`;
  return `${payload}.${sign(payload, secret)}`;
}
function validSession(token, secret) {
  if (!token) return false;
  const bits = token.split(".");
  if (bits.length !== 3) return false;
  const payload = `${bits[0]}.${bits[1]}`;
  const expires = Number(bits[0]);
  return Number.isFinite(expires) && expires > Date.now() && safeEqual(bits[2], sign(payload, secret));
}

export async function startDashboard({ getData, guildCfg, save }) {
  const password = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.DASHBOARD_SECRET;
  if (!password || password.length < 12) throw new Error("Set DASHBOARD_PASSWORD to a strong password of at least 12 characters.");
  if (!secret || secret.length < 32) throw new Error("Set DASHBOARD_SECRET to a random secret of at least 32 characters.");

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: "Cross-origin request blocked." });
      } catch { return res.status(403).json({ error: "Invalid request origin." }); }
    }
    next();
  });

  const isAuthed = (req) => validSession(readCookie(req, COOKIE), secret);
  const auth = (req, res, next) => isAuthed(req) ? next() : res.status(401).json({ error: "Please log in." });
  const cookieOptions = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

  app.get("/healthz", (_req, res) => res.json({ ok: true, service: "yapper-modbot-dashboard" }));
  app.get("/", (_req, res) => res.sendFile(path.join(HERE, "public", "dashboard.html")));
  app.post("/api/login", (req, res) => {
    const supplied = typeof req.body?.password === "string" ? req.body.password : "";
    if (!safeEqual(supplied, password)) return res.status(401).json({ error: "Incorrect password." });
    res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(makeSession(secret))}; ${cookieOptions}`);
    res.json({ ok: true });
  });
  app.post("/api/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    res.json({ ok: true });
  });
  app.get("/api/me", (req, res) => res.json({ authenticated: isAuthed(req) }));

  app.get("/api/overview", auth, (_req, res) => {
    const data = getData() || {};
    const servers = Object.entries(data).map(([id, cfg]) => {
      const warnings = cfg?.warnings || {};
      return {
        id,
        warningCount: Object.values(warnings).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0),
        warnedUsers: Object.values(warnings).filter((list) => Array.isArray(list) && list.length).length,
        reportCount: Array.isArray(cfg?.reports) ? cfg.reports.length : 0,
        bannedWords: Array.isArray(cfg?.banned_words) ? cfg.banned_words.length : 0,
        linkBlocking: Boolean(cfg?.block_links),
        logChannel: cfg?.log_channel || null,
      };
    });
    res.json({ servers, totals: {
      warnings: servers.reduce((n, s) => n + s.warningCount, 0),
      reports: servers.reduce((n, s) => n + s.reportCount, 0),
      servers: servers.length,
    }});
  });

  app.get("/api/servers/:id", auth, (req, res) => {
    const id = String(req.params.id);
    const data = getData() || {};
    if (!Object.prototype.hasOwnProperty.call(data, id)) return res.status(404).json({ error: "Server not found in the bot's local data yet." });
    const cfg = guildCfg(id);
    const warnings = [];
    for (const [userId, list] of Object.entries(cfg.warnings || {})) {
      if (!Array.isArray(list)) continue;
      list.forEach((w, i) => warnings.push({
        caseId: w.case_id || `LEGACY-${id}-${userId}-${i + 1}`,
        userId,
        action: w.action || "warn",
        reason: String(w.reason || "No reason recorded"),
        moderator: String(w.mod || "Unknown"),
        timestamp: Number(w.time || 0),
      }));
    }
    warnings.sort((a, b) => b.timestamp - a.timestamp);
    res.json({ id, settings: {
      banned_words: cfg.banned_words || [],
      block_links: Boolean(cfg.block_links),
      allowed_domains: cfg.allowed_domains || [],
      log_channel: cfg.log_channel || "",
    }, warnings: warnings.slice(0, 250), reports: (cfg.reports || []).slice(-100).reverse() });
  });

  app.put("/api/servers/:id/settings", auth, (req, res) => {
    const id = String(req.params.id);
    const data = getData() || {};
    if (!Object.prototype.hasOwnProperty.call(data, id)) return res.status(404).json({ error: "Server not found." });
    const body = req.body || {};
    if (typeof body.block_links !== "boolean") return res.status(400).json({ error: "block_links must be true or false." });
    const cleanList = (value, max, label) => {
      if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== "string" || !v.trim() || v.length > 120)) throw new Error(`${label} must be a list of up to ${max} short text values.`);
      return [...new Set(value.map(v => v.trim().toLowerCase()))];
    };
    try {
      const cfg = guildCfg(id);
      cfg.block_links = body.block_links;
      cfg.banned_words = cleanList(body.banned_words, 200, "banned_words");
      cfg.allowed_domains = cleanList(body.allowed_domains, 100, "allowed_domains").map(d => d.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, ""));
      const channel = typeof body.log_channel === "string" ? body.log_channel.trim() : "";
      if (channel && !/^[\w-]+$/.test(channel)) throw new Error("log_channel must be a channel ID or blank.");
      cfg.log_channel = channel || null;
      save();
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.use((err, _req, res, _next) => {
    console.error("Dashboard error:", err.message);
    res.status(500).json({ error: "Internal dashboard error." });
  });

  const port = Number(process.env.PORT || 10000);
  await new Promise((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`ModBot dashboard listening on 0.0.0.0:${port}`);
      resolve();
    });
    server.once("error", reject);
  });
}
