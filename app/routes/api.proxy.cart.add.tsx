import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  resolveGemistApiBaseUrl,
  getGemistProduct,
  getGemistProductPrices,
  pickGemistListPrice,
} from "../lib/gemist-api.server";
import { createGemistCartLine } from "../lib/gemist-cart.server";
import { applyMarkup, formatMoney } from "../lib/pricing.server";
import { authenticateAppProxy } from "../lib/app-proxy.server";
import { getMerchantSettings } from "../models/merchant-settings.server";

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

  if (!admin) {
    return json({
      error:
        "Open the Gemist app in Shopify admin once so it can create cart products, then try again.",
    });
  }

  let gemistProductId = "";
  let engraving = "";
  try {
    const payload = await readCartPayload(request);
    gemistProductId = payload.gemistProductId;
    engraving = payload.engraving;
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
    const markedUp = formatMoney(
      applyMarkup(pickGemistListPrice(product, prices), settings.markupPercent),
    );
    const line = await createGemistCartLine(admin, product, {
      price: markedUp,
      engraving,
    });
    return json({
      variantId: line.variantId,
      variantGid: line.variantGid,
      productGid: line.productGid,
      properties: line.properties,
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
    };
    return {
      gemistProductId: String(body.gemistProductId || "").trim(),
      engraving: String(body.engraving || "").trim(),
    };
  }
  const form = await request.formData();
  return {
    gemistProductId: String(form.get("gemistProductId") || "").trim(),
    engraving: String(form.get("engraving") || "").trim(),
  };
}
