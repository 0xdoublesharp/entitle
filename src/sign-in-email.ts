import { emailLayout, emailSubject } from "./email-layout.ts";
import { site } from "./site.ts";
import type { Message } from "./email.ts";

/** One email body for both login flows; browser binding applies only to sellers. */
export function signInEmail(
  to: string,
  url: string,
  audience: "seller" | "customer",
  publisher: string = site.name,
): Omit<Message, "messageId"> {
  const seller = audience === "seller";
  const destination = seller
    ? "your seller dashboard"
    : `your ${publisher} customer account`;
  const instructions = seller
    ? "Open this link in the same browser where you requested it. If you requested more than one email, use your latest sign-in link."
    : "Open this link in your browser to continue.";
  const brand = seller ? site.name : publisher;
  const expiry = "This single-use link expires in 15 minutes.";
  const ignore = "If you didn’t request this email, you can safely ignore it.";

  return {
    to,
    subject: emailSubject("Sign in", brand),
    text: `Open ${url}\n\nSign in to ${brand}\nContinue to ${destination}.\nSigning in as: ${to}\n\n${instructions}\n${expiry}\n\n${ignore}`,
    html: emailLayout({
      subject: emailSubject("Sign in", brand),
      brand,
      preview: `Your sign-in link for ${brand}. Expires in 15 minutes.${seller ? " Open in the same browser where you requested it." : ""}`,
      category: "Account access",
      title: "Your sign-in link is ready.",
      intro: `Continue to ${destination}.`,
      details: [{ label: "Signing in as", value: to }],
      paragraphs: [instructions],
      action: {
        label: seller ? "Sign in to Entitle" : "Sign in to your account",
        url,
        expiry,
        sameBrowser: seller,
      },
      footer: ignore,
    }),
  };
}
