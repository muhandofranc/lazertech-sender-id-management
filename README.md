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

`DB_HOST` / `DB_PORT` are read from `.env` and nothing else. `docker-compose.yml`
does **not** set them under `environment:`, because a value there outranks
`env_file` and would silently override the deployment's own setting — a
production `DB_HOST=172.16.1.2` gets discarded and the container dials the
docker bridge gateway instead, failing with:

```
connect ECONNREFUSED 172.17.0.1:3130
```

(The port is right and the host is wrong: that is the signature of this
mistake, since only `DB_HOST` was being overridden.)

| deployment | `DB_HOST` | `DB_PORT` |
| --- | --- | --- |
| Production | `172.16.1.2` | `3130` |
| Docker, MySQL on the same host | `host.docker.internal` | `3306` |
| Run directly on the host | `127.0.0.1` | `3306` |

Inside a container `127.0.0.1` is the container itself, never the host — that
is what `host.docker.internal` (mapped via `extra_hosts`) is for. It is unused
and harmless when `DB_HOST` names a real remote host.

### Docker

```bash
docker compose up -d --build   # http://localhost:3020
```

MySQL runs on the host rather than in this compose project, so the container
reaches it through the docker bridge gateway (`host.docker.internal`). The
connection therefore arrives at MySQL from the bridge subnet, which is why
`migrations/002_app_user.sql` grants `intranet` for `'172.%'` as well as for
localhost. Without that grant MySQL refuses the container with:

```
Host '172.31.0.2' is not allowed to connect to this MySQL server
```

The migration and `seed-user` steps above still have to be run once against the
database; compose does not do them.

## Schema added by the migration

| Table | Purpose |
| --- | --- |
| `dashboard_users` | Operators who can sign in. Seeded with the default super admin by migration 004. `username`, bcrypt `password_hash`, `role`, `is_active`, `last_login_at`. |
| `sender_audit_log` | Append-only trail: `create`, `update`, `delete`, `login`, `login_failed`, `user_create`, `user_update`, `user_delete`, with actor, IP, and before/after JSON. |

`sender_audit_log` deliberately has no foreign key to `senderiddetails` (the
row it describes is usually gone) and denormalises `actor_username` alongside
`actor_user_id` so history stays readable if a user row is ever removed.

## Layout

```
src/          Express + TypeScript server
  server.ts     app wiring, login/logout, static + page routes
  auth.ts       bcrypt verification, JWT session cookie, route guards
  db.ts         mysql2 pool + boot-time schema check
  audit.ts      audit writer (transaction-aware)
  routes/       senders CRUD, audit log reader
  seed-user.ts  create/reset a dashboard user
client/       browser TypeScript, compiled to public/
views/        HTML pages, served only through the auth-guarded routes
public/       static CSS + compiled client JS
migrations/   SQL
```

HTML lives in `views/` rather than `public/` so `express.static` cannot serve
the dashboard shell to an unauthenticated caller via `/index.html`.

## Database account

The app connects as `intranet`, which is granted only `SELECT, INSERT, UPDATE,
DELETE` on `grantiliff.*` — no DDL, and no access to any other schema.
Migrations are applied as `root` instead. The account exists for three host
scopes (`localhost`, `127.0.0.1`, `172.%`) so it works whether the app runs
directly on the host or in a container on the bridge network.

MySQL 8.4 removed the `mysql_native_password` plugin, so the account uses
`caching_sha2_password`; the `mysql2` driver speaks it.

## Notes

- `senderId` is `varchar(12)` with a `UNIQUE` index; the API validates the
  length and turns a duplicate-key error into a `409` with a readable message.
- `senderIdType` and `csp` are MySQL enums; the API validates against the same
  values so a bad value is a `400` rather than a raw SQL error.
- Login is rate limited to 10 attempts per 15 minutes per IP.
- Password hashes are never written to the audit log; a reset is recorded as
  `password_changed: true` and nothing more.
- Set `COOKIE_SECURE=true` when serving over HTTPS behind a proxy.
