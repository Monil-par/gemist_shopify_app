export type MarkupCondition = {
  optionType: string;
  optionValue: string;
};

export type MarkupRuleInput = {
  id?: string;
  name: string;
  multiplier: number;
  conditions: MarkupCondition[];
  active?: boolean;
};

export type ResolvedMarkup = {
  /** Absolute multiplier applied to Gemist price (e.g. 2.5). */
  multiplier: number;
  /** Equivalent percent for legacy clients: (multiplier - 1) * 100. */
  markupPercent: number;
  ruleId: string | null;
  ruleName: string;
  specificity: number;
  source: "rule" | "default";
};

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function parseConditionsJson(raw: string): MarkupCondition[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as { optionType?: unknown; optionValue?: unknown };
        const optionType = String(row.optionType || "").trim();
        const optionValue = String(row.optionValue || "").trim();
        if (!optionType || !optionValue) return null;
        return { optionType, optionValue };
      })
      .filter((item): item is MarkupCondition => Boolean(item));
  } catch {
    return [];
  }
}

export function serializeConditions(conditions: MarkupCondition[]) {
  return JSON.stringify(
    conditions.map((item) => ({
      optionType: item.optionType.trim(),
      optionValue: item.optionValue.trim(),
    })),
  );
}

/** Convert legacy markup percent (e.g. 25 → 1.25×) into a multiplier. */
export function percentToMultiplier(markupPercent: number) {
  const percent = Number.isFinite(markupPercent) ? Math.max(markupPercent, 0) : 0;
  return 1 + percent / 100;
}

export function multiplierToPercent(multiplier: number) {
  const value = Number.isFinite(multiplier) ? multiplier : 1;
  return Math.round((Math.max(value, 0) - 1) * 10000) / 100;
}

/**
 * Pick the single most-specific matching rule.
 * A rule matches only when every condition is present on the product parts.
 * Ties: higher specificity wins, then higher multiplier, then newer createdAt.
 */
export function pickMarkupRule<
  T extends {
    id: string;
    name: string;
    multiplier: number;
    conditions: MarkupCondition[];
    specificity: number;
    createdAt?: Date | string | null;
  },
>(rules: T[], selectedParts: Record<string, string>): T | null {
  const parts = new Map<string, string>();
  for (const [key, value] of Object.entries(selectedParts || {})) {
    if (!key || value == null || value === "") continue;
    parts.set(normalizeKey(key), normalizeKey(String(value)));
  }

  let best: T | null = null;
  for (const rule of rules) {
    const conditions = rule.conditions || [];
    if (!conditions.length) continue;
    const matches = conditions.every((condition) => {
      const have = parts.get(normalizeKey(condition.optionType));
      return have != null && have === normalizeKey(condition.optionValue);
    });
    if (!matches) continue;

    if (!best) {
      best = rule;
      continue;
    }
    if (rule.specificity !== best.specificity) {
      if (rule.specificity > best.specificity) best = rule;
      continue;
    }
    if (rule.multiplier !== best.multiplier) {
      if (rule.multiplier > best.multiplier) best = rule;
      continue;
    }
    const ruleTime = rule.createdAt ? new Date(rule.createdAt).getTime() : 0;
    const bestTime = best.createdAt ? new Date(best.createdAt).getTime() : 0;
    if (ruleTime > bestTime) best = rule;
  }
  return best;
}

export function resolveMarkupFromRules(
  rules: Array<{
    id: string;
    name: string;
    multiplier: number;
    conditions: MarkupCondition[];
    specificity: number;
    createdAt?: Date | string | null;
  }>,
  selectedParts: Record<string, string>,
  defaultMarkupPercent = 0,
): ResolvedMarkup {
  const matched = pickMarkupRule(rules, selectedParts);
  if (matched) {
    const multiplier = Math.max(Number(matched.multiplier) || 0, 0);
    return {
      multiplier,
      markupPercent: multiplierToPercent(multiplier),
      ruleId: matched.id,
      ruleName: matched.name || "Markup rule",
      specificity: matched.specificity,
      source: "rule",
    };
  }
  const multiplier = percentToMultiplier(defaultMarkupPercent);
  return {
    multiplier,
    markupPercent: multiplierToPercent(multiplier),
    ruleId: null,
    ruleName: "Default markup",
    specificity: 0,
    source: "default",
  };
}

/** Apply an absolute multiplier to a Gemist amount. */
export function applyMultiplier(amount: number, multiplier = 1) {
  const base = Number.isFinite(amount) ? Math.max(amount, 0) : 0;
  const factor = Number.isFinite(multiplier) ? Math.max(multiplier, 0) : 1;
  return Math.round(base * factor * 100) / 100;
}

/** Legacy percent helper (kept for callers that still pass markup %). */
export function applyMarkup(amount: number, markupPercent = 0) {
  return applyMultiplier(amount, percentToMultiplier(markupPercent));
}

export function formatMoney(amount: number) {
  return amount.toFixed(2);
}

/** Common Gemist option types for the admin Pricing UI. */
export const COMMON_OPTION_TYPES = [
  "Band Style",
  "Metal Type",
  "Metal Color",
  "Stone Type",
  "Center Stone",
  "Side Stone",
  "Carat",
  "Cut",
  "Clarity",
  "Color",
  "Ring Size",
  "Lab vs Natural",
  "Gemstone Type",
] as const;

const PART_LABELS: Record<string, string> = {
  metal: "Metal Type",
  metal_type: "Metal Type",
  metal_color: "Metal Color",
  stone: "Stone Type",
  stone_type: "Stone Type",
  center_stone: "Center Stone",
  side_stone: "Side Stone",
  carat: "Carat",
  cut: "Cut",
  clarity: "Clarity",
  color: "Color",
  ring_size: "Ring Size",
  band_style: "Band Style",
  gemstone_type: "Gemstone Type",
  lab_vs_natural: "Lab vs Natural",
};

function humanizePartKey(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Normalize Gemist product part maps into label → value for rule matching. */
export function partsFromProduct(product: {
  metal?: string;
  selectedProductParts?: Record<string, string>;
  productParts?: Record<string, unknown>;
  defaultProductMetadata?: Record<string, unknown>;
  manufacturerMetadata?: Record<string, unknown>;
}): Record<string, string> {
  const parts: Record<string, string> = {};
  if (product.metal) parts["Metal Type"] = String(product.metal);

  const sources = [
    product.selectedProductParts,
    product.productParts,
    product.defaultProductMetadata,
    product.manufacturerMetadata,
  ];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      if (value == null || value === "" || typeof value === "object") continue;
      const label = PART_LABELS[key] || (key.includes(" ") ? key : humanizePartKey(key));
      if (!parts[label]) parts[label] = String(value);
      // Also keep raw key so rules authored with API keys still match.
      if (!parts[key]) parts[key] = String(value);
    }
  }
  return parts;
}
