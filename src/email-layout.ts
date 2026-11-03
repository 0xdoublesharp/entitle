import { site } from "./site.ts";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

export function emailSubject(
  action: string,
  brand: string = site.name,
): string {
  return `${brand}: ${action}`;
}

/** Shared, inline-styled layout for transactional emails. All content is escaped. */
export function emailLayout(content: {
  subject: string;
  brand?: string;
  preview: string;
  category: string;
  title: string;
  intro: string;
  details: { label: string; value: string; monospace?: boolean }[];
  paragraphs: string[];
  action?: { label: string; url: string; expiry: string; sameBrowser: boolean };
  footer: string;
}): string {
  const name = escapeHtml(content.brand ?? site.name);
  const action = content.action;
  const safeUrl = escapeHtml(action?.url ?? "");
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
  <title>${escapeHtml(content.subject)}</title>
  <style>
    a:focus-visible { outline: 3px solid #a97726; outline-offset: 4px; }
    .email-action:hover { background-color: #173b32 !important; }
    @media only screen and (max-width: 600px) {
      .email-shell { padding: 28px 16px !important; }
      .email-content { padding: 28px 24px !important; }
      .email-title { font-size: 30px !important; line-height: 36px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; width: 100%; background-color: #f6f7f4; color: #1d302d; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
  <div style="display: none; font-size: 1px; line-height: 1px; max-height: 0; max-width: 0; opacity: 0; overflow: hidden; mso-hide: all;">${escapeHtml(content.preview)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f6f7f4" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td class="email-shell" align="center" style="padding: 44px 24px;">
        <!--[if mso]><table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 560px; table-layout: fixed; border-collapse: collapse; font-family: Arial, Helvetica, sans-serif;">
          <tr>
            <td style="padding: 0 0 24px; color: #205843; font-size: 20px; line-height: 28px; font-weight: 700; letter-spacing: -0.5px; overflow-wrap: anywhere;">${name}</td>
          </tr>
          <tr>
            <td bgcolor="#ffffff" style="background-color: #ffffff; border: 1px solid #dce3dd; border-top: 4px solid #205843; border-radius: 12px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; table-layout: fixed; border-collapse: collapse;">
                <tr>
                  <td class="email-content" style="padding: 36px 40px; overflow-wrap: anywhere;">
                    <p style="margin: 0 0 16px; color: #286551; font-size: 11px; line-height: 16px; font-weight: 700; letter-spacing: 1.8px; text-transform: uppercase;">${escapeHtml(content.category)}</p>
                    <h1 class="email-title" style="margin: 0 0 16px; color: #173b32; font-family: Georgia, 'Times New Roman', serif; font-size: 36px; line-height: 42px; font-weight: 400; letter-spacing: -0.8px;">${escapeHtml(content.title)}</h1>
                    <p style="margin: 0 0 24px; color: #5c6e66; font-size: 16px; line-height: 26px;">${escapeHtml(content.intro)}</p>
                    ${content.details
                      .map(
                        (
                          detail,
                        ) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 16px; width: 100%; table-layout: fixed; border-collapse: collapse;">
                      <tr>
                        <td bgcolor="#f1f5ef" style="padding: 16px 20px; background-color: #f1f5ef; border-radius: 8px;">
                          <p style="margin: 0 0 4px; color: #5c6e66; font-size: 11px; line-height: 16px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;">${escapeHtml(detail.label)}</p>
                          <p style="margin: 0; color: #1d302d; font-family: ${detail.monospace ? "Consolas, Monaco, 'Courier New', monospace" : "Arial, Helvetica, sans-serif"}; font-size: 15px; line-height: 24px; font-weight: 600; overflow-wrap: anywhere; word-break: break-all;">${escapeHtml(detail.value)}</p>
                        </td>
                      </tr>
                    </table>`,
                      )
                      .join("\n")}
                    ${content.paragraphs.map((paragraph) => `<p style="margin: 24px 0; color: #42584c; font-size: 14px; line-height: 23px;">${escapeHtml(paragraph)}</p>`).join("\n")}
                    ${
                      action
                        ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td align="center" bgcolor="#205843" style="background-color: #205843; border-radius: 8px; mso-padding-alt: 16px 24px;">
                          <a class="email-action" href="${safeUrl}" style="display: block; padding: 16px 24px; border: 1px solid #205843; border-radius: 8px; color: #ffffff; background-color: #205843; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 22px; font-weight: 700; text-align: center; text-decoration: none; mso-padding-alt: 0;">${escapeHtml(action.label)}</a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 12px 0 28px; color: #5c6e66; font-size: 12px; line-height: 20px; text-align: center;">${escapeHtml(action.expiry)}</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; table-layout: fixed; border-collapse: collapse;">
                      <tr>
                        <td style="border-top: 1px solid #e4e9e2; padding-top: 24px;">
                          <p style="margin: 0 0 8px; color: #5c6e66; font-size: 12px; line-height: 20px;">Button not working? Copy and paste this link into ${action.sameBrowser ? "the same" : "your"} browser:</p>
                          <a href="${safeUrl}" style="color: #286551; font-size: 12px; line-height: 20px; text-decoration: underline; overflow-wrap: anywhere; word-break: break-all;">${safeUrl}</a>
                        </td>
                      </tr>
                    </table>`
                        : ""
                    }
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 8px 0; color: #5c6e66; font-size: 12px; line-height: 20px; text-align: center;">${escapeHtml(content.footer)}</td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}
