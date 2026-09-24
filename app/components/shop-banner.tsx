export function ShopBanner({
  shopName,
  shopDomain,
}: {
  shopName: string;
  shopDomain: string;
}) {
  return (
    <s-banner heading={shopName} tone="info">
      Configuring {shopDomain}
    </s-banner>
  );
}
