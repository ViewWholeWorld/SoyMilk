#!/bin/sh

# GitHub compare(main...tag): a tag already merged into main has status=behind and ahead_by=0.
# The exact same commit has status=identical and ahead_by=0. A tag ahead of or diverged from
# main must not pass the release gate.
release_ref_is_on_main() {
  case "${1:-}:${2:-}" in
    behind:0|identical:0) return 0 ;;
    *) return 1 ;;
  esac
}

# Reads a JSON argument, or stdin when no argument is given (auto-release.sh pipes the response).
release_json_input() {
  if [ "$#" -gt 0 ]; then printf '%s' "$1"; else cat; fi
}

# Reads the nested object.sha from a tag ref or tag object response. The top-level sha of an
# annotated tag is the tag object itself and must never be used for compare or CI lookups.
release_object_sha() {
  release_json_input "$@" | tr -d '\r\n' |
    sed -n 's/.*"object"[[:space:]]*:[[:space:]]*{[^{}]*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{40\}\)".*/\1/p'
}

# Reads the nested object.type ("commit" for a lightweight tag, "tag" for an annotated tag).
release_object_type() {
  release_json_input "$@" | tr -d '\r\n' |
    sed -n 's/.*"object"[[:space:]]*:[[:space:]]*{[^{}]*"type"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p'
}

# The only accepted CI state: the newest push run for the tag commit is completed and successful.
# A newer queued/in-progress run, a failed rerun, or PR-only success must all be rejected.
release_ci_allows() {
  [ "${1:-}" = completed ] && [ "${2:-}" = success ]
}
