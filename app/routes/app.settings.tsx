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
import {
  activateLicense,
  getLicenseView,
  refreshLicense,
  removeLicense,
} from "../lib/license.server";
import { pricingUrl } from "../lib/admin-link.server";
import { isAppointmentsEnabled, isMonetizationEnabled } from "../lib/features.server";
import { getStoreProfileReport, reportStoreToAdmin } from "../lib/store-report.server";

type ActionData =
  | {
      ok: true;
      intent: string;
      styleCount?: number;
      version?: string;
      planName?: string;
      credentialsValidated?: boolean;
      credentialsMessage?: string;
    }
  | { ok: false; error: string; intent?: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const profile = await getShopProfile(admin, session.shop);
  const credentials = await getMerchantCredentials(session.shop);
  const settings = await getMerchantSettings(session.shop);
  const monetization = isMonetizationEnabled();
  const appointments = isAppointmentsEnabled();
  const license = monetization
    ? await getLicenseView(session.shop)
    : {
        enforced: false,
        active: true,
        hasKey: false,
        keyHint: "",
        status: "inactive",
        message: "",
        planName: "",
        planType: "",
        expiresAt: null,
        lastVerifiedAt: null,
        lastError: "",
      };

  return {
    profile,
    license,
    pricingUrl: monetization ? pricingUrl(session.shop) : "",
    showLicense: monetization,
    showAppointments: appointments,
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

  if (intent === "activate-license" || intent === "refresh-license" || intent === "remove-license") {
    if (!isMonetizationEnabled()) {
      return { ok: false, intent, error: "Licensing is not enabled for this app." } satisfies ActionData;
    }
  }

  if (intent === "activate-license") {
    const profile = await getStoreProfileReport(admin);
    const result = await activateLicense(
      session.shop,
      String(formData.get("licenseKey") || ""),
      profile,
    );
    if (!result.ok) return { ok: false, intent, error: result.error } satisfies ActionData;
    reportStoreToAdmin(session.shop, admin).catch(() => {});
    return { ok: true, intent, planName: result.planName } satisfies ActionData;
  }

  if (intent === "refresh-license") {
    const row = await refreshLicense(session.shop, await getStoreProfileReport(admin));
    if (row?.lastError) {
      return { ok: false, intent, error: "Could not reach the license server. Your store keeps working during the grace period." } satisfies ActionData;
    }
    return { ok: true, intent } satisfies ActionData;
  }

  if (intent === "remove-license") {
    await removeLicense(session.shop);
    return { ok: true, intent } satisfies ActionData;
  }

  if (intent === "delete") {
    await deleteMerchantCredentials(session.shop);
    return { ok: true, intent: "delete" } satisfies ActionData;
  }

  if (intent === "test") {
    try {
      const credentials = await getMerchantCredentials(session.shop);
      const result = await pingGemistApi(
        resolveGemistApiBaseUrl(String(formData.get("apiBaseUrl") || "")),
        credentials?.merchantSecret,
      );
      return {
        ok: true,
        intent: "test",
        styleCount: result.styleCount,
        version: result.version,
        credentialsValidated: result.credentialsValidated,
        credentialsMessage: result.credentialsMessage,
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
    const existing = await getMerchantSettings(session.shop);
    const appointments = isAppointmentsEnabled();
    const settings = {
      shop: session.shop,
      apiBaseUrl: String(formData.get("apiBaseUrl") || "").trim(),
      markupPercent: Number.isFinite(markupPercent) ? markupPercent : 0,
      appointmentUrl: appointments
        ? String(formData.get("appointmentUrl") || "").trim()
        : existing.appointmentUrl,
      appointmentEmail: appointments
        ? String(formData.get("appointmentEmail") || "").trim()
        : existing.appointmentEmail,
      appointmentLabel: appointments
        ? String(formData.get("appointmentLabel") || "").trim() || "Schedule an Appointment"
        : existing.appointmentLabel,
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
      const cred =
        fetcher.data.credentialsMessage ||
        (fetcher.data.credentialsValidated
          ? "Order token validated."
          : "Catalog only (no order-token check).");
      shopify.toast.show(
        `Catalog OK · ${fetcher.data.styleCount ?? 0} styles${
          fetcher.data.version ? ` (API ${fetcher.data.version})` : ""
        }. ${cred}`,
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

      {data.showLicense ? (
        <LicenseSection license={data.license} pricingUrl={data.pricingUrl} />
      ) : null}

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
            <s-paragraph>
              Markup rules (specificity multipliers) are managed on the{" "}
              <s-link href="/app/pricing">Pricing</s-link> page. Default fallback
              markup is also set there.
            </s-paragraph>
            <input type="hidden" name="markupPercent" value={markupPercent} />
            {data.showAppointments ? (
              <>
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
              </>
            ) : null}
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
        {fetcher.data &&
        "ok" in fetcher.data &&
        fetcher.data.ok &&
        fetcher.data.intent === "test" &&
        fetcher.data.credentialsMessage ? (
          <s-banner
            heading={
              fetcher.data.credentialsValidated
                ? "Order token check passed"
                : "Order token not validated"
            }
            tone={fetcher.data.credentialsValidated ? "success" : "warning"}
          >
            {fetcher.data.credentialsMessage}
          </s-banner>
        ) : null}
      </s-section>

      <s-section heading="API credentials">
        <s-paragraph>
          Optional for catalog browsing. Required to submit Shopify orders to
          Gemist manufacturing (`/api/orders/shopify/draft`). Stored encrypted
          for this store only.
        </s-paragraph>

        {data.hasSecret ? (
          <s-banner heading="Order token saved for this store" tone="success">
            Leave the secret blank to keep it, or enter a new value to replace
            it. Orders can be forwarded to Gemist with this token.
          </s-banner>
        ) : (
          <s-banner heading="Order token required for Gemist handoff" tone="warning">
            Without a Merchant secret / API token, Shopify orders are stored in
            the app for retry but are not submitted to Gemist. Save a token here
            (or set GEMIST_ORDER_BEARER on the server) once Gemist provides it.
          </s-banner>
        )}

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

type LicenseData = Awaited<ReturnType<typeof loader>>["license"];

function formatLicenseDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function LicenseSection({
  license,
  pricingUrl,
}: {
  license: LicenseData;
  pricingUrl: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [licenseKey, setLicenseKey] = useState("");
  const pendingIntent =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("intent") || "") : "";
  const error =
    fetcher.data && !fetcher.data.ok && fetcher.data.intent === "activate-license"
      ? fetcher.data.error
      : "";

  useEffect(() => {
    if (!fetcher.data) return;
    if (!fetcher.data.ok) {
      if (fetcher.data.intent !== "activate-license") shopify.toast.show(fetcher.data.error);
      return;
    }
    if (fetcher.data.intent === "activate-license") {
      setLicenseKey("");
      shopify.toast.show(
        `Gemist activated${fetcher.data.planName ? ` · ${fetcher.data.planName} plan` : ""}`,
      );
    } else if (fetcher.data.intent === "refresh-license") {
      shopify.toast.show("License checked");
    } else if (fetcher.data.intent === "remove-license") {
      shopify.toast.show("License removed from this store");
    }
  }, [fetcher.data, shopify]);

  const expiry = formatLicenseDate(license.expiresAt);

  if (!license.enforced) {
    return (
      <s-section heading="License">
        <s-banner heading="License server not connected" tone="critical">
          This app server isn’t linked to the Gemist admin panel, so license keys
          can’t be activated yet. Set GEMIST_ADMIN_URL and GEMIST_ADMIN_SHARED_SECRET
          in the app’s environment and restart it.
        </s-banner>
      </s-section>
    );
  }

  return (
    <s-section heading="License">
      {license.active ? (
        <s-banner heading={`Gemist is active${license.planName ? ` · ${license.planName}` : ""}`} tone="success">
          {expiry ? `Valid until ${expiry}.` : "Lifetime license."} Key {license.keyHint}
        </s-banner>
      ) : license.hasKey ? (
        <s-banner heading="Your license is not active" tone="critical">
          {license.message ||
            "The storefront widget is turned off until a valid license is activated."}
        </s-banner>
      ) : (
        <s-banner heading="Activate Gemist" tone="warning">
          Enter the license key you received after purchase. The storefront
          widget stays off until the store is activated.
        </s-banner>
      )}

      <s-stack direction="block" gap="base">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="activate-license" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="licenseKey"
              label={license.hasKey ? "Replace license key" : "License key"}
              placeholder="GEM-XXXX-XXXX-XXXX-XXXX"
              value={licenseKey}
              onChange={(event) => setLicenseKey(event.currentTarget.value)}
              autocomplete="off"
              error={error}
            />
            <s-stack direction="inline" gap="base">
              <s-button
                type="submit"
                variant="primary"
                {...(pendingIntent === "activate-license" ? { loading: true } : {})}
              >
                Activate
              </s-button>
              {pricingUrl ? (
                <s-button href={pricingUrl} target="_blank" variant="secondary">
                  {license.hasKey ? "Renew or change plan" : "Get a license"}
                </s-button>
              ) : null}
            </s-stack>
          </s-stack>
        </fetcher.Form>

        {license.hasKey ? (
          <s-stack direction="inline" gap="base">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="refresh-license" />
              <s-button
                type="submit"
                variant="tertiary"
                {...(pendingIntent === "refresh-license" ? { loading: true } : {})}
              >
                Check license now
              </s-button>
            </fetcher.Form>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="remove-license" />
              <s-button
                type="submit"
                variant="tertiary"
                tone="critical"
                {...(pendingIntent === "remove-license" ? { loading: true } : {})}
              >
                Remove license
              </s-button>
            </fetcher.Form>
          </s-stack>
        ) : null}
        {license.lastVerifiedAt ? (
          <s-paragraph>
            Last checked {new Date(license.lastVerifiedAt).toLocaleString()}
            {license.lastError ? ` · last attempt failed: ${license.lastError}` : ""}
          </s-paragraph>
        ) : null}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
