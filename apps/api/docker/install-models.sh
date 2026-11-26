#!/bin/sh
# Install the local Laya model into ML_RUNTIME_MODEL_DIR (a volume). Idempotent: reports
# "already_installed" after the first run. Retries rate limits and network errors, then
# always exits 0: if the model is still missing, the worker starts anyway and documents
# show a visible, retryable "model not installed" failure instead of the stack silently
# doing nothing. Fix with `docker compose run --rm models`, then Retry.
if [ "${LOMI_LAYA:-1}" != "1" ]; then
  echo "Laya disabled (LOMI_LAYA=0)"
  exit 0
fi
attempt=1
while [ "$attempt" -le 4 ]; do
  if ml-runtime model install laya && ml-runtime model doctor laya; then
    exit 0
  fi
  wait_s=$((attempt * 15))
  echo "Laya install attempt ${attempt} failed; retrying in ${wait_s}s"
  sleep "$wait_s"
  attempt=$((attempt + 1))
done
echo "WARNING: Laya model not installed. Documents will fail visibly until it is; run: docker compose run --rm models"
exit 0
