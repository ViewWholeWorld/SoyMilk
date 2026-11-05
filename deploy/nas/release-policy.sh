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
