-- CreateTable
CREATE TABLE "MerchantCatalogStyle" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "title" TEXT NOT NULL DEFAULT '',
    "gemistProductId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantCatalogStyle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantCatalogStyle_shop_status_idx" ON "MerchantCatalogStyle"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantCatalogStyle_shop_slug_key" ON "MerchantCatalogStyle"("shop", "slug");
