import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  isCatalogStyleStatus,
  setCatalogStyleStatus,
} from "../models/merchant-catalog.server";

/**
 * Dedicated admin endpoint for catalog visibility updates.
 * Always returns JSON (never throws to the React Router error boundary).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    if (request.method !== "POST") {
      return Response.json(
        { ok: false, error: "Method not allowed." },
        { status: 405 },
      );
    }

    const { session } = await authenticate.admin(request);
    const formData = await request.formData();
    const slug = String(formData.get("slug") || "").trim();
    const status = String(formData.get("status") || "").trim();
    const title = String(formData.get("title") || "").trim();
    const gemistProductId = String(formData.get("gemistProductId") || "").trim();

    if (!slug || !isCatalogStyleStatus(status)) {
      return Response.json({
        ok: false,
        error: "Invalid product status update.",
      });
    }

    await setCatalogStyleStatus({
      shop: session.shop,
      slug,
      status,
      title,
      gemistProductId,
    });

    return Response.json({ ok: true, intent: "set-status", slug, status });
  } catch (error) {
    console.error("[gemist catalog-status] failed", error);
    return Response.json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not update product visibility.",
    });
  }
};

export const loader = async () =>
  Response.json({ ok: false, error: "Use POST." }, { status: 405 });
