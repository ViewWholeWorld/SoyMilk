import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimelineCard } from "@aihot/contracts/site";
import { isUnreadCard, shouldLoadUnread } from "../app/features/feed/unread.ts";

test("读过代表文章仍能找到未读成员，全部读完才隐藏", () => {
  const card = { item:{ id:"representative" },group:{ memberIds:["representative","member"] } } as TimelineCard;
  assert.equal(isUnreadCard(card,new Set(["representative"])),true);
  assert.equal(isUnreadCard(card,new Set(["representative","member"])),false);
  assert.equal(isUnreadCard({ ...card,group:null },new Set(["representative"])),false);
  assert.equal(isUnreadCard({ ...card,group:{ ...card.group!,memberIds:undefined } },new Set()),true);
});
test("未读自动翻页有上限，失败等待手动重试，已有可见内容不继续取页", () => {
  assert.equal(shouldLoadUnread(0,"next",1,false,false,3),true);
  assert.equal(shouldLoadUnread(0,"next",3,false,false,3),false);
  assert.equal(shouldLoadUnread(0,"next",2,false,true,3),false);
  assert.equal(shouldLoadUnread(0,"next",2,true,false,3),false);
  assert.equal(shouldLoadUnread(0,null,2,false,false,3),false);
  assert.equal(shouldLoadUnread(1,"next",2,false,false,3),false);
});
