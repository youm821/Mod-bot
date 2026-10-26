/**
 * ModBot — Discord OAuth to Yapin OAuth migration
 * Run from the root of your Mod-bot repository:
 * node fix-yapin-oauth.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const serverFile = path.resolve("dashboard.mjs");
const htmlFile = path.resolve("public/dashboard.html");

if (!fs.existsSync(serverFile) || !fs.existsSync(htmlFile)) {
  console.error(
    "Run this script from your Mod-bot repository root. " +
    "Expected dashboard.mjs and public/dashboard.html."
  );
  process.exit(1);
}

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText);

  if (
    first < 0 ||
    source.indexOf(oldText, first + oldText.length) >= 0
  ) {
    throw new Error(
      `Could not uniquely find "${label}". No files have been changed.`
    );
  }

  return (
    source.slice(0, first) +
    newText +
    source.slice(first + oldText.length)
  );
}

let server = fs.readFileSync(serverFile, "utf8");
let html = fs.readFileSync(htmlFile, "utf8");

server = replaceOnce(
  server,
  `function encodeSession(user, secret) {
  const payload = Buffer.from(JSON.stringify({
    id: String(user.id), username: String(user.username || 'Discord user'),
    avatar: user.avatar ? \`https://cdn.discordapp.com/avatars/\${user.id}/\${user.avatar}.png?size=128\` : null,
    exp: Date.now() + SESSION_TTL,
  })).toString('base64url');
  return \`\${payload}.\${sign(payload, secret)}\`;
}`,
  `function encodeSession(user, secret) {
  const payload = Buffer.from(JSON.stringify({
    id: String(user.id),
    username: String(user.display_name || user.username || 'Yapin user'),
    avatar: user.avatar_url || null,
    exp: Date.now() + SESSION_TTL,
  })).toString('base64url');
  return \`\${payload}.\${sign(payload, secret)}\`;
}`,
  "session encoding"
);

server = replaceOnce(
  server,
  `  const clientId = process.env.DISCORD_CLIENT_ID || '';
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
  if (!token) throw new Error('Set TOKEN to your Yapper bot token.');`,
  `  const clientId = process.env.YAPPER_CLIENT_ID || '';
  const clientSecret = process.env.YAPPER_CLIENT_SECRET || '';
  const redirectUri = process.env.DASHBOARD_REDIRECT_URI || '';
  const allowedIds = new Set((process.env.DASHBOARD_ALLOWED_YAPIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const dashboardPassword = process.env.DASHBOARD_PASSWORD || '';
  const yapinOAuthEnabled = Boolean(clientId && clientSecret && redirectUri && allowedIds.size);
  const token = process.env.TOKEN || '';

  if (secret.length < 32) {
    throw new Error('DASHBOARD_SECRET must be at least 32 characters.');
  }

  if (!dashboardPassword && !yapinOAuthEnabled) {
    throw new Error('Configure Yapin OAuth and DASHBOARD_ALLOWED_YAPIN_IDS, or set DASHBOARD_PASSWORD.');
  }

  if (dashboardPassword && dashboardPassword.length < 12) {
    throw new Error('DASHBOARD_PASSWORD must be at least 12 characters.');
  }

  if (dashboardPassword) allowedIds.add('password-admin');

  if (!token) {
    throw new Error('Set TOKEN to your Yapper bot token.');
  }`,
  "OAuth configuration"
);

server = replaceOnce(
  server,
  "  const stateCookie = `Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;",
  "  const stateCookie = `Path=/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;",
  "OAuth state cookie"
);

const routesStart = server.indexOf(
  "  app.get('/auth/discord', (req, res) => {"
);
const routesEnd = server.indexOf(
  "  const loginAttempts = new Map();",
  routesStart
);

if (routesStart < 0 || routesEnd < 0) {
  throw new Error(
    "Could not locate the original Discord OAuth routes. No files changed."
  );
}

const yapinRoutes = `  app.get('/auth/yapin', (req, res) => {
    if (!yapinOAuthEnabled) {
      return res.status(503).send('Yapin OAuth is not configured.');
    }

    const state = crypto.randomBytes(24).toString('base64url');

    res.setHeader(
      'Set-Cookie',
      \`\${STATE_COOKIE}=\${encodeURIComponent(\`\${state}.\${sign(state, secret)}\`)}; \${stateCookie}\`
    );

    const url = new URL('https://www.yapin.gg/oauth/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);

    res.redirect(url.toString());
  });

  app.get('/callback', route(async (req, res) => {
    if (!yapinOAuthEnabled) {
      return res.status(503).send('Yapin OAuth is not configured.');
    }

    const stateToken = cookie(req, STATE_COOKIE);
    const [storedState, signature, ...extra] = stateToken.split('.');

    res.setHeader(
      'Set-Cookie',
      \`\${STATE_COOKIE}=; Path=/callback; HttpOnly; SameSite=Lax; Max-Age=0\${secure}\`
    );

    if (
      req.query.error ||
      !req.query.code ||
      !req.query.state ||
      extra.length ||
      !storedState ||
      !safeEqual(String(req.query.state), storedState) ||
      !safeEqual(signature || '', sign(storedState, secret))
    ) {
      return res.status(400).send(
        'Yapin sign-in was cancelled or failed validation. Return to the dashboard and try again.'
      );
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(req.query.code),
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const tokenRes = await fetch(
      'https://www.yapin.gg/api/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15000),
      }
    );

    const tokenData = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Yapin token exchange failed:', tokenRes.status);
      return res.status(502).send(
        'Yapin sign-in failed. Check your OAuth credentials and redirect URI.'
      );
    }

    const userRes = await fetch(
      'https://www.yapin.gg/api/oauth/me',
      {
        headers: {
          Authorization: \`Bearer \${tokenData.access_token}\`,
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    const user = await userRes.json().catch(() => ({}));

    if (!userRes.ok || !user.id) {
      return res.status(502).send(
        'Could not read your Yapin profile. Please try again.'
      );
    }

    if (!allowedIds.has(String(user.id))) {
      return res.status(403).send(
        'This Yapin account is not authorized. Add your user ID to DASHBOARD_ALLOWED_YAPIN_IDS.'
      );
    }

    res.setHeader(
      'Set-Cookie',
      \`\${COOKIE}=\${encodeURIComponent(encodeSession(user, secret))}; \${sessionCookie}\`
    );

    res.redirect('/');
  }));

`;

server =
  server.slice(0, routesStart) +
  yapinRoutes +
  server.slice(routesEnd);

server = replaceOnce(
  server,
  "    res.json({ authenticated: !!user, user: user ? { id: user.id, username: user.username, avatar: user.avatar } : null, loginOptions: { password: Boolean(dashboardPassword), discord: discordOAuthEnabled } });",
  "    res.json({ authenticated: !!user, user: user ? { id: user.id, username: user.username, avatar: user.avatar } : null, loginOptions: { password: Boolean(dashboardPassword), yapin: yapinOAuthEnabled } });",
  "login options"
);

html = replaceOnce(
  html,
  `<div id="discordLoginWrap" class="hidden"><div class="divider"></div><button id="oauthLogin" class="oauth-btn" onclick="location.href='/auth/discord'"><span style="font-size:19px">◉</span> Continue with Discord</button></div><div class="notice">Yapper does not currently document user OAuth sign-in.
The dashboard password signs you into this website; the bot connects to Yapper securely using the server-side TOKEN environment variable.</div>`,
  `<div id="yapinLoginWrap" class="hidden"><div class="divider"></div><button id="oauthLogin" class="oauth-btn" type="button" onclick="location.href='/auth/yapin'"><span style="font-size:19px">◉</span> Login with Yapin’</button></div><div class="notice">Sign in with your Yapin’ account. The bot connects to Yapper securely using the server-side TOKEN environment variable.</div>`,
  "dashboard login HTML"
);

html = html.replaceAll(
  "$('#discordLoginWrap').classList.toggle('hidden', !me.loginOptions?.discord)",
  "$('#yapinLoginWrap').classList.toggle('hidden', !me.loginOptions?.yapin)"
);

html = html.replaceAll(
  '$("#discordLoginWrap").classList.toggle("hidden", !me.loginOptions?.discord)',
  '$("#yapinLoginWrap").classList.toggle("hidden", !me.loginOptions?.yapin)'
);

if (
  html.includes("discordLoginWrap") ||
  html.includes("/auth/discord") ||
  html.includes("me.loginOptions?.discord")
) {
  throw new Error(
    "Some Discord login references remain in dashboard.html. No files changed."
  );
}

if (
  server.includes("DISCORD_CLIENT_ID") ||
  server.includes("discordOAuthEnabled") ||
  server.includes("/auth/discord")
) {
  throw new Error(
    "Some Discord OAuth references remain in dashboard.mjs. No files changed."
  );
}

const tempFile = path.resolve(".dashboard-yapin-check.mjs");
fs.writeFileSync(tempFile, server);

try {
  const result = spawnSync(
    process.execPath,
    ["--check", tempFile],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Syntax check failed.");
  }
} finally {
  fs.rmSync(tempFile, { force: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

fs.copyFileSync(serverFile, `${serverFile}.${timestamp}.bak`);
fs.copyFileSync(htmlFile, `${htmlFile}.${timestamp}.bak`);

fs.writeFileSync(serverFile, server);
fs.writeFileSync(htmlFile, html);

console.log("Yapin OAuth migration completed.");
console.log("Backups created for both modified files.");
console.log("Configure the following environment variables in Render:");
console.log("YAPPER_CLIENT_ID");
console.log("YAPPER_CLIENT_SECRET");
console.log("DASHBOARD_REDIRECT_URI");
console.log("DASHBOARD_ALLOWED_YAPIN_IDS");
console.log("DASHBOARD_SECRET");
console.log("TOKEN");