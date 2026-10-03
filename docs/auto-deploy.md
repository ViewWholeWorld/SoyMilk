# Automatic Updates

## Upstream Sync

`Sync Upstream` checks `KKKKhazix/AIHOT:main` hourly at minute 17 (GitHub scheduling can be delayed), or can be run manually in Actions. It creates a merge candidate without changing SoyMilk `main`, reuses the complete `Check` workflow, then promotes the exact validated commit only if `main` has not moved. It explicitly dispatches `Check` afterwards: a push made with `GITHUB_TOKEN` does not trigger another push workflow.

Conflicts, failed tests, concurrent edits to `main`, and upstream changes to `industry/`, migration files, deployment/workflow definitions, provider protection, or bootstrap budget code stop automatic promotion. An issue named `Automatic upstream sync needs attention` links to the failed run; GitHub notification preferences control its delivery. Candidate branches are removed after the run. No force push is made to `main`.

Protected-path checks include both sides of renames: moving a protected file outside its original directory still requires review. The regression test verifies this against real, isolated Git repositories.

Database migrations always require manual review, even when they appear additive. This conservative gate avoids making an unverified compatibility decision. Existing SoyMilk industry, model/account settings, budgets and NAS overrides must be preserved when resolving a stopped update.

## Validated Images

After both `check` and `docker` pass on `main`, `publish` builds the Bookworm NAS image, labels it with the exact revision and publishes it to `ghcr.io/viewwholeworld/soymilk`. The package is public like the source repository, allowing anonymous pulls without placing a GitHub token on the NAS. Environment files, data, backups, Docker credentials and private Compose overrides are excluded from the build context.

The `deployment-channel` branch contains only `release.json`, including the exact image digest, source revision, migration fingerprint and root Compose fingerprint. A stale CI run cannot publish a channel update after `main` has moved. Candidate validation and PRs never publish images. No floating `latest` tag is deployed.

## NAS Pull Deployment

The dedicated `soymilk-auto-deploy` container checks the channel immediately on start and then every 15 minutes. Docker's `unless-stopped` policy starts it again after a NAS reboot. It needs outbound GitHub/GHCR access only; no public SSH port, webhook, GitHub PAT or always-on desktop is required. A kernel file lock prevents concurrent deployers.

The controller uses the NAS's existing Docker and Compose clients. It runs as the deployment owner with the Docker socket group, not as a privileged container. **Access to the Docker socket grants administrative control of Docker.** Only trusted code should be installed as this controller. The deployment directory is writable for its release override, backup and state files; client binaries are mounted read-only. It does not load production model environment variables into its own process or print secrets.

It pulls and verifies the revision and fingerprints before stopping anything. Any migration or base Compose change requires manual approval. Routine deployment first gracefully stops the worker (230 seconds maximum, preserving paid calls), then stops API/web, backs up the database plus `uploads/` and `feedback-screenshots/`, runs migrations followed by `seed.ts --topics-only`, starts the pinned images and runs the public smoke checks plus worker reuse/concurrency checks. Topic synchronization updates industry-pack fields by slug without deleting other topics; it does not seed sources or model accounts. Collection, model accounts, budgets and private NAS overrides remain in place. The database service is not replaced.

`deploy/nas/compose.sh` loads all three existing private overrides and finally the generated `compose.release.yml`. The final override pins **setup, API, worker and web**; old tags in the worker/web overrides therefore cannot silently keep an old application version running. This file changes only image references and the setup command, not environment variables, networks, volumes or thresholds. A failed migration prevents topic synchronization; either command failing prevents application startup through this deployment step.

On failure after stopping services, the controller restores the saved immutable application images and checks the old site. It **never restores the old database**, so new receipts and data remain. Migrations or topic synchronization may already have changed some rows when setup fails; application rollback does not undo those changes. A journal recovers an interrupted deployment after restart. Failed or incompatible revisions are blocked from repeated deployment until a newer validated release or manual resolution. Automatic rollback failure requires prompt manual attention. Network/pull errors before cutover retry on the next check while the old site keeps running.

Backups are kept under `backups/auto-*`, not automatically deleted. Less than 2 GiB free space blocks deployment. Check disk capacity and arrange retention separately. Private diagnostic logs are limited to the current and previous 10 MiB log; they must not be copied unfiltered into tickets.

## Operations

Run these in the existing NAS deployment directory:

```sh
# Safe, non-secret state and existing services.
cat .data/auto-deploy/status.json
sh deploy/nas/compose.sh ps

# Pause new deployments without stopping news collection.
touch .data/auto-deploy/paused

# Resume; remove only the pause marker, then trigger an immediate check.
rm .data/auto-deploy/paused
docker restart soymilk-auto-deploy

# Stop the controller completely; the news services keep running.
docker stop soymilk-auto-deploy
```

Use the NAS Docker client's absolute path where `docker` is not on PATH. Do not execute `auto-update.ts` concurrently without its `flock` wrapper. Resolving a blocked migration requires reviewing compatibility, backing up and applying it manually, then re-establishing the approved Compose contract; do not bypass the fingerprint check by altering the channel.

The controller is installed separately from app releases and is not self-updated from downloaded code. Changes to deployment policy need a deliberate, verified controller update. GitHub sync/CI failures create an Issue and use GitHub notifications. NAS failure state is recorded in `status.json` and the container log; push notifications from the NAS are not configured by this feature.

## Verification

2026-10-03: upstream-sync feature commit `3541ec5` passed [Check #5](https://github.com/ViewWholeWorld/SoyMilk/actions/runs/37106698163): 617 backend tests, zero failures/cancellations/skips (the previous baseline was 615; two automation tests were added), 31 web tests, typecheck, web build, empty-site smoke/MCP and Docker checks. The first manual sync found Issues disabled; after enabling Issues, the rerun passed without creating a candidate because upstream was already included.

The `check` and `docker` jobs of [Check #6](https://github.com/ViewWholeWorld/SoyMilk/actions/runs/37107702823), on deployment feature commit `bfafb45`, passed with 621 backend tests, zero failures/cancellations/skips, about 144 seconds, and 31 web tests. Four deployment tests account for the increase from 617; the baseline failures remain resolved. Image publication and live deployment are separate checks, not inferred from these test totals.

The same run's `publish` job also passed the Bookworm image build and isolated startup/smoke check, then published the immutable image and channel. The NAS controller was installed paused while the original news services kept running; live cutover is verified separately before enabling its ongoing polling.

Final shutdown-order commit `4f8e99b` passed all three jobs of [Check #7](https://github.com/ViewWholeWorld/SoyMilk/actions/runs/37108078497): 621 backend tests, zero failures/cancellations/skips, 31 web tests, and both Docker image checks. Deployment status and live smoke are checked separately through the operations commands above.

Deployment unit tests exercise strict manifest parsing, immutable image overrides, portable migration fingerprints, operation ordering, compatibility rejection and application-only rollback on backup/migration/start/smoke failures. Full CI must pass on the release before the NAS can see it in the channel. Empty-site CI skips the existing three leaderboard pages when no data exists; the deployed site's smoke check validates the live public pages independently.
