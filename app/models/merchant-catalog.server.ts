import prisma from "../db.server";

export const CATALOG_STATUSES = ["active", "archived", "deleted"] as const;
export type CatalogStyleStatus = (typeof CATALOG_STATUSES)[number];

export function isCatalogStyleStatus(value: string): value is CatalogStyleStatus {
  return (CATALOG_STATUSES as readonly string[]).includes(value);
}

export function normalizeCatalogStatus(
  value: string | null | undefined,
): CatalogStyleStatus {
  return isCatalogStyleStatus(value || "") ? value! : "active";
}

function isMissingTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("MerchantCatalogStyle") ||
    message.includes("does not exist") ||
    message.includes("P2021") ||
    message.includes("P2010")
  );
}

export async function getCatalogStatusMap(
  shop: string,
): Promise<Record<string, CatalogStyleStatus>> {
  try {
    const catalog = (prisma as { merchantCatalogStyle?: typeof prisma.merchantCatalogStyle })
      .merchantCatalogStyle;
    if (!catalog?.findMany) {
      console.warn(
        "[gemist catalog] Prisma client missing MerchantCatalogStyle — rebuild image (prisma generate)",
      );
      return {};
    }
    const rows = await catalog.findMany({
      where: { shop },
      select: { slug: true, status: true },
    });
    const map: Record<string, CatalogStyleStatus> = {};
    for (const row of rows) {
      map[row.slug] = normalizeCatalogStatus(row.status);
    }
    return map;
  } catch (error) {
    if (isMissingTableError(error)) {
      console.warn(
        "[gemist catalog] MerchantCatalogStyle missing — run prisma migrate deploy",
        error instanceof Error ? error.message : error,
      );
      return {};
    }
    console.error("[gemist catalog] status map failed", error);
    return {};
  }
}

export async function getCatalogStyleStatus(
  shop: string,
  slug: string,
): Promise<CatalogStyleStatus> {
  try {
    const row = await prisma.merchantCatalogStyle.findUnique({
      where: { shop_slug: { shop, slug } },
      select: { status: true },
    });
    return normalizeCatalogStatus(row?.status);
  } catch (error) {
    if (isMissingTableError(error)) return "active";
    throw error;
  }
}

export async function setCatalogStyleStatus({
  shop,
  slug,
  status,
  title = "",
  gemistProductId = "",
}: {
  shop: string;
  slug: string;
  status: CatalogStyleStatus;
  title?: string;
  gemistProductId?: string;
}) {
  try {
    return await prisma.merchantCatalogStyle.upsert({
      where: { shop_slug: { shop, slug } },
      create: {
        shop,
        slug,
        status,
        title,
        gemistProductId,
      },
      update: {
        status,
        ...(title ? { title } : {}),
        ...(gemistProductId ? { gemistProductId } : {}),
      },
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      throw new Error(
        "Database is missing MerchantCatalogStyle. On the server run: npx prisma migrate deploy (or restart the app container so CMD migrates).",
      );
    }
    throw error;
  }
}

/** Storefront: only styles that are active (missing row counts as active). */
export function filterActiveCatalogSlugs(
  slugs: string[],
  statusMap: Record<string, CatalogStyleStatus>,
): string[] {
  return slugs.filter((slug) => {
    const status = statusMap[slug] || "active";
    return status === "active";
  });
}

/** Admin list: filter by tab. */
export function filterCatalogSlugsByStatus(
  slugs: string[],
  statusMap: Record<string, CatalogStyleStatus>,
  filter: CatalogStyleStatus | "all",
): string[] {
  if (filter === "all") {
    return slugs.filter((slug) => (statusMap[slug] || "active") !== "deleted");
  }
  return slugs.filter((slug) => (statusMap[slug] || "active") === filter);
}

export async function deleteCatalogStylesForShop(shop: string) {
  try {
    await prisma.merchantCatalogStyle.deleteMany({ where: { shop } });
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
}
