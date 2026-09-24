import prisma from "../db.server";
import {
  DEFAULT_GEMIST_API_BASE_URL,
  normalizeGemistApiBaseUrl,
} from "../lib/gemist-api.server";

export type MerchantSettings = {
  shop: string;
  apiBaseUrl: string;
  markupPercent: number;
  appointmentUrl: string;
  appointmentEmail: string;
  appointmentLabel: string;
};

const DEFAULT_LABEL = "Schedule an Appointment";

export const defaultMerchantSettings = (shop: string): MerchantSettings => ({
  shop,
  apiBaseUrl: DEFAULT_GEMIST_API_BASE_URL,
  markupPercent: 0,
  appointmentUrl: "",
  appointmentEmail: "",
  appointmentLabel: DEFAULT_LABEL,
});

export async function getMerchantSettings(shop: string): Promise<MerchantSettings> {
  const record = await prisma.merchantSetting.findUnique({ where: { shop } });
  if (!record) return defaultMerchantSettings(shop);
  return {
    shop: record.shop,
    apiBaseUrl: record.apiBaseUrl || DEFAULT_GEMIST_API_BASE_URL,
    markupPercent: record.markupPercent,
    appointmentUrl: record.appointmentUrl,
    appointmentEmail: record.appointmentEmail,
    appointmentLabel: record.appointmentLabel || DEFAULT_LABEL,
  };
}

export async function upsertMerchantSettings(settings: MerchantSettings) {
  const apiBaseUrl =
    normalizeGemistApiBaseUrl(settings.apiBaseUrl) || DEFAULT_GEMIST_API_BASE_URL;
  return prisma.merchantSetting.upsert({
    where: { shop: settings.shop },
    create: {
      shop: settings.shop,
      apiBaseUrl,
      markupPercent: Math.max(0, settings.markupPercent),
      appointmentUrl: settings.appointmentUrl.trim(),
      appointmentEmail: settings.appointmentEmail.trim(),
      appointmentLabel: settings.appointmentLabel.trim() || DEFAULT_LABEL,
    },
    update: {
      apiBaseUrl,
      markupPercent: Math.max(0, settings.markupPercent),
      appointmentUrl: settings.appointmentUrl.trim(),
      appointmentEmail: settings.appointmentEmail.trim(),
      appointmentLabel: settings.appointmentLabel.trim() || DEFAULT_LABEL,
    },
  });
}

type Admin = {
  graphql: (query: string, options?: { variables?: unknown }) => Promise<Response>;
};

export async function publishCommerceMetafield(
  admin: Admin,
  settings: MerchantSettings,
) {
  const shopResponse = await admin.graphql(`#graphql
    query GemistCommerceShop {
      shop { id }
    }
  `);
  const shopJson = await shopResponse.json();
  const ownerId = shopJson.data?.shop?.id as string | undefined;
  if (!ownerId) return;

  const response = await admin.graphql(
    `#graphql
      mutation GemistSaveCommerce($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: "$app",
            key: "gemist_commerce",
            type: "json",
            value: JSON.stringify({
              apiBaseUrl: settings.apiBaseUrl,
              markupPercent: settings.markupPercent,
              appointmentUrl: settings.appointmentUrl,
              appointmentEmail: settings.appointmentEmail,
              appointmentLabel: settings.appointmentLabel,
            }),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((error: { message: string }) => error.message).join(" "));
  }
}
