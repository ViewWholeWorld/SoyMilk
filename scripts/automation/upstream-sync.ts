import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const protectedPaths = [
  "industry/", ".github/", "deploy/", "database/migrations/",
  "packages/backend/src/providers/", "packages/backend/src/operations/bootstrap-budget.ts",
  "packages/backend/src/config.ts", "AGENTS.md", "Dockerfile", "docker-compose.yml",
];

export function requiresReview(files: string[]): string[] {
  return files.filter((file) => protectedPaths.some((entry) =>
    entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

export function prepareCandidate(cwd: string, runId: string, upstream = "https://github.com/KKKKhazix/AIHOT.git") {
  if (!/^\d+$/.test(runId)) throw new Error("Expected a numeric workflow run ID");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  git("fetch", "origin", "main");
  git("checkout", "--detach", "origin/main");
  const base = git("rev-parse", "HEAD");
  git("fetch", upstream, "main");
  const upstreamSha = git("rev-parse", "FETCH_HEAD");
  if (spawnSync("git", ["merge-base", "--is-ancestor", upstreamSha, base], { cwd }).status === 0) {
    return { changed: "false", base, sha: base, branch: "" };
  }
  const ancestor = git("merge-base", base, upstreamSha);
  const files = git("diff", "--no-renames", "--name-only", "-z", ancestor, upstreamSha).split("\0").filter(Boolean);
  const guarded = requiresReview(files);
  if (guarded.length) throw new Error(`Manual review required for: ${guarded.join(", ")}`);
  const branch = `codex/upstream-sync-${runId}`;
  git("checkout", "-b", branch);
  git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "merge", "--no-ff", upstreamSha, "-m", `Merge upstream/main ${upstreamSha.slice(0, 12)}`);
  const sha = git("rev-parse", "HEAD");
  git("push", "origin", `HEAD:refs/heads/${branch}`);
  return { changed: "true", base, sha, branch };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = prepareCandidate(process.cwd(), process.env.GITHUB_RUN_ID ?? "");
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""));
  console.log(result.changed === "true" ? `Prepared candidate ${result.sha}` : "Already contains upstream/main");
}
