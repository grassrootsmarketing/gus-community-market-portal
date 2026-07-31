#!/usr/bin/env bash
# .github/scripts/assert-staging.sh
# ============================================================================
# Refuse to run integration tests against anything but the approved disposable
# staging project. Runs BEFORE any secret is used and before any suite starts.
#
# Two independent conditions, deliberately asymmetric:
#   * an ALLOW check against a value supplied by repository configuration, and
#   * a DENY list hardcoded HERE, in source.
#
# The asymmetry is the point. What may be targeted is an operational decision and can
# live in configuration; what may NEVER be targeted is a review decision and must not be
# editable from a settings page. Repointing the variable at production therefore does not
# help, because the deny check runs regardless of it.
# ============================================================================
set -euo pipefail

EXPECTED='tileejdviuvijumjeplv'
DENY=('ecapmcyumpjjgjwuokyv' 'eubbgurdwqmwqduamwhn')

echo "target ref: ${TARGET_REF:-<unset>}"

if [ -z "${TARGET_REF:-}" ]; then
  echo "REFUSING: STAGING_PROJECT_REF is unset. Refusing to guess a target."
  exit 1
fi

for d in "${DENY[@]}"; do
  if [ "$TARGET_REF" = "$d" ]; then
    echo "REFUSING: $TARGET_REF is production or a retired project."
    exit 1
  fi
done

if [ "$TARGET_REF" != "$EXPECTED" ]; then
  echo "REFUSING: $TARGET_REF is not the approved staging project ($EXPECTED)."
  exit 1
fi

echo "target accepted: $TARGET_REF"
