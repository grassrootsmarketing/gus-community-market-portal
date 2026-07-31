#!/usr/bin/env bash
# .github/scripts/provision-identity.sh <target-name> <project-ref>
#
#   target-name : preview | production | development  (the VERCEL target)
#   project-ref : the Supabase project ref to provision
#
# ============================================================================
# THE PRODUCTION CUTOVER STEP. Not test scaffolding.
#
# A database built from the migration chain serves ZERO requests until this runs:
# deployment_identity is empty after `db reset`, set_deployment_identity is deliberately
# unreachable from service_role, and api/_env.js fails closed on an unprovisioned
# identity. CI runs the same statement an operator runs at cutover, so the step is in
# version control and exercised on every build instead of living in someone's memory.
#
# TWO MISTAKES ALREADY MADE HERE, BOTH RECORDED BECAUSE THE SHAPE OF THE FIX FOLLOWS
# FROM THEM:
#
#   1. I passed 'preview' -- the VERCEL TARGET name -- where the DATABASE ENVIRONMENT
#      belongs. They are deliberately different strings: TARGETS.preview.dbEnvironment
#      is 'staging'. The CHECK constraint in 0050 rejected it, so nothing wrong was
#      written, but a value that must agree with api/_env.js should never be retyped by
#      hand in a shell script. It is now DERIVED from the same object the runtime binding
#      check reads, so the two cannot drift.
#
#   2. That derivation was first written by interpolating a shell variable into a
#      double-quoted `node -e` string. The nested quoting silently produced an empty
#      result rather than an error -- the worst possible failure mode, and the same
#      species as everything else in this project's ledger. The target name now travels
#      to node through the ENVIRONMENT, where no quoting layer can eat it, and the result
#      is asserted non-empty before use.
# ============================================================================
set -euo pipefail

TARGET_NAME="${1:?target name required (preview|production|development)}"
PROJECT_REF="${2:?project ref required}"

# --- derive the database environment from the single source of truth ---------
DB_ENVIRONMENT="$(TARGET_NAME="$TARGET_NAME" node -e '
  import("./api/_env.js").then(m => {
    const t = m.TARGETS[process.env.TARGET_NAME];
    if (!t || !t.dbEnvironment) {
      console.error("unknown target: " + process.env.TARGET_NAME);
      process.exit(1);
    }
    process.stdout.write(t.dbEnvironment);
  }).catch(e => { console.error(e.message); process.exit(1); });
' 2>/dev/null)"

# Non-empty is asserted explicitly. An empty derivation is exactly what the quoting bug
# produced, and it would otherwise sail through into a confusing constraint violation.
if [ -z "$DB_ENVIRONMENT" ]; then
  echo "FAIL: could not derive dbEnvironment for target '$TARGET_NAME' from api/_env.js"
  exit 1
fi

echo "target '$TARGET_NAME' maps to database environment '$DB_ENVIRONMENT'"

# The CHECK constraint in 0050, asserted here so a mismatch fails with a sentence rather
# than a 23514 raised from inside a PL/pgSQL frame.
case "$DB_ENVIRONMENT" in
  production|staging|development|rebuild-check) ;;
  *) echo "FAIL: '$DB_ENVIRONMENT' is not a value deployment_identity.environment accepts"; exit 1 ;;
esac

# --- validate the ref FORMAT before it is ever substituted into SQL ----------
# Codex v6 hardening. CI protects this with an exact staging-ref assertion, but the same
# script is meant to run at PRODUCTION cutover, where that assertion will not apply. A ref
# is exactly twenty lowercase letters -- the same shape 0050's CHECK constraint enforces --
# so anything carrying a quote, whitespace, a shell metacharacter or SQL punctuation is
# refused before it can reach a sed substitution and then a SQL string literal.
if ! printf '%s' "$PROJECT_REF" | grep -qE '^[a-z]{20}$'; then
  echo "REFUSING: '$PROJECT_REF' is not a valid Supabase project ref (expected exactly 20 lowercase letters)"
  exit 1
fi

# --- refuse production and retired projects, in source -----------------------
for d in ecapmcyumpjjgjwuokyv eubbgurdwqmwqduamwhn; do
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

echo "--- rendering provisioning statement for ${DB_ENVIRONMENT} / ${PROJECT_REF}"
sed -e "s/__ENVIRONMENT__/${DB_ENVIRONMENT}/g" \
    -e "s/__PROJECT_REF__/${PROJECT_REF}/g" "$TEMPLATE" > "$RENDERED"

# A silent substitution failure would write the literal string __PROJECT_REF__ into the
# identity row, and every route would then fail with database_project_ref_mismatch
# instead of identity_not_provisioned: a different 503, equally uninformative.
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

echo "--- reading the identity back through get_deployment_identity(), the same function"
echo "    the runtime binding check calls"
cat > verify-identity.sql <<'VSQL'
select 'IDENTITY | ' || coalesce(environment, '<null>') || ' | ' || coalesce(project_ref, '<null>')
from public.get_deployment_identity();
VSQL

if ! supabase db query -f verify-identity.sql --linked > verify.out 2> verify.err; then
  echo "FAIL: identity read-back exited non-zero"
  cat verify.err || true
  exit 1
fi

# Positive assertion on content. Writing and then assuming is how the manifest step lied
# for a whole round.
if ! grep -q "IDENTITY | ${DB_ENVIRONMENT} | ${PROJECT_REF}" verify.out; then
  echo "FAIL: identity did not read back as ${DB_ENVIRONMENT} / ${PROJECT_REF}"
  echo "----- what came back -----"
  cat verify.out
  exit 1
fi

echo "--- PASS: deployment identity is ${DB_ENVIRONMENT} / ${PROJECT_REF}"
