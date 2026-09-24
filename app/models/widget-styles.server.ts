import {
  mergeWidgetStyles,
  type WidgetStyles,
} from "../widgets/registry";

const NAMESPACE = "$app";
const KEY = "gemist_widgets";

type Admin = { graphql: (query: string, options?: { variables?: unknown }) => Promise<Response> };

async function shopId(admin: Admin) {
  const response = await admin.graphql(`#graphql
    query GemistWidgetShop {
      shop {
        id
      }
    }
  `);
  const json = await response.json();
  return json.data?.shop?.id as string;
}

export async function getWidgetStyles(admin: Admin): Promise<WidgetStyles> {
  const saved = await readWidgetStylesMetafield(admin);
  return mergeWidgetStyles(saved);
}

/** Returns null when the merchant has not saved Widgets styles yet. */
export async function getSavedWidgetStyles(
  admin: Admin,
): Promise<WidgetStyles | null> {
  const saved = await readWidgetStylesMetafield(admin);
  if (!saved) return null;
  return mergeWidgetStyles(saved);
}

async function readWidgetStylesMetafield(admin: Admin): Promise<unknown | null> {
  const response = await admin.graphql(
    `#graphql
      query GemistWidgetStyles {
        shop {
          metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
            value
          }
        }
      }
    `,
  );
  const json = await response.json();
  const raw = json.data?.shop?.metafield?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveWidgetStyles(admin: Admin, styles: WidgetStyles) {
  const ownerId = await shopId(admin);
  const response = await admin.graphql(
    `#graphql
      mutation GemistSaveWidgetStyles($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: NAMESPACE,
            key: KEY,
            type: "json",
            value: JSON.stringify(styles),
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
