#!/usr/bin/env bash
# .github/scripts/retry-transient.sh -- source this, then use: retry_transient <label> <cmd...>
# ============================================================================
# Codex v6: "bounded retries are accepted, with narrower rules."
#
# His objection to the first version was exact and correct: the comment claimed it retried
# "only a transient" while the code retried EVERY query error. A retry that cannot tell a
# network blip from a syntax error is a machine for turning real defects into green builds.
#
# So classification is explicit and the default is DO NOT RETRY.
#
# RETRIED  connectivity, timeouts, rate limits, 5xx, and the specific Supabase temporary
#          401 observed on `link` and `db query` login-role initialisation
# NEVER    SQL syntax, permissions, missing file, assertion, migration, comparison --
#          anything that will fail identically on the next attempt
#
# Callers must never wrap `db reset`, the manifest comparison, or the identity write.
# Those are destructive or are the verification itself; retrying them to obtain a green
# result is precisely the abuse this file is written to prevent.
# ============================================================================

# Returns 0 when the captured output looks transient and a retry is justified.
_is_transient() {
  local out="$1"
  # Never retry these, whatever else the output says. Checked FIRST so a permanent error
  # that happens to mention "timeout" somewhere cannot sneak into the retry path.
  if grep -qiE 'syntax error|permission denied|does not exist|already exists|violates (check|foreign key|not-null|unique)|no such file|is missing or empty|POST-CONDITION FAILED|invalid input syntax' <<<"$out"; then
    return 1
  fi
  grep -qiE 'timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|TLS handshake|rate limit|too many requests|429|50[0-9] |Bad Gateway|Service Unavailable|Gateway Time-?out|temporarily unavailable|unexpected login role status 401|Unexpected error retrieving remote project status.*Unauthorized' <<<"$out"
}

# retry_transient <label> <command...>
retry_transient() {
  local label="$1"; shift
  local attempts=3 n=1 out rc
  while : ; do
    echo "    [$label] attempt ${n}/${attempts}"
    set +e
    out="$("$@" 2>&1)"; rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
      [ -n "$out" ] && sed 's/^/      /' <<<"$out"
      return 0
    fi
    echo "    [$label] attempt ${n} exited ${rc}:"
    sed 's/^/      /' <<<"$out"

    if ! _is_transient "$out"; then
      echo "    [$label] NOT a transient condition -- failing immediately, no retry"
      return "$rc"
    fi
    if [ "$n" -ge "$attempts" ]; then
      echo "    [$label] transient persisted across ${attempts} attempts."
      echo "    [$label] Per Codex v6: a persistent 401 here means the credential is invalid,"
      echo "    [$label] NOT harmless infrastructure noise. Check SUPABASE_ACCESS_TOKEN."
      return "$rc"
    fi
    n=$((n + 1))
    sleep $((n * 5))
  done
}
