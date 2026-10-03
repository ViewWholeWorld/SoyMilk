# Automatic Updates

## Upstream Sync

`Sync Upstream` checks `KKKKhazix/AIHOT:main` hourly at minute 17 (GitHub scheduling can be delayed), or can be run manually in Actions. It creates a merge candidate without changing SoyMilk `main`, reuses the complete `Check` workflow, then promotes the exact validated commit only if `main` has not moved. It explicitly dispatches `Check` afterwards: a push made with `GITHUB_TOKEN` does not trigger another push workflow.

Conflicts, failed tests, concurrent edits to `main`, and upstream changes to `industry/`, migration files, deployment/workflow definitions, provider protection, or bootstrap budget code stop automatic promotion. An issue named `Automatic upstream sync needs attention` links to the failed run; GitHub notification preferences control its delivery. Candidate branches are removed after the run. No force push is made to `main`.

Database migrations always require manual review, even when they appear additive. This conservative gate avoids making an unverified compatibility decision. Existing SoyMilk industry, model/account settings, budgets and NAS overrides must be preserved when resolving a stopped update.
