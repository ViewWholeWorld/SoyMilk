import assert from "node:assert/strict";
import { test } from "node:test";
import { resizeImage } from "@aihot/backend/media/images";

test("图片代理拒绝超过像素预算的图像", async () => {
  const huge = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><rect width="1" height="1"/></svg>');
  await assert.rejects(resizeImage(huge, "image/svg+xml", "image-720"), /pixel limit/);
});
