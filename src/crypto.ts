import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
export const random = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const csrf = (session: string, secret: string) =>
  createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`csrf:${session}`)
    .digest("base64url");
export function equal(a: string, b: string) {
  const actual = Buffer.from(a);
  const expected = Buffer.from(b);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function seal(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "hex"), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function unseal<T>(value: string, secret: string): T {
  const data = Buffer.from(value, "base64url");
  // A 12-byte IV, full 16-byte tag and non-empty body; GCM must never accept a truncated tag.
  if (data.length <= 28) throw Error("Sealed value is truncated.");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(secret, "hex"),
    data.subarray(0, 12),
    { authTagLength: 16 },
  );
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(
      "utf8",
    ),
  ) as T;
}
