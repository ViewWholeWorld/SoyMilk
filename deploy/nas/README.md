# NAS Maintenance

Read [the current SoyMilk operations guide](../../docs/soymilk-operations.md) and [automatic deployment](../../docs/auto-deploy.md) before updating an existing site. Historical first-install notes do not describe the current production switches or news counts.

`compose.sh` loads the existing private overrides plus an optional final `compose.release.yml`. Private overrides are not tracked or included in Docker build contexts. Preserve them, production `.env`, data volumes, worker reuse, concurrency limits and budgets.

The compatible production image uses this directory's Bookworm `Dockerfile`. `compose.auto-deploy.yml` runs a separate polling controller with explicit deployment path and pinned control image supplied by the installer. It never opens public access or changes the site's existing HTTP/private-network configuration.

The controller uses the existing NAS Docker client and Compose plugin. Its Docker socket access is an administrative capability: use only trusted, reviewed controller code. It is installed and upgraded deliberately, separately from automatically pulled application images.
