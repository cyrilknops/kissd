# kissd

**Keep It Super Simple Dashboard.** One container that gives you your whole
Docker host in a browser: containers grouped by compose project, live host
metrics, ntfy alerts, pruning, and terminals — including Claude Code.

It installs **nothing on your host**. No nginx, no PHP, no certbot, no systemd
units, no package manager. Just a container talking to the Docker socket.

---

## The name

**K**eep **I**t **S**uper **S**imple **D**ashboard. Pronounced *kissed*.

Which is also the design brief. It is a peck on the cheek, not a French kiss —
kissd keeps its tongue well clear of your nginx config. It touches your host
lightly, leaves nothing behind, and does not move in and rearrange the
furniture.

---

## Why

Most self-hosted server panels want to *own* the machine. They install their own
nginx, take ports 80 and 443, manage your certificates, and run a package
manager behind your back. If you already have a reverse proxy — Nginx Proxy
Manager, Traefik, Caddy — that is a fight you did not ask for.

Worse, several of them only show you the containers *they* created. Point one at
an existing host with twenty running services and you get an empty list.

kissd does the opposite. It shows what is already there, changes nothing about
how your host is arranged, and gets out of the way.

## What you get

| | |
|---|---|
| **Containers** | Every container on the host, as cards grouped by compose project, with live CPU, memory, health, ports and uptime |
| **Detail page** | Per-container stats, mounts, networks, published ports, restart policy, failing healthcheck output, and live logs |
| **Actions** | Start, stop, restart, and update via `docker compose pull && up -d`, resolved from each container's own compose labels |
| **Host metrics** | CPU, load, memory, swap, network throughput, per-mount disk usage |
| **Alerts** | ntfy push when a container stops, goes unhealthy, or enters a restart loop — plus disk, memory and load thresholds |
| **Maintenance** | Disk usage breakdown and per-target pruning, with named volumes handled one at a time |
| **Terminals** | A shell in any container, a root shell on the host, and Claude Code — all in the browser |

Everything is one screen deep. There is no wizard, no onboarding, no marketplace.

## Install

You need Docker with the compose plugin, and a reverse proxy in front — kissd
publishes no host ports and its session cookies are `Secure`, so it expects
HTTPS.

```bash
git clone https://github.com/cyrilknops/kissd.git
cd kissd
cp .env.example .env
```

Set a password and a session secret in `.env`:

```bash
# a strong random secret
openssl rand -hex 32
```

Then bring it up:

```bash
docker compose up -d --build
```

Point your proxy at `kissd:8090` over the shared Docker network — or publish a
port yourself if you prefer. **Websocket upgrades must be enabled**; the
terminals and log streaming will not work without them.

<details>
<summary>Nginx Proxy Manager settings</summary>

| Field | Value |
|---|---|
| Scheme | `http` |
| Forward hostname | `kissd` |
| Forward port | `8090` |
| Websockets Support | **on** |
| Force SSL | on |

kissd joins an external network named `proxy-tier` by default. Change that in
`docker-compose.yml` to whatever network your proxy is on.
</details>

## Configuration

`.env` holds only what is needed to boot:

| Variable | Purpose |
|---|---|
| `KISSD_ADMIN_USER` / `KISSD_ADMIN_PASSWORD` | Login. Hashed at boot; never written to disk. |
| `KISSD_JWT_SECRET` | Signs session cookies. Changing it logs everyone out. |
| `REPO_DIR` | Where your compose files live. Bind-mounted at the *same* path inside the container so `docker compose` resolves relative binds correctly. |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | Optional first-run seed for notifications. |

Everything else — ntfy server, auth mode, alert toggles, thresholds, cooldown,
hysteresis — lives in **Settings** and is stored in `data/settings.json`
(mode 0600). Changes apply immediately, with no restart.

ntfy credentials never travel back to the browser. The UI shows *set / not set*
plus a four-character hint, and only overwrites a secret when you type a new one.

## Alerts

Threshold alerts use hysteresis and a cooldown, so a disk hovering at 85% sends
one notification rather than one every 30 seconds, and only announces recovery
once it has clearly dropped back.

Container alerts fire on **state transitions**, so a container you stopped on
purpose does not nag you. The first poll after a restart takes a silent
baseline.

Restart loops are counted over a **rolling window** (default: 3 restarts within
60 minutes). Comparing only against the previous poll would miss a slow loop — a
container restarting every few minutes never shows a spike between two 30-second
samples, yet it is still looping.

## Pruning

The Maintenance page prunes dangling images, unused images, stopped containers,
build cache and unused networks — each behind its own confirmation showing what
will be freed.

**There is deliberately no bulk volume prune.** Docker treats a named volume as
"dangling" whenever its container merely isn't running, so `docker volume prune`
happily destroys live data. kissd lists unused volumes by name, size and compose
project, and deletes them one at a time — each requiring your password *and* the
volume name typed out. The refcount is re-checked at the moment of deletion, so
a volume that got attached in the meantime is refused.

Reported figures are what a prune would **actually free**, which is not always
what `docker system df` prints in its RECLAIMABLE column — that number counts
total-minus-unused and can claim 75% reclaimable while most images are in
active use.

## Security

kissd holds the Docker socket and can open a root shell on the host. **It is
root-equivalent access to your server.** That is the point of the tool, but be
deliberate about it:

- Put it behind HTTPS and treat the login as a root password.
- Consider an IP allowlist or basic auth at the proxy, in front of kissd.
- The host shell is gated behind re-entering your password, which mints a
  separate token valid for five minutes. That slows an attacker down; it does
  not stop one who has your password.
- Login is rate-limited to five attempts per fifteen minutes.

The container runs `privileged` with `pid: host`. Both are required: `pid: host`
so host metrics come from the host's namespaces (`/proc/1/net/dev`,
`/proc/1/mounts`) rather than the container's, and `privileged` so `nsenter` can
reach PID 1 for the host shell. If you do not want a host shell, drop both and
everything except that one feature keeps working.

## Claude Code

The **Claude** terminal tab runs Claude Code inside the container, with `$HOME`
on the `data/` volume so your login survives restarts. Sign in once via the
browser terminal and it stays signed in.

## Built with

Node 22, Express, dockerode and node-pty on the back. React 18, Vite and xterm.js
on the front. No database — settings are a JSON file. The whole thing is one
multi-stage `Dockerfile`.

## Licence

[GPL-3.0](LICENSE)
