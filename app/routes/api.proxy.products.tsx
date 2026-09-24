import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  resolveGemistApiBaseUrl,
  getGemistCatalogPage,
  getGemistCatalogSlugs,
  getGemistStyleProduct,
  getGemistProduct,
  searchGemistProducts,
} from "../lib/gemist-api.server";
import { authenticateAppProxy } from "../lib/app-proxy.server";
import { getMerchantSettings } from "../models/merchant-settings.server";
import {
  filterActiveCatalogSlugs,
  getCatalogStatusMap,
  getCatalogStyleStatus,
} from "../models/merchant-catalog.server";

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function resolveApiBase(shop: string) {
  let settings = null;
  try {
    settings = shop ? await getMerchantSettings(shop) : null;
  } catch (error) {
    console.error("[gemist proxy] failed to load merchant settings", error);
  }
  return resolveGemistApiBaseUrl(settings?.apiBaseUrl);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  let shop = "";
  try {
    const context = await authenticateAppProxy(request);
    shop = context.shop;
  } catch (error) {
    console.error("[gemist proxy] auth failed", error);
    return json({
      slugs: [],
      products: [],
      productsCount: 0,
      error:
        "App proxy authentication failed. Reinstall the Gemist app on this store, then run shopify app deploy.",
    });
  }

  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") || "").trim();
  const productId = (url.searchParams.get("id") || "").trim();
  const limit = Math.max(Number(url.searchParams.get("limit") || 8) || 8, 1);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0) || 0, 0);
  const apiBaseUrl = await resolveApiBase(shop);

  try {
    if (productId) {
      const product = await getGemistProduct({ apiBaseUrl, productId });
      if (!product) {
        return json({
          product: null,
          error: `Gemist product not found for id ${productId}.`,
        });
      }
      const productSlug = String(product.slug || "").trim();
      if (shop && productSlug) {
        const status = await getCatalogStyleStatus(shop, productSlug);
        if (status !== "active") {
          return json({
            product: null,
            error: "This product is not available on the storefront.",
          });
        }
      }
      return json({ product });
    }

    if (slug) {
      if (shop) {
        const status = await getCatalogStyleStatus(shop, slug);
        if (status !== "active") {
          return json({
            product: null,
            error: "This product is not available on the storefront.",
          });
        }
      }
      const product = await getGemistStyleProduct(apiBaseUrl, slug);
      if (!product) {
        return json({
          product: null,
          error: `Gemist style not found for slug ${slug}.`,
        });
      }
      return json({ product });
    }

    const allSlugs = await getGemistCatalogSlugs(apiBaseUrl);
    const statusMap = shop ? await getCatalogStatusMap(shop) : {};
    const allowedSlugs = shop
      ? filterActiveCatalogSlugs(allSlugs, statusMap)
      : allSlugs;

    const result = await getGemistCatalogPage({
      apiBaseUrl,
      limit,
      offset,
      allowedSlugs,
    });
    return json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not load Gemist products.";
    console.error("[gemist proxy] catalog failed", message);
    if (productId || slug) return json({ product: null, error: message });
    return json({
      slugs: [],
      products: [],
      productsCount: 0,
      error: message,
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  let shop = "";
  try {
    const context = await authenticateAppProxy(request);
    shop = context.shop;
  } catch (error) {
    console.error("[gemist proxy] auth failed", error);
    return json({
      products: [],
      error:
        "App proxy authentication failed. Reinstall the Gemist app on this store, then run shopify app deploy.",
    });
  }

  const apiBaseUrl = await resolveApiBase(shop);

  try {
    const body = (await request.json().catch(() => ({}))) as {
      baseProductId?: string;
      slug?: string;
      productParts?: Record<string, string>;
      limit?: number;
      offset?: number;
    };

    const result = await searchGemistProducts({
      apiBaseUrl,
      baseProductId: body.baseProductId,
      slug: body.slug,
      productParts: body.productParts,
      limit: body.limit ?? 1,
      offset: body.offset ?? 0,
    });
    return json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not search Gemist products.";
    console.error("[gemist proxy] search failed", message);
    return json({ products: [], error: message });
  }
};
