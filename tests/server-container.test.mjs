import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test(
  "compiled server roles verify PostgreSQL schema and stop cleanly",
  { skip: !process.env.SERVER_CONTAINER_IMAGE, timeout: 180000 },
  async (t) => {
    const image = process.env.SERVER_CONTAINER_IMAGE;
    const suffix = `${process.pid}-${Date.now()}`,
      network = `entitle-roles-${suffix}`,
      postgres = `entitle-pg-${suffix}`;
    const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/container-roles-");
    await chmod(root, 0o777);
    const containers = [];
    const docker = (...args) => {
      const r = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    t.after(async () => {
      for (const name of containers.reverse())
        spawnSync("docker", ["rm", "-f", name]);
      spawnSync("docker", ["network", "rm", network]);
      // Only the disposable fixture data, written by container UID 1000, is removed.
      spawnSync("docker", [
        "run",
        "--rm",
        "--user",
        "0",
        "--mount",
        `type=bind,src=${root},dst=/fixture`,
        "--entrypoint",
        "node",
        image,
        "-e",
        "for(const name of require('node:fs').readdirSync('/fixture'))require('node:fs').rmSync('/fixture/'+name,{recursive:true,force:true})",
      ]);
      await rm(root, { recursive: true, force: true });
    });
    docker("network", "create", network);
    docker(
      "run",
      "-d",
      "--name",
      postgres,
      "--network",
      network,
      "--network-alias",
      "role-db",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "-e",
      "POSTGRES_PASSWORD=fixture",
      "postgres:15-alpine",
    );
    containers.push(postgres);
    for (let i = 0; i < 100; i++) {
      if (
        spawnSync("docker", ["exec", postgres, "pg_isready", "-U", "postgres"])
          .status === 0
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const env = {
      NODE_ENV: "test",
      APP_SECRET: "ab".repeat(32),
      OPERATOR_TOKEN: "fixture-".repeat(8),
      LOCAL_BILLING: "true",
      DATA_DIR: "/data",
      WORK_DIR: "/data/work",
      DATABASE_URL: "postgresql://postgres:fixture@role-db:5432/postgres",
      AWS_EC2_METADATA_DISABLED: "true",
    };
    const flags = Object.entries(env).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);
    const base = [
      "--network",
      network,
      "--read-only",
      "--mount",
      `type=bind,src=${root},dst=/data`,
      ...flags,
    ];
    docker("run", "--rm", ...base, "-e", "SERVER_ROLE=migrate", image);
    const count = () =>
      docker(
        "exec",
        postgres,
        "psql",
        "-U",
        "postgres",
        "-tAc",
        "SELECT count(*) FROM knex_migrations",
      );
    assert.equal(count(), "15");
    const name = `entitle-api-role-${suffix}`;
    docker(
      "run",
      "-d",
      "--name",
      name,
      ...base,
      "-e",
      "SERVER_ROLE=api",
      "-e",
      "DEPLOYMENT_SLOT=blue",
      image,
    );
    containers.push(name);
    const probe =
      "fetch('http://127.0.0.1:3211/api/v1/ready').then(r=>console.log(JSON.stringify({role:r.headers.get('x-entitle-server-role'),slot:r.headers.get('x-entitle-deployment-slot')}))).catch(()=>process.exit(1))";
    let identity;
    for (let i = 0; i < 100; i++) {
      const r = spawnSync("docker", ["exec", name, "node", "-e", probe], {
        encoding: "utf8",
        timeout: 10000,
      });
      if (r.status === 0) {
        identity = JSON.parse(r.stdout);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(identity, { role: "api", slot: "blue" });
    assert.equal(count(), "15");
    docker("stop", "--time", "20", name);
    assert.equal(
      docker("inspect", "--format", "{{.State.ExitCode}}", name),
      "0",
    );
    docker(
      "exec",
      postgres,
      "psql",
      "-U",
      "postgres",
      "-c",
      "INSERT INTO knex_migrations(name,batch,migration_time) VALUES ('future_unknown',99,now())",
    );
    const failed = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        ...base,
        "-e",
        "SERVER_ROLE=api",
        "-e",
        "DEPLOYMENT_SLOT=green",
        image,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /migration|schema/i);
    assert.equal(count(), "15");
    docker(
      "exec",
      postgres,
      "psql",
      "-U",
      "postgres",
      "-c",
      "DELETE FROM knex_migrations WHERE name='future_unknown'",
    );
    const worker = `entitle-worker-role-${suffix}`;
    docker(
      "run",
      "-d",
      "--name",
      worker,
      ...base,
      "-e",
      "SERVER_ROLE=worker",
      image,
    );
    containers.push(worker);
    let workerIdentity;
    for (let i = 0; i < 100; i++) {
      const r = spawnSync("docker", ["exec", worker, "node", "-e", probe], {
        encoding: "utf8",
        timeout: 10000,
      });
      if (r.status === 0) {
        workerIdentity = JSON.parse(r.stdout);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(workerIdentity, { role: "worker", slot: null });
    docker("stop", "--time", "20", worker);
    assert.equal(
      docker("inspect", "--format", "{{.State.ExitCode}}", worker),
      "0",
    );
    assert.equal(count(), "15");
  },
);
