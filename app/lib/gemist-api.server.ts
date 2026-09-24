import { cacheGet, cacheSet, cacheDelete, withCache, CACHE_TTL_SECONDS } from "./cache.server";

export type GemistProduct = {
  id?: string;
  baseProductId?: string;
  title?: string;
  shortTitle?: string;
  subtitle?: string;
  description?: string;
  slug?: string;
  sku?: string;
  style?: string;
  vendor?: string;
  metal?: string;
  type?: string;
  subtype?: string;
  price?: number | string;
  salePrice?: number | string;
  thumbnail?: string | { url?: string; src?: string };
  images?: Array<string | { url?: string; src?: string }>;
  images360?: Array<string | { url?: string; src?: string }>;
  sizes?: number[];
  productParts?: Record<string, unknown>;
  defaultProductMetadata?: Record<string, unknown>;
  manufacturerMetadata?: Record<string, unknown>;
  availableProductParts?: Record<string, string[]>;
  selectedProductParts?: Record<string, string>;
};

/** OpenAPI ProductPart */
export type GemistProductPart = {
  optionType?: string;
  optionValue?: string;
  extraData?: Record<string, unknown>;
};

export type GemistHealth = {
  message?: string;
  version?: string;
};

export type SearchProductsResponse = {
  products?: GemistProduct[];
  limit?: number;
  offset?: number;
  productsCount?: number;
  selectedProductParts?: Record<string, string>;
  availableProductParts?: Record<string, string[]>;
};

export const DEFAULT_GEMIST_API_BASE_URL = "https://classique.dev.gemist.co";

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}${path}`;
}

export function getGemistApiBaseUrl() {
  return (
    process.env.GEMIST_API_BASE_URL || DEFAULT_GEMIST_API_BASE_URL
  ).trim().replace(/\/+$/, "");
}

export function resolveGemistApiBaseUrl(shopUrl?: string | null) {
  const fromShop = (shopUrl || "").trim().replace(/\/+$/, "");
  return fromShop || getGemistApiBaseUrl();
}

export function normalizeGemistApiBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGemistError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /502|503|504|timeout|aborted|ECONNRESET|fetch failed/i.test(message);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Gemist request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (!isRetryableGemistError(error) || attempt === 1) throw error;
      await delay(400 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function getGemistProduct({
  apiBaseUrl,
  productId,
}: {
  apiBaseUrl: string;
  productId: string;
}): Promise<GemistProduct | null> {
  const url = joinUrl(apiBaseUrl, `/api/products/${encodeURIComponent(productId)}`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Gemist request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }
      const product = (await response.json()) as GemistProduct;
      return product?.id ? product : null;
    } catch (error) {
      lastError = error;
      if (!isRetryableGemistError(error) || attempt === 1) throw error;
      await delay(400 * (attempt + 1));
    }
  }
  throw lastError;
}

/** GET /api/products/{id}/parts — OpenAPI ProductPart[] */
export async function getGemistProductParts({
  apiBaseUrl,
  productId,
}: {
  apiBaseUrl: string;
  productId: string;
}): Promise<GemistProductPart[]> {
  const data = await fetchJson<GemistProductPart[] | { parts?: GemistProductPart[] }>(
    joinUrl(apiBaseUrl, `/api/products/${encodeURIComponent(productId)}/parts`),
  );
  if (Array.isArray(data)) return data;
  return Array.isArray(data.parts) ? data.parts : [];
}

/**
 * GET /api/products/{id}/prices
 * OpenAPI: additionalProperties number — key semantics NEEDS CONFIRMATION.
 */
export async function getGemistProductPrices({
  apiBaseUrl,
  productId,
}: {
  apiBaseUrl: string;
  productId: string;
}): Promise<Record<string, number>> {
  const data = await fetchJson<Record<string, number>>(
    joinUrl(apiBaseUrl, `/api/products/${encodeURIComponent(productId)}/prices`),
  );
  return data && typeof data === "object" ? data : {};
}

/** Prefer known keys if present; otherwise fall back to Product.salePrice/price. */
export function pickGemistListPrice(
  product: GemistProduct,
  prices?: Record<string, number> | null,
): number {
  if (prices) {
    for (const key of ["salePrice", "sale_price", "price", "total", "amount"]) {
      const value = prices[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
  }
  const raw = product.salePrice ?? product.price;
  const amount = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("This Gemist product does not have a valid price.");
  }
  return amount;
}

export function gemistProductPrice(product: GemistProduct): string {
  return pickGemistListPrice(product).toFixed(2);
}

/** GET /api/products/byParts */
export async function getGemistProductsByParts({
  apiBaseUrl,
  baseProductId,
  slug,
  subtype,
  parts,
}: {
  apiBaseUrl: string;
  baseProductId?: string;
  slug?: string;
  subtype?: string;
  parts?: Record<string, string>;
}): Promise<GemistProduct[]> {
  const params = new URLSearchParams();
  if (baseProductId) params.set("baseProductId", baseProductId);
  if (slug) params.set("slug", slug);
  if (subtype) params.set("subtype", subtype);
  if (parts) {
    for (const [optionType, optionValue] of Object.entries(parts)) {
      if (optionType && optionValue) params.set(optionType, optionValue);
    }
  }
  const qs = params.toString();
  const data = await fetchJson<GemistProduct[] | { products?: GemistProduct[] }>(
    joinUrl(apiBaseUrl, `/api/products/byParts${qs ? `?${qs}` : ""}`),
  );
  if (Array.isArray(data)) return data;
  return Array.isArray(data.products) ? data.products : [];
}

/** GET /health */
export async function getGemistHealth(apiBaseUrl: string): Promise<GemistHealth> {
  return fetchJson<GemistHealth>(joinUrl(apiBaseUrl, "/health"));
}

/**
 * POST /api/products/shopify — create product via Gemist (SUPPORTED).
 * Cart path today uses Shopify Admin GraphQL; call this when Gemist confirms
 * merchant credentials for this route.
 */
export async function createGemistShopifyProduct({
  apiBaseUrl,
  bearer,
  body,
}: {
  apiBaseUrl: string;
  bearer?: string;
  body: {
    product: Record<string, unknown>;
    variants?: unknown[];
    media?: unknown[];
    validateDuplicates?: boolean;
    productId?: string;
  };
}): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return fetchJson(joinUrl(apiBaseUrl, "/api/products/shopify"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function searchGemistProducts({
  apiBaseUrl,
  baseProductId,
  slug,
  productParts,
  limit = 24,
  offset = 0,
}: {
  apiBaseUrl: string;
  baseProductId?: string;
  slug?: string;
  productParts?: Record<string, string>;
  limit?: number;
  offset?: number;
}): Promise<SearchProductsResponse> {
  const body: Record<string, unknown> = { limit, offset };
  if (baseProductId) body.baseProductId = baseProductId;
  if (slug) body.slug = slug;
  if (productParts && Object.keys(productParts).length) {
    body.productParts = productParts;
  }

  return fetchJson<SearchProductsResponse>(
    joinUrl(apiBaseUrl, "/api/products/search"),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

export function getGemistOrderBearer(merchantSecret?: string) {
  return (process.env.GEMIST_ORDER_BEARER || merchantSecret || "").trim();
}

export type GemistDraftOrderInput = {
  lineItems: unknown[];
  email?: string;
  phone?: string;
  note?: string;
  customAttributes?: Record<string, string>;
};

export type GemistDraftOrderResult =
  | { ok: true; id: string; raw: unknown }
  | { ok: false; status: number; error: string };

export async function submitGemistDraftOrder({
  apiBaseUrl,
  bearer,
  body,
}: {
  apiBaseUrl: string;
  bearer: string;
  body: GemistDraftOrderInput;
}): Promise<GemistDraftOrderResult> {
  const response = await fetch(
    joinUrl(apiBaseUrl, "/api/orders/shopify/draft"),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    },
  );

  const text = await response.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { message: text.slice(0, 300) };
  }

  if (!response.ok) {
    const message =
      String(json.message || json.error || text || "").trim() ||
      `Gemist order request failed (${response.status})`;
    return { ok: false, status: response.status, error: message.slice(0, 500) };
  }

  const id = json.id ?? json.draftOrderId ?? json.orderId ?? json.gemistOrderId;
  return { ok: true, id: id != null ? String(id) : "", raw: json };
}

const SLUG_TTL_SECONDS = CACHE_TTL_SECONDS;
const STYLE_TTL_SECONDS = CACHE_TTL_SECONDS;

const styleInflight = new Map<string, Promise<GemistProduct | null>>();
let gemistActive = 0;
const gemistWaiters: Array<() => void> = [];
const GEMIST_CONCURRENCY = 2;

async function withGemistSlot<T>(task: () => Promise<T>): Promise<T> {
  if (gemistActive >= GEMIST_CONCURRENCY) {
    await new Promise<void>((resolve) => gemistWaiters.push(resolve));
  }
  gemistActive += 1;
  try {
    return await task();
  } finally {
    gemistActive -= 1;
    const next = gemistWaiters.shift();
    if (next) next();
  }
}

function cacheScope(apiBaseUrl: string) {
  return apiBaseUrl.replace(/[^a-z0-9]+/gi, "-").slice(0, 80);
}

export async function getGemistCatalogSlugs(apiBaseUrl: string): Promise<string[]> {
  return withCache(
    `gemist:v1:slugs:${cacheScope(apiBaseUrl)}`,
    SLUG_TTL_SECONDS,
    async () => {
      const slugs = await fetchJson<unknown>(
        joinUrl(apiBaseUrl, "/api/products/base/all"),
      );
      if (!Array.isArray(slugs)) return [];
      return slugs.filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
    },
  );
}

/** Drop cached style list for a catalog host so the next load hits Gemist again. */
export async function invalidateGemistCatalogSlugs(apiBaseUrl: string) {
  await cacheDelete(`gemist:v1:slugs:${cacheScope(apiBaseUrl)}`);
}

function styleCacheKey(apiBaseUrl: string, slug: string) {
  return `gemist:v1:style:${cacheScope(apiBaseUrl)}:${slug}`;
}

export async function getCachedGemistStyleProduct(
  apiBaseUrl: string,
  slug: string,
): Promise<GemistProduct | null> {
  const cached = await cacheGet<GemistProduct>(styleCacheKey(apiBaseUrl, slug));
  return cached ?? null;
}

export async function getGemistCatalogPage({
  apiBaseUrl,
  limit = 8,
  offset = 0,
  allowedSlugs,
}: {
  apiBaseUrl: string;
  limit?: number;
  offset?: number;
  /** When set, only these style slugs are returned (storefront visibility). */
  allowedSlugs?: string[] | null;
}): Promise<{ slugs: string[]; products: GemistProduct[]; productsCount: number }> {
  const allSlugs = await getGemistCatalogSlugs(apiBaseUrl);
  const slugs =
    allowedSlugs == null
      ? allSlugs
      : allSlugs.filter((slug) => allowedSlugs.includes(slug));
  const start = Math.max(offset, 0);
  const selected = slugs.slice(start, start + Math.max(limit, 1));
  const loaded = await Promise.all(
    selected.map(async (slug) => {
      try {
        return await getGemistStyleProduct(apiBaseUrl, slug);
      } catch (error) {
        console.error("[gemist] failed to load style", slug, error);
        return null;
      }
    }),
  );
  const products = loaded.filter((product): product is GemistProduct => Boolean(product));

  return {
    slugs,
    products,
    productsCount: slugs.length,
  };
}

export async function getGemistStyleProduct(
  apiBaseUrl: string,
  slug: string,
): Promise<GemistProduct | null> {
  const key = styleCacheKey(apiBaseUrl, slug);
  const cached = await cacheGet<GemistProduct>(key);
  if (cached) return cached;

  const existing = styleInflight.get(key);
  if (existing) return existing;

  const request = withGemistSlot(async () => {
    const again = await cacheGet<GemistProduct>(key);
    if (again) return again;

    const baseKey = `gemist:v1:base:${cacheScope(apiBaseUrl)}:${slug}`;
    let baseId = (await cacheGet<{ id?: string }>(baseKey))?.id;
    if (!baseId) {
      const base = await fetchJson<{ id?: string }>(
        joinUrl(apiBaseUrl, `/api/products/base/${encodeURIComponent(slug)}`),
      );
      baseId = base.id;
      if (baseId) await cacheSet(baseKey, { id: baseId }, STYLE_TTL_SECONDS);
    }
    if (!baseId) return null;

    const result = await searchGemistProducts({
      apiBaseUrl,
      baseProductId: baseId,
      limit: 1,
      offset: 0,
    });
    const product = result.products?.[0] ?? null;
    if (!product) return null;
    product.baseProductId = product.baseProductId || baseId;
    product.availableProductParts = result.availableProductParts;
    product.selectedProductParts = result.selectedProductParts;
    await cacheSet(key, product, STYLE_TTL_SECONDS);
    return product;
  }).finally(() => styleInflight.delete(key));

  styleInflight.set(key, request);
  return request;
}

export async function pingGemistApi(apiBaseUrl: string) {
  let health: GemistHealth | null = null;
  try {
    health = await getGemistHealth(apiBaseUrl);
  } catch {
    /* catalog ping still proves reachability */
  }

  const slugs = await getGemistCatalogSlugs(apiBaseUrl);
  return {
    ok: Array.isArray(slugs),
    styleCount: Array.isArray(slugs) ? slugs.length : 0,
    version: health?.version || "",
    healthMessage: health?.message || "",
    /**
     * API DEPENDENCY: OpenAPI does not document a credential-validation route.
     * Merchant secret is only proven when calling Bearer-protected
     * POST /api/orders/shopify/draft.
     */
    credentialsValidated: false as const,
  };
}

export async function listGemistCatalogProducts({
  apiBaseUrl,
  limit = 48,
  offset = 0,
}: {
  apiBaseUrl: string;
  limit?: number;
  offset?: number;
}): Promise<SearchProductsResponse> {
  const slugs = await getGemistCatalogSlugs(apiBaseUrl);
  const start = Math.max(offset, 0);
  const selected = slugs.slice(start, start + Math.max(limit, 1));
  const products = (
    await Promise.all(
      selected.map(async (slug) => {
        try {
          return await getGemistStyleProduct(apiBaseUrl, slug);
        } catch (error) {
          console.error("[gemist] failed to load style", slug, error);
          return null;
        }
      }),
    )
  ).filter((product): product is GemistProduct => Boolean(product));

  return {
    products,
    productsCount: slugs.length,
    limit,
    offset: start,
  };
}
