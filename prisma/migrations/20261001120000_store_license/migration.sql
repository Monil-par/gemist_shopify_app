-- CreateTable
CREATE TABLE "StoreLicense" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "licenseKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "message" TEXT NOT NULL DEFAULT '',
    "planCode" TEXT NOT NULL DEFAULT '',
    "planName" TEXT NOT NULL DEFAULT '',
    "planType" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "lastCheckAttemptAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "verifyIntervalHours" INTEGER NOT NULL DEFAULT 6,
    "graceHours" INTEGER NOT NULL DEFAULT 72,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreLicense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreLicense_shop_key" ON "StoreLicense"("shop");
