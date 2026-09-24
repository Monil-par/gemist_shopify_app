import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ShopBanner } from "../components/shop-banner";
import { getShopProfile } from "../lib/shop-profile.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const profile = await getShopProfile(admin, session.shop);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const editorBase = `https://${session.shop}/admin/themes/current/editor`;

  return {
    profile,
    addProductsUrl: `${editorBase}?template=index&addAppBlockId=${apiKey}/gemist-products&target=newAppsSection`,
    addCollectionUrl: `${editorBase}?template=collection&addAppBlockId=${apiKey}/gemist-products&target=newAppsSection`,
  };
};

export default function ThemePage() {
  const { profile, addProductsUrl, addCollectionUrl } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Theme">
      <ShopBanner shopName={profile.name} shopDomain={profile.domain} />

      <s-section heading="Product grid">
        <s-paragraph>
          Add the Gemist product grid to this store’s theme. Collection and home
          pages are the recommended placements.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button href={addCollectionUrl} target="_blank" variant="primary">
            Add to collection
          </s-button>
          <s-button href={addProductsUrl} target="_blank">
            Add to home
          </s-button>
          <s-button href="/app/widgets">Customize styles</s-button>
        </s-stack>
      </s-section>

      <s-section heading="Storefront">
        <s-paragraph>
          After placing the grid, open the storefront to confirm products load.
        </s-paragraph>
        <s-button href={profile.storefrontUrl} target="_blank">
          Open storefront
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
