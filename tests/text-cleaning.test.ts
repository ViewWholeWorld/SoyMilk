import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTags } from "@aihot/backend/lib/text";

test("HTML 属性内的大于号、未加引号值的撇号和注释不泄露或吞掉正文", () => {
  for (const html of ['<a title="Platforms > Xbox" href="/xbox">Xbox</a>', "<a title='Platforms > Xbox'>Xbox</a>", '<a title = "don\'t > do">Xbox</a>']) assert.equal(stripTags(html), "Xbox");
  assert.equal(stripTags("<a title=don't>Xbox</a><p title=it's>next paragraph</p>"), "Xbox next paragraph");
  for (const comment of ["<!-- note -->", "<!-->", "<!--->", "<!-- note --!>", "<!-- don't -->"]) assert.equal(stripTags(`${comment}<p>visible article</p>`), "visible article");
  assert.equal(stripTags('text <a title="unfinished>visible'), "text");
});

test("HTML文字解码数字、命名及双重实体，保留未知实体与地址参数", () => {
  assert.equal(stripTags("AI&#8217;s leaders, AT&#038;T &#x2014; done&#8230;"), "AI’s leaders, AT&T — done…");
  assert.equal(stripTags("AI&amp;#8217;s &amp;lt;7d&gt;"), "AI’s <7d>");
  assert.equal(stripTags("Gemini &mdash; &ldquo;fast&rdquo; &amp;hellip; caf&eacute; 5&times;"), "Gemini — “fast” … café 5×");
  assert.equal(stripTags("?a=1&copy=2 &unknown; AT&T"), "?a=1&copy=2 &unknown; AT&T");
  assert.equal(stripTags("<script>hidden</script><style>hidden</style><noscript>hidden</noscript><p>one</p><p>two</p>"), "one two");
});
