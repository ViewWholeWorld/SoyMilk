import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ReleaseManifest {
  schema: 1;
  revision: string;
  image: string;
  migrationsHash: string;
  composeHash: string;
}

export function fingerprints(root: string) {
  const hash = createHash("sha256");
  const dir = path.join(root, "database/migrations");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) {
    hash.update(name).update("\0").update(readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n")).update("\0");
  }
  return {
    migrationsHash: hash.digest("hex"),
    composeHash: createHash("sha256").update(readFileSync(path.join(root, "docker-compose.yml"), "utf8").replace(/\r\n/g, "\n")).digest("hex"),
  };
}

export function validateManifest(value: unknown): ReleaseManifest {
  const m = value as Partial<ReleaseManifest> | null;
  if (!m || m.schema !== 1 || typeof m.revision !== "string" || !/^[a-f0-9]{40}$/.test(m.revision)
    || typeof m.image !== "string" || !/^ghcr\.io\/viewwholeworld\/soymilk@sha256:[a-f0-9]{64}$/.test(m.image)
    || typeof m.migrationsHash !== "string" || !/^[a-f0-9]{64}$/.test(m.migrationsHash)
    || typeof m.composeHash !== "string" || !/^[a-f0-9]{64}$/.test(m.composeHash)) {
    throw new Error("Invalid release manifest");
  }
  return { schema: 1, revision: m.revision, image: m.image, migrationsHash: m.migrationsHash, composeHash: m.composeHash };
}

export function releaseOverlay(images: Record<"setup" | "api" | "worker" | "web", string>) {
  for (const image of Object.values(images)) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image) && !/^ghcr\.io\/viewwholeworld\/soymilk@sha256:[a-f0-9]{64}$/.test(image)) {
      throw new Error("Expected immutable image reference");
    }
  }
  return "services:\n" + Object.entries(images).map(([role, image]) =>
    `  ${role}:\n    image: ${JSON.stringify(image)}\n    pull_policy: never\n`
    + (role === "setup" ? '    command: ["sh", "-c", "node scripts/migrate.ts && node scripts/seed.ts --topics-only"]\n' : "")).join("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, root, revision, image, output] = process.argv.slice(2);
  if (mode === "fingerprint" && root) console.log(JSON.stringify(fingerprints(root)));
  else if (mode === "create" && root && output) {
    writeFileSync(output, JSON.stringify(validateManifest({ schema: 1, revision, image, ...fingerprints(root) }), null, 2) + "\n");
  } else throw new Error("Expected fingerprint ROOT or create ROOT REVISION IMAGE OUTPUT");
}
