import crypto from "node:crypto";
import { authenticate } from "../shopify.server";

export type AppProxyAuth = {
  shop: string;
  admin?: {
    graphql: (
      query: string,
      options?: { variables?: unknown },
    ) => Promise<Response>;
  };
};

/**
 * Prefer Shopify's authenticate.public.appProxy.
 * If that fails (e.g. fresh DB with no Session row), fall back to verifying
 * the App Proxy HMAC so public catalog reads still work.
 */
export async function authenticateAppProxy(
  request: Request,
): Promise<AppProxyAuth> {
  try {
    const context = await authenticate.public.appProxy(request);
    const shop = context.session?.shop || shopFromRequest(request);
    return { shop, admin: context.admin };
  } catch (error) {
    const shop = verifyAppProxyHmac(request);
    if (shop) {
      console.warn(
        "[gemist proxy] HMAC ok but session auth failed; continuing without session",
        error instanceof Error ? error.message : error,
      );
      return { shop };
    }
    throw error;
  }
}

function shopFromRequest(request: Request): string {
  const url = new URL(request.url);
  return (url.searchParams.get("shop") || "").trim();
}

function verifyAppProxyHmac(request: Request): string {
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) return "";

  const url = new URL(request.url);
  const signature = url.searchParams.get("signature");
  if (!signature) return "";

  const entries: string[] = [];
  url.searchParams.forEach((value, key) => {
    if (key === "signature" || key === "hmac") return;
    entries.push(`${key}=${value}`);
  });
  entries.sort();
  const digest = crypto
    .createHmac("sha256", secret)
    .update(entries.join(""))
    .digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "";

  return (url.searchParams.get("shop") || "").trim();
}
