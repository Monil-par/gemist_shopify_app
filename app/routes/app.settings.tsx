import { useEffect, useState } from "react";
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
import {
  deleteMerchantCredentials,
  getMerchantCredentials,
  upsertMerchantCredentials,
} from "../models/merchant-credential.server";
import {
  getMerchantSettings,
  publishCommerceMetafield,
  upsertMerchantSettings,
} from "../models/merchant-settings.server";
import {
  pingGemistApi,
  resolveGemistApiBaseUrl,
} from "../lib/gemist-api.server";
import { getShopProfile } from "../lib/shop-profile.server";

type ActionData =
  | { ok: true; intent: string; styleCount?: number; version?: string }
  | { ok: false; error: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const profile = await getShopProfile(admin, session.shop);
  const credentials = await getMerchantCredentials(session.shop);
  const settings = await getMerchantSettings(session.shop);

  return {
    profile,
    merchantKey: credentials?.merchantKey ?? "",
    hasSecret: Boolean(credentials?.merchantSecret),
    apiBaseUrl: settings.apiBaseUrl,
    markupPercent: settings.markupPercent,
    appointmentUrl: settings.appointmentUrl,
    appointmentEmail: settings.appointmentEmail,
    appointmentLabel: settings.appointmentLabel,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save");

  if (intent === "delete") {
    await deleteMerchantCredentials(session.shop);
    return { ok: true, intent: "delete" } satisfies ActionData;
  }

  if (intent === "test") {
    try {
      const result = await pingGemistApi(
        resolveGemistApiBaseUrl(String(formData.get("apiBaseUrl") || "")),
      );
      return {
        ok: true,
        intent: "test",
        styleCount: result.styleCount,
        version: result.version,
      } satisfies ActionData;
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not reach the Gemist catalog for this store.",
      } satisfies ActionData;
    }
  }

  if (intent === "save-commerce") {
    const markupPercent = Number(formData.get("markupPercent") || 0);
    const settings = {
      shop: session.shop,
      apiBaseUrl: String(formData.get("apiBaseUrl") || "").trim(),
      markupPercent: Number.isFinite(markupPercent) ? markupPercent : 0,
      appointmentUrl: String(formData.get("appointmentUrl") || "").trim(),
      appointmentEmail: String(formData.get("appointmentEmail") || "").trim(),
      appointmentLabel:
        String(formData.get("appointmentLabel") || "").trim() ||
        "Schedule an Appointment",
    };
    await upsertMerchantSettings(settings);
    await publishCommerceMetafield(admin, {
      ...settings,
      apiBaseUrl: resolveGemistApiBaseUrl(settings.apiBaseUrl),
    });
    return { ok: true, intent: "save-commerce" } satisfies ActionData;
  }

  const merchantKey = String(formData.get("merchantKey") || "").trim();
  const merchantSecret = String(formData.get("merchantSecret") || "").trim();
  const existing = await getMerchantCredentials(session.shop);

  if (!merchantKey) {
    return { ok: false, error: "Enter a merchant key for this store." } satisfies ActionData;
  }

  if (!merchantSecret && !existing) {
    return { ok: false, error: "Enter a merchant secret for this store." } satisfies ActionData;
  }

  await upsertMerchantCredentials({
    shop: session.shop,
    merchantKey,
    merchantSecret: merchantSecret || existing!.merchantSecret,
  });

  try {
    const settings = await getMerchantSettings(session.shop);
    const ping = await pingGemistApi(resolveGemistApiBaseUrl(settings.apiBaseUrl));
    return {
      ok: true,
      intent: "save",
      styleCount: ping.styleCount,
    } satisfies ActionData;
  } catch {
    return { ok: true, intent: "save" } satisfies ActionData;
  }
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [merchantKey, setMerchantKey] = useState(data.merchantKey);
  const [merchantSecret, setMerchantSecret] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState(data.apiBaseUrl);
  const [markupPercent, setMarkupPercent] = useState(String(data.markupPercent));
  const [appointmentUrl, setAppointmentUrl] = useState(data.appointmentUrl);
  const [appointmentEmail, setAppointmentEmail] = useState(data.appointmentEmail);
  const [appointmentLabel, setAppointmentLabel] = useState(data.appointmentLabel);

  const intent = String(fetcher.formData?.get("intent") || "");
  const isSavingCreds =
    fetcher.state !== "idle" && (intent === "save" || intent === "");
  const isSavingCommerce =
    fetcher.state !== "idle" && intent === "save-commerce";
  const isTesting = fetcher.state !== "idle" && intent === "test";
  const isDeleting = fetcher.state !== "idle" && intent === "delete";
  const error =
    fetcher.data && "ok" in fetcher.data && !fetcher.data.ok
      ? fetcher.data.error
      : "";

  useEffect(() => {
    setMerchantKey(data.merchantKey);
    setApiBaseUrl(data.apiBaseUrl);
    setMarkupPercent(String(data.markupPercent));
    setAppointmentUrl(data.appointmentUrl);
    setAppointmentEmail(data.appointmentEmail);
    setAppointmentLabel(data.appointmentLabel);
  }, [data]);

  useEffect(() => {
    if (!fetcher.data || !("ok" in fetcher.data) || !fetcher.data.ok) return;
    if (fetcher.data.intent === "test") {
      shopify.toast.show(
        `This store’s catalog connected. ${fetcher.data.styleCount ?? 0} styles available${
          fetcher.data.version ? ` (API ${fetcher.data.version})` : ""
        }.`,
      );
      return;
    }
    setMerchantSecret("");
    if (fetcher.data.intent === "save" && fetcher.data.styleCount != null) {
      shopify.toast.show(
        `Credentials saved. Catalog reachable (${fetcher.data.styleCount} styles).`,
      );
      return;
    }
    shopify.toast.show(
      fetcher.data.intent === "delete"
        ? "Credentials removed for this store"
        : fetcher.data.intent === "save-commerce"
          ? "Saved for this store"
          : "Credentials saved for this store",
    );
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Settings">
      <ShopBanner shopName={data.profile.name} shopDomain={data.profile.domain} />

      <s-section heading="Catalog">
        <s-paragraph>
          Products load live from Gemist. They are not imported as a full
          Shopify catalog. Open Manage products to review this store’s Gemist
          dataset and place the storefront grid.
        </s-paragraph>
        <s-button href="/app/products">Manage products</s-button>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="save-commerce" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="apiBaseUrl"
              label="Gemist catalog URL"
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.currentTarget.value)}
              details="Example: https://classique.dev.gemist.co"
            />
            <s-text-field
              name="markupPercent"
              label="Markup (%)"
              value={markupPercent}
              onChange={(event) => setMarkupPercent(event.currentTarget.value)}
              details="Added on top of the Gemist price."
            />
            <s-text-field
              name="appointmentLabel"
              label="Appointment button label"
              value={appointmentLabel}
              onChange={(event) =>
                setAppointmentLabel(event.currentTarget.value)
              }
            />
            <s-text-field
              name="appointmentUrl"
              label="Appointment URL"
              value={appointmentUrl}
              onChange={(event) => setAppointmentUrl(event.currentTarget.value)}
            />
            <s-text-field
              name="appointmentEmail"
              label="Appointment email"
              value={appointmentEmail}
              onChange={(event) =>
                setAppointmentEmail(event.currentTarget.value)
              }
              details="Used if no appointment URL is set."
            />
            <s-stack direction="inline" gap="base">
              <s-button
                type="submit"
                variant="primary"
                {...(isSavingCommerce ? { loading: true } : {})}
              >
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="test" />
          <input type="hidden" name="apiBaseUrl" value={apiBaseUrl} />
          <s-button
            type="submit"
            variant="secondary"
            {...(isTesting ? { loading: true } : {})}
          >
            Test connection
          </s-button>
        </fetcher.Form>
      </s-section>

      <s-section heading="API credentials">
        <s-paragraph>
          Optional for catalog browsing. Required to submit orders to Gemist.
          Stored encrypted for this store only.
        </s-paragraph>

        {data.hasSecret ? (
          <s-banner heading="Token saved for this store" tone="success">
            Leave the secret blank to keep it, or enter a new value to replace
            it.
          </s-banner>
        ) : null}

        <s-stack direction="block" gap="base">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="save" />
            <s-stack direction="block" gap="base">
              <s-text-field
                name="merchantKey"
                label="Merchant key / Merchant ID"
                value={merchantKey}
                onChange={(event) => setMerchantKey(event.currentTarget.value)}
                autocomplete="off"
              />
              <s-password-field
                name="merchantSecret"
                label="Merchant secret / API token"
                value={merchantSecret}
                onChange={(event) =>
                  setMerchantSecret(event.currentTarget.value)
                }
                autocomplete="off"
                details={
                  data.hasSecret
                    ? "Leave blank to keep the current secret for this store."
                    : "Needed later to send orders to Gemist."
                }
                error={error}
              />
              <s-button
                type="submit"
                variant="primary"
                {...(isSavingCreds ? { loading: true } : {})}
              >
                Save token for this store
              </s-button>
            </s-stack>
          </fetcher.Form>

          {data.hasSecret ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="delete" />
              <s-button
                type="submit"
                variant="tertiary"
                tone="critical"
                {...(isDeleting ? { loading: true } : {})}
              >
                Remove this store’s token
              </s-button>
            </fetcher.Form>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
