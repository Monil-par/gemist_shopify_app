import { BillingInterval } from "@shopify/shopify-app-react-router/server";
import { isMonetizationEnabled } from "./features.server";

export const MONTHLY_PLAN = "Gemist Monthly";
export const YEARLY_PLAN = "Gemist Yearly";
export const BILLING_PLANS = [MONTHLY_PLAN, YEARLY_PLAN] as const;
export type BillingPlanName = (typeof BILLING_PLANS)[number];

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envFlag(name: string, fallback: boolean) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * "shopify": Shopify Billing API (needs Public/unlisted distribution).
 * "stripe": checkout on the Gemist admin panel; the purchase arrives as a license (works with Custom distribution).
 * Only used when GEMIST_MONETIZATION_ENABLED=true (out of SOW otherwise).
 */
export function billingProvider(): "shopify" | "stripe" {
  if (!isMonetizationEnabled()) return "shopify";
  return (process.env.GEMIST_BILLING_PROVIDER || "").trim().toLowerCase() === "stripe" ? "stripe" : "shopify";
}

/** A paid Shopify subscription is required before the grid shows on the live storefront. */
export function isBillingRequired() {
  return (
    isMonetizationEnabled() &&
    billingProvider() === "shopify" &&
    envFlag("SHOPIFY_BILLING_REQUIRED", false)
  );
}

/** Test charges are free and only meant for development/review. Turn off when going live. */
export function isBillingTestMode() {
  return envFlag("SHOPIFY_BILLING_TEST", true);
}

/** Shops that never need a subscription (e.g. your own stores), comma separated. */
export function isFreeShop(shop: string) {
  const list = (process.env.GEMIST_FREE_SHOPS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(shop.trim().toLowerCase());
}

export function billingPlans() {
  const currencyCode = (process.env.SHOPIFY_BILLING_CURRENCY || "USD").trim().toUpperCase();
  const trialDays = envNumber("SHOPIFY_BILLING_TRIAL_DAYS", 0);
  return {
    [MONTHLY_PLAN]: {
      trialDays,
      lineItems: [
        {
          amount: envNumber("SHOPIFY_BILLING_MONTHLY_PRICE", 49),
          currencyCode,
          interval: BillingInterval.Every30Days as const,
        },
      ],
    },
    [YEARLY_PLAN]: {
      trialDays,
      lineItems: [
        {
          amount: envNumber("SHOPIFY_BILLING_YEARLY_PRICE", 490),
          currencyCode,
          interval: BillingInterval.Annual as const,
        },
      ],
    },
  };
}
