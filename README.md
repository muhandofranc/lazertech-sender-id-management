# grantiliff-senders

Small TypeScript dashboard for managing sender IDs in the `senderiddetails`
table of the local `grantiliff` MySQL database.

- Login backed by a `dashboard_users` table (bcrypt, signed JWT session cookie)
- Two roles: **super admin** (everything) and **user** (sender IDs only)
- Create / update / **delete** sender IDs, with a confirmation dialog on delete
- User management: create accounts, change roles, enable/disable, reset passwords
- Append-only audit log of logins, sender changes and user-management events

## The `senderiddetails` table is not modified

No columns were added to it. The dashboard writes exactly the four columns
that were already there: `Id`, `senderId`, `senderIdType`, `csp`. Existing
consumers (`grantliff_mq/bulk_pub.py` and friends) are unaffected.

Deletes are **hard deletes** — the row is gone from `senderiddetails` for good.
The audit log is the only remaining record that the sender ID existed, which is
why the delete and its audit row are written in one transaction, and why the
audit row snapshots the full contents of the deleted row into `before_json`.

## Default login

`migrations/004_default_super_admin.sql` creates the bootstrap account:

| username | password |
| --- | --- |
| `admin` | `ChangeMe@123` |

**Change this password the first time you sign in** — it is published in this
repository, so anyone who can read the source knows it. Change it from the
Users tab, or with `npm run seed-user -- admin '<new password>' super_admin`.

The insert is guarded on `dashboard_users` being empty, so it only fires on a
genuinely fresh install. Re-running the migration will not resurrect a deleted
admin, reset a password that has since been changed, or re-add the account on
an instance that has moved on to real users.

SQL cannot compute bcrypt, so the hash in that file is precomputed (cost 12).
If you change the default password, regenerate the hash rather than editing the
plaintext:

```bash
node -e "console.log(require('bcryptjs').hashSync('<new password>', 12))"
```

## Roles

| | super admin | user |
| --- | --- | --- |
| Sender IDs (create / update / delete) | yes | yes |
| Users tab (create, promote, disable, reset password, delete) | yes | no |
| Audit log | yes | no |

Both restricted areas are enforced server-side — `/api/users` and `/api/audit`
return `403` for a non-super-admin. Hiding the tabs in the UI is a convenience
on top of that, not the access control itself.

The role is re-read from the database on every request rather than trusted from
the session cookie, so a demotion or a disable takes effect on the target's
**live session**, not whenever their cookie happens to expire.

Two guards prevent locking everyone out:

- the last active super admin cannot be demoted, disabled, or deleted —
  promote someone else first;
- nobody can delete their own account.

## Setup

```bash
# 1. create the dashboard's own tables (senderiddetails is untouched)
mysql -h 127.0.0.1 -u root -p grantiliff < migrations/001_dashboard_tables.sql

# 2. create the least-privilege MySQL account the app connects as
mysql -h 127.0.0.1 -u root -p < migrations/002_app_user.sql

# 3. configure
cp .env.example .env   # then fill in DB_PASSWORD and SESSION_SECRET

# 4. build
npm install
npm run build   # needs node locally; otherwise use the Docker path below

# 5. (optional) migration 004 already created the default super admin.
#    Use this only to reset a password or add an account from the CLI.
npm run seed-user -- <username> <password> [super_admin|user]   # defaults to super_admin

# 6. run
npm start                      # http://localhost:3020
```

## Configuration precedence

`DB_HOST` / `DB_PORT` / `PORT` are read from `.env` and nothing else.
`docker-compose.yml` does **not** set them under `environment:`, because a value
there outranks `env_file` and would silently override the deployment's own
setting.

| deployment | `DB_HOST` | `DB_PORT` |
| --- | --- | --- |
| Production | `172.16.1.2` | `3130` |
| MySQL on the same host | `127.0.0.1` | `3306` |

## Networking

Compose uses `network_mode: host`, so the container shares the host's network
stack and reaches the database over the same route as a `mysql` CLI run on that
host. Because of this the app binds `PORT` directly and there is no `ports:`
mapping.

This is deliberate. On the default bridge network the container routes through
docker's own `172.x` network, which fails against a database at `172.16.1.2`:

```
connect ETIMEDOUT
```

Two things cause that, and host networking sidesteps both:

1. **Subnet overlap.** Docker allocates bridge networks from `172.16.0.0/12`.
   If any docker network covers `172.16.1.0/24`, the container treats the
   database as link-local, ARPs for it on the bridge, and gets nothing back.
   Check with:

   ```bash
   docker network ls --format '{{.Name}}' | while read n; do
     echo "$n: $(docker network inspect "$n" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')"
   done
   ```

2. **Blocked forwarding.** The host's `FORWARD` chain drops container traffic
   towards the interface that reaches the database — common where the route
   runs over a VPN or a secondary NIC.

Both drop packets silently, which is why the symptom is a timeout rather than a
refusal. To diagnose from inside a bridge-networked container:

```bash
docker run --rm alpine sh -c "ip route; nc -vz -w5 172.16.1.2 3130"
```

If you would rather keep bridge isolation, fix the underlying cause — move
docker's address pool off the conflicting range in `/etc/docker/daemon.json`
(`default-address-pools`), or allow the forwarding — and then replace
`network_mode: host` with a `ports:` mapping.

### Docker

```bash
docker compose up -d --force-recreate --build   # http://localhost:3020
```

`--force-recreate` matters: compose will not recreate the container for an
`.env` change alone, so without it a config fix appears to deploy while the old
container keeps running.

The migration and `seed-user` steps above still have to be run once against the
database; compose does not do them.

## Behind a reverse proxy

`mod_proxy` alone cannot forward to an `http://` backend — `mod_proxy_http`
carries the protocol handler. Without it every request fails with:

```
AH01144: No protocol handler was valid for the URL / (scheme 'http')
```

```bash
sudo a2enmod proxy proxy_http
sudo systemctl restart apache2
```

A minimal vhost:

```apache
<VirtualHost *:9310>
  ServerName 94.72.97.10
  ServerAdmin info@lazertech.co.ke
  ErrorLog ${APACHE_LOG_DIR}/lazertech_sender_id_mng.log
  CustomLog ${APACHE_LOG_DIR}/access.log combined

  ProxyPreserveHost On
  ProxyPass        / http://127.0.0.1:3020/
  ProxyPassReverse / http://127.0.0.1:3020/

  LogLevel warn
</VirtualHost>
```

`DocumentRoot` and the matching `<Directory>` block are not needed: every path
is proxied, so Apache never serves a file from disk.

**Set `BIND_HOST=127.0.0.1` in `.env` whenever a proxy is in front.** With
`network_mode: host` and the default `0.0.0.0`, the app also answers on every
external interface, so anyone can reach it on `:3020` directly and skip the
proxy — along with any auth, TLS or IP restriction configured there.

The app already sets `trust proxy`, so `X-Forwarded-For` from the proxy is what
lands in the audit log's `ip` column — real client addresses, not `127.0.0.1`.

### COOKIE_SECURE also controls two headers

`COOKIE_SECURE` means "this deployment is served over https". It sets the
cookie flag, and it gates two headers that break a plain-http vhost:

- **`upgrade-insecure-requests`** (a helmet CSP default). Over http it makes
  the browser rewrite every stylesheet and script URL to `https://`, which has
  no listener — so the HTML renders **with no CSS and no JS**, silently, with
  nothing in the server log and `200`s in Apache's access log. `curl` does not
  enforce CSP, so the assets look fine when fetched by hand.
- **`Strict-Transport-Security`**, which would pin the host to https before
  anything is listening there.

Set `COOKIE_SECURE=true` only once TLS actually terminates in front of the app;
both headers come back automatically. Setting it `true` on a plain-http vhost
has the opposite failure: login returns `200` and bounces straight back to the
login page, because the browser refuses to store a `Secure` cookie over http.

## Database account

The app connects as `intranet`, which is granted only `SELECT, INSERT, UPDATE,
DELETE` on `grantiliff.*` — no DDL, and no access to any other schema.
Migrations are applied as `root` instead. The account exists for three host
scopes (`localhost`, `127.0.0.1`, `172.%`) so it works whether the app runs
directly on the host or in a container on the bridge network.

MySQL 8.4 removed the `mysql_native_password` plugin, so the account uses
`caching_sha2_password`; the `mysql2` driver speaks it.

## Pagination

Both tables page on the server: the query uses `LIMIT`/`OFFSET` and a matching
`COUNT(*)`, so a page costs the same whether the table holds 50 rows or 50,000.
Default 50 per page, selectable 25/50/100/200 (200 is the server's cap; a
larger `limit` is a `400`).

The count is computed with the **same** `WHERE` clause as the page, so
filtering to `csp=lazer` reports the number of lazer rows, not the table total.

Two edge cases the client handles:

- changing a filter resets to the first page, since the narrowed result set is
  usually shorter than the current offset;
- deleting the last row on the final page steps back a page and refetches,
  instead of showing an empty table while rows still exist.

## Notes

- `senderId` is `varchar(12)` with a `UNIQUE` index; the API validates the
  length and turns a duplicate-key error into a `409` with a readable message.
- `senderIdType` and `csp` are MySQL enums; the API validates against the same
  values so a bad value is a `400` rather than a raw SQL error.
- Login is rate limited to 10 attempts per 15 minutes per IP.
- Password hashes are never written to the audit log; a reset is recorded as
  `password_changed: true` and nothing more.
- Set `COOKIE_SECURE=true` when serving over HTTPS behind a proxy.
