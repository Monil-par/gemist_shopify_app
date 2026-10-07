import prisma from "../db.server";
import { decrypt, encrypt } from "../utils/encryption.server";
import { isLicensingEnabled, postToAdmin } from "./admin-link.server";
import type { StoreProfileReport } from "./store-report.server";

const HOUR_MS = 60 * 60 * 1000;
const MEMORY_TTL_MS = 60 * 1000;

type VerifyResponse = {
  valid: boolean;
  status: string;
  reason?: string;
  message: string;
  plan?: { code: string; name: string; type: string };
  expiresAt?: string | null;
  verifyIntervalHours?: number;
  graceHours?: number;
};

export type LicenseView = {
  enforced: boolean;
  active: boolean;
  hasKey: boolean;
  keyHint: string;
  status: string;
  message: string;
  planName: string;
  planType: string;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string;
};

const memory = new Map<string, { active: boolean; at: number }>();

function maskKey(key: string) {
  return key.length > 8 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key;
}

async function storeLicenseRow(shop: string) {
  try {
    return await prisma.storeLicense.findUnique({ where: { shop } });
  } catch (error) {
    console.error("[gemist license] failed to read license", error);
    return null;
  }
}

type LicenseRow = NonNullable<Awaited<ReturnType<typeof storeLicenseRow>>>;

function isRowActive(row: LicenseRow | null, now = Date.now()) {
  if (!row || row.status !== "active") return false;
  if (row.expiresAt && row.expiresAt.getTime() < now) return false;
  if (!row.lastVerifiedAt) return false;
  return now - row.lastVerifiedAt.getTime() < row.graceHours * HOUR_MS;
}

async function callVerify(shop: string, key: string, activate: boolean, store?: StoreProfileReport) {
  return postToAdmin<VerifyResponse>("/api/v1/license/verify", {
    shop,
    licenseKey: key,
    activate,
    ...(store ? { store: { ...store, event: activate ? "installed" : "heartbeat" } } : {}),
  });
}

async function saveResult(shop: string, key: string, result: VerifyResponse) {
  const now = new Date();
  const data = {
    licenseKey: encrypt(key),
    status: result.valid ? "active" : result.status || "invalid",
    message: result.message || "",
    planCode: result.plan?.code || "",
    planName: result.plan?.name || "",
    planType: result.plan?.type || "",
    expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
    lastVerifiedAt: now,
    lastCheckAttemptAt: now,
    lastError: "",
    verifyIntervalHours: result.verifyIntervalHours || 6,
    graceHours: result.graceHours || 72,
  };
  memory.delete(shop);
  return prisma.storeLicense.upsert({ where: { shop }, create: { shop, ...data }, update: data });
}

/** Activates a license key for this shop with the admin panel. */
export async function activateLicense(shop: string, key: string, store?: StoreProfileReport) {
  const licenseKey = key.trim().toUpperCase();
  if (!licenseKey) return { ok: false as const, error: "Enter your license key." };
  let result: VerifyResponse;
  try {
    result = await callVerify(shop, licenseKey, true, store);
  } catch (error) {
    console.error("[gemist license] activation failed", error);
    return { ok: false as const, error: "Could not reach the Gemist license server. Try again in a minute." };
  }
  if (!result.valid) return { ok: false as const, error: result.message || "This license key is not valid." };
  await saveResult(shop, licenseKey, result);
  return { ok: true as const, planName: result.plan?.name || "" };
}

/** Asks the admin panel for a license purchased for this shop and activates it. */
export async function claimLicense(shop: string, store?: StoreProfileReport) {
  if (!isLicensingEnabled()) return { ok: false as const, error: "" };
  let licenseKey: string | null = null;
  try {
    const result = await postToAdmin<{ ok: boolean; licenseKey: string | null }>(
      "/api/v1/license/claim",
      { shop },
    );
    licenseKey = result.licenseKey;
  } catch (error) {
    console.error("[gemist license] claim failed", error);
    return { ok: false as const, error: "Could not reach the Gemist license server. Try again in a minute." };
  }
  if (!licenseKey) return { ok: false as const, error: "No completed purchase found for this store yet." };
  return activateLicense(shop, licenseKey, store);
}

/** Stripe customer portal link (manage payment method, cancel) for this shop's subscription. */
export async function billingPortalUrl(shop: string, returnUrl: string) {
  try {
    const result = await postToAdmin<{ ok: boolean; url?: string; error?: string }>(
      "/api/v1/billing/portal",
      { shop, returnUrl },
    );
    return result.ok && result.url
      ? { ok: true as const, url: result.url }
      : { ok: false as const, error: result.error || "Could not open the billing portal." };
  } catch (error) {
    console.error("[gemist license] billing portal failed", error);
    return { ok: false as const, error: "Could not reach the Gemist license server. Try again in a minute." };
  }
}

/** Re-checks the saved key with the admin panel. Network errors keep the last known state. */
export async function refreshLicense(shop: string, store?: StoreProfileReport) {
  const row = await storeLicenseRow(shop);
  if (!row) return null;
  let key: string;
  try {
    key = decrypt(row.licenseKey);
  } catch {
    return null;
  }
  try {
    const result = await callVerify(shop, key, false, store);
    return await saveResult(shop, key, result);
  } catch (error) {
    memory.delete(shop);
    return prisma.storeLicense.update({
      where: { shop },
      data: {
        lastCheckAttemptAt: new Date(),
        lastError: error instanceof Error ? error.message : "License server unreachable",
      },
    });
  }
}

const refreshing = new Set<string>();

function refreshInBackground(shop: string) {
  if (refreshing.has(shop)) return;
  refreshing.add(shop);
  refreshLicense(shop)
    .catch((error) => console.error("[gemist license] background refresh failed", error))
    .finally(() => refreshing.delete(shop));
}

/** Fast check used on every storefront request. */
export async function isLicenseActive(shop: string): Promise<boolean> {
  if (!isLicensingEnabled()) return true;
  if (!shop) return false;
  const cached = memory.get(shop);
  if (cached && Date.now() - cached.at < MEMORY_TTL_MS) return cached.active;

  const row = await storeLicenseRow(shop);
  const active = isRowActive(row);
  memory.set(shop, { active, at: Date.now() });

  if (row) {
    const lastAttempt = (row.lastCheckAttemptAt || row.lastVerifiedAt)?.getTime() || 0;
    if (Date.now() - lastAttempt > row.verifyIntervalHours * HOUR_MS) refreshInBackground(shop);
  }
  return active;
}

export async function getLicenseView(shop: string): Promise<LicenseView> {
  const row = await storeLicenseRow(shop);
  let keyHint = "";
  if (row) {
    try {
      keyHint = maskKey(decrypt(row.licenseKey));
    } catch {
      keyHint = "";
    }
  }
  return {
    enforced: isLicensingEnabled(),
    active: !isLicensingEnabled() || isRowActive(row),
    hasKey: Boolean(row),
    keyHint,
    status: row?.status || "inactive",
    message: row?.message || "",
    planName: row?.planName || "",
    planType: row?.planType || "",
    expiresAt: row?.expiresAt ? row.expiresAt.toISOString() : null,
    lastVerifiedAt: row?.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    lastError: row?.lastError || "",
  };
}

export async function removeLicense(shop: string) {
  memory.delete(shop);
  await prisma.storeLicense.deleteMany({ where: { shop } });
}

export const LICENSE_INACTIVE_MESSAGE =
  "Gemist is not activated for this store. The store owner needs to activate a license in the Gemist app.";
