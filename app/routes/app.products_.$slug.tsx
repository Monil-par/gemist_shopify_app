import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ShopBanner } from "../components/shop-banner";
import { getShopProfile } from "../lib/shop-profile.server";
import { getMerchantSettings } from "../models/merchant-settings.server";
import {
  getCatalogStyleStatus,
  isCatalogStyleStatus,
  setCatalogStyleStatus,
  type CatalogStyleStatus,
} from "../models/merchant-catalog.server";
import {
  getGemistStyleProduct,
  resolveGemistApiBaseUrl,
} from "../lib/gemist-api.server";
import productsAdminStyles from "../styles/products-admin.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: productsAdminStyles },
];

type ActionData = { ok: true } | { ok: false; error: string };

function mediaUrl(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value) {
    const record = value as { url?: string; src?: string };
    return record.url || record.src || "";
  }
  return "";
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const slug = decodeURIComponent(params.slug || "").trim();
  if (!slug) {
    throw new Response("Not found", { status: 404 });
  }

  let profile = {
    name: session.shop,
    domain: session.shop,
    storefrontUrl: `https://${session.shop}`,
  };
  try {
    profile = await getShopProfile(admin, session.shop);
  } catch (error) {
    console.warn("[gemist product detail] shop profile failed", error);
  }

  let apiBaseUrl = resolveGemistApiBaseUrl("");
  try {
    const settings = await getMerchantSettings(session.shop);
    apiBaseUrl = resolveGemistApiBaseUrl(settings.apiBaseUrl);
  } catch (error) {
    console.warn("[gemist product detail] settings failed", error);
  }

  let status = "active" as Awaited<ReturnType<typeof getCatalogStyleStatus>>;
  try {
    status = await getCatalogStyleStatus(session.shop, slug);
  } catch (error) {
    console.warn("[gemist product detail] status failed", error);
  }

  let product;
  try {
    product = await getGemistStyleProduct(apiBaseUrl, slug);
  } catch (error) {
    console.error("[gemist product detail] catalog fetch failed", error);
    throw new Response(
      error instanceof Error ? error.message : "Could not load product",
      { status: 502 },
    );
  }
  if (!product) {
    throw new Response("Product not found in Gemist catalog", { status: 404 });
  }

  const parts =
    product.productParts ||
    product.selectedProductParts ||
    product.defaultProductMetadata ||
    {};

  const images = (product.images || [])
    .map(mediaUrl)
    .filter(Boolean) as string[];
  const hero =
    mediaUrl(product.thumbnail) || images[0] || "";

  return {
    profile,
    status,
    product: {
      id: String(product.id || ""),
      baseProductId: String(product.baseProductId || ""),
      title: String(
        product.title || product.shortTitle || product.style || slug,
      ),
      description: String(product.description || product.subtitle || ""),
      slug,
      sku: String(product.sku || ""),
      vendor: String(product.vendor || ""),
      style: String(product.style || ""),
      metal: String(product.metal || ""),
      type: String(product.type || ""),
      subtype: String(product.subtype || ""),
      price:
        product.salePrice != null
          ? String(product.salePrice)
          : product.price != null
            ? String(product.price)
            : "",
      hero,
      images,
      parts: Object.fromEntries(
        Object.entries(parts).filter(
          ([, value]) =>
            value != null && value !== "" && typeof value !== "object",
        ),
      ) as Record<string, string>,
      manufacturerMetadata: product.manufacturerMetadata || null,
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const slug = decodeURIComponent(params.slug || "").trim();
  const formData = await request.formData();
  const status = String(formData.get("status") || "").trim();
  const title = String(formData.get("title") || "").trim();
  const gemistProductId = String(formData.get("gemistProductId") || "").trim();

  if (!slug || !isCatalogStyleStatus(status)) {
    return { ok: false, error: "Invalid status." } satisfies ActionData;
  }

  try {
    await setCatalogStyleStatus({
      shop: session.shop,
      slug,
      status,
      title,
      gemistProductId,
    });
    return { ok: true } satisfies ActionData;
  } catch (error) {
    console.error("[gemist product detail] set-status failed", error);
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not update product visibility.",
    } satisfies ActionData;
  }
};

export default function ProductDetailPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [busyStatus, setBusyStatus] = useState<string>("");

  const { product, status } = data;

  const updateStatus = async (nextStatus: CatalogStyleStatus) => {
    if (busyStatus) return;
    setBusyStatus(nextStatus);
    try {
      const token =
        typeof shopify.idToken === "function" ? await shopify.idToken() : "";
      const body = new URLSearchParams({
        slug: product.slug,
        status: nextStatus,
        title: product.title,
        gemistProductId: product.id,
      });
      const response = await fetch("/api/catalog-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.ok) {
        shopify.toast.show(payload?.error || "Update failed");
        return;
      }
      shopify.toast.show("Product visibility updated.");
      window.location.reload();
    } catch (error) {
      shopify.toast.show(
        error instanceof Error ? error.message : "Update failed",
      );
    } finally {
      setBusyStatus("");
    }
  };

  return (
    <s-page heading={product.title}>
      <ShopBanner shopName={data.profile.name} shopDomain={data.profile.domain} />

      <s-section>
        <s-stack direction="inline" gap="base">
          <Link to="/app/products">
            <s-button>Back to products</s-button>
          </Link>
          <span
            className={`gemist-admin-badge${
              status !== "active" ? ` gemist-admin-badge--${status}` : ""
            }`}
          >
            {status}
          </span>
        </s-stack>
      </s-section>

      <s-section heading="Storefront visibility">
        <s-paragraph>
          Active = shown in the storefront grid. Archive and Delete hide the
          style from shoppers without removing it from Gemist.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          {(
            [
              ["active", "Activate", undefined],
              ["archived", "Archive", undefined],
              ["deleted", "Delete", "critical"],
            ] as const
          )
            .filter(([value]) => value !== status)
            .map(([value, label, tone]) => (
              <s-button
                key={value}
                type="button"
                variant={value === "active" ? "primary" : "secondary"}
                {...(tone ? { tone } : {})}
                {...(busyStatus === value ? { loading: true } : {})}
                onClick={() => updateStatus(value)}
              >
                {label}
              </s-button>
            ))}
        </s-stack>
      </s-section>

      <s-section heading="Details">
        <div className="gemist-admin-detail-media">
          <div>
            {product.hero ? (
              <img
                className="gemist-admin-detail-hero"
                src={product.hero}
                alt={product.title}
              />
            ) : (
              <div className="gemist-admin-detail-hero" />
            )}
            {product.images.length > 1 ? (
              <div className="gemist-admin-thumbs">
                {product.images.slice(0, 8).map((src) => (
                  <img key={src} src={src} alt="" />
                ))}
              </div>
            ) : null}
          </div>
          <s-stack direction="block" gap="base">
            {product.description ? (
              <s-paragraph>{product.description}</s-paragraph>
            ) : null}
            {product.price ? (
              <s-paragraph>
                <strong>Price</strong> {product.price}
              </s-paragraph>
            ) : null}
            <s-paragraph>
              <strong>Slug</strong> {product.slug}
            </s-paragraph>
            {product.id ? (
              <s-paragraph>
                <strong>Gemist product id</strong> {product.id}
              </s-paragraph>
            ) : null}
            {product.baseProductId ? (
              <s-paragraph>
                <strong>Base product id</strong> {product.baseProductId}
              </s-paragraph>
            ) : null}
            {product.sku ? (
              <s-paragraph>
                <strong>SKU</strong> {product.sku}
              </s-paragraph>
            ) : null}
            {product.vendor ? (
              <s-paragraph>
                <strong>Vendor</strong> {product.vendor}
              </s-paragraph>
            ) : null}
            {product.style ? (
              <s-paragraph>
                <strong>Style</strong> {product.style}
              </s-paragraph>
            ) : null}
            {product.type ? (
              <s-paragraph>
                <strong>Type</strong> {product.type}
                {product.subtype ? ` / ${product.subtype}` : ""}
              </s-paragraph>
            ) : null}
            {product.metal ? (
              <s-paragraph>
                <strong>Metal</strong> {product.metal}
              </s-paragraph>
            ) : null}
          </s-stack>
        </div>
      </s-section>

      {Object.keys(product.parts).length ? (
        <s-section heading="Configuration / parts">
          <ul className="gemist-admin-specs">
            {Object.entries(product.parts).map(([label, value]) => (
              <li key={label}>
                <span>{label.replace(/_/g, " ")}</span>
                <strong>{value}</strong>
              </li>
            ))}
          </ul>
        </s-section>
      ) : null}

      {product.manufacturerMetadata ? (
        <s-section heading="Manufacturer metadata">
          <ul className="gemist-admin-specs">
            {Object.entries(product.manufacturerMetadata).map(
              ([label, value]) =>
                value == null || value === "" || typeof value === "object" ? null : (
                  <li key={label}>
                    <span>{label}</span>
                    <strong>{String(value)}</strong>
                  </li>
                ),
            )}
          </ul>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
