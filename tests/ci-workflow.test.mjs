import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const workflow = await readFile(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
function job(name) {
  const text = workflow
    .split(`\n  ${name}:\n`)[1]
    ?.split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.ok(text, `missing ${name} job`);
  return text;
}
function script(text, anchor) {
  assert.ok(text.includes(anchor), `missing ${anchor}`);
  const block = text.slice(text.indexOf(anchor) + anchor.length);
  const run = block.match(/\n        run: \|\n((?:          .*\n|\n)+)/);
  assert.ok(run, `missing script after ${anchor}`);
  return run[1].replace(/^          /gm, "");
}

test("deployment dispatch accepts only successful canonical main push or manual runs", async () => {
  const notify = await readFile(
    new URL("../.github/workflows/notify.yml", import.meta.url),
    "utf8",
  );
  const expression = notify
    .match(/\n    if: ([\s\S]*?)\n    runs-on:/)[1]
    .replace(/^>-\n/, "");
  const eligible = new Function("github", "vars", `return ${expression}`);
  const baseline = () => ({
    repository: "doublesharp/entitle",
    event: {
      workflow_run: {
        conclusion: "success",
        event: "push",
        head_branch: "main",
        head_repository: { full_name: "doublesharp/entitle" },
      },
    },
  });
  const vars = { DISPATCH_APP_ID: "123" };
  assert.equal(eligible(baseline(), vars), true);
  const manual = baseline();
  manual.event.workflow_run.event = "workflow_dispatch";
  assert.equal(eligible(manual, vars), true);
  for (const change of [
    (github) => { github.repository = "fork/entitle"; },
    (github) => { github.event.workflow_run.event = "pull_request"; },
    (github) => { github.event.workflow_run.head_repository.full_name = "fork/entitle"; },
    (github) => { github.event.workflow_run.head_branch = "feature"; },
    (github) => { github.event.workflow_run.conclusion = "failure"; },
  ]) {
    const github = baseline();
    change(github);
    assert.equal(eligible(github, vars), false);
  }
  assert.equal(eligible(baseline(), { DISPATCH_APP_ID: "" }), false);
});
async function fixture(t) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/ci-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = async (name, text) => {
    await writeFile(
      join(root, name),
      "#!/bin/bash\nset -euo pipefail\n" + text,
    );
    await chmod(join(root, name), 0o755);
  };
  return { root, executable };
}

test("server build overlaps checks, publishes only a candidate, and promotion waits for all shards", () => {
  const build = job("server-build");
  assert.match(build, /needs: changes/);
  assert.match(build, /github.event_name != 'pull_request'/);
  assert.match(
    build,
    /build-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/,
  );
  assert.doesNotMatch(build, /:source-|tags:[\s\S]*:input-/);
  const promote = job("server-image");
  for (const dependency of [
    "changes",
    "server-build",
    "server-checks",
    "server-tests",
  ])
    assert.match(promote.split("steps:")[0], new RegExp(dependency));
  assert.match(promote, /outputs.server == 'false'/);
  assert.doesNotMatch(promote, /docker\/build-push-action/);
  assert.match(promote, /name: server-image-\$\{\{ github.sha \}\}/);
  assert.match(promote, /path: server-digest.txt/);
});

test("three independent test shards use the entire current root test list and retain stable gate names", () => {
  const shards = job("server-tests");
  assert.match(shards, /shard: \[1, 2, 3\]/);
  assert.match(shards, /fail-fast: false/);
  assert.match(shards, /--test-shard=\$\{\{ matrix.shard \}\}\/3/);
  assert.match(
    shards,
    /--test-concurrency=1 tests\/\*\.test\.ts tests\/\*\.test\.mjs web\/\*\.test\.ts/,
  );
  assert.match(job("server-checks"), /pnpm typecheck && pnpm lint/);
  assert.doesNotMatch(job("server-checks"), /pnpm test/);
  assert.match(
    job("server-checks"),
    /if: github.event_name == 'pull_request'\n      -?\s*run: pnpm build:server/,
  );
  for (const name of ["server-tests", "server-build"])
    assert.match(job("ci-required").split("steps:")[0], new RegExp(name));
  assert.match(job("ci-required"), /name: ci-required/);
});

test("frontend qualifies router changes before runtime qualification tags are published", () => {
  assert.match(
    job("frontend"),
    /if: env.FRONTEND_RUNTIME_SMOKE == '1'\n        run: node --test tests\/api-router.test.mjs\n        env:\n          API_ROUTER_SMOKE: ['"]1['"]/,
  );
  assert.match(
    job("changes"),
    /runtime_hash=.*deploy\/api-router-entrypoint.sh/,
  );
  assert.match(job("web-runtime"), /needs: \[changes, frontend\]/);
});

test("change detection forces all qualifying test/tooling changes, and PRs never contact registry", async (t) => {
  const { root, executable } = await fixture(t);
  await writeFile(join(root, "input"), "same-image-input");
  await executable(
    "git",
    'if [[ "$1" == ls-files ]]; then printf "input\\0"; else printf "%s\\n" "${CHANGED_FILE:-}"; fi\n',
  );
  await executable(
    "docker",
    'printf "%s\\n" "$*" >> "$CALLS"\nif [[ "$1" == login ]]; then cat >/dev/null; fi\n',
  );
  const run = (file, event = "push", owner = "0xDoubleSharp") =>
    spawnSync("bash", ["-c", script(job("changes"), "- id: changes")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_REPOSITORY_OWNER: owner,
        GITHUB_ACTOR: "ci",
        BASE_SHA: "a".repeat(40),
        REGISTRY_TOKEN: "do-not-print-token",
        GITHUB_OUTPUT: join(root, "output"),
        CALLS: join(root, "calls"),
        CHANGED_FILE: file,
      },
    });
  for (const file of [
    "tests/ci-results.test.mjs",
    "tests/core.test.ts",
    "scripts/deployment/check-ci-results.mjs",
    "scripts/build.ts",
    ".github/workflows/ci.yml",
    ".node-version",
    "eslint.config.js",
    "tsconfig.json",
    "pnpm-lock.yaml",
  ]) {
    await writeFile(join(root, "output"), "");
    const result = run(file);
    assert.equal(result.status, 0, result.stderr);
    const output = await readFile(join(root, "output"), "utf8");
    assert.match(output, /server=true/, file);
    assert.match(output, /runtime=true/, file);
    assert.match(output, /^image_root=ghcr\.io\/0xdoublesharp$/m, file);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-token/);
  }
  // Cache probes use the repository owner's lowercase namespace.
  const probes = await readFile(join(root, "calls"), "utf8");
  assert.match(probes, /^manifest inspect ghcr\.io\/0xdoublesharp\/entitle-server:input-[0-9a-f]{64}$/m);
  assert.match(probes, /^manifest inspect ghcr\.io\/0xdoublesharp\/entitle-web-runtime:input-[0-9a-f]{64}$/m);
  assert.doesNotMatch(probes, /do-not-print-token|ghcr\.io\/(?!0xdoublesharp\/)/);
  for (const owner of ["", "bad/owner"]) {
    assert.notEqual(run("docs/guide.md", "push", owner).status, 0, owner);
  }
  await writeFile(join(root, "output"), "");
  assert.equal(run("docs/guide.md").status, 0);
  assert.match(
    await readFile(join(root, "output"), "utf8"),
    /server=false\nruntime=false/,
  );
  await writeFile(join(root, "calls"), "");
  await writeFile(join(root, "output"), "");
  assert.equal(run("docs/guide.md", "pull_request").status, 0);
  assert.equal(await readFile(join(root, "calls"), "utf8"), "");
  assert.match(
    await readFile(join(root, "output"), "utf8"),
    /server=true\nruntime=true/,
  );
});

test("image names and source labels follow the repository owner", () => {
  assert.doesNotMatch(workflow, /ghcr\.io\/doublesharp|github\.com\/doublesharp/);
  // The only registry namespace is the one the changes job derives from the owner.
  assert.deepEqual(workflow.match(/ghcr\.io\/[^\s"']*/g), ["ghcr.io/$owner"]);
  assert.match(job("changes"), /image_root: \$\{\{ steps\.changes\.outputs\.image_root \}\}/);
  for (const name of ["server-build", "server-image", "web-runtime"]) {
    assert.match(job(name), /\$\{\{ needs\.changes\.outputs\.image_root \}\}\/entitle-/, name);
  }
  assert.equal(
    workflow.match(/org\.opencontainers\.image\.source=\$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}/g)?.length,
    2,
  );
});

test("tag publication preserves the selected digest and rejects a registry digest mismatch", async (t) => {
  const { root, executable } = await fixture(t);
  const digest = `sha256:${"a".repeat(64)}`;
  await executable(
    "docker",
    `
if [[ "$3" == create ]]; then
  [[ " $* " == *" --prefer-index=false "* ]]
  [[ "\u0024{!#}" == "$IMAGE@$DIGEST" ]]
  printf '%s\\n' "$*" >> "$CALLS"
elif [[ "$3" == inspect ]]; then
  if [[ "\u0024{MISMATCH:-0}" == 1 ]]; then printf 'sha256:%064d\\n' 0; else printf '%s\\n' "$DIGEST"; fi
else exit 1; fi
`,
  );
  const publish = script(job("server-image"), "- name: Publish qualified tags");
  const run = (selected = digest, mismatch = "0") =>
    spawnSync("bash", ["-c", publish], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        DIGEST: selected,
        IMAGE: "ghcr.io/doublesharp/entitle-server",
        SOURCE_SHA: "b".repeat(40),
        INPUT_HASH: "c".repeat(64),
        CALLS: join(root, "calls"),
        MISMATCH: mismatch,
      },
    });
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(
    (await readFile(join(root, "server-digest.txt"), "utf8")).trim(),
    digest,
  );
  const calls = await readFile(join(root, "calls"), "utf8");
  assert.match(calls, /:source-b{40}/);
  assert.match(calls, /:input-c{64}/);
  await rm(join(root, "server-digest.txt"));
  assert.notEqual(run(digest, "1").status, 0);
  await assert.rejects(readFile(join(root, "server-digest.txt")));
  assert.notEqual(run("invalid").status, 0);
});

// Evaluate the workflow's own boolean guard against GitHub-style needs fixtures.
test("promotion rejects failed matrix/build/check dependencies and permits only explicit cache skips", () => {
  const expression = job("server-image")
    .match(/if: >-\n([\s\S]*?)\n    runs-on:/)[1]
    .replace(/always\(\)/g, "true")
    .replace(/github\.event_name/g, "event")
    .replace(
      /needs\.([a-z-]+)\.result/g,
      (_, name) => `needs["${name}"].result`,
    )
    .replace(
      /needs\.changes\.outputs\.server/g,
      "needs.changes.outputs.server",
    );
  const eligible = new Function("needs", "event", `return ${expression}`);
  const baseline = () => ({
    changes: { result: "success", outputs: { server: "true" } },
    "server-build": { result: "success" },
    "server-checks": { result: "success" },
    "server-tests": { result: "success" },
  });
  assert.equal(eligible(baseline(), "push"), true);
  assert.equal(eligible(baseline(), "workflow_dispatch"), true);
  assert.equal(eligible(baseline(), "pull_request"), false);
  for (const name of [
    "changes",
    "server-build",
    "server-checks",
    "server-tests",
  ]) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const needs = baseline();
      needs[name].result = result;
      assert.equal(eligible(needs, "push"), false, `${name}: ${result}`);
    }
  }
  const cached = baseline();
  cached.changes.outputs.server = "false";
  cached["server-checks"].result = cached["server-tests"].result = "skipped";
  assert.equal(eligible(cached, "push"), true);
  cached["server-tests"].result = "failure";
  assert.equal(eligible(cached, "push"), false);
});
