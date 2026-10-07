import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ShopBanner } from "../components/shop-banner";
import { getShopProfile } from "../lib/shop-profile.server";
import { COMMON_OPTION_TYPES } from "../lib/pricing.server";
import {
  getMerchantSettings,
  upsertMerchantSettings,
} from "../models/merchant-settings.server";
import {
  createMarkupRule,
  deleteMarkupRule,
  listMarkupRules,
  updateMarkupRule,
} from "../models/markup-rules.server";

type ActionData =
  | { ok: true; intent: string }
  | { ok: false; intent: string; error: string };

type ConditionRow = { optionType: string; optionValue: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [profile, settings, rules] = await Promise.all([
    getShopProfile(admin, session.shop),
    getMerchantSettings(session.shop),
    listMarkupRules(session.shop),
  ]);
  return {
    profile,
    markupPercent: settings.markupPercent,
    apiBaseUrl: settings.apiBaseUrl,
    appointmentUrl: settings.appointmentUrl,
    appointmentEmail: settings.appointmentEmail,
    appointmentLabel: settings.appointmentLabel,
    rules,
    optionTypes: [...COMMON_OPTION_TYPES],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "save-default") {
    const markupPercent = Number(formData.get("markupPercent") || 0);
    const existing = await getMerchantSettings(session.shop);
    await upsertMerchantSettings({
      shop: session.shop,
      apiBaseUrl: existing.apiBaseUrl,
      markupPercent: Number.isFinite(markupPercent) ? Math.max(markupPercent, 0) : 0,
      appointmentUrl: existing.appointmentUrl,
      appointmentEmail: existing.appointmentEmail,
      appointmentLabel: existing.appointmentLabel,
    });
    return { ok: true, intent } satisfies ActionData;
  }

  if (intent === "save-rule" || intent === "create-rule") {
    try {
      const id = String(formData.get("id") || "").trim();
      const name = String(formData.get("name") || "").trim();
      const multiplier = Number(formData.get("multiplier") || 0);
      const active = formData.get("active") !== "false";
      const conditions = parseConditionsFromForm(formData);
      if (intent === "create-rule" || !id) {
        await createMarkupRule(session.shop, { name, multiplier, conditions, active });
      } else {
        await updateMarkupRule(session.shop, id, { name, multiplier, conditions, active });
      }
      return { ok: true, intent } satisfies ActionData;
    } catch (error) {
      return {
        ok: false,
        intent,
        error: error instanceof Error ? error.message : "Could not save rule.",
      } satisfies ActionData;
    }
  }

  if (intent === "delete-rule") {
    try {
      await deleteMarkupRule(session.shop, String(formData.get("id") || ""));
      return { ok: true, intent } satisfies ActionData;
    } catch (error) {
      return {
        ok: false,
        intent,
        error: error instanceof Error ? error.message : "Could not delete rule.",
      } satisfies ActionData;
    }
  }

  return { ok: false, intent, error: "Unknown action." } satisfies ActionData;
};

function parseConditionsFromForm(formData: FormData): ConditionRow[] {
  const types = formData.getAll("conditionType").map((item) => String(item || "").trim());
  const values = formData.getAll("conditionValue").map((item) => String(item || "").trim());
  const rows: ConditionRow[] = [];
  const count = Math.max(types.length, values.length);
  for (let index = 0; index < count; index += 1) {
    const optionType = types[index] || "";
    const optionValue = values[index] || "";
    if (!optionType && !optionValue) continue;
    rows.push({ optionType, optionValue });
  }
  return rows;
}

export default function PricingPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [markupPercent, setMarkupPercent] = useState(String(data.markupPercent));
  const [draft, setDraft] = useState<ConditionRow[]>([{ optionType: "Metal Type", optionValue: "" }]);
  const [name, setName] = useState("");
  const [multiplier, setMultiplier] = useState("2.5");
  const pending = fetcher.state !== "idle" ? String(fetcher.formData?.get("intent") || "") : "";

  useEffect(() => {
    setMarkupPercent(String(data.markupPercent));
  }, [data.markupPercent]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (!fetcher.data.ok) {
      shopify.toast.show(fetcher.data.error);
      return;
    }
    if (fetcher.data.intent === "save-default") shopify.toast.show("Default markup saved");
    if (fetcher.data.intent === "create-rule" || fetcher.data.intent === "save-rule") {
      shopify.toast.show("Markup rule saved");
      setName("");
      setMultiplier("2.5");
      setDraft([{ optionType: "Metal Type", optionValue: "" }]);
    }
    if (fetcher.data.intent === "delete-rule") shopify.toast.show("Markup rule deleted");
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Pricing">
      <ShopBanner shopName={data.profile.name} shopDomain={data.profile.domain} />

      <s-banner heading="How markup rules work" tone="info">
        Each rule targets one product part or a combination of parts. The most
        specific matching rule wins — only one multiplier is applied. If nothing
        matches, the default markup percent is used.
      </s-banner>

      <s-section heading="Default markup">
        <s-paragraph>
          Used when no specificity rule matches the configured product parts.
          Example: 25 means Gemist price × 1.25.
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="save-default" />
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field
              name="markupPercent"
              label="Default markup (%)"
              value={markupPercent}
              onChange={(event) => setMarkupPercent(event.currentTarget.value)}
            />
            <s-button type="submit" variant="primary" {...(pending === "save-default" ? { loading: true } : {})}>
              Save default
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Specificity rules">
        <s-stack direction="block" gap="base">
          {data.rules.length ? (
            data.rules.map((rule) => (
              <s-box key={rule.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-200">
                  <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                    <s-heading>
                      {rule.name} · {rule.multiplier}×
                      {!rule.active ? " (inactive)" : ""}
                    </s-heading>
                    <s-badge>{rule.specificity} condition{rule.specificity === 1 ? "" : "s"}</s-badge>
                  </s-stack>
                  <s-paragraph>
                    {rule.conditions
                      .map((item) => `${item.optionType}: ${item.optionValue}`)
                      .join(" · ")}
                  </s-paragraph>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="delete-rule" />
                    <input type="hidden" name="id" value={rule.id} />
                    <s-button
                      type="submit"
                      tone="critical"
                      variant="tertiary"
                      {...(pending === "delete-rule" && fetcher.formData?.get("id") === rule.id
                        ? { loading: true }
                        : {})}
                    >
                      Delete
                    </s-button>
                  </fetcher.Form>
                </s-stack>
              </s-box>
            ))
          ) : (
            <s-paragraph>No specificity rules yet. Add one below (e.g. Natural Diamond → 2.5×).</s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Add rule">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create-rule" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="name"
              label="Rule name (optional)"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              details="Leave blank to auto-name from conditions."
            />
            <s-text-field
              name="multiplier"
              label="Multiplier"
              value={multiplier}
              onChange={(event) => setMultiplier(event.currentTarget.value)}
              details="Example: 2.5 charges 2.5× the Gemist price. 3 = 3×."
            />
            <s-stack direction="block" gap="small-200">
              <s-heading>Conditions (all must match)</s-heading>
              <s-paragraph>
                Common part types: {data.optionTypes.slice(0, 6).join(", ")}, …
              </s-paragraph>
              {draft.map((row, index) => (
                <s-stack key={`cond-${index}`} direction="inline" gap="base" alignItems="end">
                  <s-text-field
                    name="conditionType"
                    label="Part type"
                    value={row.optionType}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setDraft((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, optionType: value } : item)),
                      );
                    }}
                    details={index === 0 ? 'Example: "Stone Type" or "Metal Color"' : undefined}
                  />
                  <s-text-field
                    name="conditionValue"
                    label="Part value"
                    value={row.optionValue}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setDraft((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, optionValue: value } : item)),
                      );
                    }}
                    details={index === 0 ? 'Example: "Natural Diamond" or "18K White Gold"' : undefined}
                  />
                  {draft.length > 1 ? (
                    <s-button
                      type="button"
                      variant="tertiary"
                      onClick={() => setDraft((prev) => prev.filter((_, i) => i !== index))}
                    >
                      Remove
                    </s-button>
                  ) : null}
                </s-stack>
              ))}
              <s-button
                type="button"
                variant="secondary"
                onClick={() =>
                  setDraft((prev) => [...prev, { optionType: "Metal Color", optionValue: "" }])
                }
              >
                Add part condition
              </s-button>
            </s-stack>
            <s-button type="submit" variant="primary" {...(pending === "create-rule" ? { loading: true } : {})}>
              Save rule
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
