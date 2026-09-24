import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestShopifyOrder } from "../models/gemist-order.server";

type ShopifyLineItem = {
  sku?: string;
  title?: string;
  properties?: Array<{ name?: string; value?: string }> | Record<string, string>;
};

function propertiesMap(
  properties: ShopifyLineItem["properties"],
): Record<string, string> {
  if (!properties) return {};
  if (Array.isArray(properties)) {
    return Object.fromEntries(
      properties
        .filter((entry) => entry.name && entry.value)
        .map((entry) => [String(entry.name), String(entry.value)]),
    );
  }
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, String(value)]),
  );
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const order = payload as {
    id?: number | string;
    name?: string;
    email?: string;
    phone?: string;
    note?: string;
    line_items?: ShopifyLineItem[];
  };

  const lines = (order.line_items ?? []).map((item) => {
    const properties = propertiesMap(item.properties);
    return {
      gemistProductId:
        properties._gemist_config_id ||
        properties._gemist_product_id ||
        properties._gemist_configuration_id ||
        "",
      sku: properties._gemist_sku || item.sku || "",
      title: properties.Title || item.title || "",
      properties,
    };
  });

  const gemistLines = lines.filter(
    (line) =>
      line.gemistProductId ||
      line.properties._gemist_sku ||
      line.properties._gemist_config_id ||
      line.properties._gemist_configuration_id,
  );

  if (gemistLines.length) {
    try {
      await ingestShopifyOrder({
        shop,
        shopifyOrderId: String(order.id ?? ""),
        shopifyOrderName: order.name ?? "",
        email: order.email ?? "",
        phone: order.phone ?? "",
        note: order.note ?? "",
        lines: gemistLines,
      });
    } catch (error) {
      console.error("[gemist order] ingest failed", error);
    }
  }

  return new Response();
};
