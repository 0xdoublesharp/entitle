import { z } from "zod";

const exact = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      value.trim() === value &&
      ![...value].some(
        (char) =>
          char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "*",
      ),
    "Use an exact value without wildcards or control characters.",
  );
const httpsUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Use an HTTPS URL without credentials, query or fragment.");

// Only the operator supplies network destinations. Tenant policies select a name.
export const oidcProvidersSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z0-9-]{1,50}$/),
        issuer: httpsUrl,
        jwksUrl: httpsUrl,
        algorithms: z
          .array(z.enum(["RS256", "ES256"]))
          .min(1)
          .max(2)
          .default(["RS256"]),
      })
      .strict(),
  )
  .max(20)
  .refine(
    (providers) =>
      new Set(providers.map((provider) => provider.id)).size ===
        providers.length &&
      new Set(providers.map((provider) => provider.issuer)).size ===
        providers.length,
    "Provider names and issuers must be unique.",
  );
export type OidcProvider = z.infer<typeof oidcProvidersSchema>[number];
export const defaultOidcProviders: OidcProvider[] = [
  {
    id: "github",
    issuer: "https://token.actions.githubusercontent.com",
    jwksUrl: "https://token.actions.githubusercontent.com/.well-known/jwks",
    algorithms: ["RS256"],
  },
];
export const publisherInputSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    provider: z.string().regex(/^[a-z0-9-]{1,50}$/),
    product: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(100),
    subject: exact,
    claims: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
        z.union([exact, z.boolean(), z.number().finite()]),
      )
      .refine(
        (claims) =>
          Object.keys(claims).length <= 20 &&
          !Object.keys(claims).some((key) =>
            ["iss", "aud", "sub", "iat", "nbf", "exp", "jti"].includes(key),
          ),
        "Use up to twenty additional identity claims.",
      )
      .default({}),
  })
  .strict();

export const oidcAudience = (origin: string, tenant: string) =>
  `${origin}/api/v1/tenants/${tenant}/oidc`;
