import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeyboardEvent } from "react";
import { outlineHeight, scrollOutline } from "../app/features/item/outline-scroll.ts";

test("目录扣除来源等区域，键盘到边界仍留在目录，Tab 和组合键保持原行为", () => {
  assert.equal(outlineHeight(695,314),357);
  assert.equal(outlineHeight(300,314),0);
  const nav={scrollTop:0,scrollHeight:1086,clientHeight:357};
  let prevented=0;
  const press=(key:string,ctrlKey=false) => scrollOutline({key,ctrlKey,currentTarget:nav,preventDefault:() => {prevented++;}} as unknown as KeyboardEvent<HTMLElement>);
  press('End'); assert.equal(nav.scrollTop,729);
  press('ArrowDown'); assert.equal(nav.scrollTop,729); assert.equal(prevented,2);
  press('Home'); assert.equal(nav.scrollTop,0);
  press('ArrowUp'); assert.equal(nav.scrollTop,0);
  press('PageDown'); assert.equal(nav.scrollTop,321.3);
  const count=prevented; press('Tab'); press('End',true); assert.equal(prevented,count);
});
