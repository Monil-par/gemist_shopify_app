export type ShopProfile = {
  name: string;
  domain: string;
  storefrontUrl: string;
};

type Admin = {
  graphql: (query: string) => Promise<Response>;
};

export async function getShopProfile(
  admin: Admin,
  shop: string,
): Promise<ShopProfile> {
  const fallback: ShopProfile = {
    name: shop.replace(/\.myshopify\.com$/i, ""),
    domain: shop,
    storefrontUrl: `https://${shop}`,
  };

  try {
    const response = await admin.graphql(`#graphql
      query GemistShopProfile {
        shop {
          name
          myshopifyDomain
          primaryDomain { url }
        }
      }
    `);
    const json = await response.json();
    const data = json.data?.shop as
      | {
          name?: string;
          myshopifyDomain?: string;
          primaryDomain?: { url?: string } | null;
        }
      | undefined;
    if (!data?.myshopifyDomain && !data?.name) return fallback;
    return {
      name: data.name || fallback.name,
      domain: data.myshopifyDomain || shop,
      storefrontUrl: data.primaryDomain?.url || fallback.storefrontUrl,
    };
  } catch {
    return fallback;
  }
}
