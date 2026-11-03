import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { signInEmail } from "../src/sign-in-email.ts";
import { site } from "../src/site.ts";
import {
  accountVerificationEmail,
  emailChangeEmail,
  licenseKeyEmail,
  lifecycleEmail,
} from "../src/transactional-email.ts";

const context = { publisher: "Acme Publishing", product: "Example Pro" };

test("all email subjects use the brand followed by a specific action or update", () => {
  const to = "owner@example.test",
    url = "https://example.test/#token=abc";
  const messages = [
    [signInEmail(to, url, "seller"), "Sign in"],
    [signInEmail(to, url, "customer"), "Sign in"],
    [accountVerificationEmail(to, url, "api_keys"), "Confirm account action"],
    [
      emailChangeEmail(to, url, "new@example.test", true),
      "Approve email change",
    ],
    [emailChangeEmail(to, url, to, false), "Verify email address"],
    [licenseKeyEmail(to, "DE-example", context), "Your license key"],
    [
      licenseKeyEmail(to, "DE-example", context, "2026-12-01T18:30:00.000Z"),
      "Your license key",
    ],
    [
      lifecycleEmail(to, "expired", "2026-12-01T18:30:00.000Z", context),
      "License expired",
    ],
    [
      lifecycleEmail(
        to,
        "canceled_no_autorenew",
        "2026-12-01T18:30:00.000Z",
        context,
      ),
      "License will not renew automatically",
    ],
    [
      lifecycleEmail(
        to,
        "expiry_approaching",
        "2026-12-01T18:30:00.000Z",
        context,
      ),
      "License expires soon",
    ],
  ] as const;
  for (const [message, action] of messages) {
    const plugin =
      action.startsWith("License") || action === "Your license key";
    assert.equal(
      message.subject,
      plugin
        ? `${context.publisher}: ${context.product} — ${action}`
        : `${site.name}: ${action}`,
    );
  }
});

test("transactional emails escape content and retain links, key and account information", async () => {
  const to = `owner+<img src=x onerror='alert(1)'>@example.test`;
  const url = `https://accounts.example.test/app/seller?a="b"&c='<b>'#token=example`;
  const key = `DE-<script>"&'example`;
  const context = {
    publisher: `Publisher <img src=x onerror='alert(1)'>`,
    product: `Plugin <script>"&'name`,
  };
  for (const message of [
    ...(
      [
        "recovery_codes",
        "billing",
        "api_keys",
        "tenant_transfer",
        "release_publish",
      ] as const
    ).map((purpose) => accountVerificationEmail(to, url, purpose)),
    emailChangeEmail(to, url, to, true),
    emailChangeEmail(to, url, to, false),
    licenseKeyEmail(to, key, context),
    licenseKeyEmail(to, key, context, "2026-12-01T18:30:00.000Z"),
    lifecycleEmail(
      to,
      "expiry_approaching",
      "2026-12-01T18:30:00.000Z",
      context,
    ),
  ]) {
    const window = new Window();
    try {
      window.document.write(message.html!);
      const document = window.document;
      assert.equal(document.querySelectorAll("img, script, b").length, 0);
      assert.ok(document.querySelector(".email-content h1"));
      assert.ok(document.querySelector('meta[name="viewport"]'));
      assert.equal(document.title, message.subject);
      const links = [...document.querySelectorAll("a")];
      if (message.text.includes(url)) {
        assert.equal(links.length, 2);
        for (const link of links) assert.equal(link.getAttribute("href"), url);
        assert.ok(document.body.textContent.includes(to));
      } else {
        assert.equal(links.length, 0);
        assert.ok(document.body.textContent.includes(context.publisher));
        assert.ok(document.body.textContent.includes(context.product));
        if (message.text.includes(key))
          assert.ok(document.body.textContent.includes(key));
      }
    } finally {
      await window.happyDOM.close();
    }
  }
});

test("complimentary license emails separate the key, readable expiry and recovery guidance", async () => {
  const key = `DE-${"long-key".repeat(12)}`;
  const message = licenseKeyEmail(
    "owner@example.test",
    key,
    context,
    "2026-12-01T18:30:00.000Z",
  );
  const window = new Window();
  try {
    window.document.write(message.html!);
    const document = window.document;
    const keyElement = [...document.querySelectorAll("p")].find(
      (p) => p.textContent === key,
    )!;
    assert.ok(keyElement, "the key has its own copyable text element");
    assert.match(keyElement.style.fontFamily, /monospace/);
    assert.equal(keyElement.style.overflowWrap, "anywhere");
    assert.match(document.body.textContent, /December 1, 2026 at 6:30 PM UTC/);
    assert.match(
      document.body.textContent,
      /not be charged automatically or enrolled in a subscription/,
    );
    assert.match(
      document.body.textContent,
      /Key replacement revokes existing activation tokens/,
    );
    assert.match(
      document.body.textContent,
      /Expiration and service outages never disable installed functionality/,
    );
    assert.ok(document.querySelectorAll(".email-content > p").length >= 4);
    assert.ok(message.text.includes(key));
    assert.ok(message.text.includes("2026-12-01T18:30:00.000Z"));
  } finally {
    await window.happyDOM.close();
  }
});
