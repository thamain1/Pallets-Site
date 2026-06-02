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
  // Bind in CF Pages dashboard → Settings → Environment variables when wiring
  // real email delivery. Examples:
  //   RESEND_API_KEY?: string;
  //   SENDGRID_API_KEY?: string;
  //   INQUIRY_TO_EMAIL?: string;   // e.g. "anthonyw@palletspalletspallets.com"
  //   INQUIRY_FROM_EMAIL?: string; // e.g. "noreply@palletspalletspallets.com"
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

export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
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
    await deliverInquiry(inquiry);
  } catch (err) {
    console.error("[contact] delivery failed", err);
    return redirectErr("delivery-failed");
  }

  return redirectTo("/contact/thanks");
};

/**
 * Stub. Today it just logs to the CF Pages function log — visible in
 * the CF dashboard → Pages project → Functions → Logs.
 *
 * TODO before go-live:
 *   1. Pick an email provider (recommended: Resend for marketing sites,
 *      SendGrid if matching the platform-pilot stack).
 *   2. Add the API key as a CF Pages env var (Settings → Environment variables).
 *   3. Replace this stub with a real fetch to the provider's send endpoint.
 *
 * Example (Resend):
 *
 *   await fetch("https://api.resend.com/emails", {
 *     method: "POST",
 *     headers: {
 *       "Authorization": `Bearer ${env.RESEND_API_KEY}`,
 *       "Content-Type": "application/json",
 *     },
 *     body: JSON.stringify({
 *       from: env.INQUIRY_FROM_EMAIL,
 *       to: env.INQUIRY_TO_EMAIL,
 *       reply_to: inquiry.email,
 *       subject: `New inquiry from ${inquiry.name}`,
 *       text: formatInquiry(inquiry),
 *     }),
 *   });
 */
async function deliverInquiry(inquiry: Inquiry): Promise<void> {
  console.log("[contact] new inquiry", {
    name: inquiry.name,
    company: inquiry.company,
    email: inquiry.email,
    need: inquiry.need,
    quantity: inquiry.quantity,
    when: inquiry.when,
    messageLength: inquiry.message.length,
  });
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
