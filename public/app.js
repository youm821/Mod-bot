// Yapper ModBot dashboard (no build step, no inline styles: works with the server's CSP)
const root = document.getElementById("root");
const S = { me: null, servers: [], gid: localStorage.getItem("ym_gid"), view: "home", srv: null, cache: {} };

// ---------- helpers
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(9)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const ICONS = {
  home: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.500-1-8-4-8-9V6z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.900 4.900l2.100 2.100M17 17l2.100 2.100M4.900 19.100L7 17M17 7l2.100-2.100"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  book: '<path d="M3 5h7a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H3zM21 5h-7a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h7z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.500 20c0-3.500 3-6 6.500-6s6.500 2.500 6.500 6M16 4.500a3.500 3.500 0 0 1 0 7M18 14.500c2.200.8 3.500 2.800 3.500 5.500"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
};
function icon(name) {
  const s = h("span");
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s.firstChild;
}
let toastT;
function toast(msg, err = false) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ""), 3500);
}
async function api(method, path, body) {
  const res = await fetch("/api" + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch {}
  if (res.status === 401) { S.me = null; renderLogin(); throw new Error("login"); }
  if (!res.ok) throw new Error(j.error || "Something went wrong.");
  return j;
}
async function act(fn, ok) {
  try { const r = await fn(); toast(r?.message || ok || "Saved."); return r; }
  catch (e) { if (e.message !== "login") toast(e.message, true); return null; }
}
const ago = (t) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago"; return Math.floor(s / 86400) + " d ago";
};
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" });
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const nameOf = (names, id) => (id ? names?.[id] || "User " + String(id).slice(0, 6) : "-");
const initials = (s) => (s || "?").trim().slice(0, 2).toUpperCase();
const canManage = () => S.srv?.level === "manage";

function sparkline(vals) {
  const ns = "http://www.w3.org/2000/svg", w = 110, hgt = 34, max = Math.max(1, ...vals);
  const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "spark"); svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * (w - 6) + 3, hgt - 4 - (v / max) * (hgt - 10)]);
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", pts.map((q, i) => (i ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1)).join(" "));
  p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "2.2"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
  svg.append(p); return svg;
}
function perDay(entries, days, filter = () => true) {
  const out = Array(days).fill(0), start = new Date(); start.setHours(0, 0, 0, 0);
  for (const e of entries) {
    if (!filter(e)) continue;
    const d = days - 1 - Math.floor((start.getTime() + 86400000 - e.time * 1000) / 86400000);
    if (d >= 0 && d < days) out[d]++;
  }
  return out;
}

// ---------- login
function renderLogin() {
  const err = new URLSearchParams(location.search).get("login_error");
  root.replaceChildren(h("div", { class: "login" }, h("div", { class: "box" },
    h("img", { class: "logo2", src: "/logo.svg", alt: "ModBot" }),
    h("h1", {}, "Yapper ModBot"),
    h("p", {}, "Log in with your Yapin' account to manage warnings, auto-mod and moderation for your servers."),
    err && h("div", { class: "err" }, err),
    h("a", { class: "btn", href: "/auth/login" }, "Login with Yapin'"))));
}

// ---------- shell
const NAV = [["home", "Home", "home"], ["moderate", "Moderate", "shield"], ["automod", "Auto-mod", "gear"], ["warnings", "Warnings", "warn"], ["members", "Members", "users"], ["activity", "Activity", "list"], ["commands", "Commands", "book"], ["status", "Status", "pulse"]];
const TITLES = { home: "Home", moderate: "Moderate", automod: "Auto-mod", warnings: "Warnings", members: "Members", activity: "Activity", commands: "Commands", status: "Status" };

function shell(compact, kpis, content) {
  const u = S.me.user, nm = u.displayName || u.username;
  const pick = h("select", { class: "pick", "aria-label": "Server", onchange: (e) => { S.gid = e.target.value; localStorage.setItem("ym_gid", S.gid); S.cache = {}; load(); } },
    S.servers.length ? S.servers.map((s) => h("option", { value: s.id, selected: s.id === S.gid }, s.name)) : h("option", {}, "No servers yet"));
  root.replaceChildren(h("div", { class: "app" },
    h("aside", { class: "rail" }, h("div", { class: "logo" }, h("img", { src: "/logo.svg", alt: "ModBot" })),
      h("nav", { class: "nav" }, NAV.map(([id, label, ic]) => h("button", { "aria-current": S.view === id ? "page" : null, "aria-label": label, onclick: () => { S.view = id; load(); } }, icon(ic), label)))),
    h("div", { class: "main" },
      h("div", { class: "band" + (compact ? " compact" : "") },
        h("div", { class: "top" }, h("h1", {}, TITLES[S.view]), pick,
          h("div", { class: "who" }, h("span", {}, h("span", { class: "dot " + S.me.botState }), "Bot " + S.me.botState),
            h("div", { class: "av" }, u.avatar ? h("img", { src: u.avatar, alt: "" }) : initials(nm)), nm,
            h("button", { onclick: async () => { await fetch("/auth/logout", { method: "POST" }); location.href = "/"; } }, "Log out"))),
        kpis),
      h("div", { class: "content" }, content))));
}
function kpi(title, big, sub, extra, hi) {
  return h("div", { class: "kpi" + (hi ? " hi" : "") }, h("h3", {}, title), h("div", { class: "big" }, big), h("div", { class: "sub" }, sub), extra);
}

// ---------- data
async function ensure(key, path) { return (S.cache[key] ??= await api("GET", path)); }
const base = () => `/servers/${S.gid}`;
async function refreshSrv() { S.srv = await api("GET", base()); delete S.cache.act; delete S.cache.warn; }

async function load() {
  try {
    if (!S.me) S.me = await api("GET", "/me");
    if (!S.servers.length) S.servers = (await api("GET", "/servers")).servers;
    if (!S.servers.find((s) => s.id === S.gid)) S.gid = S.servers[0]?.id ?? null;
    if (!S.gid) return shell(true, null, h("div", { class: "card" }, h("h2", {}, "No servers yet"),
      h("p", { class: "hint" }, "A server shows up once the bot has seen a message there, and you need the Manage Messages permission in it. Send a message in your server, then reload.")));
    localStorage.setItem("ym_gid", S.gid);
    S.srv = await api("GET", base());
    const views = { home: vHome, moderate: vModerate, automod: vAutomod, warnings: vWarnings, commands: vCommands, members: vMembers, activity: vActivity, status: vStatus };
    await views[S.view]();
  } catch (e) { if (e.message !== "login") { shell(true, null, h("div", { class: "card" }, h("h2", {}, "Couldn't load"), h("p", { class: "hint" }, e.message))); } }
}

// ---------- views
const TYPE_LABEL = { warn: "WARN", unwarn: "UNWARN", timeout: "TIMEOUT", ban: "BAN", unban: "UNBAN", clearwarns: "CLEAR", addword: "WORD", delword: "WORD", links: "LINKS", allowdomain: "DOMAIN", setlog: "LOG", settings: "SET" };
const badge = (t) => h("span", { class: "badge " + t }, TYPE_LABEL[t] || t.toUpperCase());

async function vHome() {
  const [act, warn] = await Promise.all([ensure("act", base() + "/activity"), ensure("warn", base() + "/warnings")]);
  const s = S.srv, en = act.entries;
  const week = perDay(en, 7), five = perDay(en, 5);
  const days = Array.from({ length: 5 }, (_, i) => new Date(Date.now() - (4 - i) * 86400000).toLocaleDateString(undefined, { weekday: "short" }));
  const mx = Math.max(1, ...five);
  const bars = h("div", { class: "bars" }, five.map((v, i) => { const col = h("div", {}, h("i"), days[i]); col.firstChild.style.height = Math.max(4, (v / mx) * 78) + "%"; col.firstChild.title = v + " actions"; return col; }));
  const kpis = h("div", { class: "kpis" },
    kpi("Warned users", String(s.stats.warnedUsers), "Right now", sparkline(perDay(en, 7, (e) => e.type === "warn"))),
    kpi("Total warnings", String(s.stats.totalWarnings), "Right now", sparkline(week), true),
    h("div", { class: "kpi" }, h("h3", {}, "Actions, last 5 days"), bars),
    kpi("Banned words", String(s.stats.bannedWords), s.level === "manage" ? "On the list" : "Managers only", sparkline(perDay(en, 7, (e) => e.type === "timeout"))),
    kpi("Auto-mod", `${["automod_words", "automod_spam", "automod_mentions"].filter((k) => s.settings[k]).length}/3`, "Filters on", sparkline(perDay(en, 7, (e) => e.source === "automod"))));

  const rows = en.slice(0, 6);
  const table = h("div", { class: "card" }, h("h2", {}, "Latest actions"),
    rows.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Type", "User", "By", "Reason", "Date", "Source"].map((c) => h("th", {}, c)))),
      h("tbody", {}, rows.map((e) => h("tr", {}, h("td", {}, badge(e.type)), h("td", {}, nameOf(act.names, e.target)), h("td", {}, e.mod), h("td", { class: "reason", title: e.reason }, e.reason || "-"), h("td", {}, fmtDate(e.time)), h("td", {}, e.source || "chat")))))
      : h("div", { class: "empty" }, "Nothing has happened yet. Warnings and timeouts will show up here."));

  const on = ["Bad words", "Spam", "Mass mentions"].map((l, i) => [l, s.settings[["automod_words", "automod_spam", "automod_mentions"][i]]]);
  const n = on.filter((x) => x[1]).length;
  const cream = h("div", { class: "card cream" }, h("h2", {}, "Auto-mod"), h("div", { class: "count" }, `${n} of 3 filters on`),
    h("div", { class: "gold" }, s.block_links ? "Links blocked" : "Links allowed"),
    on.map(([l, v]) => h("p", {}, `${l}: ${v ? "on" : "off"}`)),
    h("button", { class: "btn gold sm go", onclick: () => { S.view = "automod"; load(); } }, "Change settings"));

  const top = warn.users.slice(0, 4);
  const left = h("div", {}, h("h2", {}, "Most warned"),
    top.length ? top.map((u) => h("div", { class: "person" }, h("div", { class: "av" }, initials(nameOf(warn.names, u.id))),
      h("div", {}, h("b", {}, nameOf(warn.names, u.id)), h("span", {}, "Last: " + (u.warnings.at(-1)?.reason ?? "-"))), h("div", { class: "n" }, u.warnings.length)))
      : h("p", { class: "hint" }, "Nobody has been warned. That's a quiet server."));
  const right = h("div", {}, h("h2", {}, "Recent activity"), h("div", { class: "tl" },
    en.slice(0, 4).map((e) => h("div", {}, h("time", {}, fmtTime(e.time), h("br"), ago(e.time)), h("i"), h("span", {}, `${e.type} ${e.target ? nameOf(act.names, e.target) : ""}`.trim()), h("em", {}, e.mod)))));
  shell(false, kpis, [h("div", { class: "row" }, table, cream), h("div", { class: "bottom" }, left, right)]);
}

function userForm(title, hint, fields, btn, run, danger) {
  const inputs = {};
  const f = fields.map(([key, label, type, ph]) => { inputs[key] = h("input", { type: type || "text", placeholder: ph || "", min: type === "number" ? 1 : null }); return [h("label", {}, label), inputs[key]]; });
  return h("div", { class: "card" }, h("h2", { class: "sm" }, title), h("p", { class: "hint" }, hint), f,
    h("div", { class: "actions" }, h("button", { class: "btn", onclick: async (e) => {
      if (danger && !confirm(danger)) return; e.target.disabled = true;
      const r = await act(() => run(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]))));
      e.target.disabled = false; if (r) { for (const i of Object.values(inputs)) i.value = ""; await refreshSrv(); }
    } }, btn)));
}
async function vModerate() {
  const m = canManage();
  const cards = [
    userForm("Warn a member", "Adds a warning. Reaching an escalation step times them out automatically.", [["userId", "User id or @mention"], ["reason", "Reason", "text", "Optional"]], "Warn", (v) => api("POST", base() + "/warnings", v)),
    userForm("Time out a member", "Stops them from chatting for a while.", [["userId", "User id or @mention"], ["minutes", "Minutes", "number", "10"], ["reason", "Reason", "text", "Optional"]], "Time out", (v) => api("POST", base() + "/timeout", v)),
  ];
  if (m) cards.push(
    userForm("Ban a member", "Removes them from the server.", [["userId", "User id or @mention"], ["reason", "Reason", "text", "Optional"]], "Ban", (v) => api("POST", base() + "/ban", v), "Ban this member?"),
    userForm("Unban a member", "Lets a banned member join again.", [["userId", "User id or @mention"]], "Unban", (v) => api("POST", base() + "/unban", v)));
  shell(true, null, [h("div", { class: "grid2" }, cards), !m && h("p", { class: "hint" }, "Banning needs the Manage Server permission.")]);
}

async function vAutomod() {
  const s = S.srv, m = canManage(), st = s.settings, dis = !m;
  const sw = (key, title, desc, checked) => h("label", { class: "switch" }, h("span", {}, title, h("small", {}, desc)),
    h("input", { type: "checkbox", checked, disabled: dis, onchange: (e) => patch({ [key]: e.target.checked }) }));
  const patch = async (b) => { const r = await act(() => api("PATCH", base() + "/settings", b)); await refreshSrv(); await vAutomod(); return r; };
  const num = (v, min, max) => h("input", { type: "number", value: v, min, max, disabled: dis });
  const spamN = num(st.spam_messages, 2, 30), spamS = num(st.spam_seconds, 2, 60), menN = num(st.max_mentions, 1, 50);
  const rulesBox = h("textarea", { class: "ta", rows: 7, maxlength: 1500, disabled: dis, placeholder: "1. Be kind\n2. No spam" }); rulesBox.value = s.rules ?? "";
  const logI = h("input", { type: "text", value: s.log_channel ?? "", placeholder: "#channel or id", disabled: dis });
  const esc = Object.entries(st.escalation).sort((a, b) => a[0] - b[0]).map(([w, mins]) => ({ w, mins }));
  const escBox = h("div", {});
  const drawEsc = () => escBox.replaceChildren(esc.map((r, i) => h("div", { class: "esc" },
    h("input", { type: "number", min: 1, value: r.w, disabled: dis, "aria-label": "Warnings", oninput: (e) => (r.w = e.target.value) }),
    h("input", { type: "number", min: 1, value: r.mins, disabled: dis, "aria-label": "Minutes", oninput: (e) => (r.mins = e.target.value) }),
    !dis && h("button", { class: "iconbtn red", "aria-label": "Remove step", onclick: () => { esc.splice(i, 1); drawEsc(); } }, icon("trash")))),
    !dis && h("button", { class: "btn ghost sm", onclick: () => { esc.push({ w: (esc.at(-1) ? +esc.at(-1).w : 0) + 1, mins: 10 }); drawEsc(); } }, "Add step"));
  drawEsc();

  const chips = (list, del) => h("div", { class: "chips" }, list.map((x) => h("span", { class: "chip" }, x, !dis && h("button", { "aria-label": "Remove " + x, onclick: () => del(x) }, "×"))));
  const addRow = (ph, fn) => { const i = h("input", { type: "text", placeholder: ph }); return h("div", { class: "inline" }, i, h("button", { class: "btn sm", onclick: async () => { if (i.value.trim()) { await fn(i.value); } } }, "Add")); };
  const wordsAdd = async (w) => { await act(() => api("POST", base() + "/words", { word: w })); await refreshSrv(); vAutomod(); };
  const domAdd = async (d) => { await act(() => api("POST", base() + "/domains", { domain: d })); await refreshSrv(); vAutomod(); };

  shell(true, null, [!m && h("p", { class: "hint" }, "You can view these settings. Changing them needs the Manage Server permission."),
    h("div", { class: "grid2" },
      h("div", { class: "card" }, h("h2", { class: "sm" }, "Filters"),
        sw("automod_words", "Bad words", "Warn members who use words on your list.", st.automod_words),
        sw("automod_spam", "Spam", "Warn members who send too many messages too fast.", st.automod_spam),
        sw("automod_mentions", "Mass mentions", "Warn members who mention too many people.", st.automod_mentions),
        sw("block_links", "Block links", "Delete links unless the domain is allowed.", s.block_links),
        h("label", {}, "Spam: messages"), spamN, h("label", {}, "Spam: within seconds"), spamS, h("label", {}, "Mentions allowed per message"), menN,
        h("div", { class: "actions" }, h("button", { class: "btn", disabled: dis, onclick: () => patch({ spam_messages: spamN.value, spam_seconds: spamS.value, max_mentions: menN.value }) }, "Save limits"))),
      h("div", { class: "card" }, h("h2", { class: "sm" }, "Warning escalation"), h("p", { class: "hint" }, "When a member reaches this many warnings, they're timed out for this many minutes."),
        escBox, !dis && h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => patch({ escalation: esc.map((r) => ({ warnings: r.w, minutes: r.mins })) }) }, "Save escalation")),
        h("label", {}, "Mod log channel"), logI,
        h("div", { class: "actions" }, h("button", { class: "btn ghost", disabled: dis, onclick: () => patch({ log_channel: logI.value }) }, "Save channel"))),
      m && h("div", { class: "card" }, h("h2", { class: "sm" }, "Banned words"), s.banned_words.length ? chips(s.banned_words, async (w) => { await act(() => api("DELETE", base() + "/words/" + encodeURIComponent(w))); await refreshSrv(); vAutomod(); }) : h("p", { class: "hint" }, "No words yet."), addRow("Add a word or phrase", wordsAdd)),
      h("div", { class: "card" }, h("h2", { class: "sm" }, "Allowed domains"), s.allowed_domains.length ? chips(s.allowed_domains, async (d) => { await act(() => api("DELETE", base() + "/domains/" + encodeURIComponent(d))); await refreshSrv(); vAutomod(); }) : h("p", { class: "hint" }, "No domains yet."), m && addRow("example.com", domAdd)),
      h("div", { class: "card" }, h("h2", { class: "sm" }, "Server rules"), h("p", { class: "hint" }, "Members see this when they type !rules."),
        rulesBox, m && h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => patch({ rules: rulesBox.value }) }, "Save rules"))))]);
}

async function vWarnings() {
  const w = await ensure("warn", base() + "/warnings");
  const rm = async (uid, i) => { await act(() => api("DELETE", `${base()}/warnings/${uid}/${i + 1}`)); await refreshSrv(); vWarnings(); };
  const clear = async (uid) => { if (!confirm("Clear all warnings for this member?")) return; await act(() => api("DELETE", `${base()}/warnings/${uid}`)); await refreshSrv(); vWarnings(); };
  shell(true, null, h("div", { class: "card" }, h("h2", {}, "Members with warnings"),
    w.users.length ? w.users.map((u) => h("details", { class: "user" },
      h("summary", {}, h("div", { class: "av" }, initials(nameOf(w.names, u.id))), h("b", {}, nameOf(w.names, u.id)), h("span", { class: "badge warn" }, u.warnings.length + (u.warnings.length === 1 ? " warning" : " warnings"))),
      h("div", { class: "wlist" }, u.warnings.map((x, i) => h("div", { class: "wl" }, h("span", {}, x.reason, " ", h("small", {}, `by ${x.mod} · ${ago(x.time)}`)),
        h("button", { class: "iconbtn red", "aria-label": "Remove warning", onclick: () => rm(u.id, i) }, icon("trash")))),
        canManage() && h("div", { class: "actions" }, h("button", { class: "btn ghost sm", onclick: () => clear(u.id) }, "Clear all")))))
      : h("div", { class: "empty" }, "No warnings. Use Moderate to warn a member.")));
}

async function vCommands() {
  const c = await ensure("cmd", "/commands");
  shell(true, null, h("div", { class: "card" }, h("h2", {}, "Chat commands"), h("p", { class: "hint" }, `Type these in your server. Prefix: ${c.prefix}`),
    h("table", {}, h("thead", {}, h("tr", {}, ["Command", "What it does", "Who", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, c.commands.map((x) => h("tr", {}, h("td", {}, h("b", {}, c.prefix + x.name)), h("td", {}, x.description), h("td", {}, c.labels?.[x.level] ?? x.level), h("td", {}, h("code", {}, x.usage || ""))))))));
}

// ---------- more pages
async function vActivity() {
  const act = await api("GET", base() + "/activity");
  const types = ["all", ...new Set(act.entries.map((e) => e.type))];
  let type = "all", q = "";
  const body = h("div", {});
  const draw = () => {
    const rows = act.entries.filter((e) => (type === "all" || e.type === type) && (!q || `${e.reason} ${e.mod} ${nameOf(act.names, e.target)}`.toLowerCase().includes(q)));
    body.replaceChildren(rows.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Type", "User", "By", "Reason", "When", "Source"].map((c) => h("th", {}, c)))),
      h("tbody", {}, rows.map((e) => h("tr", {}, h("td", {}, badge(e.type)), h("td", {}, nameOf(act.names, e.target)), h("td", {}, e.mod), h("td", { class: "reason", title: e.reason }, e.reason || "-"), h("td", {}, ago(e.time)), h("td", {}, e.source || "chat")))))
      : h("div", { class: "empty" }, "Nothing matches. Try another filter."));
  };
  const chips = h("div", { class: "chips" }, types.map((t) => h("button", { class: "btn ghost sm", onclick: () => { type = t; draw(); } }, t)));
  shell(true, null, h("div", { class: "card" }, h("h2", {}, "All activity"), h("p", { class: "hint" }, `The last ${act.entries.length} actions on this server.`), chips,
    h("input", { type: "text", placeholder: "Search by name, moderator or reason", oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }), body));
  draw();
}

async function vMembers() {
  const out = h("div", {});
  const idI = h("input", { type: "text", placeholder: "User id or @mention" });
  const lookup = async (id) => {
    const r = await act(() => api("GET", `${base()}/member/${encodeURIComponent(id)}`), "Found.");
    if (!r) return out.replaceChildren();
    const m = r.member, again = () => lookup(m.id);
    const reasonI = h("input", { type: "text", placeholder: "Reason (optional)" }), minI = h("input", { type: "number", min: 1, value: 10 }), noteI = h("input", { type: "text", placeholder: "Private note for moderators" });
    const warnCard = h("div", { class: "card" }, h("h2", { class: "sm" }, `Warnings (${r.warnings.length})`),
      r.warnings.length ? h("div", { class: "wlist" }, r.warnings.map((x, i) => h("div", { class: "wl" }, h("span", {}, x.reason, " ", h("small", {}, `by ${x.mod} · ${ago(x.time)}`)),
        h("button", { class: "iconbtn red", "aria-label": "Remove warning", onclick: async () => { await act(() => api("DELETE", `${base()}/warnings/${m.id}/${i + 1}`)); await refreshSrv(); again(); } }, icon("trash")))))
        : h("p", { class: "hint" }, "No warnings."));
    const noteCard = h("div", { class: "card" }, h("h2", { class: "sm" }, `Private notes (${r.notes.length})`),
      r.notes.length ? h("div", { class: "wlist" }, r.notes.map((x, i) => h("div", { class: "wl" }, h("span", {}, x.text, " ", h("small", {}, `by ${x.mod} · ${ago(x.time)}`)),
        h("button", { class: "iconbtn red", "aria-label": "Delete note", onclick: async () => { await act(() => api("DELETE", `${base()}/notes/${m.id}/${i}`)); again(); } }, icon("trash"))))) : h("p", { class: "hint" }, "No notes yet."),
      h("div", { class: "inline" }, noteI, h("button", { class: "btn sm", onclick: async () => { if (noteI.value.trim() && await act(() => api("POST", base() + "/notes", { userId: m.id, text: noteI.value }))) again(); } }, "Add")));
    const histCard = h("div", { class: "card" }, h("h2", { class: "sm" }, "History"),
      r.history.length ? h("div", { class: "wlist" }, r.history.map((e) => h("div", { class: "wl" }, badge(e.type), h("span", {}, e.reason || "-", " ", h("small", {}, `by ${e.mod} · ${ago(e.time)}`))))) : h("p", { class: "hint" }, "Nothing on record."));
    const infoCard = h("div", { class: "card" }, h("h2", { class: "sm" }, m.displayName), h("p", { class: "hint" }, `@${m.name} · id ${m.id}`),
      h("div", { class: "chips" }, m.isOwner && h("span", { class: "chip" }, "Server owner"), m.isMod && h("span", { class: "chip" }, "Moderator"), m.roles.map((x) => h("span", { class: "chip" }, x))),
      h("label", {}, "Reason"), reasonI, h("label", {}, "Timeout minutes"), minI,
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: async () => { if (await act(() => api("POST", base() + "/warnings", { userId: m.id, reason: reasonI.value }))) { await refreshSrv(); again(); } } }, "Warn"),
        h("button", { class: "btn ghost", onclick: async () => { if (await act(() => api("POST", base() + "/timeout", { userId: m.id, minutes: minI.value, reason: reasonI.value }))) again(); } }, "Time out")));
    out.replaceChildren(h("div", { class: "grid2" }, infoCard, warnCard, noteCard, histCard));
  };
  shell(true, null, [h("div", { class: "card" }, h("h2", {}, "Find a member"), h("p", { class: "hint" }, "See their roles, warnings, notes and history in one place."),
    h("div", { class: "inline" }, idI, h("button", { class: "btn", onclick: () => idI.value.trim() && lookup(idI.value.trim()) }, "Look up"))), h("div", { class: "gap" }), out]);
}

async function vStatus() {
  const st = await api("GET", "/status");
  const dur = (s) => `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  const row = (k, v) => h("div", { class: "wl" }, h("span", {}, k), h("b", {}, v));
  const url = st.baseUrl + "/healthz";
  shell(true, null, h("div", { class: "grid2" },
    h("div", { class: "card" }, h("h2", { class: "sm" }, "Bot"),
      row("State", [h("span", { class: "dot " + st.botState }), st.botState]), st.botError && row("Last error", st.botError),
      row("Running for", dur(st.uptimeSeconds)), row("Automatic restarts", String(st.restarts)), row("Servers seen", String(st.servers)), row("Memory", st.memoryMB + " MB")),
    h("div", { class: "card" }, h("h2", { class: "sm" }, "Staying online"),
      row("Self-ping", st.keepAlive ? (st.lastSelfPing ? (st.lastSelfPingOk ? "working" : "failed") + ", " + ago(st.lastSelfPing / 1000) : "starting") : "off"),
      row("Data saved across restarts", st.persistent ? "yes" : "no"),
      !st.persistent && h("p", { class: "hint" }, "Warnings and settings are stored on a disk that resets on redeploys or restarts. Use a paid Render plan with a disk to keep them."),
      h("p", { class: "hint" }, "To stop a free Render service from falling asleep, add this address to a free uptime monitor (like UptimeRobot) with a 5 minute interval:"),
      h("div", { class: "inline" }, h("input", { type: "text", value: url, readonly: true }), h("button", { class: "btn sm", onclick: () => navigator.clipboard?.writeText(url).then(() => toast("Copied.")) }, "Copy")))));
}

load().catch(() => {});
