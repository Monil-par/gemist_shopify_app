import { useEffect, useState, type MouseEvent } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useFetcher, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ShopBanner } from "../components/shop-banner";
import { getShopProfile } from "../lib/shop-profile.server";
import { getMerchantSettings } from "../models/merchant-settings.server";
import {
  filterCatalogSlugsByStatus,
  getCatalogStatusMap,
  isCatalogStyleStatus,
  setCatalogStyleStatus,
  type CatalogStyleStatus,
} from "../models/merchant-catalog.server";
import {
  getGemistCatalogSlugs,
  getGemistStyleProduct,
  invalidateGemistCatalogSlugs,
  pingGemistApi,
  resolveGemistApiBaseUrl,
  type GemistProduct,
} from "../lib/gemist-api.server";
import productsAdminStyles from "../styles/products-admin.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: productsAdminStyles },
];

const PAGE_SIZE = 12;

type ActionData =
  | { ok: true; intent: string; styleCount?: number }
  | { ok: false; error: string };

type ListProduct = {
  id: string;
  title: string;
  slug: string;
  sku: string;
  price: string;
  image: string;
  vendor: string;
  status: CatalogStyleStatus;
};

function mediaUrl(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value) {
    const record = value as { url?: string; src?: string };
    return record.url || record.src || "";
  }
  return "";
}

function mapProduct(
  product: GemistProduct,
  status: CatalogStyleStatus,
): ListProduct {
  return {
    id: String(product.id || ""),
    title: String(
      product.title || product.shortTitle || product.style || product.slug || "Untitled",
    ),
    slug: String(product.slug || ""),
    sku: String(product.sku || ""),
    price:
      product.salePrice != null
        ? String(product.salePrice)
        : product.price != null
          ? String(product.price)
          : "",
    image: mediaUrl(product.thumbnail) || mediaUrl(product.images?.[0]),
    vendor: String(product.vendor || ""),
    status,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(Number(url.searchParams.get("page") || 1) || 1, 1);
  const layout = url.searchParams.get("layout") === "list" ? "list" : "grid";
  const statusParam = url.searchParams.get("status") || "active";
  const statusFilter =
    statusParam === "all" || isCatalogStyleStatus(statusParam)
      ? statusParam
      : "active";

  let profile = {
    name: session.shop,
    domain: session.shop,
    storefrontUrl: `https://${session.shop}`,
  };
  try {
    profile = await getShopProfile(admin, session.shop);
  } catch (error) {
    console.warn("[gemist products] shop profile failed", error);
  }

  let apiBaseUrl = resolveGemistApiBaseUrl("");
  try {
    const settings = await getMerchantSettings(session.shop);
    apiBaseUrl = resolveGemistApiBaseUrl(settings.apiBaseUrl);
  } catch (error) {
    console.warn("[gemist products] settings failed", error);
  }

  let statusMap: Record<string, CatalogStyleStatus> = {};
  let statusDbWarning = "";
  try {
    statusMap = await getCatalogStatusMap(session.shop);
  } catch (error) {
    statusDbWarning =
      error instanceof Error
        ? error.message
        : "Could not load product visibility from the database.";
    console.error("[gemist products] status map failed", error);
  }

  let catalogOk = false;
  let catalogError = "";
  let version = "";
  let products: ListProduct[] = [];
  let filteredCount = 0;
  let totalStyles = 0;

  try {
    const ping = await pingGemistApi(apiBaseUrl);
    catalogOk = ping.ok;
    version = ping.version;
    const allSlugs = await getGemistCatalogSlugs(apiBaseUrl);
    totalStyles = allSlugs.length;
    const filteredSlugs = filterCatalogSlugsByStatus(
      allSlugs,
      statusMap,
      statusFilter as CatalogStyleStatus | "all",
    );
    filteredCount = filteredSlugs.length;
    const offset = (page - 1) * PAGE_SIZE;
    const pageSlugs = filteredSlugs.slice(offset, offset + PAGE_SIZE);
    const loaded = await Promise.all(
      pageSlugs.map(async (slug) => {
        try {
          return await getGemistStyleProduct(apiBaseUrl, slug);
        } catch {
          return null;
        }
      }),
    );
    products = loaded
      .filter((product): product is GemistProduct => Boolean(product?.slug))
      .map((product) =>
        mapProduct(product, statusMap[String(product.slug)] || "active"),
      );
  } catch (error) {
    catalogOk = false;
    catalogError =
      error instanceof Error ? error.message : "Could not load Gemist catalog.";
    console.error("[gemist products] catalog failed", error);
  }

  const pageCount = Math.max(Math.ceil(filteredCount / PAGE_SIZE), 1);

  return {
    profile,
    apiBaseUrl,
    catalogOk,
    catalogError,
    statusDbWarning,
    version,
    totalStyles,
    filteredCount,
    page,
    pageCount,
    layout,
    statusFilter,
    products,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "refresh") {
    const settings = await getMerchantSettings(session.shop);
    const apiBaseUrl = resolveGemistApiBaseUrl(settings.apiBaseUrl);
    try {
      await invalidateGemistCatalogSlugs(apiBaseUrl);
      const ping = await pingGemistApi(apiBaseUrl);
      return {
        ok: true,
        intent: "refresh",
        styleCount: ping.styleCount,
      } satisfies ActionData;
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not refresh the Gemist catalog.",
      } satisfies ActionData;
    }
  }

  if (intent === "set-status") {
    const slug = String(formData.get("slug") || "").trim();
    const status = String(formData.get("status") || "").trim();
    const title = String(formData.get("title") || "").trim();
    const gemistProductId = String(formData.get("gemistProductId") || "").trim();
    if (!slug || !isCatalogStyleStatus(status)) {
      return { ok: false, error: "Invalid product status update." } satisfies ActionData;
    }
    try {
      await setCatalogStyleStatus({
        shop: session.shop,
        slug,
        status,
        title,
        gemistProductId,
      });
      return { ok: true, intent: "set-status" } satisfies ActionData;
    } catch (error) {
      console.error("[gemist products] set-status failed", error);
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not update product visibility.",
      } satisfies ActionData;
    }
  }

  return { ok: false, error: "Unknown action." } satisfies ActionData;
};

export default function ProductsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();

  useEffect(() => {
    if (!fetcher.data || !("ok" in fetcher.data)) return;
    if (!fetcher.data.ok) {
      shopify.toast.show(fetcher.data.error || "Action failed");
      return;
    }
    if (fetcher.data.intent === "refresh") {
      shopify.toast.show(
        `Catalog refreshed (${fetcher.data.styleCount ?? 0} styles).`,
      );
      window.location.reload();
      return;
    }
    if (fetcher.data.intent === "set-status") {
      shopify.toast.show("Product visibility updated.");
      window.location.reload();
    }
  }, [fetcher.data, shopify]);

  const buildHref = (patch: Record<string, string | number>) => {
    const params = new URLSearchParams(searchParams);
    Object.entries(patch).forEach(([key, value]) => {
      params.set(key, String(value));
    });
    return `/app/products?${params.toString()}`;
  };

  const busy =
    fetcher.state !== "idle" &&
    ["refresh", "set-status"].includes(
      String(fetcher.formData?.get("intent") || ""),
    );

  const listNavigating =
    navigation.state === "loading" &&
    navigation.location?.pathname === "/app/products";

  const pendingSearch = listNavigating
    ? new URLSearchParams(navigation.location?.search || "")
    : null;
  const pendingPage = pendingSearch
    ? Math.max(Number(pendingSearch.get("page") || data.page) || 1, 1)
    : data.page;
  const pendingLayout =
    pendingSearch?.get("layout") === "list" ? "list" : data.layout;

  return (
    <s-page heading="Manage products">
      <ShopBanner shopName={data.profile.name} shopDomain={data.profile.domain} />

      <s-section heading="Storefront visibility">
        <s-paragraph>
          Active products appear in the storefront Product grid. Archived and
          deleted styles stay in admin but are hidden from shoppers. No Shopify
          Product mapping is created.
        </s-paragraph>
        <s-paragraph>
          Catalog: {data.apiBaseUrl}
          {data.catalogOk
            ? ` · ${data.totalStyles} Gemist styles${
                data.version ? ` · API ${data.version}` : ""
              }`
            : ""}
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="refresh" />
          <s-button
            type="submit"
            variant="secondary"
            {...(busy && String(fetcher.formData?.get("intent")) === "refresh"
              ? { loading: true }
              : {})}
          >
            Refresh catalog cache
          </s-button>
        </fetcher.Form>
      </s-section>

      <s-section heading={`Products (${data.filteredCount})`}>
        {data.statusDbWarning ? (
          <s-banner heading="Visibility database not ready" tone="warning">
            {data.statusDbWarning} Restart the app container so migrations run,
            or run: npx prisma migrate deploy
          </s-banner>
        ) : null}
        {!data.catalogOk ? (
          <s-banner heading="Catalog unavailable" tone="warning">
            {data.catalogError || "Check the Gemist catalog URL in Settings."}
          </s-banner>
        ) : null}

        <div className="gemist-admin-toolbar">
          <div className="gemist-admin-toolbar__group">
            {(
              [
                ["active", "Active"],
                ["archived", "Archived"],
                ["deleted", "Deleted"],
                ["all", "All (except deleted)"],
              ] as const
            ).map(([value, label]) => (
              <Link key={value} to={buildHref({ status: value, page: 1 })}>
                <s-button
                  variant={data.statusFilter === value ? "primary" : "secondary"}
                >
                  {label}
                </s-button>
              </Link>
            ))}
          </div>
          <div className="gemist-admin-toolbar__group">
            <Link to={buildHref({ layout: "grid", page: 1 })}>
              <s-button
                variant={data.layout === "grid" ? "primary" : "secondary"}
              >
                Grid
              </s-button>
            </Link>
            <Link to={buildHref({ layout: "list", page: 1 })}>
              <s-button
                variant={data.layout === "list" ? "primary" : "secondary"}
              >
                List
              </s-button>
            </Link>
          </div>
        </div>

        {listNavigating ? (
          <ProductsSkeleton layout={pendingLayout} count={PAGE_SIZE} />
        ) : data.products.length ? (
          data.layout === "grid" ? (
            <div className="gemist-admin-grid">
              {data.products.map((product) => (
                <ProductCard key={product.slug} product={product} />
              ))}
            </div>
          ) : (
            <div className="gemist-admin-list">
              {data.products.map((product) => (
                <ProductRow key={product.slug} product={product} />
              ))}
            </div>
          )
        ) : data.catalogOk ? (
          <s-paragraph>No products in this filter.</s-paragraph>
        ) : null}

        {data.pageCount > 1 ? (
          <div className="gemist-admin-pager">
            <div className="gemist-admin-pager__controls">
              {data.page > 1 ? (
                <Link to={buildHref({ page: data.page - 1 })}>
                  <s-button {...(listNavigating ? { loading: true } : {})}>
                    Previous
                  </s-button>
                </Link>
              ) : (
                <s-button disabled>Previous</s-button>
              )}
              <p className="gemist-admin-pager__label">
                {listNavigating
                  ? `Loading page ${pendingPage}…`
                  : `Page ${data.page} of ${data.pageCount}`}
              </p>
              {data.page < data.pageCount ? (
                <Link to={buildHref({ page: data.page + 1 })}>
                  <s-button {...(listNavigating ? { loading: true } : {})}>
                    Next
                  </s-button>
                </Link>
              ) : (
                <s-button disabled>Next</s-button>
              )}
            </div>
          </div>
        ) : null}
      </s-section>
    </s-page>
  );
}

function ProductsSkeleton({
  layout,
  count,
}: {
  layout: "grid" | "list";
  count: number;
}) {
  const items = Array.from({ length: count }, (_, index) => index);
  if (layout === "list") {
    return (
      <div className="gemist-admin-list" aria-busy="true" aria-label="Loading products">
        {items.map((index) => (
          <div key={index} className="gemist-admin-row gemist-admin-skeleton-row">
            <div className="gemist-admin-skeleton gemist-admin-skeleton--thumb" />
            <div className="gemist-admin-skeleton-copy">
              <div className="gemist-admin-skeleton gemist-admin-skeleton--badge" />
              <div className="gemist-admin-skeleton gemist-admin-skeleton--title" />
              <div className="gemist-admin-skeleton gemist-admin-skeleton--meta" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="gemist-admin-grid" aria-busy="true" aria-label="Loading products">
      {items.map((index) => (
        <div key={index} className="gemist-admin-card gemist-admin-skeleton-card">
          <div className="gemist-admin-skeleton gemist-admin-skeleton--image" />
          <div className="gemist-admin-card__body">
            <div className="gemist-admin-skeleton gemist-admin-skeleton--badge" />
            <div className="gemist-admin-skeleton gemist-admin-skeleton--title" />
            <div className="gemist-admin-skeleton gemist-admin-skeleton--meta" />
            <div className="gemist-admin-skeleton gemist-admin-skeleton--price" />
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: CatalogStyleStatus }) {
  return (
    <span
      className={`gemist-admin-badge${
        status !== "active" ? ` gemist-admin-badge--${status}` : ""
      }`}
    >
      {status}
    </span>
  );
}

function StatusActions({
  product,
}: {
  product: ListProduct;
}) {
  return (
    <s-stack direction="inline" gap="small">
      {product.status !== "active" ? (
        <StatusForm product={product} status="active" label="Activate" />
      ) : null}
      {product.status !== "archived" ? (
        <StatusForm product={product} status="archived" label="Archive" />
      ) : null}
      {product.status !== "deleted" ? (
        <StatusForm
          product={product}
          status="deleted"
          label="Delete"
          tone="critical"
        />
      ) : null}
    </s-stack>
  );
}

function StatusForm({
  product,
  status,
  label,
  tone,
  loading,
  onDone,
}: {
  product: ListProduct;
  status: CatalogStyleStatus;
  label: string;
  tone?: "critical";
  loading?: boolean;
  onDone?: () => void;
}) {
  const shopify = useAppBridge();
  const [pending, setPending] = useState(false);
  const busy = loading || pending;

  const submitStatus = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setPending(true);
    try {
      const token =
        typeof shopify.idToken === "function" ? await shopify.idToken() : "";
      const body = new URLSearchParams({
        slug: product.slug,
        status,
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
        shopify.toast.show(payload?.error || "Could not update product visibility.");
        return;
      }
      shopify.toast.show("Product visibility updated.");
      onDone?.();
      window.location.reload();
    } catch (error) {
      shopify.toast.show(
        error instanceof Error
          ? error.message
          : "Could not update product visibility.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <span onClick={(event) => event.stopPropagation()}>
      <s-button
        type="button"
        variant="tertiary"
        {...(tone ? { tone } : {})}
        {...(busy ? { loading: true } : {})}
        onClick={submitStatus}
      >
        {label}
      </s-button>
    </span>
  );
}

function productHref(slug: string) {
  return `/app/products/${encodeURIComponent(slug)}`;
}

/**
 * Use React Router Link (SPA). Do not use bare <a> or <s-link> here —
 * those full-reload gemistapp.zooq.app and hit nginx X-Frame-Options: DENY.
 */
function ProductCard({
  product,
}: {
  product: ListProduct;
}) {
  const href = productHref(product.slug);
  return (
    <div className="gemist-admin-card">
      <Link to={href}>
        {product.image ? (
          <img
            className="gemist-admin-card__image"
            src={product.image}
            alt=""
          />
        ) : (
          <div className="gemist-admin-card__image" />
        )}
      </Link>
      <div className="gemist-admin-card__body">
        <StatusBadge status={product.status} />
        <Link to={href}>
          <h3 className="gemist-admin-card__title">{product.title}</h3>
        </Link>
        <p className="gemist-admin-card__meta">
          {[product.vendor, product.sku].filter(Boolean).join(" · ")}
        </p>
        {product.price ? (
          <p className="gemist-admin-card__price">{product.price}</p>
        ) : null}
        <StatusActions product={product} />
      </div>
    </div>
  );
}

function ProductRow({
  product,
}: {
  product: ListProduct;
}) {
  const href = productHref(product.slug);
  return (
    <div className="gemist-admin-row">
      <Link to={href}>
        {product.image ? (
          <img
            className="gemist-admin-row__image"
            src={product.image}
            alt=""
          />
        ) : (
          <div className="gemist-admin-row__image" />
        )}
      </Link>
      <div>
        <StatusBadge status={product.status} />
        <Link to={href}>
          <h3 className="gemist-admin-card__title">{product.title}</h3>
        </Link>
        <p className="gemist-admin-card__meta">
          {[product.vendor, product.sku, product.slug].filter(Boolean).join(" · ")}
        </p>
        {product.price ? (
          <p className="gemist-admin-card__price">{product.price}</p>
        ) : null}
      </div>
      <StatusActions product={product} />
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
