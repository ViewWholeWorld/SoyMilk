import { readFileSync } from "node:fs";

const packageVersion: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "dev";
  }
})();

export function releaseName(): string {
  return process.env.AIHOT_RELEASE || packageVersion;
}
