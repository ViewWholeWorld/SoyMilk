// 应用版本与网站日志同步；导航红点仍使用日期时间。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PUBLIC_VERSIONS } from "@aihot/backend/publication/llms";

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const lock = read("package-lock.json");
const log = read("industry/changelog.json");
const spec = read("reference/public-v1.openapi.json");
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
for (const [name, version] of Object.entries({ lock: lock.version, lockRoot: lock.packages[""].version, changelog: log.version, latestRelease: log.releases[0]?.version, openApi: PUBLIC_VERSIONS.v1OpenApi, openApiDocument: spec.info.version })) {
  assert.equal(version, pkg.version, `${name} 版本不一致`);
}
assert.match(log.latestVersion, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
assert.equal(log.latestVersion, `${log.releases[0].date}T${log.releases[0].time}`);
console.log(`版本同步通过：${pkg.version}；网站日志 ${log.latestVersion}`);
