#!/usr/bin/env bash
# .github/scripts/provision-identity.sh <environment> <project-ref>
# ============================================================================
# Render and execute the deployment-identity provisioning statement, then PROVE it
# took effect by reading it back.
#
# Writing and then assuming is how the manifest step lied for a whole round. So this
# script performs the write, re-reads the row through the same function the runtime
# binding check uses, and fails unless both fields come back exactly as supplied.
# ============================================================================
set -euo pipefail

ENVIRONMENT="${1:?environment required (preview|production)}"
PROJECT_REF="${2:?project ref required}"

DENY=('ecapmcyumpjjgjwuokyv' 'eubbgurdwqmwqduamwhn')
for d in "${DENY[@]}"; do
  if [ "$PROJECT_REF" = "$d" ]; then
    echo "REFUSING: $PROJECT_REF is production or a retired project."
    exit 1
  fi
done

TEMPLATE='supabase/provision-identity.sql.template'
RENDERED='provision-identity.rendered.sql'

if [ ! -s "$TEMPLATE" ]; then
  echo "FAIL: $TEMPLATE is missing or empty"
  exit 1
fi

echo "--- rendering provisioning statement for ${ENVIRONMENT} / ${PROJECT_REF}"
sed -e "s/__ENVIRONMENT__/${ENVIRONMENT}/g" \
    -e "s/__PROJECT_REF__/${PROJECT_REF}/g" "$TEMPLATE" > "$RENDERED"

# The placeholders must be gone. A silent substitution failure would otherwise write the
# literal string __PROJECT_REF__ into the identity row and every route would then fail
# with database_project_ref_mismatch instead of identity_not_provisioned -- a different
# 503 with the same uselessness.
if grep -q '__ENVIRONMENT__\|__PROJECT_REF__' "$RENDERED"; then
  echo "FAIL: placeholders remain after substitution"
  exit 1
fi

echo "--- executing"
if ! supabase db query -f "$RENDERED" --linked > provision.out 2> provision.err; then
  echo "FAIL: provisioning statement exited non-zero"
  cat provision.err || true
  exit 1
fi

echo "--- reading the identity back through the same function the binding check uses"
cat > verify-identity.sql <<'VSQL'
select 'IDENTITY | ' || coalesce(environment, '<null>') || ' | ' || coalesce(project_ref, '<null>')
from public.get_deployment_identity();
VSQL

if ! supabase db query -f verify-identity.sql --linked > verify.out 2> verify.err; then
  echo "FAIL: identity read-back exited non-zero"
  cat verify.err || true
  exit 1
fi

# Positive assertion on content. Absence of an error is not evidence.
if ! grep -q "IDENTITY | ${ENVIRONMENT} | ${PROJECT_REF}" verify.out; then
  echo "FAIL: identity did not read back as ${ENVIRONMENT} / ${PROJECT_REF}"
  echo "----- what came back -----"
  cat verify.out
  exit 1
fi

echo "--- PASS: deployment identity is ${ENVIRONMENT} / ${PROJECT_REF}"
