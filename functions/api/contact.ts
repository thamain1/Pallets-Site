/**
 * POST /api/contact — Pallets-Site inquiry form handler.
 *
 * Runs on Cloudflare Pages Functions (Workers runtime).
 *
 * Today: validates input, drops bot submissions via honeypot, and 303-redirects
 * to /contact/thanks on success or /contact?error=... on failure.
 *
 * Not yet wired: actual email delivery. See TODO block below — swap the
 * `deliverInquiry` stub for a real send via the Client's chosen email provider
 * (Resend, SendGrid, Mailchannels, etc.) once Anthony provides credentials.
 */

interface Env {
  // Set via: wrangler pages secret put <NAME> --project-name=pallets-site
  // (treated as secrets so they don't sit in source; not strictly sensitive
  // beyond the API key, but keeping them out of code lets us reroute
  // recipients without a deploy.)
  SENDGRID_API_KEY?: string;
  // Comma-separated. Both owner partners go here today:
  //   "anthonyw@palletspalletspallets.com,anthony@palletspalletspallets.com"
  INQUIRY_TO_EMAILS?: string;
  // Comma-separated. Jesse copied during preview phase:
  //   "jmorgan@4wardmotions.com"
  INQUIRY_CC_EMAILS?: string;
  // Verified sender from the Pallet-Lead-Agents pilot SendGrid account.
  INQUIRY_FROM_EMAIL?: string;
  // Display name on the From: line, e.g. "Pallets Pallets Pallets — Website".
  INQUIRY_FROM_NAME?: string;
}

interface Inquiry {
  name: string;
  company: string;
  email: string;
  phone: string;
  need: string;
  quantity: string;
  when: string;
  message: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const origin = new URL(request.url).origin;
  const redirectTo = (path: string) => Response.redirect(new URL(path, origin).toString(), 303);
  const redirectErr = (code: string) => redirectTo(`/contact?error=${encodeURIComponent(code)}`);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectErr("invalid-payload");
  }

  // Honeypot: bots fill hidden fields; real humans don't.
  if (form.get("website")) {
    // Silently succeed so bots think they got through.
    return redirectTo("/contact/thanks");
  }

  const inquiry: Inquiry = {
    name: str(form.get("name")),
    company: str(form.get("company")),
    email: str(form.get("email")),
    phone: str(form.get("phone")),
    need: str(form.get("need")),
    quantity: str(form.get("quantity")),
    when: str(form.get("when")),
    message: str(form.get("message")),
  };

  if (!inquiry.name || !inquiry.email || !inquiry.need || !inquiry.message) {
    return redirectErr("missing-required");
  }

  if (!isLikelyEmail(inquiry.email)) {
    return redirectErr("bad-email");
  }

  // Server-side length caps protect against pathological payloads.
  if (
    inquiry.name.length > 200 ||
    inquiry.company.length > 200 ||
    inquiry.email.length > 320 ||
    inquiry.phone.length > 50 ||
    inquiry.need.length > 50 ||
    inquiry.quantity.length > 200 ||
    inquiry.when.length > 200 ||
    inquiry.message.length > 5000
  ) {
    return redirectErr("too-long");
  }

  try {
    await deliverInquiry(inquiry, env);
  } catch (err) {
    console.error("[contact] delivery failed", err);
    return redirectErr("delivery-failed");
  }

  return redirectTo("/contact/thanks");
};

/**
 * Delivers the inquiry via SendGrid v3 /mail/send.
 *
 * - TO: both owner partners (env.INQUIRY_TO_EMAILS, comma-separated).
 * - CC: Jesse during the preview phase (env.INQUIRY_CC_EMAILS).
 * - FROM: a sender identity already verified in the Pallet-Lead-Agents
 *   SendGrid account (env.INQUIRY_FROM_EMAIL).
 * - Reply-To is the inquirer, so Anthony can hit reply directly.
 *
 * If any required env var is missing (e.g. on a preview deploy that hasn't
 * been provisioned yet), we LOG-ONLY and let the user proceed to the thanks
 * page. That's a deliberate fail-open for demo deploys — see the production
 * checklist note below.
 */
async function deliverInquiry(inquiry: Inquiry, env: Env): Promise<void> {
  const apiKey = env.SENDGRID_API_KEY;
  const toEmails = parseEmailList(env.INQUIRY_TO_EMAILS);
  const ccEmails = parseEmailList(env.INQUIRY_CC_EMAILS);
  const fromEmail = env.INQUIRY_FROM_EMAIL;
  const fromName = env.INQUIRY_FROM_NAME ?? "Pallets Pallets Pallets — Website";

  if (!apiKey || toEmails.length === 0 || !fromEmail) {
    console.warn("[contact] SendGrid env vars not set — logging only", {
      hasApiKey: Boolean(apiKey),
      toEmailCount: toEmails.length,
      hasFromEmail: Boolean(fromEmail),
      inquiry: redact(inquiry),
    });
    return;
  }

  const subject = `New inquiry: ${inquiry.need}${inquiry.company ? ` — ${inquiry.company}` : ""} (${inquiry.name})`;

  const personalization: Record<string, unknown> = {
    to: toEmails.map((email) => ({ email })),
    subject,
  };
  if (ccEmails.length > 0) {
    personalization.cc = ccEmails.map((email) => ({ email }));
  }

  const payload = {
    personalizations: [personalization],
    from: { email: fromEmail, name: fromName },
    reply_to: { email: inquiry.email, name: inquiry.name },
    content: [
      { type: "text/plain", value: formatInquiryPlain(inquiry) },
      { type: "text/html", value: formatInquiryHtml(inquiry) },
    ],
  };

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(empty)");
    throw new Error(`SendGrid ${response.status}: ${body.slice(0, 500)}`);
  }
}

function parseEmailList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isLikelyEmail(s));
}

function formatInquiryPlain(inquiry: Inquiry): string {
  return [
    `New inquiry from the palletspalletspallets.com contact form.`,
    ``,
    `Name:      ${inquiry.name}`,
    `Company:   ${inquiry.company || "(not provided)"}`,
    `Email:     ${inquiry.email}`,
    `Phone:     ${inquiry.phone || "(not provided)"}`,
    `Need:      ${inquiry.need}`,
    `Quantity:  ${inquiry.quantity || "(not provided)"}`,
    `When:      ${inquiry.when || "(not provided)"}`,
    ``,
    `Details:`,
    inquiry.message,
    ``,
    `—`,
    `Reply directly to this email to respond to ${inquiry.name}.`,
  ].join("\n");
}

function formatInquiryHtml(inquiry: Inquiry): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#6b4423;font-weight:600;white-space:nowrap;">${label}</td><td style="padding:6px 0;color:#1f2937;">${escapeHtml(value)}</td></tr>`;
  return `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;max-width:560px;">
  <h2 style="color:#3d2812;margin:0 0 8px;">New inquiry</h2>
  <p style="color:#6b7280;margin:0 0 20px;font-size:14px;">From the palletspalletspallets.com contact form.</p>
  <table style="border-collapse:collapse;font-size:14px;margin-bottom:20px;">
    ${row("Name", inquiry.name)}
    ${row("Company", inquiry.company || "(not provided)")}
    ${row("Email", inquiry.email)}
    ${row("Phone", inquiry.phone || "(not provided)")}
    ${row("Need", inquiry.need)}
    ${row("Quantity", inquiry.quantity || "(not provided)")}
    ${row("When", inquiry.when || "(not provided)")}
  </table>
  <h3 style="color:#3d2812;margin:24px 0 6px;font-size:15px;">Details</h3>
  <div style="white-space:pre-wrap;background:#f5efe6;border-left:3px solid #f59e0b;padding:12px 16px;font-size:14px;line-height:1.55;">${escapeHtml(inquiry.message)}</div>
  <p style="color:#6b7280;margin:24px 0 0;font-size:12px;">Reply directly to this email to respond to ${escapeHtml(inquiry.name)}.</p>
</div>
  `.trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function redact(inquiry: Inquiry): Partial<Inquiry> {
  // For log messages, drop the freeform message body to keep logs tidy and
  // avoid surfacing customer data in log search.
  const { message, ...rest } = inquiry;
  return { ...rest, message: `(${message.length} chars)` as unknown as string };
}

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLikelyEmail(value: string): boolean {
  // Conservative — accept anything that looks roughly like local@host.tld.
  // Server-side check is a sanity gate; the real authority is whether the
  // address actually bounces when we try to reply.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
