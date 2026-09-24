/**
 * Register a storefront widget here and it automatically appears in
 * Admin → Widgets with live preview and size/color controls.
 */

export type FieldType = "range" | "color" | "select" | "textarea";

export type StyleField = {
  id: string;
  label: string;
  type: FieldType;
  cssVar?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  default: string | number;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  group?: "typography" | "layout" | "specs" | "colors" | "advanced";
};

export type WidgetId = "products" | "detail";

export type WidgetInstallTarget = "collection" | "home";

export type WidgetDefinition = {
  id: WidgetId;
  name: string;
  handle: string;
  description: string;
  placement: string;
  installTarget: WidgetInstallTarget;
  previewTone: "mint" | "sky" | "sand" | "lilac";
  fields: StyleField[];
};

export type WidgetStyles = Record<WidgetId, Record<string, string | number>>;

const colors: StyleField[] = [
  {
    id: "background",
    label: "Card background",
    type: "color",
    cssVar: "--gemist-setting-bg",
    default: "#ffffff",
    group: "colors",
  },
  {
    id: "textColor",
    label: "Text color",
    type: "color",
    cssVar: "--gemist-setting-text",
    default: "#1a1a1a",
    group: "colors",
  },
  {
    id: "accentColor",
    label: "Accent / price color",
    type: "color",
    cssVar: "--gemist-setting-accent",
    default: "#1f6feb",
    group: "colors",
  },
];

export const WIDGETS: WidgetDefinition[] = [
  {
    id: "products",
    name: "Product grid",
    handle: "gemist-products",
    description:
      "Show the Gemist catalog on collection or home pages with images, prices, View product, and Customize.",
    placement: "Collection / Home",
    installTarget: "collection",
    previewTone: "mint",
    fields: [
      {
        id: "headingFontSize",
        label: "Heading font size",
        type: "range",
        cssVar: "--gemist-heading-size",
        unit: "px",
        min: 16,
        max: 48,
        step: 1,
        default: 28,
        group: "typography",
      },
      {
        id: "titleFontSize",
        label: "Card title font size",
        type: "range",
        cssVar: "--gemist-title-size",
        unit: "px",
        min: 12,
        max: 28,
        step: 1,
        default: 16,
        group: "typography",
      },
      {
        id: "bodyFontSize",
        label: "Card body font size",
        type: "range",
        cssVar: "--gemist-body-size",
        unit: "px",
        min: 10,
        max: 20,
        step: 1,
        default: 13,
        group: "typography",
      },
      {
        id: "priceFontSize",
        label: "Price font size",
        type: "range",
        cssVar: "--gemist-price-size",
        unit: "px",
        min: 12,
        max: 28,
        step: 1,
        default: 15,
        group: "typography",
      },
      {
        id: "imageSize",
        label: "Image height",
        type: "range",
        cssVar: "--gemist-image-size",
        unit: "px",
        min: 120,
        max: 420,
        step: 4,
        default: 220,
        group: "layout",
      },
      {
        id: "cardMaxWidth",
        label: "Card max width",
        type: "range",
        cssVar: "--gemist-card-max-width",
        unit: "px",
        min: 160,
        max: 480,
        step: 4,
        default: 280,
        group: "layout",
      },
      {
        id: "cardPadding",
        label: "Card padding",
        type: "range",
        cssVar: "--gemist-card-padding",
        unit: "px",
        min: 8,
        max: 36,
        step: 1,
        default: 16,
        group: "layout",
      },
      {
        id: "cardRadius",
        label: "Card corner radius",
        type: "range",
        cssVar: "--gemist-setting-radius",
        unit: "px",
        min: 0,
        max: 32,
        step: 1,
        default: 16,
        group: "layout",
      },
      {
        id: "gridGap",
        label: "Gap between cards",
        type: "range",
        cssVar: "--gemist-gap",
        unit: "px",
        min: 4,
        max: 40,
        step: 1,
        default: 16,
        group: "layout",
      },
      {
        id: "columns",
        label: "Columns",
        type: "select",
        cssVar: "--gemist-cols",
        default: "3",
        group: "layout",
        options: [
          { value: "2", label: "2 columns" },
          { value: "3", label: "3 columns" },
          { value: "4", label: "4 columns" },
        ],
      },
      {
        id: "customCss",
        label: "Custom CSS",
        type: "textarea",
        default: "",
        group: "advanced",
        placeholder: ".gemist-products__heading {\n  letter-spacing: 0.12em;\n}\n\n.gemist-product-card__title {\n  text-transform: uppercase;\n}",
        hint: "Styles apply to the product grid on collection and home pages. Use Gemist class names; @media queries are supported.",
      },
      ...colors,
    ],
  },
  {
    id: "detail",
    name: "Product & Designer",
    handle: "gemist-products",
    description:
      "Product detail and native Designer: gallery, options, appointment, engraving, and Add to cart.",
    placement: "Opens from the product grid",
    installTarget: "collection",
    previewTone: "sky",
    fields: [
      {
        id: "titleFontSize",
        label: "Title font size",
        type: "range",
        cssVar: "--gemist-detail-title-size",
        unit: "px",
        min: 32,
        max: 56,
        step: 1,
        default: 48,
        group: "typography",
      },
      {
        id: "bodyFontSize",
        label: "Description font size",
        type: "range",
        cssVar: "--gemist-detail-body-size",
        unit: "px",
        min: 14,
        max: 20,
        step: 1,
        default: 17,
        group: "typography",
      },
      {
        id: "priceFontSize",
        label: "Price font size",
        type: "range",
        cssVar: "--gemist-detail-price-size",
        unit: "px",
        min: 22,
        max: 36,
        step: 1,
        default: 30,
        group: "typography",
      },
      {
        id: "imageSize",
        label: "Main image size",
        type: "range",
        cssVar: "--gemist-detail-image-size",
        unit: "px",
        min: 320,
        max: 640,
        step: 4,
        default: 520,
        group: "layout",
      },
      {
        id: "thumbSize",
        label: "Thumbnail size",
        type: "range",
        cssVar: "--gemist-detail-thumb-size",
        unit: "px",
        min: 72,
        max: 88,
        step: 1,
        default: 80,
        group: "layout",
      },
      {
        id: "cardPadding",
        label: "Content spacing",
        type: "range",
        cssVar: "--gemist-detail-gap",
        unit: "px",
        min: 8,
        max: 32,
        step: 1,
        default: 16,
        group: "layout",
      },
      {
        id: "cardRadius",
        label: "Image corner radius",
        type: "range",
        cssVar: "--gemist-detail-radius",
        unit: "px",
        min: 0,
        max: 28,
        step: 1,
        default: 14,
        group: "layout",
      },
      {
        id: "specsHeadingSize",
        label: "Section heading size",
        type: "range",
        cssVar: "--gemist-detail-specs-heading-size",
        unit: "px",
        min: 10,
        max: 16,
        step: 1,
        default: 12,
        group: "specs",
      },
      {
        id: "specsLabelSize",
        label: "Label font size",
        type: "range",
        cssVar: "--gemist-detail-specs-label-size",
        unit: "px",
        min: 11,
        max: 18,
        step: 1,
        default: 14,
        group: "specs",
      },
      {
        id: "specsValueSize",
        label: "Value font size",
        type: "range",
        cssVar: "--gemist-detail-specs-value-size",
        unit: "px",
        min: 12,
        max: 20,
        step: 1,
        default: 16,
        group: "specs",
      },
      {
        id: "specsRowGap",
        label: "Row spacing",
        type: "range",
        cssVar: "--gemist-detail-specs-row-gap",
        unit: "px",
        min: 4,
        max: 24,
        step: 1,
        default: 12,
        group: "specs",
      },
      {
        id: "specsColumnGap",
        label: "Column gap",
        type: "range",
        cssVar: "--gemist-detail-specs-column-gap",
        unit: "px",
        min: 16,
        max: 48,
        step: 2,
        default: 32,
        group: "specs",
      },
      {
        id: "specsSectionGap",
        label: "Section top spacing",
        type: "range",
        cssVar: "--gemist-detail-specs-section-gap",
        unit: "px",
        min: 16,
        max: 64,
        step: 2,
        default: 40,
        group: "specs",
      },
      {
        id: "specsColumns",
        label: "Grid columns",
        type: "select",
        cssVar: "--gemist-detail-specs-columns",
        default: "2",
        group: "specs",
        options: [
          { value: "1", label: "1 column" },
          { value: "2", label: "2 columns" },
        ],
      },
      {
        id: "customCss",
        label: "Custom CSS",
        type: "textarea",
        default: "",
        group: "advanced",
        placeholder: ".gemist-detail__title {\n  font-family: Georgia, serif;\n}\n\n.gemist-detail__price {\n  letter-spacing: 0.04em;\n}",
        hint: "Styles apply to the product detail and designer pages. Use Gemist class names; @media queries are supported.",
      },
      ...colors,
    ],
  },
];

export const CUSTOM_CSS_STYLE_IDS: Record<WidgetId, string> = {
  products: "gemist-custom-css-products",
  detail: "gemist-custom-css-detail",
};

const CUSTOM_CSS_MAX_LENGTH = 12_000;

/** Strip dangerous patterns from merchant-supplied CSS before save or injection. */
export function sanitizeCustomCss(input: unknown): string {
  if (typeof input !== "string") return "";
  let css = input.trim();
  if (!css) return "";
  css = css.replace(/<\/style/gi, "");
  css = css.replace(/<script/gi, "");
  css = css.replace(/javascript:/gi, "");
  css = css.replace(/expression\s*\(/gi, "");
  return css.slice(0, CUSTOM_CSS_MAX_LENGTH);
}

export function customCssForWidget(
  widgetId: WidgetId,
  styles: WidgetStyles,
): string {
  return sanitizeCustomCss(styles[widgetId]?.customCss);
}

export const DEFAULT_WIDGET_STYLES: WidgetStyles = Object.fromEntries(
  WIDGETS.map((widget) => [
    widget.id,
    Object.fromEntries(widget.fields.map((field) => [field.id, field.default])),
  ]),
) as WidgetStyles;

export function widgetById(id: string) {
  return WIDGETS.find((widget) => widget.id === id) ?? WIDGETS[0];
}

export function mergeWidgetStyles(saved: unknown): WidgetStyles {
  const incoming =
    saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const next = structuredClone(DEFAULT_WIDGET_STYLES);

  for (const widget of WIDGETS) {
    const values = incoming[widget.id];
    if (!values || typeof values !== "object") continue;
    for (const field of widget.fields) {
      const value = (values as Record<string, unknown>)[field.id];
      if (value === undefined || value === null) continue;
      if (field.type === "textarea") {
        next[widget.id][field.id] = sanitizeCustomCss(value);
        continue;
      }
      if (value === "") continue;
      if (field.type === "range") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) continue;
        const min = field.min ?? numeric;
        const max = field.max ?? numeric;
        next[widget.id][field.id] = Math.min(max, Math.max(min, numeric));
        continue;
      }
      next[widget.id][field.id] = value as string | number;
    }
  }

  return next;
}

export function cssVarsFor(
  widget: WidgetDefinition,
  values: Record<string, string | number>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const field of widget.fields) {
    if (!field.cssVar) continue;
    const raw = values[field.id] ?? field.default;
    vars[field.cssVar] = field.unit ? `${raw}${field.unit}` : String(raw);
  }
  return vars;
}

export function stylesToCss(styles: WidgetStyles) {
  const selectors: Record<WidgetId, string> = {
    products: "[data-gemist-catalog]",
    detail: ".gemist-detail, .gemist-designer-page",
  };

  return WIDGETS.map((widget) => {
    const vars = cssVarsFor(widget, styles[widget.id]);
    const body = Object.entries(vars)
      .map(([name, value]) => `  ${name}: ${value};`)
      .join("\n");
    return `${selectors[widget.id]} {\n${body}\n}`;
  }).join("\n\n");
}
