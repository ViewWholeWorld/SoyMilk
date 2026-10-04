// Architecture boundaries (docs/architecture.md) that otherwise hold only by convention. Each rule reads
// the source and names the file that breaks it. A rule changes here and in that document together.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
type Source = { file: string; text: string };
type Paths = Pick<typeof path, "join" | "resolve" | "relative" | "dirname">;
const rulePath = (file: string) => file.replaceAll("\\", "/");

function sources(dir: string): Source[] {
  const out: Source[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /[/\\](node_modules|build|\.react-router)[/\\]/.test(full)) continue;
    out.push({ file: rulePath(path.relative(ROOT, full)), text: readFileSync(full, "utf8") });
  }
  return out;
}

/** Module specifiers a file imports (static, dynamic and type imports). */
const specifiers = (text: string) => [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

/** A specifier as a path under packages/backend/src (`events/group.ts`), or null outside the backend. */
function backendPath(file: string, spec: string, paths: Paths = path, root = ROOT): string | null {
  if (spec.startsWith("@aihot/backend/")) return `${spec.slice("@aihot/backend/".length)}.ts`;
  if (!spec.startsWith(".")) return null;
  const backend = paths.join(root, "packages/backend/src");
  const target = rulePath(paths.relative(backend, paths.resolve(root, paths.dirname(file), spec)));
  return target === ".." || target.startsWith("../") ? null : target;
}

function violations(files: Source[], broken: (file: string, spec: string) => boolean): string[] {
  return files.flatMap(({ file, text }) => {
    const normalized = rulePath(file);
    return specifiers(text).filter((spec) => broken(normalized, spec)).map((spec) => `${normalized} → ${spec}`);
  });
}

function adminImports(files: Source[], paths: Paths = path, root = ROOT): string[] {
  return violations(files, (file, spec) =>
    !file.startsWith("packages/backend/src/admin/") && (backendPath(file, spec, paths, root)?.startsWith("admin/") ?? false));
}

test("the web reaches the backend only over HTTP", () => {
  const found = violations(sources("apps/web"), (_file, spec) => spec.startsWith("@aihot/backend") || spec.includes("packages/backend") || spec === "postgres" || spec === "pg-boss");
  assert.deepEqual(found, [], "apps/web imports backend code; read it through /api/site or /api/admin instead");
});

test("packages never import the apps, and nothing below the admin imports it", () => {
  assert.deepEqual(violations(sources("packages"), (_file, spec) => /(^|\/)apps\//.test(spec)), []);
  const found = adminImports([...sources("packages/backend/src"), ...sources("apps/worker")]);
  assert.deepEqual(found, [], "admin/ is the top layer: move what others need to the module that owns it");
});

// Public routes read through the public read faces; the rest are the reader's own writes (feedback,
// analytics) and the image proxy. Admin, intake and ingest routes may call any backend use case.
const PRIVATE_ROUTES = new Set(["admin.ts", "admin-auth.ts", "intake.ts", "ingest.ts"]);
const PUBLIC_READS = [/^publication\//, /^leaderboard\/read\.ts$/, /^monitor\/read\.ts$/, /^site\//, /^analytics\//, /^lib\//, /^config\.ts$/, /^operations\/feedback\.ts$/, /^media\//, /^jobs\/queue\.ts$/];

function publicImports(files: Source[], paths: Paths = path, root = ROOT): string[] {
  const routes = files.filter(({ file }) => !PRIVATE_ROUTES.has(path.posix.basename(rulePath(file))));
  return violations(routes, (file, spec) => {
    const target = backendPath(file, spec, paths, root);
    return target !== null && !PUBLIC_READS.some((allowed) => allowed.test(target));
  });
}

test("public routes read content only through the public read layer", () => {
  const found = publicImports(sources("apps/api/src/routes"));
  assert.deepEqual(found, [], "a public route imports backend internals; add or reuse a function in publication/");
});

// Tables whose rules must not be rewritten elsewhere: the public projection and its sync ledger, paid
// receipts, content pushes, grouping, and the audit trail. Other modules read them freely.
const OWNERS: Record<string, string> = {
  publications: "publication/", selected_ledger: "publication/", selected_state: "publication/", pool_search: "publication/",
  receipts: "providers/receipts.ts", receipt_attempts: "providers/receipts.ts", receipt_consumers: "providers/receipts.ts",
  deliveries: "notify/",
  facts: "events/", fact_articles: "events/", stories: "events/", story_signals: "events/", story_aliases: "events/", story_links: "events/",
  story_digests: "events/", grouping_decisions: "events/", grouping_overrides: "events/", regroup_pending: "events/",
  audit_log: "audit.ts",
};

function tableWrites(files: Source[], paths: Paths = path): string[] {
  const found: string[] = [];
  for (const { file, text } of files) {
    const own = rulePath(paths.relative("packages/backend/src", file));
    for (const [, table] of text.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_]+)\b/gi)) {
      const owner = OWNERS[table!.toLowerCase()];
      if (owner && !own.startsWith(owner)) found.push(`${rulePath(file)} writes ${table} (owner ${owner})`);
    }
  }
  return found;
}

test("the tables that carry a rule are written only by the module that owns it", () => {
  const found = tableWrites(sources("packages/backend/src"));
  assert.deepEqual(found, []);
});

function scopeCopies(files: Source[]): string[] {
  return files
    .filter(({ file }) => !rulePath(file).endsWith("publication/scope.ts"))
    .filter(({ text }) => /'scope' = 'composite'|visible_after <= \$\{/.test(text))
    .map(({ file }) => rulePath(file));
}

test("the public scope and the composite rule are spelled once, in publication/scope.ts", () => {
  const found = scopeCopies(sources("packages/backend/src"));
  assert.deepEqual(found, [], "use the predicates of publication/scope.ts");
});

for (const { name, paths, root } of [
  { name: "POSIX", paths: path.posix, root: "/architecture-fixtures" },
  { name: "Windows", paths: path.win32, root: "C:\\architecture-fixtures" },
]) {
  test(`architecture rules detect violations and allow their owners with ${name} paths`, () => {
    const source = (file: string, text: string): Source => ({
      file: paths.relative(root, paths.join(root, file)), text,
    });
    const worker = source("apps/worker/boot.ts", 'import "../../packages/backend/src/admin/models.ts";');
    assert.deepEqual(adminImports([worker], paths, root), [
      "apps/worker/boot.ts → ../../packages/backend/src/admin/models.ts",
    ]);
    assert.deepEqual(adminImports([
      source("packages/backend/src/admin/models.ts", 'import "./settings.ts";'),
      source("apps/worker/boot.ts", 'import "../../packages/backend/src/jobs/queue.ts";'),
    ], paths, root), []);

    const route = source("apps/api/src/routes/site.ts", 'import "../../../../packages/backend/src/providers/receipts.ts";');
    assert.deepEqual(publicImports([route], paths, root), [
      "apps/api/src/routes/site.ts → ../../../../packages/backend/src/providers/receipts.ts",
    ]);
    assert.deepEqual(publicImports([
      source("apps/api/src/routes/site.ts", 'import "../../../../packages/backend/src/publication/read.ts";'),
      source("apps/api/src/routes/admin.ts", 'import "@aihot/backend/providers/receipts";'),
      source("apps/api/src/routes/site.ts", 'import "../helpers.ts";'),
    ], paths, root), []);
    assert.equal(backendPath(route.file, "../../../../packages/backend", paths, root), null);
    assert.equal(backendPath(route.file, "../../../../packages/backend/src/..internal/read.ts", paths, root), "..internal/read.ts");

    const write = "INSERT INTO receipt_consumers (receipt_id) VALUES (1)";
    assert.deepEqual(tableWrites([source("packages/backend/src/content/write.ts", write)], paths), [
      "packages/backend/src/content/write.ts writes receipt_consumers (owner providers/receipts.ts)",
    ]);
    assert.deepEqual(tableWrites([source("packages/backend/src/providers/receipts.ts", write)], paths), []);

    const scope = "'scope' = 'composite' AND visible_after <= ${now}";
    assert.deepEqual(scopeCopies([source("packages/backend/src/content/read.ts", scope)]), [
      "packages/backend/src/content/read.ts",
    ]);
    assert.deepEqual(scopeCopies([source("packages/backend/src/publication/scope.ts", scope)]), []);
  });
}
