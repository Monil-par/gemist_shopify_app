import prisma from "../db.server";
import {
  parseConditionsJson,
  serializeConditions,
  type MarkupCondition,
  type MarkupRuleInput,
  resolveMarkupFromRules,
  type ResolvedMarkup,
} from "../lib/pricing.server";

export type MarkupRuleView = {
  id: string;
  shop: string;
  name: string;
  multiplier: number;
  conditions: MarkupCondition[];
  specificity: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

function toView(row: {
  id: string;
  shop: string;
  name: string;
  multiplier: number;
  conditionsJson: string;
  specificity: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): MarkupRuleView {
  const conditions = parseConditionsJson(row.conditionsJson);
  return {
    id: row.id,
    shop: row.shop,
    name: row.name,
    multiplier: row.multiplier,
    conditions,
    specificity: row.specificity || conditions.length,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMarkupRules(shop: string) {
  const rows = await prisma.markupRule.findMany({
    where: { shop },
    orderBy: [{ specificity: "desc" }, { multiplier: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(toView);
}

export async function listActiveMarkupRules(shop: string) {
  const rows = await prisma.markupRule.findMany({
    where: { shop, active: true },
    orderBy: [{ specificity: "desc" }, { multiplier: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(toView);
}

export async function createMarkupRule(shop: string, input: MarkupRuleInput) {
  const conditions = input.conditions.filter(
    (item) => item.optionType.trim() && item.optionValue.trim(),
  );
  if (!conditions.length) throw new Error("Add at least one part condition.");
  const multiplier = Number(input.multiplier);
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error("Multiplier must be a number greater than 0 (e.g. 2.5).");
  }
  const row = await prisma.markupRule.create({
    data: {
      shop,
      name: (input.name || "").trim() || conditionLabel(conditions),
      multiplier,
      conditionsJson: serializeConditions(conditions),
      specificity: conditions.length,
      active: input.active !== false,
    },
  });
  return toView(row);
}

export async function updateMarkupRule(shop: string, id: string, input: MarkupRuleInput) {
  const existing = await prisma.markupRule.findFirst({ where: { id, shop } });
  if (!existing) throw new Error("Markup rule not found.");
  const conditions = input.conditions.filter(
    (item) => item.optionType.trim() && item.optionValue.trim(),
  );
  if (!conditions.length) throw new Error("Add at least one part condition.");
  const multiplier = Number(input.multiplier);
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error("Multiplier must be a number greater than 0 (e.g. 2.5).");
  }
  const row = await prisma.markupRule.update({
    where: { id },
    data: {
      name: (input.name || "").trim() || conditionLabel(conditions),
      multiplier,
      conditionsJson: serializeConditions(conditions),
      specificity: conditions.length,
      active: input.active !== false,
    },
  });
  return toView(row);
}

export async function deleteMarkupRule(shop: string, id: string) {
  const existing = await prisma.markupRule.findFirst({ where: { id, shop } });
  if (!existing) throw new Error("Markup rule not found.");
  await prisma.markupRule.delete({ where: { id } });
}

export async function resolveShopMarkup(
  shop: string,
  selectedParts: Record<string, string>,
  defaultMarkupPercent = 0,
): Promise<ResolvedMarkup> {
  const rules = await listActiveMarkupRules(shop);
  return resolveMarkupFromRules(
    rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      multiplier: rule.multiplier,
      conditions: rule.conditions,
      specificity: rule.specificity,
      createdAt: rule.createdAt,
    })),
    selectedParts,
    defaultMarkupPercent,
  );
}

function conditionLabel(conditions: MarkupCondition[]) {
  return conditions.map((item) => `${item.optionType}: ${item.optionValue}`).join(" + ");
}
