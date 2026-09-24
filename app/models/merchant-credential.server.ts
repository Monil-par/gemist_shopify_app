import prisma from "../db.server";
import { decrypt, encrypt } from "../utils/encryption.server";

export type MerchantCredentials = {
  shop: string;
  merchantKey: string;
  merchantSecret: string;
};

export async function getMerchantCredentials(shop: string) {
  const record = await prisma.merchantCredential.findUnique({
    where: { shop },
  });

  if (!record) {
    return null;
  }

  return {
    shop: record.shop,
    merchantKey: decrypt(record.merchantKey),
    merchantSecret: decrypt(record.merchantSecret),
    updatedAt: record.updatedAt,
  } satisfies MerchantCredentials & { updatedAt: Date };
}

export async function upsertMerchantCredentials({
  shop,
  merchantKey,
  merchantSecret,
}: MerchantCredentials) {
  const encryptedKey = encrypt(merchantKey);
  const encryptedSecret = encrypt(merchantSecret);

  return prisma.merchantCredential.upsert({
    where: { shop },
    create: {
      shop,
      merchantKey: encryptedKey,
      merchantSecret: encryptedSecret,
    },
    update: {
      merchantKey: encryptedKey,
      merchantSecret: encryptedSecret,
    },
  });
}

export async function deleteMerchantCredentials(shop: string) {
  await prisma.merchantCredential.deleteMany({ where: { shop } });
}
