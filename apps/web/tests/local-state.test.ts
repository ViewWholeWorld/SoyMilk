import assert from "node:assert/strict";
import { after, test } from "node:test";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const globals = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
const originals = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
after(() => {
  globals.forEach((key, i) => originals[i] ? Object.defineProperty(globalThis, key, originals[i]!) : Reflect.deleteProperty(globalThis, key));
});

let instance = 0;
async function reader(starred: unknown[] = [], values = new Map([["aihot-starred-items", JSON.stringify(starred)]])) {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  // 重新打开页面会清空模块快照缓存，但保留同一份本地存储。
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?test=${instance++}`);
  return { state, values, window, document };
}

async function observeUnread(state: typeof import("../app/lib/local-state.ts")) {
  const root = createRoot(document.getElementById("root")!);
  function Preference() {
    return createElement("output", null, String(state.useUnreadOnly()));
  }
  await act(async () => {
    root.render(createElement("div", null, createElement(Preference), createElement(Preference)));
  });
  return {
    values: () => Array.from(document.querySelectorAll("output"), output => output.textContent),
    close: () => act(async () => { root.unmount(); }),
  };
}

const displayDate = (value: string) => `${beijingDate(value)} ${beijingTime(value)}`;

test("只看未读默认关闭，刷新或新标签页沿用本地偏好，关闭后仍能持久保存", async () => {
  const { state, values } = await reader();
  assert.equal(state.getUnreadOnly(), false);
  state.setUnreadOnly(true);
  assert.equal(values.get(state.KEYS.unreadOnly), "true");
  const reopened = await reader([], values);
  assert.equal(reopened.state.getUnreadOnly(), true);
  reopened.state.setUnreadOnly(false);
  assert.equal(values.has(state.KEYS.unreadOnly), false);
  const nextTab = await reader([], values);
  assert.equal(nextTab.state.getUnreadOnly(), false);
});

test("只看未读通知同页所有订阅者，不更改已有已读记录", async () => {
  const { state, values } = await reader();
  values.set(state.KEYS.read, JSON.stringify(["already-read"]));
  const observed = await observeUnread(state);
  try {
    assert.deepEqual(observed.values(), ["false", "false"]);
    await act(async () => { state.setUnreadOnly(true); });
    assert.deepEqual(observed.values(), ["true", "true"]);
    await act(async () => { state.setUnreadOnly(false); });
    assert.deepEqual(observed.values(), ["false", "false"]);
    assert.deepEqual(state.getReadIds(), ["already-read"]);
  } finally {
    await observed.close();
  }
});

test("只看未读通过 storage 事件同步其他标签页的设置、删除和清空", async () => {
  const { state, values, window } = await reader();
  const observed = await observeUnread(state);
  const notify = async (key: string | null) => {
    await act(async () => {
      const event = new window.Event("storage");
      Object.assign(event, { key, storageArea: window.localStorage });
      window.dispatchEvent(event);
    });
  };
  try {
    values.set(state.KEYS.unreadOnly, "true");
    await notify(state.KEYS.unreadOnly);
    assert.deepEqual(observed.values(), ["true", "true"]);
    values.delete(state.KEYS.unreadOnly);
    await notify(state.KEYS.unreadOnly);
    assert.deepEqual(observed.values(), ["false", "false"]);
    values.set(state.KEYS.unreadOnly, "true");
    await notify(state.KEYS.unreadOnly);
    assert.deepEqual(observed.values(), ["true", "true"]);
    values.clear();
    await notify(null);
    assert.deepEqual(observed.values(), ["false", "false"]);
  } finally {
    await observed.close();
  }
});

test("字体备份兼容旧格式，并尊重已经明确选择的网站字体", async () => {
  const { state } = await reader();
  assert.equal(state.getFontPreference(), null);
  assert.equal((await state.importBundle(JSON.stringify({ version: 1, starred: [], read: [], theme: null }))).fontApplied, false);
  assert.equal((await state.importBundle(JSON.stringify({ version: 1, starred: [], read: [], font: "browser" }))).fontApplied, true);
  assert.equal(state.exportBundle().font, "browser");
  state.setFontPreference("system");
  assert.equal((await state.importBundle(JSON.stringify({ version: 1, font: "browser" }))).fontApplied, false);
  assert.equal(state.getFontPreference(), "system");
});

test("拒绝字体写入时本标签页仍保留选择，不改已有收藏", async () => {
  const { state, values } = await reader([{ id: "original", title: "原收藏" }]);
  const original = values.get(state.KEYS.starred);
  window.localStorage.setItem = () => { throw new Error("denied"); };
  state.setFontPreference("browser");
  assert.equal(state.getFontPreference(), "browser");
  assert.equal(state.exportBundle().font, "browser");
  assert.equal(values.get(state.KEYS.starred), original);
});

test("import keeps bookmarks with invalid dates and persists displayable replacements", async () => {
  const invalid = ["broken", "", "999999-01-01", "+275760-09-13T00:00:00.000Z", null, 42, {}];
  const { state, values } = await reader();
  const before = Date.now();
  const report = await state.importBundle(JSON.stringify({ version: 1, starred: invalid.map((date, i) => ({
    id: `import-${i}`, title: `Bookmark ${i}`, savedAt: date, publishedAt: date,
  })) }));
  assert.equal(report.starredAdded, invalid.length);
  const saved = JSON.parse(values.get(state.KEYS.starred)!);
  assert.equal(saved.length, invalid.length);
  for (const item of saved) {
    assert.equal(item.publishedAt, null);
    assert.ok(Date.parse(item.savedAt) >= before && Date.parse(item.savedAt) <= Date.now());
    assert.doesNotThrow(() => displayDate(item.savedAt));
  }
});

test("stored bookmarks with damaged dates remain readable, exportable and removable", async () => {
  const { state } = await reader([{ id: "stored", title: "Keep me", savedAt: "broken", publishedAt: "broken" }]);
  const starred = state.getStarred();
  assert.equal(starred.length, 1);
  assert.equal(starred[0]!.title, "Keep me");
  assert.equal(starred[0]!.publishedAt, null);
  assert.doesNotThrow(() => displayDate(starred[0]!.savedAt));
  assert.strictEqual(state.getStarred(), starred, "React snapshots must stay stable between changes");
  assert.deepEqual(state.exportBundle().starred, starred);
  await state.removeStar("stored");
  assert.deepEqual(state.getStarred(), []);
});

test("valid dates are preserved and an import cannot replace an existing bookmark", async () => {
  const existing = { id: "valid", title: "Original", savedAt: "2026-09-29T08:30:00+08:00", publishedAt: "2026-09-28T23:00:00Z" };
  const { state } = await reader([existing]);
  const report = await state.importBundle(JSON.stringify({ version: 1, starred: [{ ...existing, title: "Replacement", savedAt: "broken" }] }));
  assert.equal(report.starredAdded, 0);
  const [saved] = state.getStarred();
  assert.equal(saved!.title, existing.title);
  assert.equal(saved!.savedAt, existing.savedAt);
  assert.equal(saved!.publishedAt, existing.publishedAt);
});

// Failure cases before changing storage: denied/quota-full IDs must stay stable in this document;
// expired or corrupt sessions must rotate; another tab's writes must survive a cached-tab edit;
// unreadable bookmarks must not be overwritten and failed writes must not report success.
test("a cached tab merges newer saved bookmarks and read marks before writing", async () => {
  const { state, values } = await reader([{ id: "old", title: "Old" }]);
  state.getStarred();
  state.getReadIds();
  values.set(state.KEYS.starred, JSON.stringify([{ id: "other-tab", title: "Other tab" }, { id: "old", title: "Old" }]));
  values.set(state.KEYS.read, JSON.stringify(["other-tab"]));
  await state.toggleStar({ id: "new", title: "New", summary: null, sourceName: "", publishedAt: null, score: null, aiSelected: false });
  await state.markRead("new");
  assert.deepEqual(state.getStarred().map((s) => s.id), ["new", "other-tab", "old"]);
  assert.deepEqual(state.getReadIds(), ["new", "other-tab"]);
});

test("failed bookmark writes and damaged existing data do not report a successful toggle", async () => {
  const { state, values } = await reader();
  const item = { id: "new", title: "New", summary: null, sourceName: "", publishedAt: null, score: null, aiSelected: false };
  values.set(state.KEYS.starred, "damaged original data");
  assert.equal(await state.toggleStar(item), false);
  assert.equal(values.get(state.KEYS.starred), "damaged original data");
  window.localStorage.setItem = () => { throw new Error("quota"); };
  assert.equal(await state.toggleStar(item), false);
});
