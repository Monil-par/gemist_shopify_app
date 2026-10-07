import {
  createGemistShopifyProduct,
  gemistProductPrice,
  getGemistOrderBearer,
  getGemistShopifyMetadata,
  type GemistProduct,
} from "./gemist-api.server";
import {
  cartProperties,
  createGemistCartLine,
  type GemistCartLine,
} from "./gemist-cart.server";
import { getMerchantCredentials } from "../models/merchant-credential.server";

type Admin = {
  graphql: (
    query: string,
    options?: { variables?: unknown },
  ) => Promise<Response>;
};

type CartOptions = {
  price?: string;
  engraving?: string;
  engravingFont?: string;
  engravingFee?: number;
};

/**
 * SOW 3.6: create the Shopify product through Gemist, then return a cart line.
 * Throws when Gemist cannot produce a usable variant id so the caller can fall back.
 */
export async function createGemistShopifyCartLine({
  admin,
  apiBaseUrl,
  product,
  shop,
  options,
}: {
  admin: Admin;
  apiBaseUrl: string;
  product: GemistProduct;
  shop?: string;
  options?: CartOptions;
}): Promise<GemistCartLine> {
  if (!product.id) throw new Error("Gemist product is missing an id.");

  const credentials = shop ? await getMerchantCredentials(shop) : null;
  const bearer = getGemistOrderBearer(credentials?.merchantSecret) || undefined;
  const price = options?.price || gemistProductPrice(product);
  const title = product.title || product.shortTitle || "Gemist Custom Jewelry";
  const sku = String(product.sku || product.id).slice(0, 64);
  const image =
    typeof product.thumbnail === "string"
      ? product.thumbnail
      : product.thumbnail?.url ||
        product.thumbnail?.src ||
        (typeof product.images?.[0] === "string"
          ? product.images[0]
          : product.images?.[0]?.url || product.images?.[0]?.src || "");

  const created = await createGemistShopifyProduct({
    apiBaseUrl,
    bearer,
    body: {
      product: {
        title,
        body_html: product.description || "",
        vendor: product.vendor || "Gemist",
        product_type: product.type || "Jewelry",
        tags: ["gemist", "gemist-configured"].join(", "),
        status: "active",
      },
      variants: [
        {
          price: String(price),
          sku,
          requires_shipping: true,
          inventory_management: null,
          inventory_policy: "continue",
        },
      ],
      media: image
        ? [{ originalSource: image, mediaContentType: "IMAGE", alt: title }]
        : [],
      validateDuplicates: true,
      productId: product.id,
    },
  });

  let variantId = extractVariantId(created);
  let productGid = extractProductGid(created);

  if (!variantId) {
    const meta = await getGemistShopifyMetadata({
      apiBaseUrl,
      productId: product.id,
      bearer,
    });
    const fromMeta = extractVariantId(meta);
    const fromNumeric = numericId(meta.variantId);
    variantId = fromMeta || (fromNumeric ? String(fromNumeric) : "");
    const metaProductId =
      meta.productId != null ? String(meta.productId) : "";
    productGid =
      productGid ||
      (metaProductId
        ? metaProductId.startsWith("gid://")
          ? metaProductId
          : `gid://shopify/Product/${metaProductId}`
        : "");
  }

  if (!variantId) {
    throw new Error("Gemist Shopify product create did not return a variant id.");
  }

  const properties = cartProperties(product, {
    engraving: options?.engraving,
    engravingFont: options?.engravingFont,
    engravingFee: options?.engravingFee,
  });

  const variantGid = variantId.startsWith("gid://")
    ? variantId
    : `gid://shopify/ProductVariant/${variantId}`;
  const numericVariant = numericId(variantId);
  if (!numericVariant) {
    throw new Error("Gemist Shopify variant id is not numeric.");
  }

  // Ensure Online Store publication when we have Admin access and a product id.
  if (productGid && admin) {
    try {
      await ensurePublished(admin, productGid);
    } catch (error) {
      console.warn("[gemist cart] could not publish Gemist-created product", error);
    }
  }

  return {
    variantId: numericVariant,
    variantGid,
    productGid: productGid || "",
    properties,
  };
}

/** Used by cart route when Gemist path is disabled or fails. */
export { createGemistCartLine };

function numericId(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value || "");
  const match = raw.match(/(\d+)\s*$/);
  return match ? Number(match[1]) : 0;
}

function extractVariantId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const direct =
    record.variantId ||
    record.variant_id ||
    (record.variant && typeof record.variant === "object"
      ? (record.variant as { id?: unknown }).id
      : "");
  if (direct) return String(direct);

  const product = record.product;
  if (product && typeof product === "object") {
    const variants = (product as { variants?: unknown }).variants;
    if (Array.isArray(variants) && variants[0] && typeof variants[0] === "object") {
      const id = (variants[0] as { id?: unknown; admin_graphql_api_id?: unknown }).id
        || (variants[0] as { admin_graphql_api_id?: unknown }).admin_graphql_api_id;
      if (id) return String(id);
    }
  }

  if (Array.isArray(record.variants) && record.variants[0] && typeof record.variants[0] === "object") {
    const id = (record.variants[0] as { id?: unknown }).id;
    if (id) return String(id);
  }
  return "";
}

function extractProductGid(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const product = record.product;
  if (product && typeof product === "object") {
    const id =
      (product as { admin_graphql_api_id?: unknown; id?: unknown }).admin_graphql_api_id ||
      (product as { id?: unknown }).id;
    if (id) {
      const value = String(id);
      return value.startsWith("gid://") ? value : `gid://shopify/Product/${value}`;
    }
  }
  if (record.productId) {
    const value = String(record.productId);
    return value.startsWith("gid://") ? value : `gid://shopify/Product/${value}`;
  }
  return "";
}

async function ensurePublished(admin: Admin, productGid: string) {
  const pubs = await admin.graphql(`#graphql
    query GemistPublications {
      publications(first: 20) {
        nodes { id name }
      }
    }
  `);
  const pubsJson = await pubs.json();
  const nodes = (pubsJson.data?.publications?.nodes || []) as Array<{ id: string; name: string }>;
  const online =
    nodes.find((item) => /online store/i.test(item.name)) ||
    nodes[0];
  if (!online?.id) return;
  await admin.graphql(
    `#graphql
      mutation GemistPublish($id: ID!, $publicationId: ID!) {
        publishablePublish(id: $id, input: [{ publicationId: $publicationId }]) {
          userErrors { message }
        }
      }
    `,
    { variables: { id: productGid, publicationId: online.id } },
  );
}
