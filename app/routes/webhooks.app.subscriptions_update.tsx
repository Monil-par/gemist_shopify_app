import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applySubscriptionWebhook, syncSubscription } from "../lib/access.server";
import { reportSubscriptionToAdmin } from "../lib/store-report.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, admin, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const subscription = (payload as { app_subscription?: Record<string, string> })?.app_subscription;
  if (admin) {
    await syncSubscription(shop, admin.graphql);
  } else if (subscription) {
    await applySubscriptionWebhook(shop, subscription);
  }

  reportSubscriptionToAdmin(shop, admin).catch((error) =>
    console.warn("[gemist] could not report subscription change to admin panel", error),
  );
  return new Response();
};
