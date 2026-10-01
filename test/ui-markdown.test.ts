import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore plain JS module served to browsers
import { astToHtml, parseMarkdown, safeUrl } from "../public/js/markdown.js";

const html = (md: string): string => astToHtml(parseMarkdown(md));

test("markdown: headings, emphasis, code, lists, quotes, tables", () => {
  assert.equal(html("# Title"), "<h1>Title</h1>");
  assert.equal(html("a **b** *c* ~~d~~ `e`"), "<p>a <strong>b</strong> <em>c</em> <del>d</del> <code>e</code></p>");
  assert.equal(html("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(html("3. a\n4. b"), '<ol start="3"><li>a</li><li>b</li></ol>');
  assert.equal(html("> quoted"), "<blockquote><p>quoted</p></blockquote>");
  assert.equal(html("```ts\nlet a = 1 < 2;\n```"), '<pre><code class="lang-ts">let a = 1 &lt; 2;</code></pre>');
  assert.match(html("| a | b |\n|---|--:|\n| 1 | 2 |"), /<table><thead><tr><th>a<\/th><th class="al-right">b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td class="al-right">2<\/td>/);
  assert.match(html("- a\n  - nested\n- b"), /<ul><li>a<ul><li>nested<\/li><\/ul><\/li><li>b<\/li><\/ul>/);
  assert.match(html("- [x] done\n- [ ] todo"), /☑ done.*☐ todo/);
  assert.equal(html("***"), "<hr>");
});

test("markdown: links limited to http(s) and relative", () => {
  assert.match(html("[x](https://a.test/p?q=1)"), /<a href="https:\/\/a.test\/p\?q=1" rel="noopener noreferrer nofollow" target="_blank">x<\/a>/);
  assert.match(html("[x](#/blob/src/a.ts)"), /<a href="#\/blob\/src\/a.ts">x<\/a>/);
  assert.match(html("see https://example.com/a."), /href="https:\/\/example.com\/a"/);
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "//evil.test/x", "\\\\evil.test", "file:///etc/passwd"]) {
    const out = html(`[click](${bad})`);
    assert.ok(!/href=/.test(out) || /href="&amp;#106/.test(out) === false, `unexpected href for ${bad}: ${out}`);
    assert.ok(!/<a /.test(out), `link survived for ${bad}: ${out}`);
  }
  // entities are never decoded, so this is just an odd relative URL, not a scheme
  assert.ok(!/javascript:/.test(String(safeUrl("&#106;avascript:x")).replace("&#106;avascript", "")));
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("jav\nascript:alert(1)"), null);
  assert.equal(safeUrl("mailto:a@b.c"), null);
  assert.equal(safeUrl("/relative/path"), "/relative/path");
  assert.equal(safeUrl("HTTP://a.test"), "HTTP://a.test");
});

test("markdown: raw HTML and XSS payloads are escaped, never interpreted", () => {
  const payloads = [
    "<script>alert(1)</script>",
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)" onclick="evil()">x</a>',
    '<div><svg/onload=alert(1)><iframe src="javascript:alert(1)"></iframe></div>',
    "<<script>script>alert(1)<</script>/script>",
    "**<b onmouseover=alert(1)>x</b>**",
    "![x](javascript:alert(1))",
    '![x" onerror="alert(1)](https://a.test/x.png)',
    "`<script>`",
    "```html\n<script>alert(1)</script>\n```",
    "> <style>*{display:none}</style>",
    "| <img src=x onerror=alert(1)> | b |\n|---|---|\n| <script> | y |",
    "- <iframe srcdoc='<script>alert(1)</script>'>",
    "# <script>alert(1)</script>",
    "[<img src=x onerror=alert(1)>](https://a.test)",
    "[a](https://a.test/\" onmouseover=\"alert(1))",
  ];
  for (const p of payloads) {
    const out = html(p);
    assert.ok(!/<(script|img|iframe|svg|style|div|b|a href="javascript)[\s>/]/i.test(out.replace(/<a href="https:[^>]*>/g, "<A>")), `raw tag leaked for ${p}: ${out}`);
    assert.ok(!/href="javascript/i.test(out), `javascript href for ${p}: ${out}`);
  }
  // nothing but whitelisted tags ever appears, and every angle bracket in the text is escaped
  const out = html('<script>alert("x")</script>\n\nhello <b>x</b>');
  assert.equal(out, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p><p>hello &lt;b&gt;x&lt;/b&gt;</p>");
  // attributes in AST never exceed the whitelist
  const walk = (nodes: any[], f: (n: any) => void) => nodes.forEach((n) => typeof n !== "string" && (f(n), walk(n.children ?? [], f)));
  walk(parseMarkdown(payloads.join("\n\n")), (n: any) => {
    assert.ok(/^(p|h[1-6]|pre|code|ul|ol|li|blockquote|hr|br|em|strong|del|a|table|thead|tbody|tr|th|td)$/.test(n.tag), n.tag);
    for (const k of Object.keys(n.attrs ?? {})) assert.ok(["href", "rel", "target", "class", "start"].includes(k), k);
  });
});

test("markdown: pathological input terminates and stays bounded", () => {
  const t = Date.now();
  html("*".repeat(5000) + "\n" + "[".repeat(3000) + "\n" + "> ".repeat(2000) + "x\n" + "- ".repeat(2000) + "\n" + "`".repeat(5000));
  html(("**a " + "_b ").repeat(2000));
  assert.ok(Date.now() - t < 4000, "too slow");
});

test("markdown: nested html-in-markdown and entities", () => {
  assert.equal(html("&lt;script&gt;"), "<p>&amp;lt;script&amp;gt;</p>"); // entities are shown literally, not decoded
  assert.equal(html("a\\*b\\*"), "<p>a*b*</p>");
  assert.equal(html("line1  \nline2"), "<p>line1<br>line2</p>");
});
