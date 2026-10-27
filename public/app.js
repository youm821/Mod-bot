"use strict";
// All user-controlled text goes through textContent (see h()), so nothing here can inject HTML.
const root = document.getElementById("app");
const state = { user: null, botState: null, prefix: "!", server: null };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function toast(msg, bad) {
  const t = h("div", { class: "toast" + (bad ? " bad" : "") }, msg);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), 4500);
}

async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method, credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (res.status === 401) { state.user = null; if (path !== "/me") route(); throw new Error("Please log in."); }
  if (!res.ok) throw new Error(json?.error || res.statusText);
  return json;
}
// Runs an action, toasts the result/error.
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg || r?.message) toast(okMsg || r.message); return r; }
  catch (e) { toast(e.message, true); return null; }
}

const when = (s) => new Date(s * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const who = (id, names) => (names?.[id] ? `${names[id]} (${id})` : id);

// ---------------------------------------------------------------- layout
function shell(content) {
  const u = state.user;
  return h("div", {},
    h("header", { class: "top" },
      h("a", { class: "brand", href: "#/" }, h("img", { src: "/favicon.svg", alt: "" }), "ModBot"),
      h("a", { href: "#/commands", class: "small" }, "Commands"),
      h("span", { class: "grow" }),
      u && [
        u.avatar && h("img", { class: "avatar", src: u.avatar, alt: "", referrerpolicy: "no-referrer" }),
        h("span", { class: "name" }, u.displayName || u.username),
        h("button", { class: "btn ghost sm", onclick: logout }, "Log out"),
      ]),
    h("main", { class: "wrap" },
      state.botState && state.botState !== "online" && h("div", { class: "banner" }, `The bot is currently ${state.botState}. Settings can still be edited, but commands and auto-mod may not respond until it is online.`),
      content));
}
async function logout() { await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }); state.user = null; route(); }

function loginPage() {
  const err = new URLSearchParams(location.search).get("login_error");
  return h("div", { class: "login card" },
    h("img", { src: "/favicon.svg", width: 56, height: 56, alt: "" }),
    h("h2", {}, "ModBot Dashboard"),
    h("p", { class: "muted" }, "Manage auto-mod, warnings and moderation for your Yapper servers."),
    err && h("p", { class: "err" }, err),
    h("a", { class: "btn", href: "/auth/login" }, "Log in with Yapin\u2019"),
    h("p", { class: "muted small" }, "You can only manage servers where you are the owner or have a moderation role."));
}

// ---------------------------------------------------------------- pages
async function serversPage() {
  const view = h("div", {}, h("p", { class: "muted" }, "Loading servers\u2026"));
  api("GET", "/servers").then(({ servers, botState }) => {
    state.botState = botState;
    view.replaceChildren(
      h("h2", {}, "Your servers"),
      servers.length
        ? h("div", { class: "grid" }, servers.map((s) => h("a", { class: "card server", href: `#/s/${s.id}/overview` },
            h("h3", {}, s.name), h("span", { class: "muted small" }, s.level === "manage" ? "Manager" : "Moderator"))))
        : h("div", { class: "card" }, h("p", {}, "No servers found."),
            h("p", { class: "muted small" }, "You need to be the owner (or have a Manage Messages / Manage Server role) in a server the bot is in. If the bot was just added, send any message in that server and refresh.")));
  }).catch((e) => view.replaceChildren(h("p", { class: "err" }, e.message)));
  return view;
}

const TABS = [["overview", "Overview"], ["settings", "Settings"], ["warnings", "Warnings"], ["actions", "Actions"], ["activity", "Activity"]];

async function serverPage(id, tab) {
  const view = h("div", {}, h("p", { class: "muted" }, "Loading\u2026"));
  try {
    const s = await api("GET", `/servers/${id}`);
    state.server = s;
    const body = h("div", {});
    const pages = { overview, settings, warnings, actions, activity };
    view.replaceChildren(
      h("h2", {}, s.name),
      h("nav", { class: "tabs" }, TABS.map(([k, label]) => h("a", { href: `#/s/${id}/${k}`, class: k === tab ? "on" : "" }, label))),
      body);
    await (pages[tab] ?? overview)(body, s);
  } catch (e) { view.replaceChildren(h("p", { class: "err" }, e.message), h("a", { href: "#/" }, "\u2190 Back to servers")); }
  return view;
}

function overview(body, s) {
  const stat = (n, label) => h("div", { class: "card stat" }, h("b", {}, n), h("span", { class: "muted" }, label));
  const on = (v) => (v ? "On" : "Off");
  const esc = Object.entries(s.settings.escalation).sort((a, b) => a[0] - b[0]).map(([w, m]) => `${w} warnings \u2192 ${m} min`).join(", ") || "Off";
  body.append(
    h("div", { class: "stats" }, stat(s.stats.totalWarnings, "Total warnings"), stat(s.stats.warnedUsers, "Warned members"), stat(s.stats.bannedWords, "Banned words")),
    h("div", { class: "card" }, h("h3", {}, "Auto-mod at a glance"),
      h("table", {}, [
        ["Banned words", on(s.settings.automod_words)],
        ["Link blocking", `${on(s.block_links)} (${s.allowed_domains.length} allowed domains)`],
        ["Spam", `${on(s.settings.automod_spam)} \u2013 ${s.settings.spam_messages} messages in ${s.settings.spam_seconds}s`],
        ["Mass mentions", `${on(s.settings.automod_mentions)} \u2013 more than ${s.settings.max_mentions}`],
        ["Escalation", esc],
        ["Mod-log channel", s.log_channel ? `#${s.log_channel}` : "Not set"],
      ].map(([k, v]) => h("tr", {}, h("td", { class: "muted" }, k), h("td", {}, v))))),
    h("p", { class: "muted small" }, "Your role here: " + (s.level === "manage" ? "Manager (full access)" : "Moderator (warnings and timeouts)")));
}

async function settings(body, s) {
  if (s.level !== "manage") return body.append(h("div", { class: "card" }, "Only server managers can change settings."));
  const id = s.id;
  const rerender = (fresh) => { state.server = fresh; body.replaceChildren(); settings(body, fresh); };
  const save = async (patch) => { const r = await act(() => api("PATCH", `/servers/${id}/settings`, patch), "Saved."); if (r) rerender(r); };

  // Auto-mod toggles
  const toggle = (key, label, hint, value, isTop) => h("label", { class: "toggle" },
    h("span", {}, h("b", {}, label), h("br"), h("span", { class: "muted small" }, hint)),
    h("input", { type: "checkbox", checked: value, onchange: (e) => save({ [key]: e.target.checked }) }));
  body.append(h("div", { class: "card" }, h("h3", {}, "Auto-mod"),
    toggle("automod_words", "Banned words", "Delete messages that contain a banned word and warn the author.", s.settings.automod_words),
    toggle("block_links", "Block links", "Delete messages with links, except allowed domains.", s.block_links),
    toggle("automod_spam", "Spam", "Delete messages when someone sends too many too fast.", s.settings.automod_spam),
    toggle("automod_mentions", "Mass mentions", "Delete messages that mention too many people.", s.settings.automod_mentions)));

  // Thresholds
  const spamN = h("input", { type: "number", min: 2, max: 30, value: s.settings.spam_messages });
  const spamS = h("input", { type: "number", min: 2, max: 60, value: s.settings.spam_seconds });
  const ment = h("input", { type: "number", min: 1, max: 50, value: s.settings.max_mentions });
  body.append(h("div", { class: "card" }, h("h3", {}, "Limits"),
    h("div", { class: "row" },
      h("label", { class: "f" }, "Spam: messages", spamN),
      h("label", { class: "f" }, "\u2026within seconds", spamS),
      h("label", { class: "f" }, "Max mentions per message", ment),
      h("button", { class: "btn", onclick: () => save({ spam_messages: +spamN.value, spam_seconds: +spamS.value, max_mentions: +ment.value }) }, "Save limits"))));

  // Escalation
  const rows = Object.entries(s.settings.escalation).map(([w, m]) => ({ warnings: +w, minutes: m }));
  const escBox = h("div", {});
  const drawEsc = () => {
    escBox.replaceChildren(...rows.map((r, i) => h("div", { class: "row" },
      h("label", { class: "f" }, "At warnings", h("input", { type: "number", min: 1, max: 50, value: r.warnings, oninput: (e) => (r.warnings = +e.target.value) })),
      h("label", { class: "f" }, "Timeout (minutes)", h("input", { type: "number", min: 1, value: r.minutes, oninput: (e) => (r.minutes = +e.target.value) })),
      h("button", { class: "btn ghost sm", onclick: () => { rows.splice(i, 1); drawEsc(); } }, "Remove"))));
  };
  drawEsc();
  body.append(h("div", { class: "card" }, h("h3", {}, "Warning escalation"),
    h("p", { class: "muted small" }, "Automatically time someone out when they reach this many warnings."), escBox,
    h("div", { class: "row" },
      h("button", { class: "btn ghost", onclick: () => { rows.push({ warnings: (rows.at(-1)?.warnings ?? 0) + 1, minutes: 10 }); drawEsc(); } }, "Add step"),
      h("button", { class: "btn", onclick: () => save({ escalation: rows }) }, "Save escalation"))));

  // Log channel
  const ch = h("input", { type: "text", value: s.log_channel ?? "", placeholder: "Channel id or #mention (blank = off)" });
  body.append(h("div", { class: "card" }, h("h3", {}, "Mod-log channel"),
    h("p", { class: "muted small" }, "Warnings, timeouts and bans are posted here."),
    h("div", { class: "row" }, h("label", {}, ch), h("button", { class: "btn", onclick: () => save({ log_channel: ch.value.trim() || null }) }, "Save"))));

  // Lists
  const listCard = (title, hint, items, path, placeholder, field) => {
    const input = h("input", { type: "text", placeholder });
    const add = async () => { if (!input.value.trim()) return; const r = await act(() => api("POST", `/servers/${id}/${path}`, { [field]: input.value }), "Added."); if (r) rerender(r); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    return h("div", { class: "card" }, h("h3", {}, title), h("p", { class: "muted small" }, hint),
      h("div", { class: "row" }, h("label", {}, input), h("button", { class: "btn", onclick: add }, "Add")),
      h("div", { class: "chips" }, items.length ? items.map((it) => h("span", { class: "chip" }, it,
        h("button", { title: "Remove", onclick: async () => { const r = await act(() => api("DELETE", `/servers/${id}/${path}/${encodeURIComponent(it)}`), "Removed."); if (r) rerender(r); } }, "\u00d7")))
        : h("span", { class: "muted small" }, "Nothing here yet.")));
  };
  body.append(
    listCard("Banned words", "Matched as whole words, ignoring capitals.", s.banned_words ?? [], "words", "Add a word or phrase", "word"),
    listCard("Allowed domains", "Only used when link blocking is on. Subdomains are included.", s.allowed_domains, "domains", "example.com", "domain"));
}

async function warnings(body, s) {
  const id = s.id;
  const draw = async () => {
    const { users, names } = await api("GET", `/servers/${id}/warnings`);
    const q = h("input", { type: "text", placeholder: "Search by name, id or reason" });
    const list = h("div", {});
    const paint = () => {
      const term = q.value.trim().toLowerCase();
      const shown = users.filter((u) => !term || u.id.includes(term) || (names[u.id] ?? "").toLowerCase().includes(term) || u.warnings.some((w) => w.reason.toLowerCase().includes(term)));
      list.replaceChildren(...(shown.length ? shown.map((u) => h("details", { class: "card" },
        h("summary", {}, h("b", {}, names[u.id] ?? u.id), " ", h("span", { class: "muted small" }, names[u.id] ? u.id : ""), " \u2013 ", `${u.warnings.length} warning(s)`),
        h("table", {}, h("tr", {}, ["#", "Reason", "By", "When", ""].map((c) => h("th", {}, c))),
          u.warnings.map((w, i) => h("tr", {}, h("td", {}, i + 1), h("td", {}, w.reason), h("td", {}, w.mod), h("td", { class: "small" }, when(w.time)),
            h("td", {}, h("button", { class: "btn ghost sm", onclick: async () => { if (await act(() => api("DELETE", `/servers/${id}/warnings/${u.id}/${i + 1}`))) { body.replaceChildren(); warnings(body, s); } } }, "Remove"))))),
        s.level === "manage" && h("div", { class: "row" }, h("button", { class: "btn danger sm", onclick: async () => { if (confirm("Clear all warnings for this member?") && await act(() => api("DELETE", `/servers/${id}/warnings/${u.id}`))) { body.replaceChildren(); warnings(body, s); } } }, "Clear all"))))
        : [h("div", { class: "card muted" }, users.length ? "No matches." : "No one has been warned yet.")]));
    };
    q.addEventListener("input", paint);
    paint();
    body.append(h("div", { class: "row" }, h("label", {}, q)), h("div", { style: "height:12px" }), list);
  };
  const uid = h("input", { type: "text", placeholder: "User id or @mention" });
  const reason = h("input", { type: "text", placeholder: "Reason (optional)" });
  body.append(h("div", { class: "card" }, h("h3", {}, "Warn a member"),
    h("div", { class: "row" }, h("label", { class: "f" }, "Member", uid), h("label", { class: "f" }, "Reason", reason),
      h("button", { class: "btn", onclick: async () => { if (await act(() => api("POST", `/servers/${id}/warnings`, { userId: uid.value, reason: reason.value }))) { body.replaceChildren(); warnings(body, s); } } }, "Warn"))));
  await draw();
}

function actions(body, s) {
  const id = s.id;
  const field = (label, ph, type = "text") => h("input", { type, placeholder: ph });
  const form = (title, hint, fields, btn, run, danger) => h("div", { class: "card" }, h("h3", {}, title), h("p", { class: "muted small" }, hint),
    h("div", { class: "row" }, fields.map(([l, el]) => h("label", { class: "f" }, l, el)),
      h("button", { class: "btn" + (danger ? " danger" : ""), onclick: async () => { if (danger && !confirm(`${title}: are you sure?`)) return; if (await act(run)) fields.forEach(([, el]) => (el.value = "")); } }, btn)));
  const tu = field("", "User id or @mention"), tm = field("", "10", "number"), tr = field("", "Reason (optional)");
  body.append(form("Timeout a member", "Stops them from chatting for a while (1 minute to 7 days).",
    [["Member", tu], ["Minutes", tm], ["Reason", tr]], "Timeout", () => api("POST", `/servers/${id}/timeout`, { userId: tu.value, minutes: tm.value, reason: tr.value })));
  if (s.level !== "manage") return body.append(h("div", { class: "card muted" }, "Bans and unbans are for server managers."));
  const bu = field("", "User id or @mention"), br = field("", "Reason (optional)"), uu = field("", "User id");
  body.append(
    form("Ban a member", "Removes them from the server.", [["Member", bu], ["Reason", br]], "Ban", () => api("POST", `/servers/${id}/ban`, { userId: bu.value, reason: br.value }), true),
    form("Unban a user", "Use the user id of someone who was banned.", [["User id", uu]], "Unban", () => api("POST", `/servers/${id}/unban`, { userId: uu.value })));
}

async function activity(body, s) {
  const { entries, names } = await api("GET", `/servers/${s.id}/activity`);
  body.append(h("div", { class: "card" }, entries.length ? h("div", { style: "overflow-x:auto" }, h("table", {},
    h("tr", {}, ["When", "Action", "Member", "By", "Details"].map((c) => h("th", {}, c))),
    entries.map((e) => h("tr", {}, h("td", { class: "small" }, when(e.time)), h("td", {}, h("span", { class: `tag ${e.type}` }, e.type)),
      h("td", {}, e.target ? who(e.target, names) : ""), h("td", {}, e.mod, e.source !== "chat" ? h("span", { class: "muted small" }, ` (${e.source})`) : ""), h("td", {}, e.reason ?? ""))))) : h("p", { class: "muted" }, "Nothing has happened yet.")));
}

async function commandsPage() {
  const view = h("div", {}, h("p", { class: "muted" }, "Loading\u2026"));
  api("GET", "/commands").then(({ prefix, labels, commands }) => {
    view.replaceChildren(h("h2", {}, "Bot commands"), h("p", { class: "muted help" }, "Type these in any channel the bot can read. In chat, ", h("code", {}, `${prefix}help`), " shows only the commands you can use."),
      ["all", "mod", "manage"].map((lvl) => h("div", { class: "card help" }, h("h3", {}, labels[lvl]),
        h("table", {}, commands.filter((c) => c.level === lvl).map((c) => h("tr", {}, h("td", {}, h("code", {}, prefix + c.usage)), h("td", { class: "muted" }, c.description)))))));
  }).catch((e) => view.replaceChildren(h("p", { class: "err" }, e.message)));
  return view;
}

// ---------------------------------------------------------------- router
async function route() {
  if (!state.user) {
    try { Object.assign(state, await api("GET", "/me")); } catch { /* not logged in */ }
  }
  if (!state.user) return root.replaceChildren(loginPage());
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  let page;
  if (parts[0] === "s" && parts[1]) page = serverPage(parts[1], parts[2] || "overview");
  else if (parts[0] === "commands") page = commandsPage();
  else page = serversPage();
  root.replaceChildren(shell(await page));
}
window.addEventListener("hashchange", route);
route();
