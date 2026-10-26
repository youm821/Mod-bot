YAPPER MODBOT
=============

Needs: Node.js 18 or newer. No npm install required (no dependencies).

START THE BOT
  1. Set your bot token, either:
       - copy .env.example to .env and edit it, OR
       - set an environment variable named TOKEN (what most hosts want)
  2. Run:   node modbot.mjs      (or: npm start)

  You should see "Logged in as ..." and "ModBot ready".

HOSTING TIPS
  - Start command: node modbot.mjs   (or npm start)
  - Put TOKEN in the host's environment variables. Don't leave a real
    token inside a file you share or upload publicly.
  - Settings and warnings are saved in modbot_data.json next to the bot.
    Some hosts wipe files on restart; pick one with persistent storage
    or your word list and warnings will reset.
  - To store the data file elsewhere, set MODBOT_DATA=/path/to/file.json

COMMANDS (type !modhelp in your server)
  Moderators:        !warn  !warnings  !timeout
  Server managers:   !ban  !unban  !clearwarns  !addword  !delword
                     !words  !links on|off  !allowdomain  !setlog

Moderators = anyone with a role that has "manage messages" or "manage server".
Managers   = server owner or anyone with a "manage server" role.

The bot also needs permission in your server to delete messages, time
people out, and ban.

SETTINGS
  Edit the numbers at the top of modbot.mjs (spam limits, warning
  escalation, command prefix).
