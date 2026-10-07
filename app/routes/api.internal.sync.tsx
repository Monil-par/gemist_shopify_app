import type { ActionFunctionArgs } from "react-router";
import { readAdminRequest } from "../lib/admin-link.server";
import { buildCatalogReport, getStoreProfileReport } from "../lib/store-report.server";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";

/** Admin panel → app: return this shop's profile and Gemist catalog. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const body = await readAdminRequest<{ shop?: string }>(request);
  if (!body) return Response.json({ ok: false, error: "Invalid signature" }, { status: 401 });

  const shop = String(body.shop || "").trim().toLowerCase();
  if (!shop) return Response.json({ ok: false, error: "Missing shop." }, { status: 400 });

  const installed = await prisma.session.findFirst({ where: { shop }, select: { id: true } });
  if (!installed) {
    return Response.json({ ok: false, error: "The Gemist app is not installed on this store." }, { status: 410 });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const [profile, products] = await Promise.all([
      getStoreProfileReport(admin),
      buildCatalogReport(shop),
    ]);
    return Response.json({ ok: true, shop, ...profile, products });
  } catch (error) {
    console.error("[gemist internal] sync failed", error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Sync failed." },
      { status: 500 },
    );
  }
};
