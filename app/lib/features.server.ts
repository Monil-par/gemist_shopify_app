/**
 * Feature flags for work that is out of the approved SOW but kept in the
 * codebase for a possible later phase. Defaults are OFF so the merchant app
 * has no dependency on billing, licensing, Stripe, or appointments.
 *
 * Turn on later with env:
 *   GEMIST_MONETIZATION_ENABLED=true
 *   GEMIST_APPOINTMENTS_ENABLED=true
 */

function envFlag(name: string, fallback: boolean) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Stripe / Shopify Billing, license keys, Plan page, payment-gated storefront,
 * and Gemist admin panel licensing links.
 */
export function isMonetizationEnabled() {
  return envFlag("GEMIST_MONETIZATION_ENABLED", false);
}

/** Schedule an Appointment CTA and Settings fields (deferred in SOW §4). */
export function isAppointmentsEnabled() {
  return envFlag("GEMIST_APPOINTMENTS_ENABLED", false);
}

/**
 * Prefer Gemist POST /api/products/shopify for cart product creation (SOW 3.6).
 * Falls back to Shopify Admin GraphQL structural product on failure.
 * Default ON; set GEMIST_SHOPIFY_PRODUCT_CREATE=false to force Admin GraphQL only.
 */
export function useGemistShopifyProductCreate() {
  return envFlag("GEMIST_SHOPIFY_PRODUCT_CREATE", true);
}
