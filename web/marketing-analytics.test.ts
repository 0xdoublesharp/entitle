import assert from "node:assert/strict";
import { test } from "node:test";
import { trackMarketingPageview } from "./marketing-analytics.ts";

const origin = "https://entitle.doublesharp.com";

function browser(href: string) {
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  return {
    requests,
    location: new URL(href),
    navigator: {
      doNotTrack: null as string | null,
      globalPrivacyControl: false,
    },
    localStorage: { getItem: (_key: string): string | null => null },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ? { input, init } : { input });
      return new Response();
    },
  };
}

test("public marketing sends a single path-only pageview", async () => {
  for (const [path, url] of [
    ["/", "/"],
    ["/docs", "/docs"],
    ["/docs/", "/docs"],
  ]) {
    const page = browser(`${origin}${path}?key=private#token`);
    await trackMarketingPageview(page);
    assert.deepEqual(page.requests, [
      {
        input: "https://umami.apps.doublesharp.com/api/send",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          referrerPolicy: "no-referrer",
          keepalive: true,
          body: JSON.stringify({
            type: "event",
            payload: {
              website: "31ea668e-2065-4976-a188-91e09a13792f",
              hostname: "entitle.doublesharp.com",
              url,
            },
          }),
        },
      },
    ]);
  }
});

test("marketing tracking excludes other origins and paths", async () => {
  for (const href of [
    "http://entitle.doublesharp.com/docs",
    "https://entitle.doublesharp.com:8443/docs",
    "https://staging.entitle.doublesharp.com/docs",
    "http://localhost:3211/",
    `${origin}/app/docs`,
    `${origin}/app/seller`,
    `${origin}/app/t/tenant`,
    `${origin}/missing`,
  ]) {
    const page = browser(href);
    await trackMarketingPageview(page);
    assert.deepEqual(page.requests, [], href);
  }
});

test("marketing tracking respects browser privacy preferences", async () => {
  const dnt = browser(origin);
  dnt.navigator.doNotTrack = "1";
  const gpc = browser(origin);
  gpc.navigator.globalPrivacyControl = true;
  const optOut = browser(origin);
  optOut.localStorage.getItem = (key) =>
    key === "umami.disabled" ? "true" : null;
  const blocked = browser(origin);
  blocked.localStorage.getItem = () => {
    throw new Error("Storage disabled");
  };
  for (const page of [dnt, gpc, optOut, blocked]) {
    await trackMarketingPageview(page);
    assert.deepEqual(page.requests, []);
  }
});

test("collector errors are non-blocking", async () => {
  const page = browser(origin);
  page.fetch = async () => {
    throw new Error("Collector unavailable");
  };
  await assert.doesNotReject(trackMarketingPageview(page));
});
