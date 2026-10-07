import crypto from "node:crypto";
import { isMonetizationEnabled } from "./features.server";

/**
 * Signed communication with the Gemist admin panel (licenses, store reports).
 * Both sides sign `${timestamp}.${body}` with the same shared secret.
 */
const MAX_SKEW_SECONDS = 300;

export function adminPanelUrl() {
  if (!isMonetizationEnabled()) return "";
  return (process.env.GEMIST_ADMIN_URL || "").trim().replace(/\/+$/, "");
}

function sharedSecret() {
  if (!isMonetizationEnabled()) return "";
  return (process.env.GEMIST_ADMIN_SHARED_SECRET || "").trim();
}

/**
 * Licensing is enforced only when monetization is enabled AND the admin panel
 * is configured. Out of SOW by default (GEMIST_MONETIZATION_ENABLED=false).
 */
export function isLicensingEnabled() {
  return isMonetizationEnabled() && Boolean(adminPanelUrl() && sharedSecret());
}

export function pricingUrl(shop: string) {
  const base = adminPanelUrl();
  return base ? `${base}/pricing?shop=${encodeURIComponent(shop)}` : "";
}

function sign(timestamp: string, body: string) {
  return crypto.createHmac("sha256", sharedSecret()).update(`${timestamp}.${body}`).digest("hex");
}

export async function postToAdmin<T>(path: string, payload: unknown, timeoutMs = 10000): Promise<T> {
  const base = adminPanelUrl();
  if (!base || !sharedSecret()) throw new Error("Gemist admin panel is not configured.");
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gemist-timestamp": timestamp,
        "x-gemist-signature": sign(timestamp, body),
      },
      body,
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => null)) as T | null;
    if (!data) throw new Error(`Admin panel responded with HTTP ${response.status}.`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Verifies a request coming from the admin panel; returns the JSON body or null. */
export async function readAdminRequest<T>(request: Request): Promise<T | null> {
  if (!sharedSecret()) return null;
  const timestamp = request.headers.get("x-gemist-timestamp") || "";
  const signature = request.headers.get("x-gemist-signature") || "";
  const body = await request.text();
  const ts = Number(timestamp);
  if (!timestamp || !signature || !Number.isFinite(ts)) return null;
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return null;
  const expected = Buffer.from(sign(timestamp, body), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(body || "{}") as T;
  } catch {
    return null;
  }
}
