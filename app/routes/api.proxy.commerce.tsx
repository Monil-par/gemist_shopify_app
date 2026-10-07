import type { LoaderFunctionArgs } from "react-router";
import { authenticateAppProxy } from "../lib/app-proxy.server";
import { getMerchantSettings } from "../models/merchant-settings.server";
import { getSavedWidgetStyles } from "../models/widget-styles.server";
import { storefrontAccess } from "../lib/access.server";
import { isAppointmentsEnabled } from "../lib/features.server";
import { listActiveMarkupRules } from "../models/markup-rules.server";

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

const empty = {
  apiBaseUrl: "",
  markupPercent: 0,
  appointmentUrl: "",
  appointmentEmail: "",
  appointmentLabel: "Schedule an Appointment",
  styles: null as unknown,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("[gemist commerce] received proxy request:", request.url);
  let shop = "";
  let admin:
    | {
        graphql: (
          query: string,
          options?: { variables?: unknown },
        ) => Promise<Response>;
      }
    | undefined;

  try {
    const context = await authenticateAppProxy(request);
    shop = context.shop;
    admin = context.admin;
  } catch (error) {
    console.error("[gemist commerce] auth failed", error);
    return json(empty);
  }

  const access = await storefrontAccess(shop, request);
  if (!access.allowed) {
    return json({ ...empty, licenseInactive: true });
  }

  let settings = {
    apiBaseUrl: "",
    markupPercent: 0,
    appointmentUrl: "",
    appointmentEmail: "",
    appointmentLabel: "Schedule an Appointment",
  };

  try {
    if (shop) {
      settings = await getMerchantSettings(shop);
    }
  } catch (error) {
    console.error("[gemist commerce] failed to load merchant settings", error);
  }

  let styles = null;
  if (admin) {
    try {
      styles = await getSavedWidgetStyles(admin);
    } catch (error) {
      console.warn("[gemist commerce] could not load widget styles", error);
    }
  }

  const appointments = isAppointmentsEnabled();
  let markupRules: Array<{
    id: string;
    name: string;
    multiplier: number;
    conditions: Array<{ optionType: string; optionValue: string }>;
    specificity: number;
  }> = [];
  try {
    if (shop) {
      const rules = await listActiveMarkupRules(shop);
      markupRules = rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        multiplier: rule.multiplier,
        conditions: rule.conditions,
        specificity: rule.specificity,
      }));
    }
  } catch (error) {
    console.warn("[gemist commerce] markup rules unavailable", error);
  }

  return json({
    apiBaseUrl: settings.apiBaseUrl,
    markupPercent: settings.markupPercent,
    markupRules,
    appointmentUrl: appointments ? settings.appointmentUrl : "",
    appointmentEmail: appointments ? settings.appointmentEmail : "",
    appointmentLabel: appointments ? settings.appointmentLabel : "",
    appointmentsEnabled: appointments,
    styles,
    ...(access.previewOnly ? { previewOnly: true } : {}),
  });
};
