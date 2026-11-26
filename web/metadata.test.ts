import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderPageMetadata } from "./metadata.ts";

test("public page metadata is crawler-readable, distinct, and uses the configured origin", () => {
  const titles = new Set<string>();
  for (const page of ["home", "docs", "seller"] as const) {
    const html = renderPageMetadata(page, "https://licenses.example.com");
    const path = page === "home" ? "/" : `/${page}`;
    const image = `https://licenses.example.com/social/${page}.png?v=2`;
    assert.ok(
      html.includes(
        `property="og:url" content="https://licenses.example.com${path}"`,
      ),
    );
    assert.ok(
      html.includes(
        `rel="canonical" href="https://licenses.example.com${path}"`,
      ),
    );
    assert.ok(
      html.includes(`property="og:image" content="${image}"`),
    );
    assert.ok(
      html.includes(`name="twitter:image" content="${image}"`),
    );
    assert.ok(
      html.includes('name="twitter:card" content="summary_large_image"'),
    );
    assert.ok(html.includes('property="og:image:width" content="1200"'));
    assert.ok(html.includes('property="og:image:height" content="630"'));
    assert.ok(html.includes('property="og:image:alt"'));
    titles.add(/<title>(.*?)<\/title>/.exec(html)![1]!);
  }
  assert.equal(titles.size, 3);
});

test("customer previews contain generic metadata without a misleading canonical or account details", () => {
  const html = renderPageMetadata("customer", "https://licenses.example.com");
  assert.ok(html.includes("Customer account"));
  assert.ok(html.includes('name="robots" content="noindex, nofollow"'));
  assert.ok(!html.includes('rel="canonical"'));
  assert.ok(!html.includes('property="og:url"'));
});

test("preview origin must be an HTTP origin, and HTML attributes are escaped", () => {
  for (const origin of [
    "javascript:alert(1)",
    "https://example.com/path",
    "https://user:pass@example.com",
    "https://example.com?token=secret",
  ])
    assert.throws(() => renderPageMetadata("home", origin));
  const html = renderPageMetadata("home", "https://example.com");
  assert.ok(!html.includes("%SITE_"));
});

test("all preview images are actual 1200 by 630 PNGs", async () => {
  for (const page of ["home", "docs", "seller", "customer"]) {
    const png = await readFile(
      new URL(`./public/social/${page}.png`, import.meta.url),
    );
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  }
});

test("application metadata follows a configurable app mount", () => {
  const html = renderPageMetadata(
    "seller",
    "https://licenses.example.com",
    "/app/",
  );
  assert.match(html, /href="https:\/\/licenses.example.com\/app\/seller"/);
  assert.match(
    html,
    /content="https:\/\/licenses\.example\.com\/app\/social\/seller\.png\?v=2"/,
  );
  assert.throws(() =>
    renderPageMetadata(
      "seller",
      "https://licenses.example.com",
      "/app/../other",
    ),
  );
});
