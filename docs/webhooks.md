# Outgoing webhooks

Outgoing webhooks notify your own service about committed license, activation,
release and alert events. They are available in hosted Pro and standalone.
They are separate from the incoming Stripe webhooks used for billing.

Use them to trigger integrations, then read current authorized state through a
separate scoped API call when needed. Do not grant paid rights based on a
receiver's interpretation of a notification.

## Create an endpoint

Use the dashboard Webhooks page or a tenant key with `operations:write`:

```http
POST /api/v1/tenants/primary/seller/webhooks
Authorization: Bearer SELLER_API_KEY
Content-Type: application/json

{
  "url": "https://hooks.example.com/entitle",
  "events": ["license.created", "license.renewed", "license.canceled", "license.expired"]
}
```

The response contains `id` and `secret`. Save the secret immediately in the
receiver's secret store; list responses never return it. At most ten endpoints
can be active in a workspace. Endpoint creation resolves and validates the
destination, so configure its real public DNS and HTTPS listener first.

Destinations cannot include credentials, query parameters, fragments or
whitespace. Every resolved address must be public. Private/loopback/link-local,
mixed public/private answers and redirects are refused. An operator can further
restrict hosts through `OUTBOUND_WEBHOOK_HOSTS`. The transport pins validated
addresses for each request and preserves TLS hostname verification.

## Events and payload

An endpoint can subscribe to any of the nine event types.

| Type                 | Resource identified                           |
| -------------------- | --------------------------------------------- |
| `license.created`    | Newly created license.                        |
| `license.renewed`    | License renewed in place or granted more access time. |
| `license.revoked`    | License whose revocation event was recorded.  |
| `license.canceled`   | License whose subscription moved to canceled. Paid access can continue through the entitlement end. |
| `license.expired`    | License whose access window ended. The lifecycle scan records expiry for licenses without revocation or suspension and skips lifetime licenses. |
| `activation.changed` | Installation whose activation state changed.  |
| `release.published`  | Published release.                            |
| `release.withdrawn`  | Withdrawn release.                            |
| `alert.raised`       | Operating alert kind, such as `queue_failed`. |

Requests are JSON POSTs with this compact envelope:

```json
{
  "id": "OPAQUE_EVENT_ID",
  "type": "license.renewed",
  "resourceId": "LICENSE_ID",
  "occurredAt": 1792627200000,
  "tenantId": "INTERNAL_TENANT_ID"
}
```

`occurredAt` is Unix milliseconds. The timestamp header below is Unix seconds.
`tenantId` is an internal ID, not the public workspace slug. Payloads carry
resource identifiers, not full customer/provider records or raw license keys.
An event describes a recorded transition. Read current state if your integration
needs to know what is true when it handles a delayed event.

## Verify the exact request bytes

| Header                | Meaning                                              |
| --------------------- | ---------------------------------------------------- |
| `X-Entitle-Timestamp` | Delivery timestamp in decimal Unix seconds.          |
| `X-Entitle-Event-Id`  | Stable event ID, also present in the body.           |
| `X-Entitle-Signature` | `v1=` followed by lowercase hexadecimal HMAC-SHA256. |

The signed message is the exact UTF-8 concatenation:

```text
TIMESTAMP.EVENT_ID.RAW_BODY
```

Use the returned secret's literal string as the HMAC key. Verify before JSON
parsing and before body-normalizing middleware. Accept a timestamp only within
five minutes of your clock. Use constant-time comparison, then require the body
ID to match the signed event-ID header and validate the expected workspace and
event type. Reject malformed/oversized bodies through your receiver's own
bounded request policy.

This JavaScript helper verifies the transport signature. Pass the original
request body bytes and single-valued lowercase headers:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function validSignature(secret, headers, rawBody, now = Date.now()) {
  const timestamp = headers["x-entitle-timestamp"];
  const eventId = headers["x-entitle-event-id"];
  const supplied = headers["x-entitle-signature"];
  if (
    typeof timestamp !== "string" ||
    !/^\d{1,12}$/.test(timestamp) ||
    typeof eventId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(eventId) ||
    typeof supplied !== "string" ||
    !/^v1=[a-f0-9]{64}$/.test(supplied) ||
    Math.abs(now - Number(timestamp) * 1000) > 300000
  )
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${eventId}.`)
    .update(rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(supplied.slice(3), "hex"));
}
```

After verification, parse and validate JSON. Transactionally record the event ID
with your local work before acknowledging. Return a 2xx response promptly once
that record is durable. Use the event ID, not the delivery timestamp or signature,
for deduplication. Retries use a fresh delivery timestamp/signature for the same
event. The receiver should acknowledge an already-recorded event without doing
the work twice.

## Delivery, retries and ordering

Delivery is at least once. A lost response can cause another delivery even if
the receiver processed the first request. Do not assume global or per-resource
arrival order. Use the resource's current state rather than trying to reconstruct
authoritative billing solely from arrival order.

The service accepts only 2xx responses as success. It does not follow redirects
or retain remote response bodies. Failures retry with backoff starting at five
seconds and capped at one hour, within 72 hours and at most 12 attempts. The
worker uses bounded delivery batches; a pending row is not proof that a network
attempt has already occurred. Each workspace admits at most 1,000 pending/running
deliveries; full queues defer forwarding without turning events into paid rights.

List endpoints and the most recent safe delivery states with
`GET /seller/webhooks`. Failed deliveries can be retried with:

```http
POST /api/v1/tenants/primary/seller/webhook-deliveries/DELIVERY_ID/retry
Authorization: Bearer SELLER_API_KEY
Content-Type: application/json

{}
```

The delivery ID is the returned 64-character hexadecimal hash, distinct from
the event ID and endpoint UUID. Explicit retry resets attempts and starts a new
72-hour window. Resolve receiver/DNS/TLS failures before retrying.

## Rotate or disable

`POST /seller/webhooks/ENDPOINT_ID/rotate` with `{}` returns a new secret once.
The previous secret no longer signs new attempts. Rotation moves pending/running
deliveries to the new generation; failed rows stay failed and remain eligible
for explicit retry. Coordinate receiver deployment so it can validate the new
secret before relying on subsequent attempts. Already-sent HTTP requests cannot
be recalled; deduplication still applies.

`DELETE /seller/webhooks/ENDPOINT_ID` disables the endpoint, removes its stored
secret and cancels queued deliveries. It does not remove work already accepted
by the receiver. API keys with `operations:write` can rotate and retrieve new
secrets, so grant that scope only to trusted operators/automation.

## When hosted Pro ends

Pro expiry pauses advanced delivery/report access while retaining core security,
recovery, exports and existing buyers' paid download rights. During the bounded
renewal grace window, business events can wait for a paid contiguous renewal.
Expired grace, explicit revocation or later paid time that excludes those events
suppresses them. A never-Pro workspace receives no historical backfill. Do not
use delayed webhook delivery as evidence that unpaid Pro access is available.

See [hosted pricing](hosted-pricing.md), [API operations](api.md#sandbox-commerce-and-operations)
and [troubleshooting](troubleshooting.md#outgoing-webhooks).
