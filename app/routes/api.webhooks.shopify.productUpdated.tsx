import type { ActionFunctionArgs } from "react-router";
import { cacheDelete } from "../lib/cache.server";
import { resolveGemistApiBaseUrl } from "../lib/gemist-api.server";
// import crypto from "node:crypto";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // NOTE: If this is a Shopify Webhook, you should verify the HMAC signature here.
  // Example: 
  // const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
  // ... verify signature ...

  try {
    const payload = await request.json();
    
    console.log("[Webhook Received] Product Updated", payload);

    // The image payload shows a Shopify Product ID. 
    // If you need to clear a specific Gemist product from the cache, you need its `slug`.
    // If the payload contains the slug (e.g. payload.slug), you can delete it like this:
    
    // const apiBaseUrl = resolveGemistApiBaseUrl();
    // const cacheScope = apiBaseUrl.replace(/[^a-z0-9]+/gi, "-").slice(0, 80);
    // const slug = payload.handle; // Or wherever the slug is stored
    // const cacheKey = `gemist:v1:style:${cacheScope}:${slug}`;
    
    // await cacheDelete(cacheKey);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[Webhook Error]", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
