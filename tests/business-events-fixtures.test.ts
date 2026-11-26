import { mkdtemp, rm } from "node:fs/promises";
import { createTenant, migrate, type DB } from "../src/db.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { up } from "../src/migrations/012_business_events.ts";
import { OutboundWebhooks } from "../src/outbound-webhooks.ts";
export async function businessFixture(run: (db: DB) => Promise<void>) {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/business-events-case-",
  );
  const fixture = await isolatedDatabase(`sqlite:${root}/db`);
  try {
    await migrate(fixture.db);
    await up(fixture.db);
    await createTenant(fixture.db, {
      id: "b0000000-0000-4000-8000-000000000001",
      slug: "events",
      name: "Events",
    });
    await createTenant(fixture.db, {
      id: "other",
      slug: "other",
      name: "Other",
    });
    await run(fixture.db);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}
export const secret = "89".repeat(32);
export const tenant = {
  id: "b0000000-0000-4000-8000-000000000001",
  slug: "events",
  name: "Events",
};
const network = {
  resolve: async () => [{ address: "8.8.8.8", family: 4 }],
  send: async () => 204,
};
export function outbound(db: DB, now = Date.now) {
  return new OutboundWebhooks(db, tenant.id, secret, { network, now });
}
