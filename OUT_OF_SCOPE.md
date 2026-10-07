# Out-of-scope features (kept, disabled)

Per the approved **Scope of Work** (§4 / §5), the following were built experimentally but are **hidden and not enforced** by default so the merchant app has no dependency on them.

| Feature | Status | Re-enable |
|---------|--------|-----------|
| Stripe / Shopify Billing, Plan page | Hidden | `GEMIST_MONETIZATION_ENABLED=true` (+ admin URL/secret or Shopify billing env) |
| License keys / payment-gated storefront | Off | same flag |
| Gemist admin panel licensing link | Off | same flag |
| Schedule an Appointment (Settings + PDP CTA) | Hidden | `GEMIST_APPOINTMENTS_ENABLED=true` |
| External `gemist_admin` billing panel | Separate project; not required for SOW | Deploy only if monetization is approved |

Code remains in the repo for a possible later phase. Do **not** present these as Phase 1 deliverables to the client.
