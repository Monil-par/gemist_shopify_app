import {
  gemistProductPrice,
  type GemistProduct,
} from "./gemist-api.server";

type Admin = {
  graphql: (
    query: string,
    options?: { variables?: unknown },
  ) => Promise<Response>;
};

type GqlUserError = { field?: string[] | null; message: string };

type VariantInput = {
  price: string;
  sku: string;
  configName: string;
  imageUrl?: string;
};

const STRUCTURAL_TITLE = "Gemist Custom Jewelry";
const STRUCTURAL_TAG = "gemist-structural";
const OPTION_NAME = "Configuration";
const MAX_VARIANTS = 2000;
const MAX_PROPERTY_LENGTH = 255;
const MAX_PROPERTIES = 24;
const ALWAYS_IN_STOCK = 9999;

export type GemistCartLine = {
  variantId: number;
  variantGid: string;
  productGid: string;
  properties: Record<string, string>;
};

export async function createGemistCartLine(
  admin: Admin,
  product: GemistProduct,
  options?: { price?: string; engraving?: string },
): Promise<GemistCartLine> {
  if (!product.id) {
    throw new Error("Gemist product is missing an id.");
  }

  const price = options?.price || gemistProductPrice(product);
  const configName = uniqueOptionValue(product.id);
  const sku = clip(
    `GEMIST-${product.sku || product.id}-${configName}`.replace(/\s+/g, "-"),
    64,
  );
  const imageUrl = productImageUrl(product);
  const properties = cartProperties(product, options?.engraving);

  const parent = await findStructuralProduct(admin);
  const variantInput = { price, sku, configName, imageUrl };
  const locationId = await primaryLocationId(admin);
  const created = parent
    ? await addVariant(admin, parent.id, variantInput, false, locationId)
    : await createStructuralProduct(admin, variantInput, locationId);

  await makeVariantPurchasable(
    admin,
    created.productGid,
    created.variantGid,
    locationId,
  );

  if (imageUrl) {
    try {
      await attachVariantImage(
        admin,
        created.productGid,
        created.variantGid,
        imageUrl,
      );
    } catch (error) {
      console.warn("[gemist cart] could not attach image", error);
    }
  }

  await ensurePublished(admin, created.productGid);

  return {
    variantId: numericIdFromGid(created.variantGid),
    variantGid: created.variantGid,
    productGid: created.productGid,
    properties,
  };
}

function uniqueOptionValue(gemistId: string) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return clip(`g-${gemistId}-${suffix}`.replace(/[^a-zA-Z0-9._-]+/g, "-"), 80);
}

function clip(value: string, max = MAX_PROPERTY_LENGTH) {
  return value.length <= max ? value : value.slice(0, max);
}

function mediaUrl(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as { url?: string; src?: string };
    return record.url || record.src || "";
  }
  return "";
}

function productImageUrl(product: GemistProduct) {
  return mediaUrl(product.thumbnail) || mediaUrl(product.images?.[0]);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function cartProperties(
  product: GemistProduct,
  engraving?: string,
): Record<string, string> {
  const configId = String(product.id ?? "");
  const properties: Record<string, string> = {
    _gemist_product_id: configId,
    // PRD key; also keep configuration_id for existing order rows
    _gemist_config_id: configId,
    _gemist_configuration_id: configId,
  };

  if (product.baseProductId) {
    properties._gemist_base_product_id = clip(String(product.baseProductId));
  }
  if (product.sku) properties._gemist_sku = clip(String(product.sku));
  if (product.slug) properties._gemist_slug = clip(String(product.slug));

  const variantCode = product.manufacturerMetadata?.variant;
  if (variantCode) properties._gemist_variant = clip(String(variantCode));

  const image = productImageUrl(product);
  if (image && image.length <= MAX_PROPERTY_LENGTH) {
    properties._gemist_image = image;
  }

  const title = product.title || product.shortTitle;
  if (title) properties.Title = clip(title);

  const extras: Array<[string, unknown]> = [
    ["Style", product.style],
    ["SKU", product.sku],
    ["Metal", product.metal],
    ["Vendor", product.vendor],
  ];
  for (const [label, value] of extras) {
    if (value == null || value === "") continue;
    properties[label] = clip(String(value));
  }

  const parts = product.productParts || product.defaultProductMetadata;
  if (parts && typeof parts === "object") {
    const partMap: Record<string, string> = {
      metal: "Metal",
      metal_color: "Metal Color",
      stone: "Stone",
      shape: "Shape",
      coverage: "Coverage",
      band_width: "Band Width",
      orientation: "Orientation",
      ring_size: "Ring Size",
      style: "Style",
    };
    for (const [label, value] of Object.entries(parts)) {
      if (Object.keys(properties).length >= MAX_PROPERTIES) break;
      if (value == null || value === "" || typeof value === "object") continue;
      const key = partMap[label] || humanize(label);
      if (properties[key]) continue;
      properties[key] = clip(String(value));
    }
  }

  const trimmed = engraving?.trim();
  if (trimmed) {
    properties.Engraving = clip(trimmed, 40);
    properties._engraving_text = clip(trimmed, 40);
  }

  if (Object.keys(properties).length < MAX_PROPERTIES && parts && typeof parts === "object") {
    const compactParts: Record<string, string> = {};
    for (const [label, value] of Object.entries(parts)) {
      if (value == null || value === "" || typeof value === "object") continue;
      compactParts[label] = String(value);
    }
    const encoded = JSON.stringify(compactParts);
    if (encoded.length > 2 && encoded.length <= MAX_PROPERTY_LENGTH) {
      properties._gemist_parts = encoded;
    }
  }

  return properties;
}

function numericIdFromGid(gid: string) {
  const id = Number(String(gid).split("/").pop());
  if (!Number.isFinite(id)) {
    throw new Error("Shopify returned an invalid variant id.");
  }
  return id;
}

function userErrorMessage(errors: GqlUserError[] | undefined, fallback: string) {
  if (!errors?.length) return fallback;
  return errors.map((error) => error.message).join(" ");
}

async function gql<T>(
  admin: Admin,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(" "));
  }
  if (!json.data) {
    throw new Error("Shopify Admin API returned an empty response.");
  }
  return json.data;
}

async function findStructuralProduct(admin: Admin) {
  const data = await gql<{
    products: {
      nodes: Array<{
        id: string;
        status: string;
        options: Array<{ name: string }>;
        variantsCount?: { count?: number } | null;
      }>;
    };
  }>(
    admin,
    `#graphql
      query GemistStructuralProducts {
        products(first: 10, query: "tag:${STRUCTURAL_TAG} status:active") {
          nodes {
            id
            status
            options { name }
            variantsCount { count }
          }
        }
      }
    `,
  );

  const available = data.products.nodes.filter(
    (product) => (product.variantsCount?.count ?? 0) < MAX_VARIANTS,
  );
  return available[0] ?? null;
}

async function createStructuralProduct(
  admin: Admin,
  input: VariantInput,
  locationId?: string | null,
): Promise<{ productGid: string; variantGid: string }> {
  const data = await gql<{
    productSet: {
      product?: {
        id: string;
        variants: { nodes: Array<{ id: string }> };
      } | null;
      userErrors: GqlUserError[];
    };
  }>(
    admin,
    `#graphql
      mutation GemistProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
        productSet(synchronous: $synchronous, input: $input) {
          product {
            id
            variants(first: 1) {
              nodes { id }
            }
          }
          userErrors { field message }
        }
      }
    `,
    {
      synchronous: true,
      input: {
        title: STRUCTURAL_TITLE,
        status: "ACTIVE",
        vendor: "Gemist",
        productType: "Gemist Custom",
        tags: [STRUCTURAL_TAG, "gemist-custom"],
        descriptionHtml:
          "<p>Custom jewelry configured in Gemist. Details are stored on each cart line.</p>",
        productOptions: [
          {
            name: OPTION_NAME,
            values: [{ name: input.configName }],
          },
        ],
        variants: [
          {
            optionValues: [{ optionName: OPTION_NAME, name: input.configName }],
            price: input.price,
            inventoryPolicy: "CONTINUE",
            inventoryItem: {
              sku: input.sku,
              tracked: false,
              requiresShipping: true,
            },
            ...(locationId
              ? {
                  inventoryQuantities: [
                    {
                      locationId,
                      name: "available",
                      quantity: ALWAYS_IN_STOCK,
                    },
                  ],
                }
              : {}),
          },
        ],
      },
    },
  );

  const errors = data.productSet.userErrors;
  if (errors.length) {
    const message = userErrorMessage(errors, "Could not create the Gemist cart product.");
    if (locationId && /inventory|location|quantity/i.test(message)) {
      return createStructuralProduct(admin, input, null);
    }
    throw new Error(message);
  }

  const productGid = data.productSet.product?.id;
  const variantGid = data.productSet.product?.variants.nodes[0]?.id;
  if (!productGid || !variantGid) {
    throw new Error("Shopify created the cart product but returned no variant.");
  }
  return { productGid, variantGid };
}

async function addVariant(
  admin: Admin,
  productId: string,
  input: VariantInput,
  retried = false,
  locationId?: string | null,
): Promise<{ productGid: string; variantGid: string }> {
  const data = await gql<{
    productVariantsBulkCreate: {
      productVariants: Array<{ id: string }>;
      userErrors: GqlUserError[];
    };
  }>(
    admin,
    `#graphql
      mutation GemistAddVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }
    `,
    {
      productId,
      variants: [
        {
          optionValues: [{ optionName: OPTION_NAME, name: input.configName }],
          price: input.price,
          inventoryPolicy: "CONTINUE",
          inventoryItem: {
            sku: input.sku,
            tracked: false,
            requiresShipping: true,
          },
          ...(locationId
            ? {
                inventoryQuantities: [
                  {
                    locationId,
                    availableQuantity: ALWAYS_IN_STOCK,
                  },
                ],
              }
            : {}),
        },
      ],
    },
  );

  const errors = data.productVariantsBulkCreate.userErrors;
  if (errors.length) {
    const message = userErrorMessage(errors, "Could not add a Gemist cart variant.");
    if (!retried && /option/i.test(message)) {
      await ensureConfigurationOption(admin, productId, input.configName);
      return addVariant(
        admin,
        productId,
        { ...input, configName: uniqueOptionValue(input.sku) },
        true,
        locationId,
      );
    }
    if (/variant/i.test(message) && /limit|maximum|2048/i.test(message)) {
      return createStructuralProduct(admin, input, locationId);
    }
    if (locationId && /inventory|location|quantity/i.test(message)) {
      return addVariant(admin, productId, input, retried, null);
    }
    throw new Error(message);
  }

  const variantGid = data.productVariantsBulkCreate.productVariants[0]?.id;
  if (!variantGid) {
    throw new Error("Shopify created a cart variant but returned no id.");
  }
  return { productGid: productId, variantGid };
}

async function primaryLocationId(admin: Admin) {
  try {
    const data = await gql<{
      locations: {
        nodes: Array<{
          id: string;
          isActive?: boolean | null;
          fulfillsOnlineOrders?: boolean | null;
        }>;
      };
    }>(
      admin,
      `#graphql
        query GemistLocations {
          locations(first: 20) {
            nodes {
              id
              isActive
              fulfillsOnlineOrders
            }
          }
        }
      `,
    );
    const nodes = data.locations.nodes.filter((node) => node.isActive !== false);
    return (
      nodes.find((node) => node.fulfillsOnlineOrders)?.id ?? nodes[0]?.id ?? null
    );
  } catch (error) {
    console.warn("[gemist cart] could not load locations", error);
    return null;
  }
}

async function makeVariantPurchasable(
  admin: Admin,
  productId: string,
  variantId: string,
  locationId?: string | null,
) {
  const variant = await gql<{
    productVariant?: {
      id: string;
      inventoryItem?: { id: string; tracked?: boolean } | null;
    } | null;
  }>(
    admin,
    `#graphql
      query GemistVariantInventory($id: ID!) {
        productVariant(id: $id) {
          id
          inventoryItem { id tracked }
        }
      }
    `,
    { id: variantId },
  );

  const inventoryItemId = variant.productVariant?.inventoryItem?.id;
  if (!inventoryItemId) {
    throw new Error("Shopify created a cart variant without an inventory item.");
  }

  try {
    const updated = await gql<{
      productVariantsBulkUpdate: { userErrors: GqlUserError[] };
    }>(
      admin,
      `#graphql
        mutation GemistVariantAlwaysAvailable(
          $productId: ID!
          $variants: [ProductVariantsBulkInput!]!
        ) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors { field message }
          }
        }
      `,
      {
        productId,
        variants: [
          {
            id: variantId,
            inventoryPolicy: "CONTINUE",
          },
        ],
      },
    );
    if (updated.productVariantsBulkUpdate.userErrors.length) {
      console.warn(
        "[gemist cart] inventory policy update",
        updated.productVariantsBulkUpdate.userErrors,
      );
    }
  } catch (error) {
    console.warn("[gemist cart] inventory policy update failed", error);
  }

  if (locationId) {
    try {
      const activated = await gql<{
        inventoryActivate: { userErrors: GqlUserError[] };
      }>(
        admin,
        `#graphql
          mutation GemistActivateInventory(
            $inventoryItemId: ID!
            $locationId: ID!
            $available: Int
          ) {
            inventoryActivate(
              inventoryItemId: $inventoryItemId
              locationId: $locationId
              available: $available
            ) {
              userErrors { field message }
            }
          }
        `,
        {
          inventoryItemId,
          locationId,
          available: ALWAYS_IN_STOCK,
        },
      );
      const activateMessage = userErrorMessage(
        activated.inventoryActivate.userErrors,
        "",
      );
      if (
        activateMessage &&
        !/already|taken|activated|exists/i.test(activateMessage)
      ) {
        console.warn("[gemist cart] inventory activate", activateMessage);
      }
    } catch (error) {
      console.warn("[gemist cart] inventory activate failed", error);
    }

    try {
      const quantities = await gql<{
        inventorySetQuantities: { userErrors: GqlUserError[] };
      }>(
        admin,
        `#graphql
          mutation GemistSetInventory($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              userErrors { field message }
            }
          }
        `,
        {
          input: {
            name: "available",
            reason: "correction",
            ignoreCompareQuantity: true,
            quantities: [
              {
                inventoryItemId,
                locationId,
                quantity: ALWAYS_IN_STOCK,
              },
            ],
          },
        },
      );
      if (quantities.inventorySetQuantities.userErrors.length) {
        console.warn(
          "[gemist cart] set inventory",
          quantities.inventorySetQuantities.userErrors,
        );
      }
    } catch (error) {
      console.warn("[gemist cart] set inventory failed", error);
    }
  }

  try {
    const untracked = await gql<{
      inventoryItemUpdate: { userErrors: GqlUserError[] };
    }>(
      admin,
      `#graphql
        mutation GemistUntrackInventory($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) {
            userErrors { field message }
          }
        }
      `,
      { id: inventoryItemId, input: { tracked: false } },
    );
    if (untracked.inventoryItemUpdate.userErrors.length) {
      console.warn(
        "[gemist cart] untrack inventory",
        untracked.inventoryItemUpdate.userErrors,
      );
    }
  } catch (error) {
    console.warn("[gemist cart] untrack inventory failed", error);
  }
}

async function attachVariantImage(
  admin: Admin,
  productId: string,
  variantId: string,
  imageUrl: string,
) {
  const alreadyAttached = await variantHasImage(admin, variantId);
  if (alreadyAttached) {
    await waitForMediaReady(admin, alreadyAttached);
    return;
  }

  const created = await gql<{
    productCreateMedia: {
      media: Array<{ id: string; status?: string }>;
      mediaUserErrors: GqlUserError[];
    };
  }>(
    admin,
    `#graphql
      mutation GemistCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            id
            status
          }
          mediaUserErrors { field message }
        }
      }
    `,
    {
      productId,
      media: [
        {
          originalSource: imageUrl,
          alt: STRUCTURAL_TITLE,
          mediaContentType: "IMAGE",
        },
      ],
    },
  );

  const mediaErrors = created.productCreateMedia.mediaUserErrors;
  if (mediaErrors.length) {
    throw new Error(userErrorMessage(mediaErrors, "Could not upload the product image."));
  }

  const mediaId = created.productCreateMedia.media[0]?.id;
  if (!mediaId) {
    throw new Error("Shopify did not return a media id for the product image.");
  }

  await waitForMediaReady(admin, mediaId);

  const appended = await gql<{
    productVariantAppendMedia: { userErrors: GqlUserError[] };
  }>(
    admin,
    `#graphql
      mutation GemistAppendVariantMedia(
        $productId: ID!
        $variantMedia: [ProductVariantAppendMediaInput!]!
      ) {
        productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
          userErrors { field message }
        }
      }
    `,
    {
      productId,
      variantMedia: [{ variantId, mediaIds: [mediaId] }],
    },
  );

  const appendErrors = appended.productVariantAppendMedia.userErrors;
  if (appendErrors.length) {
    throw new Error(userErrorMessage(appendErrors, "Could not attach the image to the cart variant."));
  }
}

async function variantHasImage(admin: Admin, variantId: string) {
  const data = await gql<{
    productVariant?: {
      media?: { nodes: Array<{ id: string; status?: string }> };
    } | null;
  }>(
    admin,
    `#graphql
      query GemistVariantMedia($id: ID!) {
        productVariant(id: $id) {
          media(first: 1) {
            nodes { id status }
          }
        }
      }
    `,
    { id: variantId },
  );

  return data.productVariant?.media?.nodes[0]?.id ?? "";
}

async function waitForMediaReady(admin: Admin, mediaId: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const data = await gql<{
      node?: { status?: string } | null;
    }>(
      admin,
      `#graphql
        query GemistMediaStatus($id: ID!) {
          node(id: $id) {
            ... on MediaImage {
              status
            }
          }
        }
      `,
      { id: mediaId },
    );

    const status = data.node?.status;
    if (status === "READY") return;
    if (status === "FAILED") {
      throw new Error("Shopify failed to process the product image.");
    }
    await sleep(400);
  }
}

async function ensureConfigurationOption(
  admin: Admin,
  productId: string,
  valueName: string,
) {
  const data = await gql<{
    productOptionsCreate: { userErrors: GqlUserError[] };
  }>(
    admin,
    `#graphql
      mutation GemistProductOptions($productId: ID!, $options: [OptionCreateInput!]!) {
        productOptionsCreate(productId: $productId, options: $options) {
          userErrors { field message }
        }
      }
    `,
    {
      productId,
      options: [{ name: OPTION_NAME, values: [{ name: valueName }] }],
    },
  );
  const errors = data.productOptionsCreate.userErrors;
  if (errors.length && !/already exists|taken/i.test(errors[0].message)) {
    throw new Error(userErrorMessage(errors, "Could not add a Configuration option."));
  }
}

async function ensurePublished(admin: Admin, productId: string) {
  let nodes =
    (
      await gql<{
        publications: {
          nodes: Array<{ id: string; catalog?: { title?: string | null } | null }>;
        };
      }>(
        admin,
        `#graphql
          query GemistPublications {
            publications(first: 25, catalogType: APP) {
              nodes {
                id
                catalog { title }
              }
            }
          }
        `,
      )
    ).publications.nodes ?? [];

  if (!nodes.length) {
    nodes =
      (
        await gql<{
          publications: {
            nodes: Array<{ id: string; catalog?: { title?: string | null } | null }>;
          };
        }>(
          admin,
          `#graphql
            query GemistAllPublications {
              publications(first: 25) {
                nodes {
                  id
                  catalog { title }
                }
              }
            }
          `,
        )
      ).publications.nodes ?? [];
  }
  const online = nodes.find((node) =>
    /online store/i.test(node.catalog?.title ?? ""),
  );
  const publicationIds = (online ? [online] : nodes).map((node) => node.id);
  if (!publicationIds.length) return;

  const result = await gql<{
    publishablePublish: { userErrors: GqlUserError[] };
  }>(
    admin,
    `#graphql
      mutation GemistPublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }
    `,
    {
      id: productId,
      input: publicationIds.map((publicationId) => ({ publicationId })),
    },
  );

  const errors = result.publishablePublish.userErrors;
  if (errors.length) {
    console.warn("[gemist cart] publish failed", errors);
  }
}
