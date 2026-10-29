# PatternNifty runbook (IS)

How to run patternnifty.com on one Mac: install, start and stop, logs, health, power, moving to
another Mac, the Etsy connection and backups. Spec section 15 is the source of truth; this file
says how.

What runs, as launchd agents of the logged-in user (`~/Library/LaunchAgents`):

| Agent | Runs | Log |
| --- | --- | --- |
| `com.is.strass` | `caffeinate -i services/strass/scripts/start.sh` (127.0.0.1:8000) | `strass.log` |
| `com.is.server` | `node src/server/index.js --wait-for-strass` (127.0.0.1:3003) | `server.log` |
| `com.is.tunnel` | `cloudflared tunnel --config ~/.cloudflared/config.yml run is` | `tunnel.log` |
| `com.is.nightly` | `node src/ops/nightly.js` at 03:30 and at login | `nightly.log` (summary), `nightly-run.log` |
| `com.is.control` | `node src/control/index.js`: the control panel (127.0.0.1:3010) | `control.log` |

The logs are in `~/Library/Logs/PatternNifty` (see Logs below).

The first three and the control panel restart when they stop (KeepAlive). The server waits until the strass service's
`/health` says its models are loaded; after 5 minutes without that it exits with an error and launchd
starts it again 10 seconds later. `caffeinate -i` keeps the Mac from idle-sleeping while the strass
service runs.

The templates are in `ops/launchd/` and `ops/cloudflared/`. Commands below are run in the repository
folder (`cd ~/Documents/ImageToStrass`).

## Install

Needs: Node 20+, `brew install cloudflared`, Python 3.12 with `services/strass/scripts/setup_mac.sh`
done, `npm ci` done, `.env` in place, and the named tunnel `is` (made with `cloudflared tunnel
create is`, routed with `cloudflared tunnel route dns is patternnifty.com` and `... www.patternnifty.com`).

```sh
tools/install-agents.sh
```

It fills the templates with this folder, your home, `which node`, `which cloudflared` and the log
folder (`IS_LOG_DIR`, else `~/Library/Logs/PatternNifty`, created if missing), checks them
with `plutil -lint`, copies them to `~/Library/LaunchAgents` and loads them (`launchctl bootstrap
gui/$UID`). If `~/.cloudflared/config.yml` does not exist it writes it, with the id of the tunnel `is`
from `cloudflared tunnel list`: `patternnifty.com` and `www.patternnifty.com` go to
`http://127.0.0.1:3003` (never `localhost`, which can resolve to `::1`), everything else gets 404.
An existing `config.yml` is never overwritten. At the end it prints the log folder and the control
panel's address, http://127.0.0.1:3010.

Run it again after a `git pull` that changed `ops/`, or when `which node` changes (for example after
an nvm or Homebrew Node upgrade: the agents call node by its full path). Running it twice is safe;
each agent is stopped and started again.

To remove everything: `tools/uninstall-agents.sh` (stops the agents and deletes their plists; keeps
`~/.cloudflared/config.yml`, the log folder and `data/`).

LaunchAgents run only while the user is logged in. After a restart the agents start at login, so
turn on automatic login (System Settings → Users & Groups), which needs FileVault off. With
FileVault on, the Mac waits at the unlock screen after a restart until someone logs in; for a planned
restart use `sudo fdesetup authrestart`, which unlocks once by itself.

## Start, stop, restart

The simplest way is the control panel (below). From Terminal:

```sh
U=gui/$(id -u)
launchctl list | grep com.is                       # running agents: PID, last exit status, label
launchctl print $U/com.is.server | grep -E "state|pid|last exit"

launchctl kickstart -k $U/com.is.server            # restart one agent (also com.is.strass, com.is.tunnel)
launchctl bootout $U/com.is.server                 # stop one agent (stays stopped until bootstrap or login)
launchctl bootstrap $U ~/Library/LaunchAgents/com.is.server.plist   # start it again
launchctl kickstart $U/com.is.nightly              # run the nightly job now (or: node src/ops/nightly.js)
```

Stop everything: `tools/uninstall-agents.sh`. Start everything: `tools/install-agents.sh`.

After changing `.env`, restart the server (`launchctl kickstart -k $U/com.is.server`); `REMBG_MODEL`
is read by the strass service, so restart `com.is.strass` for that one.

## Control panel

**http://127.0.0.1:3010** (on this Mac only; another port with `IS_CONTROL_PORT` in `.env`, then run
`tools/install-agents.sh` again). Its own agent, `com.is.control`, so it works while the website
server is down. The tunnel never reaches it: through Cloudflare, or with any `Host` other than
`127.0.0.1`/`localhost`, it answers 404. It reloads itself every 10 s; tick **Pause auto-refresh**
to stop that while reading. Screenshot: `docs/control-panel.png`.

It only reads (the database read-only, the poller's state, the logs, `launchctl list`, `ps`,
`pmset -g`); the only changes are the buttons. No `.env` value is ever shown, only "set" or "missing"
for each key.

**Agents.** For each agent: state, PID, uptime, last exit code, CPU and memory (with child
processes, so strass shows caffeinate plus Python), and buttons:

- **Start**: `launchctl bootstrap` of the plist in `~/Library/LaunchAgents` (or `kickstart` if it is
  loaded but not running).
- **Stop**: `launchctl bootout`. It stays stopped until Start, the next login or the next
  `install-agents.sh`. Asks first.
- **Restart**: `launchctl kickstart -k`. Asks first.
- **Run now** (nightly): `launchctl kickstart`. Its row shows the last summary line of `nightly.log`.

The control panel has Restart only; it cannot stop itself (use `tools/uninstall-agents.sh`). If a
button's page says "the page had expired", the panel was restarted: reload it and click again.

| What it shows | Meaning | What to do |
| --- | --- | --- |
| not loaded (stopped) | Stopped with Stop or `bootout`, or never installed | Start; if it is missing from `~/Library/LaunchAgents`, run `tools/install-agents.sh` |
| loaded, not running | It exited and launchd has not started it again (yet) | Look at its log (Logs below); Restart or Start |
| last exit 78 | macOS blocked the start | "An agent shows exit code 78" below |
| last exit -15 | Stopped by a signal (Restart, Stop, a shutdown) | Nothing, unless it is not running |
| other exit code | It crashed or exited with an error | Show its log; the last lines say why |
| nightly "last run failed", or `errors` not 0 in its summary | A nightly step failed | `nightly-run.log`; Run now after fixing |

**Health.**

- *Website*: the server's `/health` from the Mac, with its time and the db / strass / etsy parts.
  "down: no connection" = the server is not running (see Agents). "answers 503" = it runs but a part
  is not ok (strass not ready, or the Etsy token missing or older than 90 days).
- *Strass*: its `/health` and whether port 8000 listens. "models loading" for about a minute after a
  start is normal. Not listening while the agent runs: `strass.log`.
- *Public*: `https://patternnifty.com/health` fetched from this Mac through Cloudflare (at most every
  30 s): proves domain, tunnel and server work end to end. Website ok but Public not: the tunnel
  (next line, `tunnel.log`, `~/.cloudflared/config.yml`); also not when this Mac is offline.
- *Tunnel*: cloudflared's connections to Cloudflare (from its local metrics, usually 4) and their
  locations. "no connection": the Mac's internet or Cloudflare; Restart the tunnel. "metrics did not
  answer": cloudflared runs but could not be asked; trust the Public line.

**Business** (read-only). Queue and the running design's stage; today and the last 7 days: designs
done, failed, declined, automatic re-runs, codes created, codes paid, downloads.

- *Orders without a code* above 0: a buyer paid without a usable code; open `/admin` (the link) and
  match it by hand.
- *Etsy token*: amber from 80 days, red at 90: reconnect Etsy (below). *Last poll* failed or *Last
  poll error*: Etsy or the internet; it retries every 3 minutes, and `/admin` has Poll now.
- *Listing ids empty*: `IS_ETSY_LISTING_IDS` is not set in `.env`, so no order is stored or paid;
  set it and restart the server.
- *Daily design cap*: designs counted today (since midnight in Paris, as the server counts them, spec
  13) of `IS_DAILY_DESIGN_CAP`. At the cap every new design answers busy until midnight in Paris;
  raise the cap in `.env` and restart the server if that is wanted.

**Machine.** Uptime; power (red on battery: the Mac will sleep, plug it in); sleep settings (red when
`sleep` on the adapter is not 0: see Power below); macOS and node versions.

**Storage.** Free disk (amber under 15 %, red under 5 % or 10 GB: clear space; never delete in
`data/archive/` by hand except for a privacy request, below); the sizes of `data/archive`, `data/delivery`, `data/backup` and the log folder (at
most once a minute); the last database backup (red when older than 36 hours: the nightly job did not
run, see its row).

**Logs.** Each file in the log folder with its size and last change; **Show last 100 lines** shows
the end as plain text, lines with error, warn, traceback, ERR or WRN highlighted.

## Logs

All in `~/Library/Logs/PatternNifty`, outside the repository and never served. They are also
visible in the Console app (Log Reports). Another folder can be set with `IS_LOG_DIR` in `.env` (an
absolute path outside the repository; run `tools/install-agents.sh` again after changing it).

```sh
L=~/Library/Logs/PatternNifty
tail -f $L/server.log
tail -f $L/strass.log $L/tunnel.log
tail -n 20 $L/nightly.log
```

`nightly.log` has one summary line per night. The nightly job copies each non-empty `*.log` there to
`<name>.log.YYYY-MM-DD` and empties it; rotated files are kept 30 days (the privacy policy says logs
are kept 30 days).

Why not in the repository: the repository lives in `~/Documents`, and macOS privacy rules (TCC) do
not let launchd open a file in `~/Documents` for an agent. Before PN-03 the strass agent's log was
`logs/strass.log` in the repository: launchd could not open it, the agent exited with code 78 and
strass never started. The repository's old `logs/` folder is no longer written to (it stays
git-ignored and is left as it is).

### An agent shows exit code 78

`launchctl list | grep com.is` shows `78` in the second column (or `last exit code = 78` in
`launchctl print`): launchd could not start the job, usually because macOS blocked a file it needs.
Look for the block in the system log right after it happened:

```sh
log show --last 5m --style compact --predicate 'eventMessage CONTAINS[c] "com.is" OR eventMessage CONTAINS[c] "Operation not permitted"'
```

Lines like `xpcproxy deny file-read-data .../Documents/...` or `posix_spawn(/usr/bin/caffeinate)
Operation not permitted` name the file that was blocked. Check that the plists in
`~/Library/LaunchAgents` point their `StandardOutPath` and `StandardErrorPath` at
`~/Library/Logs/PatternNifty` (run `tools/install-agents.sh` again if not).

During the PN-03 investigation `/usr/bin/caffeinate` was also given Full Disk Access (System Settings →
Privacy & Security → Full Disk Access). With the logs outside `~/Documents` that may not be needed.
If a future macOS blocks the strass script itself (`services/strass/scripts/start.sh`, which is in
`~/Documents`), that Full Disk Access entry for `/usr/bin/caffeinate` is the first thing to check.

## Health

From the Mac:

```sh
curl -s http://127.0.0.1:3003/health | python3 -m json.tool
curl -s http://127.0.0.1:8000/health                # the strass service on its own
```

`/health` answers 200 when the database, the strass service (models loaded) and the Etsy connection
(refresh token younger than 90 days) are all fine, else 503; `etsy.tokenAgeHours` shows the token age.
The tunnel cannot be checked from inside. From outside (a phone on mobile data, or another network):

```sh
curl -s https://patternnifty.com/health             # same answer as above: the tunnel works
curl -sI https://www.patternnifty.com/download?x=1  # 301, location: https://patternnifty.com/download?x=1
curl -s -o /dev/null -w "%{http_code}\n" https://patternnifty.com/admin   # 404: admin is Mac-only
```

If the outside check fails while the inside one passes: `tail ~/Library/Logs/PatternNifty/tunnel.log`, `cloudflared tunnel
info is` (shows connections), and check `~/.cloudflared/config.yml`.

`/admin` (http://127.0.0.1:3003/admin, on the Mac only, or with the `x-admin-token` header) shows the
poller, unmatched orders and the Etsy token age.

## Power: an always-on laptop

The Mac must not sleep. On the power adapter (`-c`), in Terminal (asks for your password; no IS script
runs sudo):

```sh
sudo pmset -c sleep 0          # never sleep on the adapter (System Settings → Battery → Options:
                               #   "Prevent automatic sleeping on power adapter when the display is off")
sudo pmset -c disksleep 0
sudo pmset -c displaysleep 10  # the display may sleep
sudo pmset -c tcpkeepalive 1
pmset -g                       # check: sleep 0 under "AC Power"
```

- Keep it on the power adapter. On battery it sleeps as usual (`-b` settings untouched).
- Closing the lid sleeps a MacBook even with `sleep 0`. Lid-closed operation (clamshell) needs the
  power adapter and an external display (and keyboard/mouse) attached. Simplest: leave the lid open.
- `caffeinate -i` in `com.is.strass` prevents idle sleep while the strass service runs, but not lid
  sleep or sleep on battery.

When the Mac was off or asleep: on wake or login the agents start again, the Etsy poller catches up
from its last good run (`min_last_modified`, spec 11.3), and the nightly job runs once at login.

## Only one Mac at a time

The server and the Etsy poller must run on one Mac only, and two `cloudflared tunnel run is` would
share the traffic between both Macs. Before starting on another Mac, stop everything on this one:

```sh
tools/uninstall-agents.sh
launchctl list | grep com.is                      # nothing
curl -s http://127.0.0.1:3003/health || echo stopped
pgrep -fl "cloudflared|src/server/index.js|uvicorn" # nothing (stop a hand-started one with Ctrl-C)
```

## Moving to the iMac

1. On the laptop: stop everything (above).
2. On the iMac:
   ```sh
   cd ~/Documents && git clone https://github.com/alexdruk/ImageToStrass.git   # or: git pull
   cd ImageToStrass && npm ci
   brew install cloudflared
   services/strass/scripts/setup_mac.sh        # without --with-dlib-tests
   rm -f services/strass/models/shape_predictor_68_face_landmarks.dat   # never in production
   ```
3. Copy from the laptop (with the laptop's server stopped):
   - `.env` as it is. `TOKEN_ENCRYPTION_KEY` must stay the same, or `data/etsy-tokens.enc` cannot be
     read and Etsy must be reconnected.
   - `data/` (with `rsync -a`, so `is.sqlite`, `etsy-tokens.enc`, `etsy-shop.json`,
     `etsy-poller.json`, `ip-hash.key`, `delivery/`, `backup/` and `archive/` move together).
   - `~/.cloudflared/`: `<tunnel id>.json` (the tunnel credentials), `cert.pem` (needed by
     `cloudflared tunnel list`, which the install script runs; or run `cloudflared tunnel login`) and
     `config.yml` (else the install script writes it).
4. On the iMac: `tools/install-agents.sh`, then the health checks above, inside and outside.
5. Power settings as above (an iMac has no lid or battery: `sudo pmset -a sleep 0 disksleep 0`).

The Etsy callback stays `https://patternnifty.com/oauth/callback`, so with the same tokens and key no
reconnect is needed.

## Reconnect Etsy (new callback)

Needed once when the callback moves from a quick tunnel to `patternnifty.com`, after a lost
`TOKEN_ENCRYPTION_KEY`, or when `/health` shows the refresh token near 90 days.

1. In the Etsy developer app, set the callback URL to `https://patternnifty.com/oauth/callback`.
2. In `.env`, `ETSY_REDIRECT_URI=https://patternnifty.com/oauth/callback` (exactly the same string),
   then `launchctl kickstart -k gui/$(id -u)/com.is.server`.
3. On the Mac, open http://127.0.0.1:3003/admin and click **Connect Etsy**. Etsy sends the browser back
   through the tunnel; the page says "Etsy connected" with the shop name.
4. `/health` shows `etsy.ok: true` and a small `tokenAgeHours`. See also `docs/IS-06-connect-shop.md`.

## Backups

The nightly job (03:30):

- copies `data/is.sqlite` with SQLite's online backup to `data/backup/is-YYYY-MM-DD.sqlite` and keeps
  the last 30;
- deletes delivery ZIPs (`data/delivery/<code>/`) 30 days after payment and marks those codes expired;
- keeping data (spec D7, PN-07): deletes a code's whole `data/archive/<code>/` folder (uploads,
  prepared images, AI images, layouts, attempt files) 30 days after its last activity when it was
  never paid (`IS_KEEP_UNPAID_DAYS`), and 30 days after payment when it was paid or refunded
  (`IS_KEEP_PAID_DAYS`, the same day as its ZIP). The code row and its Etsy orders stay in the
  database, without images. Only folders named after a code of the database are deleted: nothing
  else in `data/archive/`, and never `data/listing/` or `data/private-portraits/`;
- clears hashed IPs older than 24 h (the server does it every hour too);
- writes one summary line with counts only (`files deleted N (unpaid A, paid B)`, no codes) to
  `nightly.log`; the control panel's nightly row shows it.

To restore the database: stop the server, copy a backup to `data/is.sqlite`, delete
`data/is.sqlite-wal` and `data/is.sqlite-shm`, start the server.

`data/backup/` is on the same disk as the database, so it protects against mistakes, not a lost Mac.
`data/backup/` should also be covered by Time Machine or a regular copy to the iMac. That is Alex's
choice; IS makes no automatic copy. `data/archive/` holds buyers' photos, which the privacy policy
promises to delete after 30 days: a Time Machine or other copy would keep them longer, so exclude it
(`tmutil addexclusion data/archive`) or delete its copies on the same schedule.

## Privacy requests

A buyer emails `IS_CONTACT_EMAIL` with a code (answer within one month, spec 14). To delete their
data before the 30 days (no agent needs to stop), delete `data/archive/<code>/` and `data/delivery/<code>/`, then
set the code's `files_deleted_at` so nothing is written there again:

```
sqlite3 data/is.sqlite "UPDATE codes SET files_deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = 'PN-XXXX-XXXX'"
```

## Legal details

The privacy, terms, contact and legal notice pages read `IS_LEGAL_NAME`, `IS_LEGAL_ADDRESS`,
`IS_LEGAL_REGISTRATION` (may stay empty), `IS_LEGAL_COUNTRY`, `IS_LEGAL_LAW` and `IS_CONTACT_EMAIL`
from `.env` at start: restart the server after changing them, and the control panel to clear its
"Legal details missing in .env" warning. The texts are in `public/legal.js`; after changing them run
`node tools/make-legal-docs.mjs` and `node tools/shoot-legal.mjs`.
