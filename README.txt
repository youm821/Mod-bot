YAPPER MODBOT + DASHBOARD
=========================

One Node.js service (18+, no npm packages) that runs the bot AND a web dashboard.
Log in with "Login with Yapin'" and manage auto-mod, warnings and moderation from the browser.

FILES
  server.mjs        starts the dashboard and the bot (this is what Render runs)
  modbot.mjs        the bot (can still be run alone: npm run bot-only)
  public/           the dashboard pages
  render.yaml       Render Blueprint (service + persistent disk)
  .env.example      the settings you need

SET UP LOGIN WITH YAPIN'
  1. After the first deploy, note your site's address, e.g. https://yapper-modbot.onrender.com
  2. In Yapin': Settings > Developer > Login with Yapin' > make an app.
     (Yapin' says this is in testing, so not every account can make one yet.)
  3. Add this redirect URL, exactly:   https://YOUR-SITE/auth/callback
  4. Copy the client ID and client secret into Render as YAPIN_CLIENT_ID and YAPIN_CLIENT_SECRET.

DEPLOY ON RENDER
  1. Put these files in a GitHub repo (the .gitignore keeps .env and your data out of it).
  2. Render > New > Blueprint > pick the repo. It reads render.yaml.
  3. Fill in TOKEN, YAPIN_CLIENT_ID, YAPIN_CLIENT_SECRET (and optionally OWNER_IDS).
  4. Deploy. Logs should show "Logged in as ..." and "ModBot ready".

  Why a paid plan? The bot has to listen all day, and free Render services go to sleep.
  The disk (mounted at /var/data) keeps modbot_data.json across restarts. Without a disk,
  warnings and settings reset on every deploy.

WHO CAN USE THE DASHBOARD
  Server owner / "manage server" role : everything
  "manage messages" role               : view, warn, remove warnings, timeout
  OWNER_IDS (your Yapin user id)       : manage every server the bot is in
  A server appears once the bot has seen a message there.

RUN LOCALLY
  Copy .env.example to .env, fill it in, run: npm start
  Use http://localhost:3000/auth/callback as a redirect URL for testing.

CHAT COMMANDS (type !help in your server)
  Everyone:   !help [command]  !ping  !about  !serverinfo  !userinfo  !mywarnings
  Moderators: !warn  !warnings  !unwarn  !timeout  !automod  !dashboard  !modhelp
  Managers:   !ban  !unban  !clearwarns  !addword  !delword  !words
              !links on|off  !allowdomain  !setlog
