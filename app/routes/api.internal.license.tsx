import type { ActionFunctionArgs } from "react-router";
import { readAdminRequest } from "../lib/admin-link.server";
import { activateLicense, refreshLicense } from "../lib/license.server";
import { clearAccessCache } from "../lib/access.server";

/**
 * Admin panel → app. With `licenseKey`: a purchase for this shop completed, activate it.
 * Without: a license changed (revoked, extended…), re-check now.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const body = await readAdminRequest<{ shop?: string; licenseKey?: string }>(request);
  if (!body) return Response.json({ ok: false, error: "Invalid signature" }, { status: 401 });

  const shop = String(body.shop || "").trim().toLowerCase();
  if (!shop) return Response.json({ ok: false, error: "Missing shop." }, { status: 400 });

  if (body.licenseKey) {
    const result = await activateLicense(shop, String(body.licenseKey));
    clearAccessCache(shop);
    return Response.json(result.ok ? { ok: true, status: "active" } : { ok: false, error: result.error });
  }

  const row = await refreshLicense(shop);
  clearAccessCache(shop);
  return Response.json({ ok: true, status: row?.status || "none" });
};
