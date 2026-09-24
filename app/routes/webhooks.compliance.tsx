import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory App Store compliance webhooks:
 * customers/data_request, customers/redact, shop/redact
 * @see https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`[gemist compliance] ${topic} for ${shop}`);

  if (topic === "CUSTOMERS_DATA_REQUEST" || topic === "customers/data_request") {
    // App does not persist customer PII beyond Shopify session/order linkage.
    console.log("[gemist compliance] data_request acknowledged", {
      shop_id: (payload as { shop_id?: number })?.shop_id,
      customer: (payload as { customer?: { id?: number } })?.customer?.id,
    });
    return new Response();
  }

  if (topic === "CUSTOMERS_REDACT" || topic === "customers/redact") {
    console.log("[gemist compliance] customers/redact acknowledged", {
      shop_id: (payload as { shop_id?: number })?.shop_id,
      customer: (payload as { customer?: { id?: number } })?.customer?.id,
    });
    return new Response();
  }

  if (topic === "SHOP_REDACT" || topic === "shop/redact") {
    await db.merchantCredential.deleteMany({ where: { shop } });
    await db.merchantSetting.deleteMany({ where: { shop } });
    await db.gemistOrderSubmission.deleteMany({ where: { shop } });
    await db.merchantCatalogStyle.deleteMany({ where: { shop } });
    await db.session.deleteMany({ where: { shop } });
    return new Response();
  }

  return new Response();
};
