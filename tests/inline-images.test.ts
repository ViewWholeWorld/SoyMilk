import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { proxiedImage, proxyBodyImages } from "@aihot/backend/media/imgproxy";

test("non-image data sources are removed in all source attributes and in saved-body output", () => {
  for (const src of ["data:text/html,probe", "data:application/javascript,probe", "data:,probe", "data:image/png", "DATA:TEXT/HTML,probe"]) {
    assert.equal(proxiedImage(src, "thumb"), null, src);
    for (const attr of ["src", "data-src", "data-original"]) {
      const html = sanitizeBody(`<p>before<img ${attr}="${src}" alt="probe">after</p>`);
      assert.equal(cheerio.load(html)("img").length, 0, `${attr} ${src}`);
      assert.equal(cheerio.load(html)("p").text(), "beforeafter");
      assert.equal(sanitizeBody(html), html);
    }
    assert.equal(proxyBodyImages(`<p>before<img src="${src}" alt="probe">after</p>`), "<p>beforeafter</p>");
    assert.equal(proxyBodyImages(`<video poster="${src}"></video>`), "<video></video>");
  }
});

test("image MIME types, ordinary sources and existing tracking filters retain their behavior", () => {
  for (const src of ["data:image/png;base64,aGVsbG8=", "data:image/jpeg,bytes", "DATA:IMAGE/PNG,bytes", "data:image/svg+xml,%3Csvg%3E", "https://example.org/chart.png"]) {
    for (const attr of ["src", "data-src", "data-original"]) {
      const html = sanitizeBody(`<p>chart<img ${attr}="${src}" alt="chart"></p>`);
      assert.equal(cheerio.load(html)("img").length, 1, src);
      assert.ok(proxiedImage(cheerio.load(html)("img").attr("src"), "thumb"));
      assert.equal(cheerio.load(proxyBodyImages(html))("img").length, 1);
      assert.equal(sanitizeBody(html), html);
    }
  }
  assert.equal(sanitizeBody('<p>text<img src="https://example.org/pixel" width="1" height="1"></p>'), "<p>text</p>");
  assert.equal(proxiedImage("https://ids4.ad.gt/sync", "thumb"), null);
});
