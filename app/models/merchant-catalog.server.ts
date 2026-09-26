import prisma from "../db.server";
import { redisCommand } from "../lib/redis.server";

export const CATALOG_STATUSES = ["active", "archived", "deleted"] as const;
export type CatalogStyleStatus = (typeof CATALOG_STATUSES)[number];

export function isCatalogStyleStatus(value: string): value is CatalogStyleStatus {
  return (CATALOG_STATUSES as readonly string[]).includes(value);
}

export function normalizeCatalogStatus(
  value: string | null | undefined,
): CatalogStyleStatus {
  const normalized = value || "";
  return isCatalogStyleStatus(normalized) ? normalized : "active";
}

type CatalogStatusEntry = {
  status: CatalogStyleStatus;
  title?: string;
  gemistProductId?: string;
};

function redisKey(shop: string) {
  return `gemist:catalog-status:${shop}`;
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

function catalogDelegate() {
  return (
    prisma as { merchantCatalogStyle?: typeof prisma.merchantCatalogStyle }
  ).merchantCatalogStyle;
}

let ensureTablePromise: Promise<boolean> | null = null;

async function ensureMerchantCatalogStyleTable(): Promise<boolean> {
  if (!catalogDelegate()?.upsert) return false;
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      try {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS "MerchantCatalogStyle" (
            "id" TEXT NOT NULL,
            "shop" TEXT NOT NULL,
            "slug" TEXT NOT NULL,
            "status" TEXT NOT NULL DEFAULT 'active',
            "title" TEXT NOT NULL DEFAULT '',
            "gemistProductId" TEXT NOT NULL DEFAULT '',
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL,
            CONSTRAINT "MerchantCatalogStyle_pkey" PRIMARY KEY ("id")
          )
        `);
        await prisma.$executeRawUnsafe(`
          CREATE INDEX IF NOT EXISTS "MerchantCatalogStyle_shop_status_idx"
          ON "MerchantCatalogStyle"("shop", "status")
        `);
        await prisma.$executeRawUnsafe(`
          CREATE UNIQUE INDEX IF NOT EXISTS "MerchantCatalogStyle_shop_slug_key"
          ON "MerchantCatalogStyle"("shop", "slug")
        `);
        return true;
      } catch (error) {
        console.error(
          "[gemist catalog] failed to ensure MerchantCatalogStyle table",
          error,
        );
        ensureTablePromise = null;
        return false;
      }
    })();
  }
  return ensureTablePromise;
}

async function readRedisMap(
  shop: string,
): Promise<Record<string, CatalogStyleStatus>> {
  const raw = await redisCommand((redis) => redis.get(redisKey(shop)));
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, CatalogStatusEntry | string>;
    const map: Record<string, CatalogStyleStatus> = {};
    for (const [slug, value] of Object.entries(parsed || {})) {
      if (typeof value === "string") {
        map[slug] = normalizeCatalogStatus(value);
      } else if (value && typeof value === "object") {
        map[slug] = normalizeCatalogStatus(value.status);
      }
    }
    return map;
  } catch {
    return {};
  }
}

async function writeRedisStatus({
  shop,
  slug,
  status,
  title,
  gemistProductId,
}: {
  shop: string;
  slug: string;
  status: CatalogStyleStatus;
  title?: string;
  gemistProductId?: string;
}): Promise<boolean> {
  const key = redisKey(shop);
  const existingRaw = await redisCommand((redis) => redis.get(key));
  let existing: Record<string, CatalogStatusEntry> = {};
  if (existingRaw && typeof existingRaw === "string") {
    try {
      const parsed = JSON.parse(existingRaw) as Record<
        string,
        CatalogStatusEntry | string
      >;
      for (const [entrySlug, value] of Object.entries(parsed || {})) {
        if (typeof value === "string") {
          existing[entrySlug] = { status: normalizeCatalogStatus(value) };
        } else if (value && typeof value === "object") {
          existing[entrySlug] = {
            status: normalizeCatalogStatus(value.status),
            title: value.title,
            gemistProductId: value.gemistProductId,
          };
        }
      }
    } catch {
      existing = {};
    }
  }

  existing[slug] = {
    status,
    ...(title ? { title } : existing[slug]?.title ? { title: existing[slug].title } : {}),
    ...(gemistProductId
      ? { gemistProductId }
      : existing[slug]?.gemistProductId
        ? { gemistProductId: existing[slug].gemistProductId }
        : {}),
  };

  const saved = await redisCommand((redis) =>
    redis.set(key, JSON.stringify(existing)),
  );
  return saved === "OK";
}

async function readPrismaMap(
  shop: string,
): Promise<Record<string, CatalogStyleStatus>> {
  try {
    const catalog = catalogDelegate();
    if (!catalog?.findMany) return {};
    let rows;
    try {
      rows = await catalog.findMany({
        where: { shop },
        select: { slug: true, status: true },
      });
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      const ready = await ensureMerchantCatalogStyleTable();
      if (!ready) return {};
      rows = await catalog.findMany({
        where: { shop },
        select: { slug: true, status: true },
      });
    }
    const map: Record<string, CatalogStyleStatus> = {};
    for (const row of rows) {
      map[row.slug] = normalizeCatalogStatus(row.status);
    }
    return map;
  } catch (error) {
    if (isMissingTableError(error)) return {};
    console.error("[gemist catalog] prisma status map failed", error);
    return {};
  }
}

async function writePrismaStatus({
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
}): Promise<boolean> {
  const catalog = catalogDelegate();
  if (!catalog?.upsert) return false;

  const payload = {
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
  };

  try {
    await catalog.upsert(payload);
    return true;
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.error("[gemist catalog] prisma upsert failed", error);
      return false;
    }
    const ready = await ensureMerchantCatalogStyleTable();
    if (!ready) return false;
    try {
      await catalog.upsert(payload);
      return true;
    } catch (retryError) {
      console.error("[gemist catalog] prisma upsert retry failed", retryError);
      return false;
    }
  }
}

export async function getCatalogStatusMap(
  shop: string,
): Promise<Record<string, CatalogStyleStatus>> {
  const [prismaMap, redisMap] = await Promise.all([
    readPrismaMap(shop),
    readRedisMap(shop),
  ]);
  // Redis is the fail-safe store; it wins on conflicts.
  return { ...prismaMap, ...redisMap };
}

export async function getCatalogStyleStatus(
  shop: string,
  slug: string,
): Promise<CatalogStyleStatus> {
  const map = await getCatalogStatusMap(shop);
  return map[slug] || "active";
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
  const [redisOk, prismaOk] = await Promise.all([
    writeRedisStatus({ shop, slug, status, title, gemistProductId }),
    writePrismaStatus({ shop, slug, status, title, gemistProductId }),
  ]);

  if (!redisOk && !prismaOk) {
    throw new Error(
      "Could not save product visibility. Redis and database both unavailable — restart the app containers (docker compose up -d --build).",
    );
  }

  return { shop, slug, status, title, gemistProductId };
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
  await redisCommand((redis) => redis.del(redisKey(shop)));
  try {
    const catalog = catalogDelegate();
    if (!catalog?.deleteMany) return;
    await catalog.deleteMany({ where: { shop } });
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
}
