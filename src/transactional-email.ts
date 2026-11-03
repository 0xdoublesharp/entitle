import type { Message } from "./email.ts";
import type { SensitivePurpose } from "./account-management.ts";
import { emailLayout, emailSubject } from "./email-layout.ts";
import { site } from "./site.ts";

export interface LicenseEmailContext {
  publisher: string;
  product: string;
}

const purposeLabels: Record<SensitivePurpose, string> = {
  recovery_codes: "recovery codes",
  billing: "billing changes",
  api_keys: "API key management",
  tenant_transfer: "workspace transfer",
  workspace_remove: "permanent workspace removal",
  release_publish: "release publication",
};

export function accountVerificationEmail(
  to: string,
  url: string,
  purpose: SensitivePurpose,
): Omit<Message, "messageId"> {
  const subject = emailSubject("Confirm account action");
  const intro = `Confirm ${purposeLabels[purpose]} for your account.`;
  const instructions =
    "Open this link in the same signed-in browser where you requested it.";
  const expiry = "This single-use verification expires in 10 minutes.";
  const footer = "If you didn’t request this email, you can safely ignore it.";
  return {
    to,
    subject,
    text: `${intro}\n\n${instructions}\n${url}\n${expiry}\n\n${footer}`,
    html: emailLayout({
      subject,
      preview: `${intro} Expires in 10 minutes.`,
      category: "Account action",
      title: "Confirm your account action.",
      intro,
      details: [{ label: "Account", value: to }],
      paragraphs: [instructions],
      action: {
        label: "Confirm account action",
        url,
        expiry,
        sameBrowser: true,
      },
      footer,
    }),
  };
}

export function emailChangeEmail(
  to: string,
  url: string,
  newAddress: string,
  current: boolean,
): Omit<Message, "messageId"> {
  const subject = emailSubject(
    current ? "Approve email change" : "Verify email address",
  );
  const intro = current
    ? `Approve changing your account email to ${newAddress}.`
    : `Verify your new ${site.name} email address.`;
  const instructions =
    "Open this link in the same signed-in browser where you requested the email change.";
  const expiry = "Both addresses must approve within 15 minutes.";
  const footer = current
    ? "Ignore this email to keep your current address."
    : "If you didn’t request this email, you can safely ignore it.";
  return {
    to,
    subject,
    text: `${intro}\n\n${instructions}\n${url}\n${expiry}\n\n${footer}`,
    html: emailLayout({
      subject,
      preview: `${intro} ${expiry}`,
      category: "Account action",
      title: current
        ? "Approve your email change."
        : "Verify your new email address.",
      intro,
      details: [{ label: "Email address", value: to }],
      paragraphs: [instructions],
      action: {
        label: current ? "Approve email change" : "Verify email address",
        url,
        expiry,
        sameBrowser: true,
      },
      footer,
    }),
  };
}

export function licenseKeyEmail(
  to: string,
  key: string,
  context: LicenseEmailContext,
  complimentaryExpiry?: string,
): Omit<Message, "messageId"> {
  const subject = emailSubject(
    `${context.product} — Your license key`,
    context.publisher,
  );
  const complimentary = complimentaryExpiry
    ? `This is a complimentary license. Access to new activations, downloads and updates expires at ${complimentaryExpiry}. You will not be charged automatically or enrolled in a subscription.`
    : "";
  const recovery =
    "Save this key securely. If it is lost, request an email login link on the customer website and replace it.";
  const replacement =
    "Key replacement revokes existing activation tokens; reconnect your sites with the new key.";
  const instructions = `${recovery} ${replacement}`;
  const footer =
    "Expiration and service outages never disable installed functionality.";
  return {
    to,
    subject,
    text: `${context.product} by ${context.publisher}\n\nYour license key is ${key}\n\n${complimentary ? `${complimentary}\n\n` : ""}${instructions} ${footer}`,
    html: emailLayout({
      subject,
      brand: context.publisher,
      preview: `Your ${context.product} license key is ready. Save it securely.`,
      category: "License access",
      title: "Your license key is ready.",
      intro: `Use this key to activate ${context.product} by ${context.publisher}.`,
      details: [
        { label: "License key", value: key, monospace: true },
        ...(complimentaryExpiry
          ? [{ label: "Access expires", value: emailDate(complimentaryExpiry) }]
          : []),
      ],
      paragraphs: [
        ...(complimentaryExpiry
          ? [
              "This is a complimentary license. You will not be charged automatically or enrolled in a subscription.",
              "Access to new activations, downloads and updates ends on the expiry date above.",
            ]
          : []),
        recovery,
        replacement,
      ],
      footer,
    }),
  };
}

function emailDate(value: string): string {
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

const lifecycleSubjects = {
  expired: "License expired",
  canceled_no_autorenew: "License will not renew automatically",
  expiry_approaching: "License expires soon",
};
const lifecycleTitles = {
  expired: "Your software license has expired",
  canceled_no_autorenew: "Your software license will not renew automatically",
  expiry_approaching: "Your software license expires soon",
};

export function lifecycleEmail(
  to: string,
  kind: keyof typeof lifecycleSubjects,
  paidThrough: string,
  context: LicenseEmailContext,
): Omit<Message, "messageId"> {
  const subject = emailSubject(
    `${context.product} — ${lifecycleSubjects[kind]}`,
    context.publisher,
  );
  const title = lifecycleTitles[kind];
  const instructions = `Sign in to your ${context.publisher} customer account to review your ${context.product} license.`;
  const footer =
    "Installed software is not removed. Renewal and payment-failure email preferences are managed by your publisher through Stripe.";
  return {
    to,
    subject,
    text: `${context.product} by ${context.publisher}\n\n${title}. Paid access ends at ${paidThrough}. ${instructions} ${footer}`,
    html: emailLayout({
      subject,
      brand: context.publisher,
      preview: `${context.product}: ${title}. Paid access ends at ${paidThrough}.`,
      category: "License update",
      title: `${title}.`,
      intro: `Review the paid access period for ${context.product} by ${context.publisher}.`,
      details: [{ label: "Paid access ends", value: emailDate(paidThrough) }],
      paragraphs: [instructions],
      footer,
    }),
  };
}
