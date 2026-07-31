#!/usr/bin/env bash
# .github/scripts/capture-manifest.sh <raw-output-file>
# ============================================================================
# Capture one schema manifest and REFUSE to hand back anything that is not one.
#
# This script exists because the previous inline pipeline could not tell the
# difference between a manifest and an error message, and published the error
# message as evidence.
#
# Every gate below is a POSITIVE assertion about content. That distinction is the
# whole lesson: checking for the absence of an error string cannot work, because a
# broken command's output is defined by what it lacks.
# ============================================================================
set -euo pipefail

RAW="$1"
NORM="${RAW%.raw.txt}.txt"

MANIFEST_SQL="supabase/manifest.sql"

# NEGATIVE CONTROL. Deliberately points at a path that does not exist, to demonstrate
# on demand that the guards below actually fire. Without this, "the job would have
# failed" is a claim rather than a demonstration -- and an untested guard is precisely
# what produced the false green in the first place.
if [ "${NEGATIVE_CONTROL:-false}" = "true" ]; then
  echo "NEGATIVE CONTROL ACTIVE: using a manifest path that does not exist."
  MANIFEST_SQL="supabase/manifest.sql.deliberately-missing"
fi

echo "--- gate 1: the query file exists and is non-empty"
if [ ! -s "$MANIFEST_SQL" ]; then
  echo "FAIL: $MANIFEST_SQL is missing or empty"
  exit 1
fi

echo "--- gate 2: the query runs and exits zero"
# Redirect, never pipe. A pipeline would report tee's status, which is how the
# original defect hid a failing CLI behind a succeeding pipe.
if ! supabase db query -f "$MANIFEST_SQL" --linked > "$RAW" 2> "$RAW.err"; then
  echo "FAIL: supabase db query exited non-zero"
  echo "----- stderr -----"; cat "$RAW.err" || true
  echo "----- stdout -----"; head -40 "$RAW" || true
  exit 1
fi
if [ -s "$RAW.err" ]; then
  echo "note: stderr was non-empty:"; cat "$RAW.err"
fi

echo "--- gate 3: the output is non-empty"
if [ ! -s "$RAW" ]; then
  echo "FAIL: manifest output is empty"
  exit 1
fi

# NORMALIZATION, and nothing beyond it.
# Removed: CRs, trailing whitespace, blank lines, and psql's "(N rows)" footer.
# NOT removed and NOT reordered: anything inside a definition. A policy whose USING
# clause has reordered predicates is a different policy, and sorting that away would
# hide exactly the drift this comparison exists to detect.
echo "--- normalizing (CRs, trailing spaces, blank lines, row-count footer)"
sed -e 's/\r$//' -e 's/[[:space:]]*$//' "$RAW" \
  | grep -vE '^\([0-9]+ rows?\)$' \
  | grep -vE '^$' > "$NORM"

echo "--- gate 4: at least ${MIN_MANIFEST_LINES} rows carry the manifest's own row format"
# The strongest available check. An error page, a usage message, a login prompt or a
# truncated result cannot satisfy it, because none of them are shaped like manifest
# rows. Absence of an error string could not have caught any of those.
shaped=$(grep -cE '^[0-9]{2}[a-z]?_(schema|table|column|constraint|index|function|function_body|trigger|rls|policy|grant|grant_function|storage_bucket|migration|count) \| ' "$NORM" || true)
echo "manifest-shaped rows: $shaped"
if [ "$shaped" -lt "${MIN_MANIFEST_LINES}" ]; then
  echo "FAIL: only $shaped manifest-shaped rows; expected at least ${MIN_MANIFEST_LINES}"
  echo "----- first 40 lines of what was actually returned -----"
  head -40 "$NORM"
  exit 1
fi

echo "--- gate 5: the manifest itself reports ${EXPECTED_MIGRATIONS} applied migrations"
# Content, not shape. This catches a manifest that is well-formed but describes a
# half-applied database -- the case where `db reset` stopped early and reported success,
# which has happened once already in this project (0055 reported applied when it was not).
if ! grep -qE "^14_count \| migrations \| count migrations = ${EXPECTED_MIGRATIONS}$" "$NORM"; then
  echo "FAIL: the manifest does not report ${EXPECTED_MIGRATIONS} applied migrations"
  grep -E '^14_count' "$NORM" || echo "(no count rows at all)"
  exit 1
fi

echo "--- gate 6: every required section is present"
for sec in 01_schema 02_table 03_column 04_constraint 05_index 06_function \
           06b_function_body 07_trigger 08_rls 09_policy 10_grant \
           11_grant_function 12_storage_bucket 13_migration 14_count; do
  if ! grep -qE "^${sec} \| " "$NORM"; then
    echo "FAIL: section ${sec} is absent from the manifest"
    exit 1
  fi
done

echo "--- PASS"
echo "raw:        $RAW  ($(wc -l < "$RAW") lines)"
echo "normalized: $NORM ($(wc -l < "$NORM") lines)"
echo "sha256:     $(sha256sum "$NORM")"
