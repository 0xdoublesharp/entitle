# Publish from CI with OIDC

Entitle accepts short-lived CI identities from GitHub Actions and operator-enabled
OIDC providers, including GitLab. Each trusted publisher can upload releases for
one product. Configure trust once, then run `publish` or `publish-asset` in CI
without storing a tenant API key.

## Passwordless sign-in and email fallback

Sign in with an enrolled passkey or FIDO2 security key, or use an email link.
New credentials require user verification and discoverable credential support,
so they can identify your account without entering an email address. The browser
may ask for biometrics or the security key's PIN; Entitle stores no account password.

Under **Security**, enroll a backup key before disabling **Email-link sign-in**.
Changing that setting requires a fresh passkey or security-key approval. Disabling
it invalidates pending email sign-in links and suppresses new ones. Passkey and
security-key sign-in continues to work. Re-enabling email fallback also requires
a key. Entitle prevents removing the last key while email fallback is disabled.
Email sign-in remains available by default.

Passkeys are bound to the deployment's origin. Keep `PUBLIC_ORIGIN` stable, or
re-enroll credentials before changing domains.

## Configure a trusted publisher

1. Open **Security** in the seller dashboard. Enroll two independent hardware keys
   and have your operator provision them using the [hardware policy](authentication-policy.md).
   Your first enrollment requires a fresh email verification and confirmation
   with the new factor. Adding another factor requires an existing factor.
2. Under **Trusted publishers**, choose the product and CI provider. For GitHub,
   enter the repository, its numeric repository and owner IDs, the exact Git ref
   (for example `refs/heads/main`), and workflow path. Find the IDs with
   `gh api repos/OWNER/REPO --jq '{repository_id: .id, repository_owner_id: .owner.id}'`.
3. Verify with an independently provisioned hardware key, and save.
   Copy the publisher ID and audience into your CI configuration. They are public
   configuration values.

Every creation or revocation requires a new independently provisioned hardware-key approval.
The approval is valid for five minutes, works once in the current seller session,
and covers the exact workspace and change shown. Email verification cannot authorize these changes. See [ordinary and privileged recovery](authentication-policy.md) for replacement-key
restrictions and the independently authorized operator path.

GitHub trust requires `repository_id`, `repository_owner_id`, `ref` and either
`workflow_ref` or `job_workflow_ref`. IDs protect against repository name reuse
and ownership transfers. Pull request and `pull_request_target` jobs cannot
publish. Protect the trusted branch and workflow with repository rules. For
environment-based or customized GitHub subjects, configure the exact subject
through the owner API or CLI and include the same required identity claims.

## GitHub Actions

Use Entitle's CLI from your installed Entitle source/server distribution with
its dependencies available. The example assumes the CLI is installed at
`/opt/entitle/src/cli.ts` in the runner image. Use the Node version pinned by that
distribution. Run the command after building the release artifact:

```yaml
name: Publish
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      # Check out and build your project here using reviewed, pinned actions.
      # Install Entitle in the runner image or prepare a reviewed checkout.
      - name: Publish to Entitle
        env:
          PUBLIC_ORIGIN: https://licenses.example.com
          TENANT_SLUG: acme
          ENTITLE_OIDC_PUBLISHER_ID: 00000000-0000-4000-8000-000000000000
        run: node /opt/entitle/src/cli.ts publish plugin 1.2.3 dist/plugin.zip release.json
```

The CLI requests GitHub's ID token with the workspace audience automatically,
exchanges it for a publishing credential, uploads the artifact, and discards the
credential. `release.json` contains the usual release metadata; see
[CLI reference](cli.md). Native products use
`publish-asset PRODUCT VERSION FILE METADATA_JSON_FILE`.

For reusable workflows, pin `job_workflow_ref` in addition to the caller's
repository IDs and ref. `workflow_ref` identifies the caller's workflow;
`job_workflow_ref` identifies the reusable workflow. See
[GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

## GitLab and other providers

The operator enables each additional provider with `OIDC_PROVIDERS`. This JSON
array replaces the default GitHub provider; include GitHub to keep it enabled:

```json
[
  {
    "id": "github",
    "issuer": "https://token.actions.githubusercontent.com",
    "jwksUrl": "https://token.actions.githubusercontent.com/.well-known/jwks",
    "algorithms": ["RS256"]
  },
  {
    "id": "gitlab",
    "issuer": "https://gitlab.com",
    "jwksUrl": "https://gitlab.com/oauth/discovery/keys",
    "algorithms": ["RS256"]
  }
]
```

Use the provider's documented issuer and JWKS endpoint. Only operators configure
network destinations. Use trusted public HTTPS endpoints and restrict server
egress accordingly; Entitle follows no redirects and never discovers endpoints
from an incoming token. Supported algorithms are RS256 and ES256. An empty array
disables OIDC publishing. Removing a provider disables its active credentials.

For GitLab, configure an exact subject such as
`project_path:acme/plugin:ref_type:branch:ref:main` and require the immutable
`project_id` and appropriate protected-ref/workflow claims. Claim values match
both their value and JSON type. Request the audience displayed by Entitle:

```yaml
publish:
  id_tokens:
    ENTITLE_OIDC_TOKEN:
      aud: https://licenses.example.com/api/v1/tenants/acme/oidc
  variables:
    PUBLIC_ORIGIN: https://licenses.example.com
    TENANT_SLUG: acme
    ENTITLE_OIDC_PUBLISHER_ID: 00000000-0000-4000-8000-000000000000
  script:
    - node /opt/entitle/src/cli.ts publish plugin 1.2.3 dist/plugin.zip release.json
```

See [GitLab ID tokens](https://docs.gitlab.com/ci/secrets/id_token_authentication/)
for subject customization and available claims. Other providers supply
`ENTITLE_OIDC_TOKEN`, or an owner-only regular file through
`ENTITLE_OIDC_TOKEN_FILE`. Choose one source and omit `TENANT_API_KEY`.

## HTTP, CLI and MCP

Owner routes require a seller session and CSRF for writes:

| Operation               | Route                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Begin key sign-in       | `POST /api/v1/platform/auth/passkey/options` with `{}`                                                            |
| Finish key sign-in      | `POST /api/v1/platform/auth/passkey/verify` with `{response}` and the browser-binding cookie                      |
| Email fallback          | `POST /api/v1/platform/account/security/email-login` with `{enabled}` and action-bound approval                   |
| Remove key              | `POST /api/v1/platform/account/security/factors/ID/remove` with `{}` and action-bound approval                    |
| List factors            | `GET /api/v1/platform/account/security`                                                                           |
| Start factor enrollment | `POST /api/v1/platform/account/security/passkey/enroll` with `{name,kind?}` (`kind`: `passkey` or `security_key`) |
| Confirm enrollment      | `POST .../security/passkey/confirm` with `{challengeId,response}`                                                 |
| Start reauthentication  | `POST /api/v1/platform/account/reauth/options` with the exact intent below                                        |
| Verify                  | `POST /api/v1/platform/account/reauth/verify` with `{challengeId,response}`                                       |
| List publishers         | `GET /api/v1/tenants/TENANT/seller/oidc/publishers`                                                               |
| Create publisher        | `POST .../seller/oidc/publishers`                                                                                 |
| Revoke publisher        | `POST .../seller/oidc/publishers/ID/revoke` with `{}`                                                             |

Enrollment start uses `X-Account-Verification`: a fresh `security_enroll` email
proof for the first factor, or a strong `{"action":"security.manage"}` proof
when a factor is already enrolled. Confirm enrollment within five minutes.
Passkeys require user verification, the configured origin and its exact RP ID.

Create a publisher using this body:

```json
{
  "name": "Release workflow",
  "provider": "github",
  "product": "plugin",
  "subject": "repo:acme/plugin:ref:refs/heads/main",
  "claims": {
    "repository_id": "123",
    "repository_owner_id": "456",
    "ref": "refs/heads/main",
    "workflow_ref": "acme/plugin/.github/workflows/release.yml@refs/heads/main"
  }
}
```

The create intent is `{"action":"oidc.create","tenant":"acme","publisher":BODY}`.
The email fallback intent is `{"action":"security.email_login","enabled":false}`
(or `true` to enable it). Key removal uses `{"action":"security.remove","factorId":"ID"}`.
The revoke intent is `{"action":"oidc.revoke","tenant":"acme","publisherId":"ID"}`.
Send the resulting `verification` in `X-Account-Verification` on the write.
Editing trust means creating a replacement and revoking the old publisher.

The CLI provides `owner-publishers`, `owner-publisher-create`,
`owner-publisher-revoke`, `owner-security`, and `owner-reauth-options` with
structured JSON input files. Use `owner-reauth-verify PRIVATE_ASSERTION_JSON_FILE
NEW_PROOF_FILE` to save the approval without printing it, then set
`ENTITLE_VERIFICATION_FILE` to that owner-only file. Existing owner login/session
commands supply the seller session. `owner-passkey-login-start NEW_PREAUTH_FILE`
saves WebAuthn options and browser binding. Complete those options at the
configured HTTPS origin, then use `owner-passkey-login-finish PREAUTH_FILE
PRIVATE_ASSERTION_FILE NEW_SESSION_FILE`. Prefer the dashboard for the interactive
browser ceremony. `owner-email-login` and `owner-factor-remove` manage the account
settings with fresh action-bound approval. Structured MCP operations use the
`entitle_op_` prefix and underscores in place of hyphens; the private-file verifier
is `entitle_owner_reauth_verify`. Enrollment routes are
also available through `request` / `entitle_request`; save secret-bearing
responses with `--output` to private files.

CI clients exchange a token with
`POST /api/v1/tenants/TENANT/oidc/token`, `Authorization: Bearer ID_TOKEN`, and
`{"publisherId":"ID"}`. The response contains `accessToken`, `tokenType`,
`expiresAt`, `scopes` and `productId`. Use the returned bearer credential on the
existing release/asset upload endpoints. It permits publishing only, expires
within ten minutes or at the ID token's expiry, and cannot list private data,
withdraw releases, change billing, or manage trust.

The ID token must be signed, include `iss`, `aud`, `sub`, `iat`, `exp`, and a
unique `jti`, and have been issued within ten minutes. Time claims have five
seconds of clock tolerance, while an expired ID token never creates a credential.
Each identity can be exchanged once across workspaces. Fetch a new ID token for
each command; inspect the release after an uncertain upload response before
retrying. An upload must commit before its publishing credential expires.
Revocation is checked before accepting the upload and inside its final database
transaction, so revoking trust during an upload prevents publication.
