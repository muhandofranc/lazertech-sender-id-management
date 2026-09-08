#!/usr/bin/env sh
# Applies the dashboard's schema migrations, in order, against one database.
#
#   ./migrations/apply.sh -h 172.16.1.2 -P 3130 -u root -p grantliff
#
# Everything after the script name is passed straight through to `mysql`, so
# use whatever connection flags you would normally use -- the database name
# goes last, as usual.
#
# Needs an account that can CREATE and ALTER tables; the app's own `intranet`
# account deliberately cannot. Every migration is idempotent-safe to the extent
# noted in its header, but 003 will fail on a second run because the `role`
# column already exists -- that failure is expected and harmless.
#
# 002_app_user.sql is NOT applied here: it creates a MySQL account and its host
# scopes are environment specific. Run it by hand where it is needed.
set -e

dir=$(dirname "$0")

for m in 001_dashboard_tables 003_roles 004_default_super_admin; do
  printf '\n== applying %s ==\n' "$m"
  mysql "$@" < "$dir/$m.sql"
done

printf '\nDone. Default login: admin / ChangeMe@123 -- change it immediately.\n'
