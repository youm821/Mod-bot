# Yapper ModBot + Web Dashboard (Render)

This starter keeps the existing Node.js Yapper bot and serves a password-protected dashboard in the **same process**, so dashboard setting changes update the same in-memory config the bot uses. It adds case IDs to new warnings while preserving older warning entries.

## Deploy on Render

1. Put the contents of this folder in your GitHub repository (include `modbot.mjs`, `dashboard.mjs`, `public/`, `package.json`, and `render.yaml`).
2. In Render choose **New → Blueprint** and connect the repo, or create a Web Service with build command `npm install` and start command `npm start`.
3. Set these environment variables in Render:
   - `TOKEN`: your Yapper bot token.
   - `DASHBOARD_PASSWORD`: a strong password, at least 12 characters.
   - `DASHBOARD_SECRET`: a random secret at least 32 characters long. If using the Blueprint, Render generates one.
4. Deploy. Open the `onrender.com` URL and sign in with `DASHBOARD_PASSWORD`.
5. Check `/healthz` if Render reports a failed health check.

## Local run

Use Node.js 18+. Run `npm install`, then set `TOKEN`, `DASHBOARD_PASSWORD`, and `DASHBOARD_SECRET` in your environment or `.env`. Run `npm start` and open `http://localhost:10000` (or the `PORT` you set).

Example local `.env` (never commit this file):

```env
TOKEN=your_yapper_bot_token
DASHBOARD_PASSWORD=replace-with-a-long-unique-password
DASHBOARD_SECRET=replace-with-a-random-secret-at-least-32-characters
PORT=10000
```

## What is included

- Authenticated dashboard login with an HTTP-only, same-site cookie.
- Overview of servers represented in the bot's local data, warning totals, and report totals.
- Warning history table with case IDs. New warnings receive IDs such as `CASE-000001`; old warnings display a generated legacy label.
- Reports list.
- Settings editor for banned words, link blocking, allowed domains, and mod-log channel.
- Existing bot commands and polling loop remain in `modbot.mjs`.

## Current limits / important notes

- This is the first dashboard slice. It does not yet execute moderation actions from the web UI or provide an appeal-review workflow.
- Server entries appear after the bot has saved data for that server (for example, using `!setlog` or a moderation/configuration command).
- The existing bot uses a JSON file. Render's free service filesystem is ephemeral, so moderation history/settings can be lost when the instance is replaced or restarted. For durable production data, migrate storage to PostgreSQL or another persistent database before relying on it.
- The Yapper bot API must allow the bot token's current permissions. Dashboard login does not replace Yapper server permissions.
- Do not publish `.env`, `modbot_data.json`, or your bot token. Use Render environment variables for secrets.
