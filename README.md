# Yapper ModBot — Control Center

A web dashboard for the existing Yapper moderation bot. The bot and dashboard run in the same Node.js process, so the dashboard can edit the bot's AutoMod settings and read its warning/report history.

## What's included

- **Discord OAuth sign-in** using the Discord `identify` scope. Only Discord IDs listed in `DASHBOARD_ALLOWED_DISCORD_IDS` may sign in.
- **Live Yapper server list** from the bot API, rather than only showing servers that already have local settings saved.
- **Member browser** with paging and name/ID search.
- **Member editing**: change/clear nicknames and add/remove roles.
- **Moderation actions**: apply/clear timeouts (up to 28 days), kick, and ban. The Yapper API enforces the bot's permissions; give the bot appropriate roles in each server.
- **Warning history and reports** from the bot's local data.
- **AutoMod settings editor** for banned words, allowed domains, link blocking, and the mod-log channel.
- Signed HTTP-only session cookies, OAuth state validation, an allowlist, basic browser security headers, and server-side storage of all secrets.

## Important OAuth detail

The Yapper developer documentation describes bot-token authentication for its API; it does not document a Yapper user OAuth flow. This dashboard therefore uses **Discord OAuth only to identify and allowlist dashboard operators**. It does not connect a Discord account to a Yapper account. The actual server/member data and moderation requests use the Yapper bot token on the server. Only put trusted operator Discord IDs in the allowlist.

## 1. Create the Discord OAuth application

1. Open [Discord Developer Portal](https://discord.com/developers/applications) and create an application (or use an existing private dashboard application).
2. Open **OAuth2** and copy the **Client ID** and **Client Secret**. Do not put the secret in frontend HTML or GitHub.
3. In **OAuth2 → Redirects**, add the exact callback URL for your dashboard, for example:
   `https://YOUR-SERVICE.onrender.com/auth/discord/callback`
4. The dashboard only requests the `identify` scope. It does not request Discord server access or permissions.
5. Find the Discord user ID of each trusted operator (enable Developer Mode in Discord, then right-click the user's profile and choose Copy User ID). Put only approved IDs in `DASHBOARD_ALLOWED_DISCORD_IDS`, comma-separated.

## 2. Deploy on Render

### Connect the GitHub repository

1. Commit the files from this folder into the repository you want Render to deploy. Keep `modbot.mjs`, `dashboard.mjs`, `public/dashboard.html`, `package.json`, and `render.yaml` together at the repository root.
2. In Render, choose **New → Blueprint** and connect that repository, or edit the existing service to use build command `npm install` and start command `npm start`.
3. Add these environment variables in the Render service's **Environment** tab:
   - `TOKEN`: your Yapper bot token from **Yapper → Settings → Developer → your bot → Token**.
   - `DISCORD_CLIENT_ID`: your Discord OAuth application client ID.
   - `DISCORD_CLIENT_SECRET`: your Discord OAuth application secret.
   - `DASHBOARD_REDIRECT_URI`: the exact HTTPS callback URL you added to Discord, including `/auth/discord/callback`.
   - `DASHBOARD_ALLOWED_DISCORD_IDS`: one or more trusted Discord user IDs separated by commas.
   - `DASHBOARD_SECRET`: Render can generate this automatically in the Blueprint. Keep it at least 32 characters if setting it manually.
4. Save and deploy. Open the service URL and click **Continue with Discord**.
5. If login fails, verify the callback URL matches exactly in both Render and the Discord Developer Portal, and verify your Discord ID is allowlisted.

### Existing repository uses Yarn

Render may detect `yarn.lock` and run Yarn. That is okay as long as `package.json` contains the Express dependency and the start script `node modbot.mjs`. Use one package manager consistently; if the repo has `yarn.lock`, keep it and deploy with `yarn install` / `yarn start`.

## 3. Hosting recommendation

### Best simple option: one always-on Render web service

This project currently runs the bot's polling loop and the website in the same process. For the least complicated setup, use one **paid, always-on Render Web Service** for this app. A Render free web service spins down after 15 minutes without inbound traffic and its local files are ephemeral, so it is fine for a demo but not reliable for a continuously polling moderation bot or permanent warning history.

The Blueprint is set to `plan: free` so you can test it without a bill. After testing, change the service to an always-on paid instance if you want the bot to stay online. For durable data, migrate `modbot_data.json` to a database such as PostgreSQL, or use a paid persistent disk and ensure `MODBOT_DATA` points inside the mounted disk (for example `/var/data/modbot_data.json`). A disk is not available on Render's free web plan.

### Yapper's built-in bot hosting

Yapper's developer docs say verified bots can use Yapper's own bot hosting. That could be worth checking if your bot is eligible, but this project also serves a custom web dashboard, so the dashboard still needs a separate web host. The current project has not been converted to Yapper's hosted-bot package format.

## Local development

1. Use Node.js 18 or newer.
2. Copy `.env.example` to `.env` and fill in real values.
3. Run `npm install` then `npm start`.
4. Add `http://localhost:10000/auth/discord/callback` to the Discord OAuth redirect list and set that as `DASHBOARD_REDIRECT_URI` for local testing.
5. Open `http://localhost:10000`.

Never commit `.env`, `modbot_data.json`, the Yapper bot token, or the Discord OAuth client secret.

## Permissions and safety

- OAuth allowlisting decides who may enter the dashboard; it is not a substitute for the bot's permissions on Yapper.
- Yapper checks whether the bot has permission to change nicknames, roles, timeout, kick, or ban. If an action fails with `403`, update the bot's roles in that Yapper server.
- Dashboard operators in the allowlist can act in any server the bot is in. Only allow trusted moderators/owners.
- This dashboard does not grant access to servers the bot has not joined.
- The member list is paged through the Yapper API. Search filters the pages loaded so far; click **Load more** to search additional members.
- The JSON history remains local-file based in this version. For reliable long-term history, use durable storage before depending on it in production.


## Dashboard login and Yapper connection

Set these Render environment variables:

- `TOKEN`: Yapper bot token (server-side only).
- `DASHBOARD_PASSWORD`: a strong dashboard password of at least 12 characters.
- `DASHBOARD_SECRET`: random signing secret of at least 32 characters.

The dashboard password signs you into the website. After login, the dashboard calls the Yapper bot API using `TOKEN` and can show servers/members available to that bot. The official Yapper developer documentation currently documents bot-token API authentication, not a user OAuth login flow, so this project does not pretend to implement a non-existent “Login with Yapper” OAuth provider. Optional Discord OAuth can be enabled by setting `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DASHBOARD_REDIRECT_URI`, and `DASHBOARD_ALLOWED_DISCORD_IDS`.
