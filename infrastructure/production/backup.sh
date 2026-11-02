#!/bin/sh
# Database backups: a pg_dump of this site's database into /backups (a folder on the server, e.g. /srv/backups/<site>).
# Runs in the `backup` container (postgres image, so pg_dump matches the server version). Connection comes from
# PGHOST / PGUSER / PGPASSWORD / PGDATABASE.
#
#   backup.sh loop           run forever: one dump a day at BACKUP_AT (HH:MM, UTC)
#   backup.sh now            one dump right away
#   backup.sh check [FILE]   test a dump (default: the newest): restore it into a throwaway database, compare row
#                            counts with the live database, then drop it. Changes nothing.
#   backup.sh restore FILE   replace the live database with FILE. Stop api and web first.
#
# Dumps: <db>-YYYYmmdd-HHMMSS.dump (custom format, compressed). Kept BACKUP_KEEP_DAILY days; the Sunday dump is
# also copied to weekly/ and kept BACKUP_KEEP_WEEKLY weeks. Files are readable by root only (they hold user data).
set -eu

DIR=/backups
DB="${PGDATABASE:?set PGDATABASE}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
AT="${BACKUP_AT:-02:30}"
umask 077
mkdir -p "$DIR/weekly"

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') backup: $*"; }

newest() { ls -1t "$DIR"/"$DB"-*.dump 2>/dev/null | head -n 1; }

dump() {
  ts=$(date -u +%Y%m%d-%H%M%S)
  out="$DIR/$DB-$ts.dump"
  pg_dump --format=custom --no-owner --no-privileges --file="$out.part"
  pg_restore --list "$out.part" > /dev/null          # unreadable dump → fail here, keep the old ones
  mv "$out.part" "$out"
  [ "$(date -u +%u)" = 7 ] && cp "$out" "$DIR/weekly/"
  find "$DIR" -maxdepth 1 -name "$DB-*.dump" -mtime +"$((KEEP_DAILY - 1))" -delete
  find "$DIR/weekly" -maxdepth 1 -name "$DB-*.dump" -mtime +"$((KEEP_WEEKLY * 7 - 1))" -delete
  find "$DIR" -maxdepth 1 -name "*.part" -mmin +120 -delete
  log "wrote $out ($(du -h "$out" | cut -f1))"
}

# Row count of every table, one "table count" per line, sorted.
counts() {
  psql -X -At -d "$1" -c "SELECT format('SELECT %L || '' '' || count(*) FROM %I.%I;', tablename, schemaname, tablename)
                            FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" \
    | psql -X -At -d "$1" | sort
}

check() {
  f="${1:-$(newest)}"
  [ -n "$f" ] && [ -f "$f" ] || { log "no dump to check"; exit 1; }
  tmp="restore_check_$$"
  psql -X -q -d postgres -c "CREATE DATABASE $tmp"
  trap 'psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $tmp" || true' EXIT
  pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d "$tmp" "$f"
  counts "$tmp" > /tmp/restored.txt
  counts "$DB" > /tmp/live.txt
  log "restored $(basename "$f") into a throwaway database: $(wc -l < /tmp/restored.txt) tables"
  [ -s /tmp/restored.txt ] || { log "check FAILED: the restored database has no tables"; exit 1; }
  awk 'NR == FNR { dump[$1] = $2; next } { live[$1] = $2 }
       END {
         printf "%-20s %12s %12s\n", "table", "in dump", "live"
         for (t in dump) seen[t]; for (t in live) seen[t]
         n = 0; for (t in seen) names[++n] = t
         for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (names[j] < names[i]) { x = names[i]; names[i] = names[j]; names[j] = x }
         for (i = 1; i <= n; i++) { t = names[i]; d = (t in dump) ? dump[t] : "-"; l = (t in live) ? live[t] : "-"
           printf "%-20s %12s %12s%s\n", t, d, l, (d == l ? "" : "  (changed since the dump)") }
       }' /tmp/restored.txt /tmp/live.txt
  log "check OK"
}

restore() {
  f="${1:?usage: backup.sh restore FILE}"
  [ -f "$f" ] || f="$DIR/$f"
  [ -f "$f" ] || { log "no such file: $1"; exit 1; }
  log "restoring $f into $DB (replaces current data)"
  pg_restore --no-owner --no-privileges --clean --if-exists --exit-on-error --single-transaction -d "$DB" "$f"
  log "restore done; start api and web again"
}

loop() {
  log "daily dumps of $DB at $AT UTC into $DIR (keep $KEEP_DAILY daily, $KEEP_WEEKLY weekly)"
  last=""
  while true; do
    today=$(date -u +%Y-%m-%d)
    if [ "$(date -u +%H:%M)" = "$AT" ] && [ "$last" != "$today" ]; then
      dump || log "dump FAILED"
      last=$today
    fi
    sleep 30
  done
}

case "${1:-}" in
  loop) loop ;;
  now) dump ;;
  check) check "${2:-}" ;;
  restore) restore "${2:-}" ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
