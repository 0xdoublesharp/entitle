import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function output(t) {
  await access("/Volumes/Scratch");
  const parent = "/Volumes/Scratch/entitle/tmp/site-split-builds";
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "case-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function build(script, dir, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, BUILD_DIR: dir, TMPDIR: dir, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
async function bundle(dir, extension) {
  const names = (await readdir(join(dir, "assets"))).filter((name) =>
    name.endsWith(extension),
  );
  return (
    await Promise.all(
      names.map((name) => readFile(join(dir, "assets", name), "utf8")),
    )
  ).join("\n");
}

test("self-hosted app build opens the dashboard and excludes marketing UI", async (t) => {
  const dir = await output(t);
  build("scripts/build-web.ts", dir);
  const html = await readFile(join(dir, "web/index.html"), "utf8");
  assert.match(html, /Seller dashboard/);
  assert.doesNotMatch(
    await bundle(join(dir, "web"), ".js"),
    /Private updates in WordPress/,
  );
  assert.doesNotMatch(await bundle(join(dir, "web"), ".css"), /\.home-page/);
  await access(join(dir, "web/customer.html"));
  await access(join(dir, "web/legal/source.tar.gz"));
});

test("marketing is independently built without dashboard or payment UI", async (t) => {
  const dir = await output(t);
  build("scripts/build-marketing.ts", dir, { WEB_APP_URL: "/app/" });
  const html = await readFile(join(dir, "marketing/index.html"), "utf8");
  assert.match(html, /Software licensing/);
  const js = await bundle(join(dir, "marketing"), ".js");
  assert.match(js, /Private updates in WordPress/);
  assert.doesNotMatch(
    js,
    /Confirm seller sign in|Use a recovery code|stripe-js/,
  );
  await access(join(dir, "marketing/docs.html"));
});

test("hosted output has separate shells and retains both sets of immutable assets", async (t) => {
  const dir = await output(t);
  build("scripts/build-hosted-web.ts", dir);
  const root = join(dir, "hosted-web");
  assert.match(
    await readFile(join(root, "index.html"), "utf8"),
    /Software licensing/,
  );
  const app = await readFile(join(root, "app/index.html"), "utf8");
  assert.match(app, /Seller dashboard/);
  assert.match(app, /name="entitle-app-base" content="\/app"/);
  assert.match(app, /src="\/app\/assets\//);
  const asset = app.match(/src="\/app\/assets\/([^"]+\.js)"/)[1];
  await access(join(root, "assets", asset));
  assert.doesNotMatch(
    await readFile(join(root, "assets", asset), "utf8"),
    /Private updates in WordPress/,
  );
  await access(join(root, "app/customer.html"));
});

test("app mount and marketing destination can change without changing source", async (t) => {
  const dir = await output(t);
  build("scripts/build-web.ts", dir, { WEB_APP_BASE_PATH: "/console" });
  const html = await readFile(join(dir, "web/index.html"), "utf8");
  assert.match(html, /name="entitle-app-base" content="\/console"/);
  assert.match(html, /src="\/console\/assets\//);
  build("scripts/build-marketing.ts", dir, {
    WEB_APP_URL: "https://app.example.test/console/",
  });
  assert.match(
    await readFile(join(dir, "marketing/index.html"), "utf8"),
    /name="entitle-app-url" content="https:\/\/app.example.test\/console\/"/,
  );
});

test("build configuration rejects ambiguous application destinations", async () => {
  const { marketingApplicationUrl } =
    await import("../scripts/frontend-build.ts");
  assert.equal(marketingApplicationUrl(), "/app/");
  assert.equal(
    marketingApplicationUrl("https://app.example.test"),
    "https://app.example.test/",
  );
  for (const input of [
    "//other.test/app",
    "/app/../other",
    "https://app.test/app/../other",
    "https://user:pass@app.test/app",
    "https://app.test/app?secret=1",
    "javascript:alert(1)",
    "/app\\other",
    "/app#token",
  ])
    assert.throws(() => marketingApplicationUrl(input));
});
