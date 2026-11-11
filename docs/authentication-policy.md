# Account capabilities and recovery

Entitle combines ordinary online accounts with a privileged publishing control
plane. WebAuthn uses `@simplewebauthn/server`, exact `PUBLIC_ORIGIN`, that origin's
hostname as RP ID, and required user verification. Keep staging and production
origins separate. Credentials are discoverable. Entitle stores public keys,
verified backup properties, provenance and counters; it never collects a key PIN.

| Capability | Required authority |
| --- | --- |
| Ordinary account access | Verified email link where enabled, or a user-verified passkey/FIDO2 assertion; synced passkeys are allowed |
| First ordinary credential | Fresh browser/session-bound email confirmation |
| Additional ordinary credentials and email fallback preference | Fresh intent-bound assertion from an existing credential |
| Publisher trust, automation-key changes, interactive release publication, workspace removal | Fresh assertion from an independently provisioned hardware credential; two independent approved keys must remain enrolled |
| Remove an approved hardware credential | Fresh proof from a different remaining approved hardware key; privileges suspend below two keys |
| Ordinary recovery | Saved code, separate confirmation through the previously verified email, new credential enrollment and assertion |
| Restore privileged authority after all-key loss | Protected host/database provisioner, 24-hour objection period and two independently inventoried replacement hardware keys |

Email access, ordinary contact-address changes (both mailboxes must confirm),
routine billing verification, encrypted workspace export and saved-code management are deliberate ordinary
account exceptions. They cannot establish hardware assurance or restore recovered
privileges. Disabling email fallback leaves recovery-channel confirmation
available, but it cannot turn that confirmation into ordinary sign-in or privileged
access. Keep a backup key and offline recovery codes. Passwords and TOTP are not
sign-in or publisher-approval methods.

Browser sessions last seven days without sliding renewal and record method,
credential, verification time, recovery flow and account security generation.
They provide remembered ordinary access. Each privileged mutation additionally
requires a one-use proof valid for at most five minutes, bound to its intent,
session, generation and credential. Publisher proofs cover the exact workspace
and publisher input/ID; other privileged proofs bind purpose and exact API path.
Eligibility is checked again in the mutation transaction. Membership and resource
permissions still apply. Failed WebAuthn finish attempts consume their challenges.
Factor changes invalidate outstanding proofs and other sessions. Removing a key
also ends sessions established by that credential, including the requesting
session. Removing an approved hardware key conservatively revokes publishing
delegations in owned workspaces; review and recreate them with the remaining
approved keys. The last usable key cannot be removed while email sign-in is disabled.

## Provision hardware before enabling publishing privileges

The `security_key` label, cross-platform attachment, AAGUID, and non-backup flag
are not hardware evidence. Entitle uses **operational assurance**: a protected
local provisioner binds an inventoried physical, non-exportable, PIN/biometric
protected key to the exact enrolled public-key fingerprint. It does not claim
attestation-chain verification. Unknown, backup-eligible or backed-up credentials
are ineligible. Existing credentials receive no label-based grandfathering.

1. Enroll two physically independent FIDO2 keys with user verification. Store the
   backup separately. For each key, the trusted host operator witnesses enrollment
   and verifies the enrolled credential/fingerprint belongs to that physical key.
   Require a fresh signed assertion with the inventoried key in a trusted browser
   under the operator's control and match it to the stored public key. Do not
   approve a fingerprint supplied only by the web account holder.
2. Stop app and worker writers. Run the following with protected deployment
   configuration/database access. Record the physical inventory and approval
   reference outside the web account. `OPERATOR_TOKEN` over HTTP cannot perform
   these commands.

```sh
pnpm auth:maintenance inventory --user USER_ID --operator OPERATOR --reference CHANGE --quiesced
pnpm auth:maintenance approve --user USER_ID --factor FACTOR_ID --fingerprint PUBLIC_KEY_HASH --inventory PHYSICAL_KEY_ID --operator OPERATOR --reference CHANGE --quiesced
```

Repeat approval for the other distinct physical inventory ID. The provisioner
rejects mismatched fingerprints, duplicate inventory IDs and unverified/backup
credentials. Audit and notices identify operational assurance and the approving
operator. Resume writers. A single remaining approved key can authorize ordinary
replacement enrollment; independently provision the replacement before making
publisher changes. Ordinary web/API/CLI/MCP requests cannot mark hardware approved.

## Ordinary recovery without email sign-in

From **Sign in → Use a recovery code**, enter your account email and a saved code.
A proved code starts a restricted flow and suspends privileged changes. It grants
no account data. Confirm the separate recovery email in that browser, enroll a
replacement key, then **Verify new key and finish recovery**. Sign in with that
new key, including when email-link sign-in is disabled, and save new recovery
codes. Recovery expires after seven days; an unused saved code can start again.

Completion removes superseded authenticators, browser sessions, pending flows and
saved codes, and revokes automation keys, publisher trusts and CI credentials in
workspaces the account owns. New credentials and their descendants remain
ineligible for privileged changes, even after successful login or deleting and
re-enrolling keys. Use infrastructure recovery below to restore privileged trust.

Before completion, an original-key holder can cancel using a fresh
`security.recovery_cancel` proof bound to the flow ID. A restricted recovery
browser can also cancel its own flow. Cancellation removes only recovery
credentials and sessions; original keys and sessions survive. A proved original
credential change supersedes an unfinished recovery and invalidates its material.
Security notices go to the existing email. An unproved recovery request cannot
revoke original credentials.

## All-key or all-proof loss: infrastructure recovery

Host/database authority is the pre-established independent trust root. Establish
who controls this access before an incident. In hosted operation, authenticate
the account owner through the pre-established operator arrangement; mailbox
control alone is not this arrangement. A protected operator performs:

```sh
pnpm auth:maintenance recovery-start --user USER_ID --output PRIVATE_AUTHORIZATION_FILE --operator OPERATOR --reference INCIDENT --quiesced
```

The new file is owner-only and contains a one-use authorization. The command
returns the flow ID and earliest completion time, never the authorization token.
Deliver that authorization through the independently authenticated arrangement.
Resume writers. In the trusted sign-in browser select **Operator recovery** and
redeem it. Enroll two replacement hardware keys. This works even when email
sign-in is disabled or unavailable; no mailbox approval can replace the operator.
The operator witnesses and inventories both new keys using `inventory`/`approve`
above, stops writers again, waits at least 24 hours from recovery start, then runs:

```sh
pnpm auth:maintenance recovery-complete --flow FLOW_ID --operator OPERATOR --reference INCIDENT --quiesced
```

Completion rechecks the flow, generation, deadline, two independent approvals and
exact public-key bindings. It restores privileged eligibility, retires old keys
and revokes the same sessions/delegations as ordinary recovery. Resume writers,
sign in with a new key, save recovery codes, then explicitly recreate publishing
trust. A lost authorization can be replaced by starting infrastructure recovery
again; that cancels the old flow and restarts its delay. Saved-code recovery cannot
supersede an active infrastructure recovery. Loss of both account proofs and the
independent infrastructure trust root requires restoring that protected deployment
arrangement; email cannot bypass it.

## API, CLI and MCP

The shared owner operations expose restricted recovery status, channel request /
consume, cancel and completion through `owner-recovery-*` commands and MCP tools.
Use the existing private owner session and proof files. A replacement-key login
can resume the restricted session; refreshing its CSRF token exposes only recovery
status. Creating/redeeming recovery authorization is intentionally limited to the
protected local maintenance CLI and trusted browser, respectively. Remote agent
transports cannot provision hardware or promote infrastructure recovery.

HTTP recovery routes are under `/api/v1/platform/account/recovery`:
`status`, `channel/request`, `channel/consume`, `cancel`, `complete`, and browser
`operator` redemption. Ordinary entry retains `start` and `consume`. Mutations
require same origin and restricted-session CSRF; public entry uses browser-bound
saved-code flow or a one-use operator authorization. Ordinary completion requires
`security.recovery_complete` bound to the flow ID. The server applies the same
capability checks to HTTP, CLI and MCP; delegated CI credentials cannot use them.

Server tests use signed WebAuthn fixtures and explicit synthetic host inventory.
They do not establish physical-device acceptance. Before enabling production
privileges, verify enrollment, sign-in, independent backup and recovery on the
supported physical keys and browsers using the operational procedure above.
