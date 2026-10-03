import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, unlinkSync, openSync, closeSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { fingerprints, releaseOverlay, validateManifest, type ReleaseManifest } from "./release-manifest.ts";

type Stage = "compatible" | "snapshot" | "stop" | "backup" | "install" | "migrate" | "start" | "smoke" | "complete";
export interface DeploymentActions {
  compatible(): void;
  snapshot(): void;
  stop(): void;
  backup(): void;
  install(): void;
  migrate(): void;
  start(): void;
  smoke(): void;
  complete(): void;
  rollback(): void;
}

export function runDeployment(actions: DeploymentActions) {
  let stage: Stage = "compatible";
  let recoveryNeeded = false;
  try {
    for (const next of ["compatible", "snapshot", "stop", "backup", "install", "migrate", "start", "smoke", "complete"] as const) {
      stage = next;
      if (next === "stop") recoveryNeeded = true;
      actions[next]();
    }
    return { status: "deployed", stage };
  } catch {
    if (!recoveryNeeded) return { status: "blocked", stage };
    try { actions.rollback(); return { status: "rolled-back", stage }; }
    catch { return { status: "rollback-failed", stage }; }
  }
}

export function assertCompatible(release: ReleaseManifest, current: ReturnType<typeof fingerprints>, candidate: ReturnType<typeof fingerprints>) {
  if (release.migrationsHash !== current.migrationsHash || release.composeHash !== current.composeHash
    || release.migrationsHash !== candidate.migrationsHash || release.composeHash !== candidate.composeHash) {
    throw new Error("Migration or Compose changes require manual approval");
  }
}

function main() {
  const root = process.env.SOYMILK_DEPLOY_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error("SOYMILK_DEPLOY_ROOT must be absolute");
  const docker = process.env.SOYMILK_DOCKER ?? "/usr/local/bin/docker";
  const state = path.join(root, ".data/auto-deploy");
  const overlay = path.join(root, "deploy/nas/compose.release.yml");
  const journal = path.join(state, "journal.json");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  process.env.DOCKER_CONFIG = path.join(root, ".docker");
  process.env.NO_PROXY = "localhost,127.0.0.1";
  const logFile = path.join(state, "deployment.log");
  const run = (command: string, args: string[], outputFile?: string) => {
    const fd = outputFile ? openSync(outputFile, "w", 0o600) : undefined;
    const log = openSync(logFile, "a", 0o600);
    try {
      const r = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 15 * 60_000,
        maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", fd ?? "pipe", log] });
      if (r.status !== 0) throw new Error("Deployment command failed; inspect private deployment.log");
      return r.stdout?.trim() ?? "";
    } finally { closeSync(log); if (fd !== undefined) closeSync(fd); }
  };
  const compose = (...args: string[]) => run("sh", ["deploy/nas/compose.sh", ...args]);
  const atomic = (file: string, value: unknown) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  const status = (value: Record<string, unknown>) => {
    atomic(path.join(state, "status.json"), { checkedAt: new Date().toISOString(), ...value });
    console.log(JSON.stringify(value));
  };
  const currentImage = (role: string) => {
    const id = compose("ps", "-q", role);
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Expected one running service container");
    const image = run(docker, ["inspect", "--format", "{{.Image}}", id]);
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Invalid running image ID");
    return image;
  };
  const fingerprintImage = (image: string) => JSON.parse(run(docker, ["run", "--rm", "--network", "none",
    "--mount", `type=bind,src=${path.join(root, "deploy/nas")},dst=/control,readonly`,
    "--entrypoint", "node", image, "/control/release-manifest.ts", "fingerprint", "/app"])) as ReturnType<typeof fingerprints>;
  const start = () => compose("up", "-d", "--no-build", "--pull", "never", "setup", "api", "worker", "web");
  const smoke = () => {
    run("curl", ["--fail", "--silent", "--show-error", "--retry", "30", "--retry-delay", "2", "--retry-connrefused", "--max-time", "5", "http://127.0.0.1:3000/api/health"]);
    compose("exec", "-T", "web", "node", "scripts/smoke.ts", "--base", "http://127.0.0.1:3000");
    const flags = compose("exec", "-T", "worker", "node", "-e",
      'console.log(JSON.stringify([process.env.CODEX_REUSE_ENABLED,process.env.CODEX_CONCURRENCY,process.env.ANALYZE_CONCURRENCY]))');
    if (flags !== '["true","2","2"]') throw new Error("Worker protection settings changed");
  };
  const recover = () => {
    const saved = JSON.parse(readFileSync(journal, "utf8")) as { backup: string; revision: string };
    if (!/^auto-\d{8}T\d{6}Z-[a-f0-9]{12}$/.test(saved.backup)) throw new Error("Invalid recovery path");
    compose("stop", "-t", "230", "worker", "api", "web");
    copyFileSync(path.join(root, "backups", saved.backup, "rollback.yml"), `${overlay}.tmp`);
    renameSync(`${overlay}.tmp`, overlay);
    start(); smoke();
    const previous = path.join(root, "backups", saved.backup, "current.json");
    const current = path.join(state, "current.json");
    if (existsSync(previous)) copyFileSync(previous, current);
    else if (existsSync(current)) unlinkSync(current);
    atomic(path.join(state, "rejected.json"), { revision: saved.revision });
    unlinkSync(journal);
  };
  const tick = () => {
    if (existsSync(journal)) {
      try { recover(); status({ status: "recovered-interrupted-update" }); }
      catch { status({ status: "rollback-failed" }); return; }
    }
    if (existsSync(path.join(state, "paused"))) { status({ status: "paused" }); return; }
    // Keep controller logs bounded; backups are deliberately never deleted automatically.
    if (existsSync(logFile) && statSync(logFile).size > 10 * 1024 ** 2) renameSync(logFile, path.join(state, "previous.log"));
    const space = statfsSync(state);
    if (space.bavail * space.bsize < 2 * 1024 ** 3) {
      status({ status: "blocked", reason: "less-than-2GiB-free" }); return;
    }
    const manifestFile = path.join(state, "channel.json");
    run("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "60", "--output", `${manifestFile}.tmp`,
      `https://raw.githubusercontent.com/ViewWholeWorld/SoyMilk/deployment-channel/release.json?at=${Date.now()}`]);
    const release = validateManifest(JSON.parse(readFileSync(`${manifestFile}.tmp`, "utf8")));
    renameSync(`${manifestFile}.tmp`, manifestFile);
    for (const [file, result] of [["rejected.json", "blocked-release"], ["current.json", "up-to-date"]] as const) {
      if (existsSync(path.join(state, file)) && JSON.parse(readFileSync(path.join(state, file), "utf8")).revision === release.revision) {
        status({ status: result, revision: release.revision }); return;
      }
    }
    const apiImage = currentImage("api");
    // Pull and validate before stopping a single service.
    run(docker, ["pull", release.image]);
    if (run(docker, ["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', release.image]) !== release.revision) {
      throw new Error("Image revision does not match channel");
    }
    const backupName = `auto-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${release.revision.slice(0, 12)}`;
    const backup = path.join(root, "backups", backupName);
    const result = runDeployment({
      compatible() { assertCompatible(release, fingerprintImage(apiImage), fingerprintImage(release.image));
        if (fingerprints(root).composeHash !== release.composeHash) throw new Error("Host Compose contract changed"); },
      snapshot() {
        mkdirSync(backup, { recursive: true, mode: 0o700 });
        if (existsSync(path.join(state, "current.json"))) copyFileSync(path.join(state, "current.json"), path.join(backup, "current.json"));
        writeFileSync(path.join(backup, "rollback.yml"), releaseOverlay({ setup: apiImage, api: apiImage,
          worker: currentImage("worker"), web: currentImage("web") }), { mode: 0o600 });
        atomic(journal, { backup: backupName, revision: release.revision });
      },
      stop() { compose("stop", "-t", "230", "worker", "api", "web"); },
      backup() {
        run("sh", ["deploy/nas/compose.sh", "exec", "-T", "db", "pg_dump", "-U", "aihot", "-Fc", "aihot"], path.join(backup, "database.dump"));
        run(docker, ["run", "--rm", "--network", "none", "--volumes-from", compose("ps", "-a", "-q", "web"),
          "--entrypoint", "sh", apiImage, "-c", 'cd /data; set --; for d in uploads feedback-screenshots; do if [ -d "$d" ]; then set -- "$@" "$d"; fi; done; if [ "$#" -gt 0 ]; then tar -czf - "$@"; else tar -czf - --files-from /dev/null; fi'], path.join(backup, "files.tar.gz"));
      },
      install() {
        writeFileSync(`${overlay}.tmp`, releaseOverlay({ setup: release.image, api: release.image, worker: release.image, web: release.image }), { mode: 0o600 });
        renameSync(`${overlay}.tmp`, overlay);
      },
      migrate() { compose("run", "--rm", "--no-deps", "setup"); },
      start,
      smoke,
      complete() { atomic(path.join(state, "current.json"), { ...release, deployedAt: new Date().toISOString(), backup: backupName }); unlinkSync(journal); },
      rollback: recover,
    });
    if (result.status !== "deployed") atomic(path.join(state, "rejected.json"), { revision: release.revision });
    status({ ...result, revision: release.revision, backup: backupName });
  };
  const abort = new AbortController();
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { stopping = true; abort.abort(); });
  return (async () => {
    do {
      try { tick(); } catch { status({ status: "retry-later", reason: "check-private-deployment-log" }); }
      if (process.argv.includes("--once") || stopping) break;
      await setTimeout(15 * 60_000, undefined, { signal: abort.signal }).catch(() => {});
    } while (!stopping);
  })();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
