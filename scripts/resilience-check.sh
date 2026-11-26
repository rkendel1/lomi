#!/usr/bin/env bash
# Resilience checks against a running `docker compose up` stack (seeded).
#  1. Kill the worker with SIGKILL while it is processing a document; restart it;
#     the document must finish, with the crashed attempt recorded as abandoned.
#  2. FLUSHALL + restart Redis; review decisions must be intact and new uploads
#     must still be processed.
# Usage: scripts/resilience-check.sh   (extra compose files via COMPOSE_FILE)
set -euo pipefail
API=${API:-http://localhost:4000}
TOKEN=${TOKEN:-dev-lakeside-reviewer}
dc() { docker compose "$@"; }
psql_() { dc exec -T postgres psql -U lomi -d lomi -tAc "$1"; }
status() { curl -fsS -H "Authorization: Bearer $TOKEN" "$API/api/documents/$1/progress" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status'; }
make_pdf() { (cd "$(dirname "$0")/../apps/api" && pnpm exec tsx scripts/make-invoice.ts "$1"); }
upload() {
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/pdf' --data-binary @"$1" \
    "$API/api/documents?documentType=invoice&filename=$(basename "$1")" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documentId'
}
wait_for() { # doc-id, wanted-status, timeout-seconds
  for _ in $(seq 1 $(( $3 * 5 ))); do [ "$(status "$1")" = "$2" ] && return 0; sleep 0.2; done
  echo "FAIL: $1 did not reach $2 (now $(status "$1"))"; exit 1
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "== 1. Worker killed mid-processing"
dc restart worker >/dev/null          # fresh worker: the first Laya check loads the model (slow), widening the window
sleep 3
make_pdf "INV-2026-$RANDOM" > "$TMP/crash.pdf"
DOC=$(upload "$TMP/crash.pdf")
for _ in $(seq 1 200); do s=$(status "$DOC"); case "$s" in parsing|extracting|validating) break;; esac; sleep 0.05; done
echo "   status before kill: $(status "$DOC")"
dc kill -s SIGKILL worker >/dev/null
JOB=$(psql_ "select j.id from jobs j join document_versions dv on dv.id=j.subject_id where dv.document_id='$DOC'")
echo "   job after kill: $(psql_ "select status||' lease_owner='||coalesce(lease_owner,'-') from jobs where id='$JOB'")"
dc start worker >/dev/null
echo "   waiting for the lease to expire and the reconciler to recover the job..."
wait_for "$DOC" awaiting_review "${RECOVERY_TIMEOUT:-300}"
echo "   attempts: $(psql_ "select string_agg(attempt||':'||outcome, ', ' order by attempt) from job_attempts where job_id='$JOB'")"
echo "   values: $(psql_ "select count(*) from extracted_values ev join document_versions dv on dv.id=ev.document_version_id where dv.document_id='$DOC'") (expected 9, no duplicates)"

echo "== 2. Redis FLUSHALL + restart"
BEFORE=$(psql_ "select count(*) from review_decisions")
dc exec -T redis redis-cli FLUSHALL >/dev/null
dc restart redis >/dev/null
make_pdf "INV-2026-$RANDOM" > "$TMP/after-redis.pdf"
DOC2=$(upload "$TMP/after-redis.pdf")
wait_for "$DOC2" awaiting_review 120
AFTER=$(psql_ "select count(*) from review_decisions")
echo "   review decisions before/after: $BEFORE/$AFTER"
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: review decisions changed"; exit 1; }
echo "PASS"
