import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ShopBanner } from "../components/shop-banner";
import { getShopProfile } from "../lib/shop-profile.server";
import { clearAccessCache, getAccessView, syncSubscription } from "../lib/access.server";
import {
  BILLING_PLANS,
  billingPlans,
  billingProvider,
  isBillingTestMode,
  type BillingPlanName,
} from "../lib/billing-config.server";
import { pricingUrl } from "../lib/admin-link.server";
import { isMonetizationEnabled } from "../lib/features.server";
import { activateLicense, billingPortalUrl, claimLicense } from "../lib/license.server";
import { reportSubscriptionToAdmin } from "../lib/store-report.server";

type ActionData =
  | { ok: true; intent: string; url?: string }
  | { ok: false; intent: string; error: string };

function billingErrorMessage(error: unknown, details: unknown) {
  const messages = Array.isArray(details)
    ? details.map((item) => (item && typeof item === "object" && "message" in item ? String(item.message) : "")).filter(Boolean)
    : [];
  const text = messages.join(" ") || (error instanceof Error ? error.message : "");
  if (/public distribution|custom app|cannot use the billing api/i.test(text)) {
    return "Shopify billing isn't available for this app yet: set the app's distribution to Public (unlisted is fine) in the Partner Dashboard.";
  }
  return text ? `Shopify could not start the subscription: ${text}` : "Shopify could not start the subscription. Try again.";
}

function returnUrl(shop: string) {
  return `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY || ""}/app/billing`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // Out of SOW §5 — Plan / billing / licensing UI is opt-in via env flag.
  if (!isMonetizationEnabled()) throw redirect("/app");
  const profile = await getShopProfile(admin, session.shop);
  const provider = billingProvider();
  if (provider === "shopify") await syncSubscription(session.shop, admin.graphql);
  let access = await getAccessView(session.shop);
  if (provider === "stripe" && access.licensingEnabled && !access.active) {
    const claimed = await claimLicense(session.shop);
    if (claimed.ok) {
      clearAccessCache(session.shop);
      access = await getAccessView(session.shop);
    }
  }
  reportSubscriptionToAdmin(session.shop, admin).catch(() => {});

  const config = billingPlans();
  const plans = BILLING_PLANS.map((name) => {
    const line = config[name].lineItems[0];
    return {
      name,
      amount: line.amount,
      currencyCode: line.currencyCode,
      interval: name === BILLING_PLANS[1] ? "year" : "30 days",
      trialDays: config[name].trialDays,
    };
  });

  return { profile, access, plans, provider, checkoutUrl: pricingUrl(session.shop) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);
  if (!isMonetizationEnabled()) throw redirect("/app");
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "subscribe") {
    const plan = String(formData.get("plan") || "") as BillingPlanName;
    if (!BILLING_PLANS.includes(plan)) {
      return { ok: false, intent, error: "Choose a plan." } satisfies ActionData;
    }
    try {
      // Redirects the merchant to Shopify's approval page (thrown response).
      await billing.request({ plan, isTest: isBillingTestMode(), returnUrl: returnUrl(session.shop) });
    } catch (error) {
      if (error instanceof Response) throw error;
      const details = (error as { errorData?: unknown })?.errorData;
      console.error("[gemist billing] subscribe failed", error, JSON.stringify(details ?? null));
      return { ok: false, intent, error: billingErrorMessage(error, details) } satisfies ActionData;
    }
    return { ok: true, intent } satisfies ActionData;
  }

  if (intent === "cancel") {
    const subscriptionId = String(formData.get("subscriptionId") || "");
    if (!subscriptionId) {
      return { ok: false, intent, error: "No subscription to cancel." } satisfies ActionData;
    }
    try {
      await billing.cancel({ subscriptionId, isTest: isBillingTestMode(), prorate: true });
    } catch (error) {
      console.error("[gemist billing] cancel failed", error);
      return { ok: false, intent, error: "Could not cancel the subscription. Try again." } satisfies ActionData;
    }
    await syncSubscription(session.shop, admin.graphql);
    reportSubscriptionToAdmin(session.shop, admin).catch(() => {});
    return { ok: true, intent } satisfies ActionData;
  }

  if (intent === "refresh") {
    await syncSubscription(session.shop, admin.graphql);
    return { ok: true, intent } satisfies ActionData;
  }

  if (intent === "claim") {
    const result = await claimLicense(session.shop);
    clearAccessCache(session.shop);
    if (!result.ok) {
      return { ok: false, intent, error: result.error || "Payment not found yet." } satisfies ActionData;
    }
    reportSubscriptionToAdmin(session.shop, admin).catch(() => {});
    return { ok: true, intent } satisfies ActionData;
  }

  if (intent === "activate-license") {
    const result = await activateLicense(session.shop, String(formData.get("licenseKey") || ""));
    clearAccessCache(session.shop);
    if (!result.ok) return { ok: false, intent, error: result.error } satisfies ActionData;
    reportSubscriptionToAdmin(session.shop, admin).catch(() => {});
    return { ok: true, intent } satisfies ActionData;
  }

  if (intent === "portal") {
    const result = await billingPortalUrl(session.shop, returnUrl(session.shop));
    if (!result.ok) return { ok: false, intent, error: result.error } satisfies ActionData;
    return { ok: true, intent, url: result.url } satisfies ActionData;
  }

  return { ok: false, intent, error: "Unknown action." } satisfies ActionData;
};

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
}

function formatPrice(amount: number, currencyCode: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(amount);
  } catch {
    return `${amount} ${currencyCode}`;
  }
}

export default function BillingPage() {
  const { profile, access, plans, provider, checkoutUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const pending = fetcher.state !== "idle" ? fetcher.formData : null;
  const subscription = access.subscription;
  const subscribed = access.activeVia === "subscription" && subscription;
  const stripeMode = provider === "stripe";
  const license = access.license;

  useEffect(() => {
    if (!fetcher.data) return;
    if (!fetcher.data.ok) {
      shopify.toast.show(fetcher.data.error);
      return;
    }
    if (fetcher.data.intent === "cancel") shopify.toast.show("Subscription cancelled. The live grid is now off.");
    if (fetcher.data.intent === "refresh") shopify.toast.show("Subscription status updated");
    if (fetcher.data.intent === "claim") shopify.toast.show("Payment found — Gemist is now live");
    if (fetcher.data.intent === "activate-license") shopify.toast.show("License activated — Gemist is now live");
    if (fetcher.data.intent === "portal" && fetcher.data.url) window.open(fetcher.data.url, "_top");
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Plan & billing">
      <ShopBanner shopName={profile.name} shopDomain={profile.domain} />

      {access.active ? (
        <s-banner heading="Gemist is active on your live store" tone="success">
          {access.activeVia === "subscription" && subscription
            ? `${subscription.planName}${subscription.test ? " (test charge)" : ""}${
                subscription.currentPeriodEnd ? ` · renews ${formatDate(subscription.currentPeriodEnd)}` : ""
              }. Your saved grid configuration is live.`
            : access.activeVia === "license"
              ? `${license.planName || "Paid plan"}${
                  license.expiresAt ? ` · paid through ${formatDate(license.expiresAt)}` : ""
                }. Your saved grid configuration is live.`
              : "This store has free access. Your saved grid configuration is live."}
        </s-banner>
      ) : (
        <s-banner heading="Subscribe to show the grid on your live store" tone="warning">
          You can add the grid to your theme, customize it, and preview it in the
          theme editor now. Shoppers won’t see it until you subscribe. Your
          settings are kept and go live automatically once the subscription is
          active.
        </s-banner>
      )}

      {!stripeMode && access.testMode ? (
        <s-banner heading="Test billing is on" tone="info">
          Subscriptions are created as Shopify test charges, so nothing is
          billed. Turn off SHOPIFY_BILLING_TEST before charging real merchants.
        </s-banner>
      ) : null}

      <s-section heading="Setup">
        <s-ordered-list>
          <s-list-item>Install Gemist ✓</s-list-item>
          <s-list-item>
            Add and configure the grid — <s-link href="/app/theme">Theme</s-link>,{" "}
            <s-link href="/app/widgets">Widgets</s-link>, <s-link href="/app/products">Products</s-link>
          </s-list-item>
          <s-list-item>Preview it in the Shopify theme editor (works before subscribing)</s-list-item>
          <s-list-item>
            {stripeMode ? "Choose a plan and pay securely with Stripe" : "Subscribe below"} {access.active ? "✓" : ""}
          </s-list-item>
          <s-list-item>The grid goes live on your storefront {access.active ? "✓" : ""}</s-list-item>
        </s-ordered-list>
      </s-section>

      {stripeMode ? (
        <s-section heading={access.active ? "Your plan" : "Choose a plan"}>
          <s-stack direction="block" gap="base">
            {!access.licensingEnabled ? (
              <s-banner heading="Payments are not connected" tone="critical">
                Set GEMIST_ADMIN_URL and GEMIST_ADMIN_SHARED_SECRET on the app server to enable checkout.
              </s-banner>
            ) : null}
            {fetcher.data && !fetcher.data.ok && (fetcher.data.intent === "claim" || fetcher.data.intent === "portal") ? (
              <s-banner tone="warning">{fetcher.data.error}</s-banner>
            ) : null}
            {access.active ? (
              <s-paragraph>
                Plan: {license.planName || "Paid plan"}
                {license.expiresAt ? ` · paid through ${formatDate(license.expiresAt)}` : ""}
              </s-paragraph>
            ) : (
              <s-paragraph>
                Checkout opens in a new tab. After payment, Gemist activates this
                store automatically — come back here and the status updates.
              </s-paragraph>
            )}
            <s-stack direction="inline" gap="base">
              {!access.active && checkoutUrl ? (
                <s-button variant="primary" href={checkoutUrl} target="_blank">
                  View plans &amp; subscribe
                </s-button>
              ) : null}
              {!access.active && access.licensingEnabled ? (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="claim" />
                  <s-button type="submit" {...(pending?.get("intent") === "claim" ? { loading: true } : {})}>
                    I’ve completed payment
                  </s-button>
                </fetcher.Form>
              ) : null}
              {access.active && license.planType === "subscription" ? (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="portal" />
                  <s-button type="submit" {...(pending?.get("intent") === "portal" ? { loading: true } : {})}>
                    Manage or cancel subscription
                  </s-button>
                </fetcher.Form>
              ) : null}
            </s-stack>
            {!access.active && access.licensingEnabled ? (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="activate-license" />
                <s-stack direction="block" gap="small-200">
                  <s-text-field
                    name="licenseKey"
                    label="Have a license key? Paste it here"
                    placeholder="GEM-XXXX-XXXX-XXXX-XXXX"
                    autocomplete="off"
                    error={
                      fetcher.data && !fetcher.data.ok && fetcher.data.intent === "activate-license"
                        ? fetcher.data.error
                        : ""
                    }
                  />
                  <s-button type="submit" {...(pending?.get("intent") === "activate-license" ? { loading: true } : {})}>
                    Activate
                  </s-button>
                </s-stack>
              </fetcher.Form>
            ) : null}
            {access.active && license.planType === "subscription" ? (
              <s-paragraph>
                Cancelling turns the grid off on your live store at the end of the
                paid period. Your configuration is kept, so subscribing again restores it.
              </s-paragraph>
            ) : null}
          </s-stack>
        </s-section>
      ) : null}

      {access.billingRequired ? (
        <s-section heading="Plans">
          <s-stack direction="block" gap="base">
            {fetcher.data && !fetcher.data.ok && fetcher.data.intent === "subscribe" ? (
              <s-banner heading="Subscription could not start" tone="critical">
                {fetcher.data.error}
              </s-banner>
            ) : null}
            {plans.map((plan) => {
              const current = subscribed && subscription?.planName === plan.name;
              const loading =
                pending?.get("intent") === "subscribe" && pending?.get("plan") === plan.name;
              return (
                <s-box key={plan.name} padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                    <s-stack direction="block" gap="small-200">
                      <s-heading>{plan.name}</s-heading>
                      <s-paragraph>
                        {formatPrice(plan.amount, plan.currencyCode)} every {plan.interval}
                        {plan.trialDays ? ` · ${plan.trialDays}-day free trial` : ""}
                      </s-paragraph>
                    </s-stack>
                    {current ? (
                      <s-badge tone="success">Current plan</s-badge>
                    ) : (
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="subscribe" />
                        <input type="hidden" name="plan" value={plan.name} />
                        <s-button type="submit" variant="primary" {...(loading ? { loading: true } : {})}>
                          {subscribed ? "Switch to this plan" : "Subscribe"}
                        </s-button>
                      </fetcher.Form>
                    )}
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        </s-section>
      ) : null}

      {subscribed && subscription ? (
        <s-section heading="Manage subscription">
          <s-paragraph>
            Status: {subscription.status}
            {subscription.lastCheckedAt ? ` · checked ${new Date(subscription.lastCheckedAt).toLocaleString()}` : ""}
          </s-paragraph>
          <s-paragraph>
            Cancelling turns the grid off on your live store right away. Your
            configuration is kept, so subscribing again restores it.
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="cancel" />
            <input type="hidden" name="subscriptionId" value={subscription.id} />
            <s-button
              type="submit"
              tone="critical"
              variant="secondary"
              {...(pending?.get("intent") === "cancel" ? { loading: true } : {})}
            >
              Cancel subscription
            </s-button>
          </fetcher.Form>
        </s-section>
      ) : null}

      <s-section heading="Status">
        {stripeMode ? null : (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="refresh" />
            <s-button type="submit" variant="tertiary" {...(pending?.get("intent") === "refresh" ? { loading: true } : {})}>
              Check subscription status
            </s-button>
          </fetcher.Form>
        )}
        {access.licensingEnabled ? (
          <s-paragraph>
            Have a Gemist license key instead? <s-link href="/app/settings">Enter it in Settings</s-link>.
          </s-paragraph>
        ) : null}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
