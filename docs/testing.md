# Testing and release checks

Tests verify behavior; coverage measures which application code those tests
execute. Neither alone qualifies live billing, a production deployment or a
framework's native installation flow.

## Fast checks

Use the [pinned toolchain](development.md#toolchain) and a Scratch-backed temporary
directory. The test runner executes files serially because some fixtures share
process-wide configuration.

```sh
pnpm typecheck
pnpm lint
pnpm test
node --test tests/distribution.test.ts
php examples/wordpress/tests/client-test.php
```

A run with skipped integration tests is useful for local iteration, but it is
not a complete release gate. Read skips and failure output explicitly.

## Coverage

`pnpm coverage` enforces **100% lines, branches and functions for every executable
TypeScript module under `src/` and `web/`**. The reporter also checks that expected
modules are present. Tests and declaration files are excluded; scripts, PHP and
other client languages are not part of this percentage.

```sh
COVERAGE_DIR=/Volumes/Scratch/entitle/reports/coverage \
COVERAGE_TMP_DIR=/Volumes/Scratch/entitle/tmp/coverage \
  pnpm coverage
```

Reports include `summary.json` and `coverage.txt`. Use a distinct directory for
concurrent or independent verification. Do not lower thresholds, drop modules
from the denominator or add implementation-shaped tests merely to raise a score.
Branch counts can vary with the runtime's instrumentation; compare runs with the
same toolchain and source snapshot.

## Real integration fixtures

Start only the fixtures you need. All published fixture ports are loopback-only;
use disposable credentials and databases.

```sh
docker compose -p entitle-test -f deploy/compose.test.yaml up -d postgres mysql mail
node scripts/local-s3.ts up
```

The S3 helper writes a private `integration.env`. Load it with Node to enable the
real private-storage checks. Database tests create randomly named child databases;
the database user needs CREATE/DROP DATABASE. Do not point test-only settings at
production or a retained business database.

```sh
TEST_POSTGRES_DATABASE_URL=postgresql://postgres:entitle-test@127.0.0.1:55432/entitle \
TEST_MYSQL_DATABASE_URL=mysql://root:entitle-test@127.0.0.1:53306/entitle \
  node --env-file=/Volumes/Scratch/entitle/data/local-s3/integration.env \
  scripts/coverage.ts
```

`TEST_SAAS_DATABASE_URL` selects PostgreSQL or MySQL for suites using the shared
isolated-database helper. Run those core suites against each engine when changing
schema, locking or transactional behavior. Keep ordinary `DATABASE_URL` unset
for a test run unless a specific fixture documents otherwise.

`TEST_REDIS_URL` enables the real optional Redis tests. Supply an isolated local
Redis service. PHP must be on PATH for PHP fixtures; `JAVA_TEST_HOME` selects a
JDK when the template test cannot discover one. Check the test's own prerequisite
and skip messages before claiming it ran.

Stripe SDK tests use controlled local HTTP/provider fixtures. SMTP delivery to
Mailpit and S3 delivery to a local engine test real protocols, but do not establish
the behavior of an external provider account. Qualify actual Stripe test-mode
Checkout, Elements, Portal, refunds, disputes and connected accounts separately.

For the local StripeDouble integration, install Python 3.15.2 and make the
[`doublesharp/stripe-double`](https://github.com/doublesharp/stripe-double)
checkout available next to this repository, or set
`STRIPE_DOUBLE_APP` to its absolute path. The harness launches and owns a fresh
simulator with Entitle's `2026-09-30.endive` profile, keeps synthetic credentials
in private pipes, and removes its task-owned Scratch state after shutdown:

```sh
TMPDIR=/Volumes/Scratch/entitle/tmp PYTHONDONTWRITEBYTECODE=1 \
  pnpm test:stripe-double
```

`STRIPE_DOUBLE_WORK_ROOT` selects another existing private Scratch directory;
`NODE_BINARY` selects the Node executable used for the consumer check. The test
exercises a synthetic subscription and partial refund through Entitle's actual
Stripe billing snapshot, CLI and MCP product configuration against the simulated
annual price, and Entitle's hosted Checkout, portal cancellation and Elements
session creation. The hosted pages are exercised over HTTP with synthetic data;
this is not a browser journey. StripeDouble also provides synthetic OAuth, but
this check does not exercise it. Elements secrets are placeholders and do not
work with Stripe.js. Real Stripe behavior still requires separate provider
qualification. The test uses the checkout supplied locally; update it separately
to test a newer StripeDouble revision. The current check was verified against
StripeDouble commit `d060b03dabef112c01d3e0b102a2ae117b912a8c`.

## Invariant and fuzz tests

The bounded fast-check suites are included in `pnpm test`. They generate license,
billing, tenant-isolation and queue histories and compare against independent
models. Fixed regressions cover important time boundaries and concurrency.

```sh
pnpm test:invariants
pnpm test:fuzz
FUZZ_RUNS=1000 FUZZ_COMMANDS=150 FUZZ_SEED=12345 pnpm test:fuzz
```

The extended defaults are 500 cases and up to 100 operations. SQLite fixtures
use Scratch; PostgreSQL/MySQL runs use `TEST_SAAS_DATABASE_URL` and isolated child
databases. Each shrink attempt drains concurrent writers before resetting state.

Replay the reported seed and shrink path against the single failing property:

```sh
FUZZ_RUNS=500 FUZZ_COMMANDS=100 FUZZ_SEED=12345 FUZZ_PATH='0:1:2' \
  node --test --test-name-pattern='^invariant: generated license lifecycles' \
  tests/invariants-licensing.test.ts
```

The example seed/path are placeholders for the failure's values. Keep the same
dependency version and command budget for replay. Convert a confirmed failure
into a focused deterministic regression before changing application code.

## Release checks

1. Record the exact source revision, tool versions and enabled fixtures. Run
   strict typing, lint, relevant regressions and the full coverage gate. Exercise
   migrations and core licensing transactions against SQLite, PostgreSQL and MySQL.
2. Build the real [Dockerfile](../Dockerfile). Verify nonroot startup, readiness,
   configured-port healthcheck, persistent database/work storage and authenticated
   downloads. Verify the image's source archive matches the source snapshot.
3. Run real seller and buyer browser workflows against built assets: email sign-in,
   first workspace, product/plan setup, publication, paid access, installation
   management, key replacement, exports and error recovery. Check CSRF, ownership
   denial, pending actions and one-time secrets as well as happy paths.
4. Inspect desktop, phone and tablet layouts with real viewport measurements.
   Check keyboard focus, disclosures, table readability, error recovery and document
   overflow. Preserve screenshots and a reproducible runner outside the repository.
5. Exercise WordPress's normal update screen, WP-CLI and automatic updates using
   [its local procedure](wordpress.md#local-verification). For each native adapter,
   use the actual installer/updater on supported operating systems. A template
   typecheck or feed fixture does not substitute for installation/signature checks.
6. Perform an isolated [backup/restore drill](backup.md) and, when affected, an
   encrypted publisher transfer with paid rights and closure-state checks.
7. Record what was exercised, skipped or unavailable. Live provider accounts,
   external mail, large real-network transfers, signed desktop installs and actual
   production operation require their own evidence. Review acceptance applies to
   the source snapshot reviewed, not later edits.

## Keep evidence separate

Store command logs, coverage JSON, browser captures, source hashes and provider
receipts under `/Volumes/Scratch/entitle/reports/` for local work. Record secrets
only in private fixture inputs, never evidence. Keep the smallest useful sanitized
error and request ID. A run report should state its revision, command, result,
fixture scope and remaining limits; do not append a release diary to these guides.
