import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { removeLicense } from "../lib/license.server";
import { removeSubscription } from "../lib/access.server";
import { reportUninstallToAdmin } from "../lib/store-report.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await reportUninstallToAdmin(shop).catch((error) =>
    console.warn("[gemist] could not notify admin panel of uninstall", error),
  );
  await removeLicense(shop);
  await removeSubscription(shop);

  await db.merchantCredential.deleteMany({ where: { shop } });
  await db.merchantSetting.deleteMany({ where: { shop } });
  await db.gemistOrderSubmission.deleteMany({ where: { shop } });
  await db.merchantCatalogStyle.deleteMany({ where: { shop } });

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
