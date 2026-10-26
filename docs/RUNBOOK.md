# PatternNifty runbook (IS)

How to run patternnifty.com on one Mac: install, start and stop, logs, health, power, moving to
another Mac, the Etsy connection and backups. Spec section 15 is the source of truth; this file
says how.

What runs, as launchd agents of the logged-in user (`~/Library/LaunchAgents`):

| Agent | Runs | Log |
| --- | --- | --- |
| `com.is.strass` | `caffeinate -i services/strass/scripts/start.sh` (127.0.0.1:8000) | `logs/strass.log` |
| `com.is.server` | `node src/server/index.js --wait-for-strass` (127.0.0.1:3003) | `logs/server.log` |
| `com.is.tunnel` | `cloudflared tunnel --config ~/.cloudflared/config.yml run is` | `logs/tunnel.log` |
| `com.is.nightly` | `node src/ops/nightly.js` at 03:30 and at login | `logs/nightly.log` (summary), `logs/nightly-run.log` |

The first three restart when they stop (KeepAlive). The server waits until the strass service's
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

It fills the templates with this folder, your home, `which node` and `which cloudflared`, checks them
with `plutil -lint`, copies them to `~/Library/LaunchAgents` and loads them (`launchctl bootstrap
gui/$UID`). If `~/.cloudflared/config.yml` does not exist it writes it, with the id of the tunnel `is`
from `cloudflared tunnel list`: `patternnifty.com` and `www.patternnifty.com` go to
`http://127.0.0.1:3003` (never `localhost`, which can resolve to `::1`), everything else gets 404.
An existing `config.yml` is never overwritten.

Run it again after a `git pull` that changed `ops/`, or when `which node` changes (for example after
an nvm or Homebrew Node upgrade: the agents call node by its full path). Running it twice is safe;
each agent is stopped and started again.

To remove everything: `tools/uninstall-agents.sh` (stops the agents and deletes their plists; keeps
`~/.cloudflared/config.yml`, `logs/` and `data/`).

LaunchAgents run only while the user is logged in. After a restart the agents start at login, so
turn on automatic login (System Settings → Users & Groups), which needs FileVault off. With
FileVault on, the Mac waits at the unlock screen after a restart until someone logs in; for a planned
restart use `sudo fdesetup authrestart`, which unlocks once by itself.

## Start, stop, restart

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

## Logs

All in `logs/` (git-ignored, outside `public/`):

```sh
tail -f logs/server.log
tail -f logs/strass.log logs/tunnel.log
tail -n 20 logs/nightly.log                        # one summary line per night
```

The nightly job copies each non-empty `*.log` to `<name>.log.YYYY-MM-DD` and empties it; rotated files
are kept 14 days.

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

If the outside check fails while the inside one passes: `tail logs/tunnel.log`, `cloudflared tunnel
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
- never reads, deletes or moves anything in `data/archive/`.

To restore the database: stop the server, copy a backup to `data/is.sqlite`, delete
`data/is.sqlite-wal` and `data/is.sqlite-shm`, start the server.

`data/backup/` is on the same disk as the database, so it protects against mistakes, not a lost Mac.
`data/archive/` (every upload and design, kept forever) and `data/backup/` should also be covered by
Time Machine or a regular copy to the iMac. That is Alex's choice; IS makes no automatic copy.
