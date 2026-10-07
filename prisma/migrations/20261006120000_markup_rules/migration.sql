-- CreateTable
CREATE TABLE "MarkupRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "multiplier" DOUBLE PRECISION NOT NULL,
    "conditionsJson" TEXT NOT NULL DEFAULT '[]',
    "specificity" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarkupRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarkupRule_shop_active_idx" ON "MarkupRule"("shop", "active");

-- CreateIndex
CREATE INDEX "MarkupRule_shop_specificity_idx" ON "MarkupRule"("shop", "specificity");
