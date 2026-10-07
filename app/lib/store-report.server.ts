import prisma from "../db.server";
import {
  getCachedGemistStyleProduct,
  getGemistCatalogSlugs,
  getGemistStyleProduct,
  resolveGemistApiBaseUrl,
} from "./gemist-api.server";
import { getMerchantSettings } from "../models/merchant-settings.server";
import { getCatalogStatusMap } from "../models/merchant-catalog.server";
import { isLicensingEnabled, postToAdmin } from "./admin-link.server";

type Admin = {
  graphql: (query: string) => Promise<Response>;
};

export type StoreProfileReport = {
  name?: string;
  email?: string;
  shopifyPlan?: string;
  currency?: string;
  country?: string;
  appVersion?: string;
};

export type CatalogProductReport = {
  slug: string;
  title: string;
  gemistProductId: string;
  imageUrl: string;
  status: string;
};

function imageUrlFromProduct(product: {
  thumbnail?: string | { url?: string; src?: string } | null;
  images?: Array<string | { url?: string; src?: string }> | null;
} | null | undefined): string {
  if (!product) return "";
  const thumb = product.thumbnail;
  if (typeof thumb === "string" && thumb) return thumb;
  if (thumb && typeof thumb === "object") {
    const url = thumb.url || thumb.src || "";
    if (url) return url;
  }
  const first = product.images?.[0];
  if (typeof first === "string" && first) return first;
  if (first && typeof first === "object") return first.url || first.src || "";
  return "";
}

export async function getStoreProfileReport(admin: Admin | undefined): Promise<StoreProfileReport> {
  const appVersion = process.env.npm_package_version || "";
  if (!admin) return { appVersion };
  try {
    const response = await admin.graphql(`#graphql
      query GemistStoreReport {
        shop {
          name
          email
          currencyCode
          plan { displayName }
          billingAddress { countryCodeV2 }
        }
      }
    `);
    const json = await response.json();
    const shop = json.data?.shop as
      | {
          name?: string;
          email?: string;
          currencyCode?: string;
          plan?: { displayName?: string } | null;
          billingAddress?: { countryCodeV2?: string } | null;
        }
      | undefined;
    return {
      name: shop?.name || "",
      email: shop?.email || "",
      currency: shop?.currencyCode || "",
      shopifyPlan: shop?.plan?.displayName || "",
      country: shop?.billingAddress?.countryCodeV2 || "",
      appVersion,
    };
  } catch (error) {
    console.warn("[gemist report] could not read shop profile", error);
    return { appVersion };
  }
}

function titleFromSlug(slug: string) {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function subscriptionReport(shop: string) {
  const row = await prisma.storeSubscription.findUnique({ where: { shop } }).catch(() => null);
  if (!row) return undefined;
  return {
    status: row.status,
    planName: row.planName,
    test: row.test,
    currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
  };
}

/** Sends this shop's profile and catalog to the admin panel (best effort). */
export async function reportStoreToAdmin(shop: string, admin?: Admin) {
  if (!isLicensingEnabled()) return;
  const [profile, products, subscription] = await Promise.all([
    getStoreProfileReport(admin),
    buildCatalogReport(shop).catch((error) => {
      console.warn("[gemist report] catalog report failed", error);
      return undefined;
    }),
    subscriptionReport(shop),
  ]);
  await postToAdmin("/api/v1/stores/report", {
    shop,
    event: "sync",
    ...profile,
    ...(products ? { products } : {}),
    ...(subscription ? { subscription } : {}),
  }, 30000);
}

/** Lightweight report of the shop's Shopify subscription (no catalog). */
export async function reportSubscriptionToAdmin(shop: string, admin?: Admin) {
  if (!isLicensingEnabled()) return;
  const [profile, subscription] = await Promise.all([
    getStoreProfileReport(admin),
    subscriptionReport(shop),
  ]);
  await postToAdmin("/api/v1/stores/report", {
    shop,
    event: "heartbeat",
    ...profile,
    ...(subscription ? { subscription } : {}),
  });
}

export async function reportUninstallToAdmin(shop: string) {
  if (!isLicensingEnabled()) return;
  await postToAdmin("/api/v1/stores/report", { shop, event: "uninstalled" });
}

/** The Gemist styles this shop exposes, with storefront visibility. */
export async function buildCatalogReport(shop: string): Promise<CatalogProductReport[]> {
  const settings = await getMerchantSettings(shop);
  const apiBaseUrl = resolveGemistApiBaseUrl(settings.apiBaseUrl);
  const [slugs, statusMap, rows] = await Promise.all([
    getGemistCatalogSlugs(apiBaseUrl),
    getCatalogStatusMap(shop),
    prisma.merchantCatalogStyle
      .findMany({ where: { shop }, select: { slug: true, title: true, gemistProductId: true } })
      .catch(() => [] as { slug: string; title: string; gemistProductId: string }[]),
  ]);
  const saved = new Map(rows.map((row) => [row.slug, row]));

  return Promise.all(
    slugs.map(async (slug) => {
      const row = saved.get(slug);
      let product = await getCachedGemistStyleProduct(apiBaseUrl, slug);
      if (!product || !imageUrlFromProduct(product)) {
        try {
          product = (await getGemistStyleProduct(apiBaseUrl, slug)) || product;
        } catch (error) {
          console.warn("[gemist report] style fetch failed", slug, error);
        }
      }
      return {
        slug,
        title: row?.title || product?.title || titleFromSlug(slug),
        gemistProductId: row?.gemistProductId || product?.id || "",
        imageUrl: imageUrlFromProduct(product),
        status: statusMap[slug] || "active",
      };
    }),
  );
}
