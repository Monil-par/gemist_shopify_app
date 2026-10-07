import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  resolveGemistApiBaseUrl,
  getGemistProduct,
  getGemistProductPrices,
  pickGemistListPrice,
} from "../lib/gemist-api.server";
import { createGemistCartLine } from "../lib/gemist-cart.server";
import { createGemistShopifyCartLine } from "../lib/gemist-shopify-product.server";
import {
  applyMultiplier,
  formatMoney,
  partsFromProduct,
} from "../lib/pricing.server";
import { authenticateAppProxy } from "../lib/app-proxy.server";
import { getMerchantSettings } from "../models/merchant-settings.server";
import { resolveShopMarkup } from "../models/markup-rules.server";
import { isStoreActive, STORE_INACTIVE_MESSAGE } from "../lib/access.server";
import { useGemistShopifyProductCreate } from "../lib/features.server";

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const loader = async (_args: LoaderFunctionArgs) => {
  return json({ error: "Use POST to add a Gemist product to the cart." });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." });
  }

  let admin:
    | {
        graphql: (
          query: string,
          options?: { variables?: unknown },
        ) => Promise<Response>;
      }
    | undefined;
  let shop = "";
  try {
    const context = await authenticateAppProxy(request);
    admin = context.admin;
    shop = context.shop;
  } catch (error) {
    console.error("[gemist cart] auth failed", error);
    return json({
      error:
        "App proxy authentication failed. Reinstall the Gemist app on this store, then try again.",
    });
  }

  if (!(await isStoreActive(shop))) {
    return json({ licenseInactive: true, error: STORE_INACTIVE_MESSAGE });
  }

  if (!admin) {
    return json({
      error:
        "Open the Gemist app in Shopify admin once so it can create cart products, then try again.",
    });
  }

  let gemistProductId = "";
  let engraving = "";
  let engravingFont = "";
  let engravingFee = 0;
  try {
    const payload = await readCartPayload(request);
    gemistProductId = payload.gemistProductId;
    engraving = payload.engraving;
    engravingFont = payload.engravingFont;
    engravingFee = payload.engravingFee;
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "Missing Gemist product id.",
    });
  }

  if (!gemistProductId) {
    return json({ error: "Missing Gemist product id." });
  }

  try {
    const settings = shop
      ? await getMerchantSettings(shop)
      : { markupPercent: 0, apiBaseUrl: "" };
    const apiBaseUrl = resolveGemistApiBaseUrl(settings.apiBaseUrl);
    const product = await getGemistProduct({
      apiBaseUrl,
      productId: gemistProductId,
    });
    if (!product) {
      return json({ error: "Gemist product not found." });
    }
    let prices: Record<string, number> | null = null;
    try {
      prices = await getGemistProductPrices({
        apiBaseUrl,
        productId: gemistProductId,
      });
    } catch (error) {
      console.warn("[gemist cart] /prices unavailable; using product price", error);
    }
    const resolved = await resolveShopMarkup(
      shop,
      partsFromProduct(product),
      settings.markupPercent,
    );
    const baseMarked = applyMultiplier(
      pickGemistListPrice(product, prices),
      resolved.multiplier,
    );
    const fee =
      engraving && Number.isFinite(engravingFee) && engravingFee > 0
        ? engravingFee
        : 0;
    const markedUp = formatMoney(baseMarked + fee);
    const cartOptions = {
      price: markedUp,
      engraving,
      engravingFont: engraving ? engravingFont : "",
      engravingFee: fee,
    };

    let line;
    if (useGemistShopifyProductCreate()) {
      try {
        line = await createGemistShopifyCartLine({
          admin,
          apiBaseUrl,
          product,
          shop,
          options: cartOptions,
        });
      } catch (error) {
        console.warn(
          "[gemist cart] Gemist /api/products/shopify failed; falling back to Admin GraphQL",
          error,
        );
        line = await createGemistCartLine(admin, product, cartOptions);
      }
    } else {
      line = await createGemistCartLine(admin, product, cartOptions);
    }

    return json({
      variantId: line.variantId,
      variantGid: line.variantGid,
      productGid: line.productGid,
      properties: line.properties,
      markup: {
        multiplier: resolved.multiplier,
        ruleId: resolved.ruleId,
        source: resolved.source,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not add this item to the cart.";
    console.error("[gemist cart] add failed", message);
    return json({ error: message });
  }
};

async function readCartPayload(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as {
      gemistProductId?: unknown;
      engraving?: unknown;
      engravingFont?: unknown;
      engravingFee?: unknown;
    };
    return {
      gemistProductId: String(body.gemistProductId || "").trim(),
      engraving: String(body.engraving || "").trim(),
      engravingFont: String(body.engravingFont || "").trim(),
      engravingFee: Number(body.engravingFee) || 0,
    };
  }
  const form = await request.formData();
  return {
    gemistProductId: String(form.get("gemistProductId") || "").trim(),
    engraving: String(form.get("engraving") || "").trim(),
    engravingFont: String(form.get("engravingFont") || "").trim(),
    engravingFee: Number(form.get("engravingFee") || 0) || 0,
  };
}
