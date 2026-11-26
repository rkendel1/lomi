#!/usr/bin/env bash
# The assignment's tested behaviours, run against a live `docker compose up` stack (seeded).
# Uses plain curl without a token, as the brief does (the dev default identity applies).
#  1. Review the seeded invoice, upload the revised fixture → exactly the 2 changed fields re-open.
#  2. A new version arrives while the previous one is still extracting → latest wins (supersede).
#  3. `docker compose restart` mid-extraction → the document completes or is visibly retryable.
#  4. Redis FLUSHALL + restart → no value, review or outcome lost; new work still processed.
# Usage: scripts/brief-check.sh            (extra compose files via COMPOSE_FILE)
set -euo pipefail
API=${API:-http://localhost:4000}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FIX="$ROOT/packages/core/src/__tests__/fixtures/documents"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
dc() { docker compose "$@"; }
psql_() { dc exec -T postgres psql -U lomi -d lomi -tAc "$1"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }
status() { curl -fsS "$API/documents/$1" | js 'o.status'; }
wait_status() { # id, wanted (|-separated), timeout s
  for _ in $(seq 1 $(( $3 * 2 ))); do s=$(status "$1" 2>/dev/null || echo down); [[ "|$2|" == *"|$s|"* ]] && { echo "$s"; return 0; }; sleep 0.5; done
  echo "TIMEOUT (status $s)"; return 1
}
upload() { curl -fsS -F "type=$1" -F "file=@$2" "$API$3"; }
make_pdf() { (cd "$ROOT/apps/api" && pnpm exec tsx scripts/make-invoice.ts "$1") > "$2"; }

echo "== 1. Revised invoice: only changed fields re-open"
INV=$(curl -fsS "$API/documents?documentType=invoice" | js 'o.items.find(d=>d.title.includes("Meridian")).id')
for v in $(curl -fsS "$API/documents/$INV" | js 'o.values.filter(v=>v.needsAttention).map(v=>v.id).join(" ")'); do
  curl -fsS -X POST -H 'Content-Type: application/json' -d '{"action":"approve"}' "$API/values/$v/review" > /dev/null
done
echo "   v1 reviewed: $(curl -fsS "$API/documents/$INV/progress" | js 'JSON.stringify(o.counts)')"
t0=$(date +%s%N); upload invoice "$FIX/invoice-001.v2.pdf" "/documents/$INV/versions" > /dev/null
echo "   POST /documents/:id/versions answered in $(( ($(date +%s%N)-t0)/1000000 )) ms; status now $(status "$INV")"
wait_status "$INV" extracted 120 > /dev/null
echo "   after re-extraction: $(curl -fsS "$API/documents/$INV/progress" | js 'JSON.stringify(o.counts)')"
echo "   pending: $(curl -fsS "$API/documents/$INV" | js 'o.values.filter(v=>v.state==="pending").map(v=>v.semanticKey+"="+v.normalizedValue+" (was "+(v.previous&&v.previous.value)+")").join(", ")')"

echo "== 2. New version while the previous one is still extracting"
LEASE=$(curl -fsS "$API/documents?documentType=lease" | js 'o.items[0].id')
make_pdf "INV-2026-$RANDOM" "$TMP/a.pdf"; make_pdf "INV-2026-$RANDOM" "$TMP/b.pdf"
upload lease "$TMP/a.pdf" "/documents/$LEASE/versions" > /dev/null
upload lease "$TMP/b.pdf" "/documents/$LEASE/versions" > /dev/null
wait_status "$LEASE" "extracted|failed" 120 > /dev/null
echo "   versions: $(psql_ "select string_agg('v'||version||'='||processing_status, ', ' order by version) from document_versions where document_id='$LEASE'")"

echo "== 3. docker compose restart mid-extraction"
make_pdf "INV-2026-$RANDOM" "$TMP/c.pdf"
DOC=$(upload invoice "$TMP/c.pdf" /documents | js 'o.documentId')
wait_status "$DOC" "extracting|extracted" 60 > /dev/null
echo "   status before restart: $(status "$DOC")"
dc restart > /dev/null 2>&1
echo "   after restart: $(wait_status "$DOC" "extracted|failed" 300)"
echo "   attempts: $(psql_ "select string_agg(attempt||':'||coalesce(outcome,'running'), ', ' order by attempt) from job_attempts ja join jobs j on j.id=ja.job_id join document_versions dv on dv.id=j.subject_id where dv.document_id='$DOC'")"

echo "== 4. Redis FLUSHALL + restart"
BEFORE=$(psql_ "select (select count(*) from extracted_values)||'/'||(select count(*) from review_decisions)||'/'||(select count(*) from jobs where status='succeeded')")
dc exec -T redis redis-cli FLUSHALL > /dev/null
dc restart > /dev/null 2>&1
sleep 5
AFTER=$(psql_ "select (select count(*) from extracted_values)||'/'||(select count(*) from review_decisions)||'/'||(select count(*) from jobs where status='succeeded')")
echo "   values/reviews/succeeded jobs before: $BEFORE  after: $AFTER"
make_pdf "INV-2026-$RANDOM" "$TMP/d.pdf"
DOC2=$(upload invoice "$TMP/d.pdf" /documents | js 'o.documentId')
echo "   new upload after flush: $(wait_status "$DOC2" "extracted|failed" 180)"
stuck=$(psql_ "select count(*) from document_versions where processing_status in ('parsing','extracting','validating') and status_changed_at < now() - interval '5 minutes'")
echo "   versions stuck in extracting > 5 min: $stuck"
[ "$BEFORE" = "$AFTER" ] && [ "$stuck" = "0" ] && echo "PASS" || { echo "FAIL"; exit 1; }
