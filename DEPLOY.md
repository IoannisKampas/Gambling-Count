# Deploying to an Ubuntu VPS

The app was written on Windows and assumed it in three places. Those are now ported
(see *What changed* at the end), so the code runs as-is on Linux. What follows is the
part that is not code: what to install, what to copy, and the one thing that cannot be
copied at all.

Read §3 before anything else — it is the step people skip and then spend an evening on.

---

## 1. The shape of it

Three processes, in this order:

```
Xvfb :99            a virtual X display, because the browser must run HEADED
  └─ Chrome         launched on demand by the app to mint session tokens
node server.mjs     the monitor itself, bound to 127.0.0.1:3001
nginx               TLS + a password, the only auth in the whole stack
```

Chrome runs headed rather than `--headless=new` because the operator's launch chain
answers headless with a 403 (`FINDINGS.md §6h`). That is the entire reason Xvfb is here.
`SESSION_HEADLESS=1` skips the display requirement and will fail to mint; it exists only
for the day the operator stops blocking headless.

---

## 2. One-time host setup

Run as a user with sudo. The app itself gets its own unprivileged user, `bj` — do not
run it as root, or Chrome's sandbox has to be disabled to start at all.

```bash
# service user
sudo adduser --disabled-password --gecos "" bj

# node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# chrome + the virtual display + fonts (missing fonts render results as boxes)
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
sudo apt install -y xvfb x11vnc fonts-liberation fonts-noto-color-emoji

# proxy + certs
sudo apt install -y nginx apache2-utils certbot python3-certbot-nginx
```

**Swap.** Chrome on a 1GB VPS will be OOM-killed mid-mint, which surfaces as a token
that never arrives. If the box has under 2GB:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 3. The files — and the profile you must NOT copy

Copy the project to `/home/bj/Blackjack-Counting`, but **leave four things behind**:

| Do not copy | Why |
|---|---|
| `.chrome-profile/` | **Chrome encrypts its cookie store with an OS-bound key.** A profile from Windows carries cookies Linux Chrome cannot decrypt, so you land on a profile that looks signed in and is not. Sign in again on the VPS (§4). |
| `node_modules/` | Built for Windows. Run `npm ci` instead. |
| `scraper.log` | ~20MB of local history, no value on the new host. |
| `recordings/` | Same. |

```bash
sudo chown -R bj:bj /home/bj/Blackjack-Counting
sudo -u bj -H bash -c 'cd ~/Blackjack-Counting && rm -rf .chrome-profile node_modules scraper.log && npm ci'
```

**Credentials.** You said the box is yours alone, so the plain file is fine and the app
now reads it directly — no import step, and editing it takes effect on restart:

```bash
sudo -u bj -H tee /home/bj/Blackjack-Counting/data/credentials.json >/dev/null <<'EOF'
{ "stoiximan": { "username": "you@example.com", "password": "…" } }
EOF
sudo chmod 600 /home/bj/Blackjack-Counting/data/credentials.json
```

That file now takes precedence over the encrypted store, so it is the single place a
password lives. (If you ever want it off disk, `npm run creds` imports and shreds it —
same as on Windows. Session *tokens* are encrypted either way, under a key the app
generates itself at `~/.local/share/plfa-secrets/`; nothing for you to manage.)

---

## 4. Sign in once, over VNC

The profile has to be signed in by hand the first time, and the sign-in has to happen in
the same profile directory the server will later use.

Start the display, then a VNC server bound to loopback:

```bash
sudo cp ~/Blackjack-Counting/deploy/xvfb.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now xvfb

sudo -u bj -H bash -c 'DISPLAY=:99 x11vnc -display :99 -localhost -rfbport 5900 -nopw -forever' &
```

From your own machine, tunnel to it — `-localhost` means it is not exposed to the
internet, only through this tunnel:

```bash
ssh -L 5900:localhost:5900 you@your-vps
```

Point any VNC viewer at `localhost:5900`, then on the VPS:

```bash
sudo -u bj -H bash -c 'cd ~/Blackjack-Counting && DISPLAY=:99 node tools/login.mjs stoiximan'
```

A Chrome window appears in the VNC session. Sign in, clear any consent banners, confirm
a live table loads, close the window. Kill x11vnc when you are done — leave it running
and you have an unauthenticated remote desktop on the box.

---

## 5. Run it as a service

```bash
sudo cp ~/Blackjack-Counting/deploy/blackjack-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blackjack-monitor
journalctl -u blackjack-monitor -f
```

Expect `server started on :3001`, the table count, and within a minute or so a mint
logging a masked token. Both unit files are commented where a setting is load-bearing —
in particular neither uses `PrivateTmp`, because the X socket lives in `/tmp/.X11-unix`
and a private `/tmp` hides the display from Chrome.

---

## 6. Expose it

```bash
sudo cp ~/Blackjack-Counting/deploy/nginx.conf /etc/nginx/sites-available/bj-monitor
sudo ln -s /etc/nginx/sites-available/bj-monitor /etc/nginx/sites-enabled/
# edit server_name to your hostname first
sudo htpasswd -c /etc/nginx/.htpasswd yourname
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d monitor.example.com

sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

`ufw` matters more than usual here: the service binds loopback, but Chrome's debugging
port (9222) is a **full remote-control interface with no authentication**. It is on
loopback too, and it must stay that way.

The nginx config disables `proxy_buffering` and raises `proxy_read_timeout`. Both are
required — the wall is driven by Server-Sent Events on `/events`, and with nginx's
defaults the page loads fine and then never updates, which looks like an app bug.

---

## 7. When something is wrong

| Symptom | Cause |
|---|---|
| `no DISPLAY is set…` | The app was started outside systemd. `DISPLAY=:99 node server.mjs`, or use the unit. |
| `Chrome did not expose a CDP endpoint` | Chrome died on launch. Reproduce it directly: `sudo -u bj -H DISPLAY=:99 google-chrome --version`, then check `/dev/shm` size and free memory. |
| Mint fails, `signed out` | The profile's login lapsed, or you copied `.chrome-profile` from Windows. Redo §4. |
| Page loads, never updates | nginx buffering — §6. |
| `profile appears to be in use` | An orphaned Chrome holds the lock: `sudo -u bj pkill -f user-data-dir=.*Blackjack`. |
| Nothing in the store after a restore | The secret store's key file was not restored with it. Back up `~/.local/share/plfa-secrets/` as a unit, or set `PLFA_SECRET_KEY`. |

**The risk that is not a bug:** the mint chain exists to get past Cloudflare and
DataDome, and datacenter IP ranges are scored far harder than a residential connection.
The same profile and credentials that work from home may be challenged from the VPS. If
mints fail there while succeeding locally, that is the cause, and no amount of
configuration fixes it — it needs a residential egress or a different approach entirely.
The account limits from `CLAUDE_HANDOFF.md` are unchanged by hosting: six concurrent
Pragmatic sockets per account, one Playtech lobby session per account.

---

## 8. Day to day

### Running it

systemd owns the process. Never `npm run dev` over SSH - it dies with the session, does
not come back after a reboot, and does not restart when Chrome takes it down mid-mint.

```bash
sudo systemctl status blackjack-monitor     # is it up, and since when
sudo systemctl restart blackjack-monitor    # after a config or code change
journalctl -u blackjack-monitor -f          # live log
journalctl -u blackjack-monitor -S -1h      # the last hour, after something went wrong
```

To watch it in the foreground while debugging, stop the service first so two copies do
not fight over the profile and the port:

```bash
sudo systemctl stop blackjack-monitor
sudo -u bj -H bash -c 'cd ~/Blackjack-Counting && DISPLAY=:99 node server.mjs'
```

**One collision to know about.** `tools/login.mjs` always launches its own Chrome, and
Chrome refuses a second instance on the same `--user-data-dir`. Stop the service before
an interactive login. The other tools (`pt-mint`, `auto-login`) attach to a Chrome that
is already running and are safe to use while the service is up.

### Shipping changes from the laptop

Edit on Windows, push to the VPS, and let a hook deploy it. No GitHub account needed and
the reverse-engineering notes stay off third-party infrastructure - the bare repo lives
on your own box, and `ssh` is the only transport involved.

**On the VPS, once:**

```bash
sudo -u bj -H git init --bare /home/bj/monitor.git
sudo -u bj -H cp /home/bj/Blackjack-Counting/deploy/post-receive /home/bj/monitor.git/hooks/
sudo -u bj -H chmod +x /home/bj/monitor.git/hooks/post-receive

# let the hook restart the service without a password, and nothing else
echo 'bj ALL=(root) NOPASSWD: /bin/systemctl restart blackjack-monitor'   | sudo tee /etc/sudoers.d/bj-monitor
sudo chmod 440 /etc/sudoers.d/bj-monitor
sudo visudo -c
```

**On Windows, once:**

```bash
cd ~/Blackjack-Counting
git init -b main
git add -A && git commit -m "Windows-only assumptions ported to Linux"
git remote add production bj@your-vps:/home/bj/monitor.git
```

**Every change after that:**

```bash
git add -A && git commit -m "what changed"
git push production main
```

The hook checks out, reinstalls deps only if `package-lock.json` moved, and restarts the
service - the push prints `deployed <sha> -> restarted` when it lands. Because the first
push overwrites the files you copied by hand, the VPS and the laptop are in sync from
that point on, and `git log` on either side is the deploy history.

Nothing secret travels with a push: `data/credentials.json`, `.chrome-profile/`, the
lobby caches and the logs are all ignored, and `checkout -f` leaves ignored files alone.
Which also means the VPS keeps its own login and its own tokens across every deploy.

To roll back, push an older commit: `git push production <sha>:main --force`.

---

## What changed in the code

| File | Change |
|---|---|
| `src/chrome.mjs` | New. Finds the browser per platform (`CHROME_PATH` overrides), adds the flags a headless host needs, reports a missing `DISPLAY` before Chrome times out, and kills the process tree properly. |
| `src/secret-store.mjs` | Was PowerShell/DPAPI only, which returns `null` on Linux — every login silently failed. Now DPAPI on Windows, AES-256-GCM under a 0600 key file elsewhere. Same API. |
| `src/credentials.mjs` | `data/credentials.json` is read directly and wins over the stored copy. |
| `src/session.mjs` | Uses `src/chrome.mjs`; spawns Chrome detached so the whole tree can be killed. |
| `tools/*.mjs` (5) | Hardcoded `C:\Program Files\…` paths replaced with the shared lookup. |
| `server.mjs` | `HOST` env var, and it warns when bound to every interface without auth. |

Windows still works exactly as before — the DPAPI path and existing stored secrets are
untouched.
