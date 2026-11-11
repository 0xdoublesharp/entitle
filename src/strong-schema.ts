import { z } from "zod";
import { publisherInputSchema } from "./oidc-schema.ts";

const tenant = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);
export const strongIntentSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("oidc.create"),
      tenant,
      publisher: publisherInputSchema,
    })
    .strict(),
  z
    .object({ action: z.literal("oidc.revoke"), tenant, publisherId: z.uuid() })
    .strict(),
  z.object({ action: z.literal("security.manage") }).strict(),
  z
    .object({
      action: z.literal("security.recovery_complete"),
      flowId: z.uuid(),
    })
    .strict(),
  z
    .object({ action: z.literal("security.recovery_cancel"), flowId: z.uuid() })
    .strict(),
  z
    .object({ action: z.literal("security.email_login"), enabled: z.boolean() })
    .strict(),
  z
    .object({ action: z.literal("security.remove"), factorId: z.uuid() })
    .strict(),
  z
    .object({
      action: z.literal("account.privileged"),
      purpose: z.enum(["api_keys", "workspace_remove", "release_publish"]),
      path: z.string().startsWith("/").max(1000),
    })
    .strict(),
]);
export type StrongIntent = z.infer<typeof strongIntentSchema>;
