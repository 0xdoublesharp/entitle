import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import type { App } from "vue";
import { Window } from "happy-dom";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const dom = new Window({ url: "http://localhost:3211/" });
for (const name of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value:
      name === "window"
        ? dom
        : (dom as unknown as Record<string, unknown>)[name],
  });
const requests: string[] = [];
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string) => {
    requests.push(input);
    return input.endsWith("/info")
      ? Response.json({
          deploymentMode: "hosted",
          maxUploadBytes: 26214400,
          databaseEngines: ["SQLite"],
        })
      : Response.json(
          { error: { message: "Please sign in." } },
          { status: 401 },
        );
  },
});
Object.defineProperty(dom, "fetch", {
  configurable: true,
  value: globalThis.fetch,
});
after(() => dom.happyDOM.close());
const { nextTick } = await import("vue");
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await nextTick();
  }
}
function activeApp() {
  const element = dom.document.querySelector("#app") as unknown as {
    __vue_app__?: App;
  };
  assert.ok(element.__vue_app__);
  return element.__vue_app__;
}

test("production entry points mount the standalone app and independent static marketing site", async () => {
  dom.document.body.innerHTML = '<div id="app"></div>';
  await import("../web/app-entry.ts");
  await flush();
  assert.match(dom.document.body.textContent, /Publisher workspace/);
  assert.doesNotMatch(
    dom.document.body.textContent,
    /First-class WordPress support/,
  );
  assert.ok(requests.includes("/api/v1/platform/me"));
  activeApp().unmount();

  requests.length = 0;
  dom.document.body.innerHTML = '<div id="app"></div>';
  await import("../web/marketing-entry.ts");
  await flush();
  assert.match(dom.document.body.textContent, /First-class WordPress support/);
  assert.equal(requests.length, 0);
  activeApp().unmount();
});

test("standalone documentation mounts locally and fetches runtime limits", async () => {
  dom.history.replaceState(null, "", "/docs");
  dom.document.body.innerHTML = '<div id="app"></div>';
  const { mountDocumentation } = await import("../web/documentation.ts");
  const app = mountDocumentation();
  try {
    await flush();
    assert.match(dom.document.body.textContent, /25 MiB/);
    assert.ok(requests.includes("/api/v1/platform/info"));
  } finally {
    app.unmount();
  }
});
