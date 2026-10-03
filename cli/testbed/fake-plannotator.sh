#!/bin/sh
# A stand-in for `plannotator review --patch-file - --json` in tests: it keeps
# the patch it was given in $FAKE_PLANNOTATOR_PATCH and answers with
# $FAKE_PLANNOTATOR_DECISION (default approved). No browser opens.
[ "$1 $2 $3 $4" = "review --patch-file - --json" ] || { echo "unexpected args: $*" >&2; exit 2; }
cat > "${FAKE_PLANNOTATOR_PATCH:-/dev/null}"
printf '{"decision":"%s","message":"%s"}\n' "${FAKE_PLANNOTATOR_DECISION:-approved}" "Looks right to the stand-in reviewer."
