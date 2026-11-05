// 应用版本与网站日志同步；导航红点仍使用日期时间。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PUBLIC_VERSIONS } from "@aihot/backend/publication/llms";

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const lock = read("package-lock.json");
const log = read("industry/changelog.json");
const spec = read("reference/public-v1.openapi.json");
const readText = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
for (const [name, version] of Object.entries({ lock: lock.version, lockRoot: lock.packages[""].version, changelog: log.version, latestRelease: log.releases[0]?.version, openApi: PUBLIC_VERSIONS.v1OpenApi, openApiDocument: spec.info.version })) {
  assert.equal(version, pkg.version, `${name} 版本不一致`);
}
assert.match(log.latestVersion, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
assert.equal(log.latestVersion, `${log.releases[0].date}T${log.releases[0].time}`);
const readmeVersion = /当前(?:代码)?版本\s+([0-9]+\.[0-9]+\.[0-9]+)/.exec(readText("README.md"))?.[1];
const instructionsVersion = /当前代码版本：\s*\**([0-9]+\.[0-9]+\.[0-9]+)/.exec(readText("AGENTS.md"))?.[1];
assert.equal(readmeVersion, pkg.version, "README 当前版本未同步");
assert.equal(instructionsVersion, pkg.version, "AGENTS 当前版本未同步");
const industryReadme = readText("industry/README.md");
assert.doesNotMatch(industryReadme, /`features\.ts`/, "行业文档引用了已移除的 features.ts");
for (const file of ["site.ts", "taxonomy.ts", "topics.json", "sources.json", "selection.ts", "changelog.json"]) {
  assert.equal(existsSync(new URL(`../industry/${file}`, import.meta.url)), true, `行业文档路径不存在: ${file}`);
}
console.log(`版本同步通过：${pkg.version}；网站日志 ${log.latestVersion}`);
