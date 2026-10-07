import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { isLicensingEnabled } from "./admin-link.server";
import {
  BILLING_PLANS,
  billingProvider,
  isBillingRequired,
  isBillingTestMode,
  isFreeShop,
} from "./billing-config.server";
import { getLicenseView, isLicenseActive } from "./license.server";

const HOUR_MS = 60 * 60 * 1000;
const MEMORY_TTL_MS = 60 * 1000;
const RECHECK_HOURS = 6;

type GraphqlClient = (query: string) => Promise<Response>;

type ShopifySubscription = {
  id: string;
  name: string;
  status: string;
  test: boolean;
  trialDays: number;
  currentPeriodEnd: string | null;
};

type SubscriptionRow = NonNullable<Awaited<ReturnType<typeof readSubscription>>>;

const memory = new Map<string, { active: boolean; at: number }>();
const refreshing = new Set<string>();

async function readSubscription(shop: string) {
  try {
    return await prisma.storeSubscription.findUnique({ where: { shop } });
  } catch (error) {
    console.error("[gemist billing] failed to read subscription", error);
    return null;
  }
}

function isSubscriptionActive(row: SubscriptionRow | null) {
  if (!row || row.status !== "ACTIVE") return false;
  if (row.test && !isBillingTestMode()) return false;
  return true;
}

/** Whether this shop must pay (or hold a license) before the live storefront works. */
export function isPaymentEnforced() {
  return isBillingRequired() || isLicensingEnabled();
}

/** Reads the shop's current app subscription from Shopify and caches it. */
export async function syncSubscription(shop: string, graphql: GraphqlClient) {
  try {
    const response = await graphql(`#graphql
      query GemistActiveSubscriptions {
        currentAppInstallation {
          activeSubscriptions { id name status test trialDays currentPeriodEnd }
        }
      }
    `);
    const json = await response.json();
    const subscriptions = (json.data?.currentAppInstallation?.activeSubscriptions ||
      []) as ShopifySubscription[];
    const current =
      subscriptions.find((sub) => (BILLING_PLANS as readonly string[]).includes(sub.name)) ||
      subscriptions[0];
    const data = current
      ? {
          subscriptionId: current.id,
          planName: current.name,
          status: current.status,
          test: Boolean(current.test),
          trialDays: current.trialDays || 0,
          currentPeriodEnd: current.currentPeriodEnd ? new Date(current.currentPeriodEnd) : null,
          lastCheckedAt: new Date(),
          lastError: "",
        }
      : {
          status: "NONE",
          currentPeriodEnd: null,
          lastCheckedAt: new Date(),
          lastError: "",
        };
    memory.delete(shop);
    return await prisma.storeSubscription.upsert({
      where: { shop },
      create: { shop, ...data },
      update: data,
    });
  } catch (error) {
    console.error("[gemist billing] subscription sync failed", error);
    memory.delete(shop);
    return prisma.storeSubscription.upsert({
      where: { shop },
      create: {
        shop,
        lastCheckedAt: new Date(),
        lastError: error instanceof Error ? error.message : "Subscription check failed",
      },
      update: {
        lastCheckedAt: new Date(),
        lastError: error instanceof Error ? error.message : "Subscription check failed",
      },
    });
  }
}

/** Applies an app_subscriptions/update webhook when no Admin API session is available. */
export async function applySubscriptionWebhook(
  shop: string,
  payload: { admin_graphql_api_id?: string; name?: string; status?: string },
) {
  const status = String(payload.status || "").toUpperCase();
  if (!status) return;
  memory.delete(shop);
  const data = {
    subscriptionId: payload.admin_graphql_api_id || "",
    planName: payload.name || "",
    status,
    lastCheckedAt: new Date(),
    lastError: "",
  };
  await prisma.storeSubscription.upsert({ where: { shop }, create: { shop, ...data }, update: data });
}

export function clearAccessCache(shop: string) {
  memory.delete(shop);
}

export async function removeSubscription(shop: string) {
  memory.delete(shop);
  await prisma.storeSubscription.deleteMany({ where: { shop } });
}

function refreshInBackground(shop: string) {
  if (refreshing.has(shop)) return;
  refreshing.add(shop);
  unauthenticated
    .admin(shop)
    .then(({ admin }) => syncSubscription(shop, admin.graphql))
    .catch((error) => console.warn("[gemist billing] background check failed", error))
    .finally(() => refreshing.delete(shop));
}

/**
 * Fast check used on every storefront request: the live grid works when the shop
 * has an active Shopify subscription or (if licensing is on) a valid license key.
 */
export async function isStoreActive(shop: string): Promise<boolean> {
  if (!shop) return false;
  if (!isPaymentEnforced() || isFreeShop(shop)) return true;
  const cached = memory.get(shop);
  if (cached && Date.now() - cached.at < MEMORY_TTL_MS) return cached.active;

  let active = false;
  if (isBillingRequired()) {
    const row = await readSubscription(shop);
    active = isSubscriptionActive(row);
    const lastCheck = row?.lastCheckedAt?.getTime() || 0;
    if (Date.now() - lastCheck > RECHECK_HOURS * HOUR_MS) refreshInBackground(shop);
  }
  if (!active && isLicensingEnabled()) active = await isLicenseActive(shop);

  memory.set(shop, { active, at: Date.now() });
  return active;
}

/** Storefront proxy gate. Theme editor previews are allowed while the store is inactive. */
export async function storefrontAccess(shop: string, request: Request) {
  if (await isStoreActive(shop)) return { allowed: true, previewOnly: false };
  const preview = new URL(request.url).searchParams.get("preview") === "1";
  return { allowed: preview, previewOnly: preview };
}

export type AccessView = Awaited<ReturnType<typeof getAccessView>>;

export async function getAccessView(shop: string) {
  const [row, license] = await Promise.all([readSubscription(shop), getLicenseView(shop)]);
  const subscriptionActive = isSubscriptionActive(row);
  const licenseActive = isLicensingEnabled() && license.active && license.hasKey;
  const freeShop = isFreeShop(shop);
  return {
    enforced: isPaymentEnforced(),
    provider: billingProvider(),
    billingRequired: isBillingRequired(),
    licensingEnabled: isLicensingEnabled(),
    testMode: isBillingTestMode(),
    freeShop,
    active: !isPaymentEnforced() || freeShop || subscriptionActive || licenseActive,
    activeVia: freeShop
      ? "free"
      : subscriptionActive
        ? "subscription"
        : licenseActive
          ? "license"
          : "",
    subscription: row
      ? {
          id: row.subscriptionId,
          planName: row.planName,
          status: row.status,
          test: row.test,
          trialDays: row.trialDays,
          currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
          lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
          lastError: row.lastError,
        }
      : null,
    license,
  };
}

export const STORE_INACTIVE_MESSAGE =
  "Gemist is not active on this store yet. The store owner needs to subscribe in the Gemist app.";
