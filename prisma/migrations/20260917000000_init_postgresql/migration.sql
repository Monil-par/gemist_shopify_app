-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantCredential" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "merchantKey" TEXT NOT NULL,
    "merchantSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantSetting" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "apiBaseUrl" TEXT NOT NULL DEFAULT '',
    "markupPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "appointmentUrl" TEXT NOT NULL DEFAULT '',
    "appointmentEmail" TEXT NOT NULL DEFAULT '',
    "appointmentLabel" TEXT NOT NULL DEFAULT 'Schedule an Appointment',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GemistOrderSubmission" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL DEFAULT '',
    "gemistProductId" TEXT NOT NULL DEFAULT '',
    "oemSku" TEXT NOT NULL DEFAULT '',
    "gemistOrderId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'stored',
    "error" TEXT NOT NULL DEFAULT '',
    "payload" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GemistOrderSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantCredential_shop_key" ON "MerchantCredential"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantSetting_shop_key" ON "MerchantSetting"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "GemistOrderSubmission_shop_shopifyOrderId_key" ON "GemistOrderSubmission"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "GemistOrderSubmission_shop_status_idx" ON "GemistOrderSubmission"("shop", "status");
