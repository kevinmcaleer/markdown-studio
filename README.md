# Markdown Studio

A self-hosted suite of web apps for Kev's Power Tools:

- **Notes**: Markdown documents with live preview, real-time co-editing, sharing links and threaded comments
- **Tables**: a simple Access-style database with a spreadsheet-like grid
- **Decks**: slides written in Markdown, exported to PowerPoint and Keynote

Everything sits behind one login, stores its data in a single SQLite file, and runs as one
Docker container that is happy on a Raspberry Pi. It runs at kevspowertools.com and on your
own home network.

> **Status:** Notes works: files and folders, the Markdown editor, live co-editing, sharing,
> comments, Word/PDF export, offline use, and Google Docs and iCloud sync. Tables and Decks are tracked in the
> [epics](https://github.com/kevinmcaleer/markdown-studio/issues?q=label%3Aepic).

## How it fits together

| Part | Where | What |
| --- | --- | --- |
| Server | `server/studio` | Python 3.13 + FastAPI. JSON API, SQLite (WAL), serves the built web app. |
| Shared login | `packages/powertools-auth` | The mermaid-factory login as a reusable package: argon2id passwords, server-side sessions, CSRF, rate limiting. |
| Web app | `web` | React + TypeScript + Vite. The suite shell (sign in, app launcher, account) that Notes, Tables and Decks plug into. |
| Deployment | `Dockerfile`, `docker-compose.yml`, `docker-stack.yml` | One multi-arch image (amd64 + arm64). |

The repository is an npm workspace, so TypeScript libraries (such as the Keynote library
port) can live under `packages/` next to the web app.

## Notes

- **Files and folders** live in `studio.db` (contents as blobs). Drag to move, drop files from
  your desktop to upload. `MAX_UPLOAD_MB` (default 25) caps uploads.
- **The editor** shows Markdown with live preview: GFM tables, task lists, footnotes, fenced
  code with syntax highlighting, and `==highlights==`.
- **Co-editing** is live: everyone editing a note sees each other's cursors and changes, merged
  without conflicts (Yjs over a WebSocket at `/api/files/{id}/live`). If you put a reverse
  proxy in front, let it pass WebSocket upgrades.
- **Export** a note as Word or PDF from its Download menu. Only images stored in Markdown
  Studio are included; the server never fetches outside URLs while exporting.
- **Install and offline:** Notes installs as its own app (Chrome, Edge and Android offer
  **Install Notes**; on iPhone and iPad use Share, then Add to Home Screen). Notes you've
  opened before keep working offline, and your changes merge when you're back online.
  Service workers need HTTPS, or `localhost`.

- **Google Docs sync:** from a note's **Sync** menu, **Create a Google Doc** makes a Doc from
  the note and keeps the two in step, both ways: on **Sync now**, and in the background every
  few minutes. Needs Google set up on the server (below). Images stored in Markdown Studio
  don't travel to Google.
- **iCloud Drive:** **Sync, Save a copy** hands the note (Markdown, Word or PDF) to the share
  sheet; on iPhone, iPad and Mac choose **Save to Files**, then iCloud Drive. Other browsers
  download it. Edit the Markdown copy anywhere, then **Sync, Update from a copy** picks it
  from iCloud Drive and merges it back. iCloud has no web API, so this is a save and a
  restore rather than a live sync.
- **Conflicts:** every sync is a three-way merge against what both sides looked like last
  time, so edits to different parts of a note merge on their own. If both sides changed the
  same lines, nothing is overwritten: the note shows a banner to keep this note, keep the
  other copy, keep both (the copy becomes a new note), or fix it by hand (both versions go
  into the note between `<<<<<<<` and `>>>>>>>` lines).

## Google Docs sync

Each server needs its own Google OAuth client. It's free and takes ten minutes:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or
   pick one) and enable the **Google Drive API** (APIs & Services, Library).
2. Set up the **OAuth consent screen** (Google Auth Platform, Branding / Audience): app name
   *Markdown Studio*, your email, and on **Data Access** add the scope
   `https://www.googleapis.com/auth/drive.file`. This scope only reaches files the app
   creates, so Google treats it as non-sensitive and no app review is needed. While the app
   is in *Testing*, add each person's Google address under **Test users** (up to 100), or
   publish the app to let anyone connect.
3. Create an **OAuth client ID** (Clients, Create client), type **Web application**, with this
   authorised redirect URI: `<PUBLIC_URL>/api/cloud/google/callback`, for example
   `https://studio.kevspowertools.com/api/cloud/google/callback`. Google only accepts
   `https://` addresses or `http://localhost`, so a home server needs HTTPS (a Cloudflare
   Tunnel works) or must be reached as `localhost`.
4. Put the client's ID and secret in `.env`, set `PUBLIC_URL`, and restart:

   ```sh
   PUBLIC_URL=https://studio.example.com
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

Then each person connects their Google account from their Account page (or from a note's
Sync menu). Disconnecting stops syncing; the Google Docs stay in their Drive. Google's
refresh tokens are kept in `studio.db`, so protect its backups like the database itself.

## Quick start with Docker

```sh
git clone https://github.com/kevinmcaleer/markdown-studio.git
cd markdown-studio
cp .env.example .env   # optional: every setting has a sensible default
docker compose up -d --build
```

Open <http://localhost:8000>. On a fresh install you're taken straight to **Create the owner
account**. That first account can always be created, even with `ALLOW_REGISTRATION=false`, so
you can leave registration closed from day one.

`docker compose down && docker compose up -d` keeps everything: the data lives on the host in
`./data/studio.db`, not in the container.

## Raspberry Pi cluster

The image is built for `linux/arm64`, so any Pi 4 or 5 running a 64-bit OS can run it.

**One Pi:** use the Docker quick start above.

**Several Pis (Docker Swarm):** SQLite needs exactly one writer on a local disk, so the app runs
as a single replica pinned to the Pi that keeps the data. Swarm's routing mesh still answers on
port 8000 from every Pi, and restarts the app if it stops.

```sh
# On the manager, label the Pi that will hold the data:
docker node update --label-add studio.data=true pi-1

# On pi-1, create the data folders (owned by UID 1000 by default):
sudo mkdir -p /srv/markdown-studio/{data,backups} && sudo chown -R 1000:1000 /srv/markdown-studio

# On the manager:
export SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
docker stack deploy -c docker-stack.yml studio
```

Keep `SECRET_KEY` somewhere safe; if it changes, open browser tabs just need a refresh. Never put
the database on NFS or SMB: SQLite's locking isn't safe over network filesystems. To publish the
suite through Cloudflare without opening ports, uncomment `cloudflared` in `docker-stack.yml`.

## Backup and restore

Don't `cp` the live database: a WAL-mode file copied mid-write can be corrupt. The backup
script uses SQLite's online backup API and checks the result with `PRAGMA integrity_check`:

```sh
make backup     # docker compose exec -u app markdown-studio scripts/backup.sh /data/studio.db /backups
```

It keeps the newest 14 backups (`KEEP=30` to change). Nightly, with cron on the host:

```cron
15 2 * * * cd /home/kev/markdown-studio && docker compose exec -T -u app markdown-studio scripts/backup.sh /data/studio.db /backups >> backups/backup.log 2>&1
```

Restore with `scripts/restore.sh backups/studio-20260101T021500Z.db`: it checks the backup,
stops the container, keeps the current database aside, swaps the backup in and waits for
`/health`.

## Forgotten passwords

With email set up, "Forgot your password?" on the sign-in page sends a one-time link to the
account's email address. The link lasts an hour, works once, and signs out every other
session when used. Set these in `.env` (see `.env.example`):

```sh
PUBLIC_URL=https://studio.example.com     # reset links point here
SMTP_HOST=smtp.fastmail.com
SMTP_SECURITY=starttls                    # or ssl (port 465), or none for a LAN relay
SMTP_USERNAME=you@example.com
SMTP_PASSWORD=an-app-password
SMTP_FROM=Markdown Studio <you@example.com>
```

People who signed up without an email address can add one on their Account page.

Without email, or for an account with no address, whoever runs the server resets the
password:

```sh
docker compose exec -u app markdown-studio python -m studio reset-password kev
```

## Configuration

All settings are environment variables, normally set in `.env` (see `.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECRET_KEY` | *(generated)* | Signs CSRF tokens. If unset, one is generated on first start and kept in `./data/.secret_key`. |
| `PORT` | `8000` | Port to listen on (and publish). |
| `BIND_ADDRESS` | `0.0.0.0` | Host address the port is published on. Use `127.0.0.1` behind a local reverse proxy. |
| `DATABASE_PATH` | `./data/studio.db` (`/data/studio.db` in Docker) | SQLite file. |
| `ALLOW_REGISTRATION` | `true` | Allow new sign-ups. The first account is always allowed. |
| `HTTPS` | `false` | Set `true` when served over HTTPS: cookies get the `Secure` flag. |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-For` / `X-Forwarded-Proto` from a reverse proxy or tunnel. |
| `COOKIE_DOMAIN` | *(empty)* | Share the login cookie with sibling subdomains, e.g. `.kevspowertools.com`. |
| `PUBLIC_URL` | *(empty)* | The app's address as users see it. Required with `SMTP_HOST`; reset links use it. |
| `SMTP_HOST` | *(empty)* | Mail server for password reset emails. Empty turns email resets off. |
| `SMTP_SECURITY` | `starttls` | `starttls`, `ssl` (implicit TLS) or `none` (trusted local relay only). |
| `SMTP_PORT` | `587` (`465` with `ssl`) | Mail server port. |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | *(empty)* | Mail server login, if it needs one. |
| `SMTP_FROM` | *(empty)* | Sender, e.g. `Markdown Studio <studio@example.com>`. Required with `SMTP_HOST`. |
| `PASSWORD_RESET_MAX_AGE` | `3600` | Seconds a reset link stays valid. |
| `SESSION_MAX_AGE` | `86400` | Seconds a login lasts. |
| `REMEMBER_ME_MAX_AGE` | `2592000` | Seconds a "keep me signed in" login lasts. |
| `LOGIN_RATE_LIMIT` / `LOGIN_RATE_WINDOW` | `5` / `60` | Sign-in and sign-up attempts allowed per IP per window (seconds). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(empty)* | OAuth client for Google Docs sync (see above). Empty hides Google Docs. |
| `GOOGLE_SYNC_INTERVAL` | `300` | Seconds between background syncs of linked notes. `0` syncs only on request. |
| `POWERTOOLS_APPS_URL` | `https://kevspowertools.com/apps.json` | The shared list behind the app switcher. Empty uses the bundled copy. |
| `PUID` / `PGID` | `1000` | Owner of files in `./data` (Docker only). |
| `LOG_LEVEL` | `INFO` | Logs are JSON lines on stdout. |

## Development

You need Python 3.12+ and Node 22+.

```sh
make install   # .venv + npm workspaces
make dev       # API on :8000 with reload, web app on http://localhost:5173 with hot reload
make test      # pytest + vitest
make lint      # ruff + tsc
```

Vite proxies `/api` to the Python server, so the browser sees one origin and cookies work
the same as in production.

### Database migrations

Plain `NNNN_name.sql` files, applied once each, in order, per component: the `auth` ones ship
with `powertools-auth`, the app's own go in `server/studio/migrations`. To change the schema,
add a file; never edit one that has shipped.
