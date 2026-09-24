import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ShopBanner } from "../components/shop-banner";
import { getMerchantCredentials } from "../models/merchant-credential.server";
import { getMerchantSettings } from "../models/merchant-settings.server";
import {
  listRecentGemistOrders,
  retryGemistOrder,
} from "../models/gemist-order.server";
import { pingGemistApi, resolveGemistApiBaseUrl } from "../lib/gemist-api.server";
import { getShopProfile } from "../lib/shop-profile.server";

type ActionData =
  | { ok: true; status: string; gemistOrderId?: string }
  | { ok: false; error: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const profile = await getShopProfile(admin, session.shop);
  const credentials = await getMerchantCredentials(session.shop);
  const settings = await getMerchantSettings(session.shop);
  const orders = await listRecentGemistOrders(session.shop);
  const apiBaseUrl = resolveGemistApiBaseUrl(settings.apiBaseUrl);
  let catalogOk = false;
  let styleCount = 0;
  try {
    const ping = await pingGemistApi(apiBaseUrl);
    catalogOk = ping.ok;
    styleCount = ping.styleCount;
  } catch {
    catalogOk = false;
  }

  return {
    profile,
    apiBaseUrl,
    catalogOk,
    styleCount,
    hasCredentials: Boolean(credentials),
    markupPercent: settings.markupPercent,
    hasAppointment: Boolean(
      settings.appointmentUrl || settings.appointmentEmail,
    ),
    orders: orders.map((order) => ({
      id: order.id,
      name: order.shopifyOrderName || order.shopifyOrderId,
      sku: order.oemSku,
      gemistOrderId: order.gemistOrderId,
      status: order.status,
      error: order.error,
      attempts: order.attempts,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const orderId = String(formData.get("orderId") || "").trim();
  if (!orderId) {
    return { ok: false, error: "Missing order id." } satisfies ActionData;
  }

  try {
    const row = await retryGemistOrder(session.shop, orderId);
    if (row.status === "submitted") {
      return {
        ok: true,
        status: row.status,
        gemistOrderId: row.gemistOrderId,
      } satisfies ActionData;
    }
    return {
      ok: false,
      error: row.error || `Order is still ${row.status}.`,
    } satisfies ActionData;
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Could not retry this order.",
    } satisfies ActionData;
  }
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const retryingId = String(fetcher.formData?.get("orderId") || "");

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show("Order submitted to Gemist.");
      return;
    }
    shopify.toast.show(fetcher.data.error);
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Home">
      <ShopBanner shopName={data.profile.name} shopDomain={data.profile.domain} />

      <s-section heading="Connection">
        <s-unordered-list>
          <s-list-item>
            Catalog:{" "}
            {data.catalogOk
              ? `connected · ${data.styleCount} styles`
              : "not reachable"}
          </s-list-item>
          <s-list-item>API: {data.apiBaseUrl}</s-list-item>
          <s-list-item>Markup: {data.markupPercent}%</s-list-item>
          <s-list-item>
            Appointments: {data.hasAppointment ? "configured" : "not set"}
          </s-list-item>
          <s-list-item>
            Order token: {data.hasCredentials ? "saved" : "not saved"}
          </s-list-item>
        </s-unordered-list>
        <s-stack direction="inline" gap="base">
          <s-button href="/app/settings" variant="primary">
            Settings
          </s-button>
          <s-button href="/app/theme">Theme</s-button>
          <s-button href="/app/widgets">Widgets</s-button>
          <s-button href={data.profile.storefrontUrl} target="_blank" variant="tertiary">
            Storefront
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Get started">
        <s-unordered-list>
          <s-list-item>
            Save catalog URL, markup, and appointment settings
          </s-list-item>
          <s-list-item>
            Add the product grid to a collection or home page
          </s-list-item>
          <s-list-item>Customize widget styles for this store</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Recent orders">
        {data.orders.length ? (
          <s-stack direction="block" gap="base">
            {data.orders.map((order) => (
              <s-box
                key={order.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="base">
                  <s-paragraph>
                    {order.name}
                    {order.sku ? ` · ${order.sku}` : ""}
                    {` · ${order.status}`}
                    {order.attempts ? ` · ${order.attempts} attempt(s)` : ""}
                  </s-paragraph>
                  {order.gemistOrderId ? (
                    <s-paragraph>Gemist id {order.gemistOrderId}</s-paragraph>
                  ) : null}
                  {order.error ? <s-paragraph>{order.error}</s-paragraph> : null}
                  {order.status !== "submitted" ? (
                    <fetcher.Form method="post">
                      <input type="hidden" name="orderId" value={order.id} />
                      <s-button
                        type="submit"
                        variant="secondary"
                        {...(fetcher.state !== "idle" && retryingId === order.id
                          ? { loading: true }
                          : {})}
                      >
                        Retry Gemist submit
                      </s-button>
                    </fetcher.Form>
                  ) : null}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <s-paragraph>
            No Gemist orders yet. Complete a checkout with a Gemist cart line to
            see it here.
          </s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
