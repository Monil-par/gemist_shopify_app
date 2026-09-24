import prisma from "../db.server";
import {
  getGemistOrderBearer,
  resolveGemistApiBaseUrl,
  submitGemistDraftOrder,
} from "../lib/gemist-api.server";
import { getMerchantCredentials } from "./merchant-credential.server";
import { getMerchantSettings } from "./merchant-settings.server";

export type OrderLineSnapshot = {
  gemistProductId?: string;
  sku?: string;
  title?: string;
  properties?: Record<string, string>;
};

export type StoredOrderPayload = {
  shopifyOrderId: string;
  shopifyOrderName?: string;
  email?: string;
  phone?: string;
  note?: string;
  lines: OrderLineSnapshot[];
};

const NO_BEARER =
  "Gemist /api/orders/shopify/draft requires a Bearer token. Save an API token in Settings or set GEMIST_ORDER_BEARER. The Shopify order and Gemist line data are stored for retry.";

function clip(value: string, max = 500) {
  return value.length <= max ? value : value.slice(0, max);
}

function draftBody(payload: StoredOrderPayload, merchantKey?: string) {
  return {
    lineItems: payload.lines.map((line) => ({
      title: line.title || "Gemist custom jewelry",
      sku: line.sku || "",
      quantity: 1,
      properties: line.properties || {},
    })),
    email: payload.email || undefined,
    phone: payload.phone || undefined,
    note: payload.note || undefined,
    customAttributes: {
      shopifyOrderId: payload.shopifyOrderId,
      shopifyOrderName: payload.shopifyOrderName || "",
      gemistProductId: payload.lines[0]?.gemistProductId || "",
      gemistConfigurationId:
        payload.lines[0]?.properties?._gemist_config_id ||
        payload.lines[0]?.properties?._gemist_configuration_id ||
        payload.lines[0]?.gemistProductId ||
        "",
      ...(merchantKey ? { merchantId: merchantKey } : {}),
    },
  };
}

function parsePayload(raw: string): StoredOrderPayload | null {
  try {
    const parsed = JSON.parse(raw) as StoredOrderPayload;
    if (!parsed?.shopifyOrderId || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function ingestShopifyOrder(input: {
  shop: string;
  shopifyOrderId: string;
  shopifyOrderName?: string;
  email?: string;
  phone?: string;
  note?: string;
  lines: OrderLineSnapshot[];
}) {
  const payload: StoredOrderPayload = {
    shopifyOrderId: input.shopifyOrderId,
    shopifyOrderName: input.shopifyOrderName ?? "",
    email: input.email ?? "",
    phone: input.phone ?? "",
    note: input.note ?? "",
    lines: input.lines,
  };
  const primary = input.lines[0] ?? {};

  const existing = await prisma.gemistOrderSubmission.findUnique({
    where: {
      shop_shopifyOrderId: {
        shop: input.shop,
        shopifyOrderId: input.shopifyOrderId,
      },
    },
  });

  if (existing?.status === "submitted") {
    return existing;
  }

  const row = await prisma.gemistOrderSubmission.upsert({
    where: {
      shop_shopifyOrderId: {
        shop: input.shop,
        shopifyOrderId: input.shopifyOrderId,
      },
    },
    create: {
      shop: input.shop,
      shopifyOrderId: input.shopifyOrderId,
      shopifyOrderName: payload.shopifyOrderName ?? "",
      gemistProductId: primary.gemistProductId ?? "",
      oemSku: primary.sku ?? "",
      status: "pending",
      error: "",
      payload: JSON.stringify(payload),
      attempts: 0,
    },
    update: {
      shopifyOrderName: payload.shopifyOrderName,
      gemistProductId: primary.gemistProductId ?? undefined,
      oemSku: primary.sku ?? undefined,
      payload: JSON.stringify(payload),
      status: existing?.status === "failed" ? "retrying" : "processing",
      error: "",
    },
  });

  return attemptGemistOrderSubmit(row.shop, row.id);
}

export async function attemptGemistOrderSubmit(shop: string, id: string) {
  const row = await prisma.gemistOrderSubmission.findFirst({
    where: { shop, id },
  });
  if (!row) {
    throw new Error("Order record was not found.");
  }

  const payload = parsePayload(row.payload);
  if (!payload) {
    return prisma.gemistOrderSubmission.update({
      where: { id: row.id },
      data: {
        status: "failed",
        error: "Stored order payload is invalid.",
        attempts: { increment: 1 },
      },
    });
  }

  const credentials = await getMerchantCredentials(shop);
  const settings = await getMerchantSettings(shop);
  const bearer = getGemistOrderBearer(credentials?.merchantSecret);
  if (!bearer) {
    return prisma.gemistOrderSubmission.update({
      where: { id: row.id },
      data: {
        status: "pending",
        error: NO_BEARER,
        attempts: { increment: 1 },
      },
    });
  }

  await prisma.gemistOrderSubmission.update({
    where: { id: row.id },
    data: { status: "processing" },
  });

  const result = await submitGemistDraftOrder({
    apiBaseUrl: resolveGemistApiBaseUrl(settings.apiBaseUrl),
    bearer,
    body: draftBody(payload, credentials?.merchantKey),
  });

  if (result.ok) {
    return prisma.gemistOrderSubmission.update({
      where: { id: row.id },
      data: {
        status: "submitted",
        gemistOrderId: result.id,
        error: "",
        attempts: { increment: 1 },
      },
    });
  }

  const pendingAuth = result.status === 401 || result.status === 404;
  return prisma.gemistOrderSubmission.update({
    where: { id: row.id },
    data: {
      status: pendingAuth ? "pending" : "failed",
      error: clip(
        pendingAuth && result.status === 401
          ? `${NO_BEARER} Gemist responded: ${result.error}`
          : result.error,
      ),
      attempts: { increment: 1 },
    },
  });
}

export async function retryGemistOrder(shop: string, id: string) {
  return attemptGemistOrderSubmit(shop, id);
}

export async function listRecentGemistOrders(shop: string, take = 8) {
  return prisma.gemistOrderSubmission.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
  });
}
