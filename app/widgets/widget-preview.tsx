import { memo, type CSSProperties, type Ref } from "react";
import {
  cssVarsFor,
  customCssForWidget,
  widgetById,
  type WidgetId,
  type WidgetStyles,
} from "./registry";

const PREVIEW_CUSTOM_CSS_ID = "gemist-preview-custom-css";

const SAMPLE = {
  title: "Bezel",
  price: "$5,635",
  body: "3mm Full Eternity 14K Yellow Gold Natural Diamond",
  badge: "Classique",
};

const SAMPLE_SPECS = [
  ["Metal", "14K Gold"],
  ["Shape", "Round"],
  ["Stone", "Natural Diamond"],
  ["Style", "Eternity"],
  ["Coverage", "Full"],
  ["Ring size", "6"],
];

export function buildPreviewStyle(
  widgetId: WidgetId,
  styles: WidgetStyles,
): CSSProperties {
  if (widgetId === "detail") return buildDetailPreviewStyle(styles.detail);
  return buildProductsPreviewStyle(styles.products);
}

export function applyPreviewStyle(
  element: HTMLElement | null,
  widgetId: WidgetId,
  styles: WidgetStyles,
) {
  if (!element) return;
  const next = buildPreviewStyle(widgetId, styles);
  for (const [name, value] of Object.entries(next)) {
    if (value == null || value === "") continue;
    element.style.setProperty(name, String(value));
  }
  applyPreviewCustomCss(widgetId, styles);
}

function applyPreviewCustomCss(widgetId: WidgetId, styles: WidgetStyles) {
  const css = customCssForWidget(widgetId, styles);
  let el = document.getElementById(PREVIEW_CUSTOM_CSS_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = PREVIEW_CUSTOM_CSS_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function buildProductsPreviewStyle(
  products: Record<string, string | number>,
): CSSProperties {
  const style = cssVarsFor(widgetById("products"), products) as CSSProperties;
  const imageSize = Number(products.imageSize || 220);
  const previewImage = Math.round(Math.min(160, Math.max(96, imageSize * 0.55)));
  return {
    ...style,
    ["--gemist-preview-card-image" as string]: `${previewImage}px`,
  };
}

function buildDetailPreviewStyle(
  detail: Record<string, string | number>,
): CSSProperties {
  const style = cssVarsFor(widgetById("detail"), detail) as CSSProperties;
  const imageSize = Number(detail.imageSize || 520);
  const thumbSize = Number(detail.thumbSize || 80);
  const titleSize = Number(detail.titleFontSize || 48);
  const bodySize = Number(detail.bodyFontSize || 17);
  const priceSize = Number(detail.priceFontSize || 30);
  const radius = Number(detail.cardRadius || 18);

  const previewImage = Math.round(Math.min(280, Math.max(160, imageSize * 0.42)));
  const previewThumb = Math.round(Math.min(72, Math.max(48, thumbSize * 0.75)));
  const previewTitle = Math.round(Math.min(40, Math.max(24, titleSize * 0.72)));
  const previewBody = Math.round(Math.min(15, Math.max(12, bodySize * 0.85)));
  const previewPrice = Math.round(Math.min(26, Math.max(18, priceSize * 0.78)));
  const specsHeading = Math.round(
    Math.min(11, Math.max(8, Number(detail.specsHeadingSize || 12) * 0.72)),
  );
  const specsLabel = Math.round(
    Math.min(12, Math.max(9, Number(detail.specsLabelSize || 14) * 0.72)),
  );
  const specsValue = Math.round(
    Math.min(13, Math.max(10, Number(detail.specsValueSize || 16) * 0.72)),
  );
  const specsColumns = Number(detail.specsColumns || 2);

  return {
    ...style,
    ["--gemist-preview-image" as string]: `${previewImage}px`,
    ["--gemist-preview-thumb" as string]: `${previewThumb}px`,
    ["--gemist-detail-title-size" as string]: `${previewTitle}px`,
    ["--gemist-detail-body-size" as string]: `${previewBody}px`,
    ["--gemist-detail-price-size" as string]: `${previewPrice}px`,
    ["--gemist-detail-radius" as string]: `${radius}px`,
    ["--gemist-detail-specs-heading-size" as string]: `${specsHeading}px`,
    ["--gemist-detail-specs-label-size" as string]: `${specsLabel}px`,
    ["--gemist-detail-specs-value-size" as string]: `${specsValue}px`,
    ["--gemist-detail-specs-columns" as string]: String(specsColumns),
  };
}

type PreviewProps = {
  widgetId: WidgetId;
  styles: WidgetStyles;
  rootRef?: Ref<HTMLDivElement>;
};

export const WidgetPreview = memo(function WidgetPreview({
  widgetId,
  styles,
  rootRef,
}: PreviewProps) {
  if (widgetId === "detail") {
    return <DetailPreview styles={styles} rootRef={rootRef} />;
  }
  return <ProductsPreview styles={styles} rootRef={rootRef} />;
});

function ProductsPreview({
  styles,
  rootRef,
}: {
  styles: WidgetStyles;
  rootRef?: Ref<HTMLDivElement>;
}) {
  const style = buildProductsPreviewStyle(styles.products);
  const columns = Math.min(4, Math.max(2, Number(styles.products.columns || 3)));

  return (
    <div className="gemist-studio-preview" ref={rootRef} style={style}>
      <p className="gemist-studio-kicker">Home / Collection</p>
      <h3 className="gemist-studio-heading">All products</h3>
      <div
        className="gemist-studio-grid"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: columns }).map((_, index) => (
          <article key={index} className="gemist-studio-card">
            <div className="gemist-studio-image" />
            <div className="gemist-studio-card-body">
              <strong className="gemist-studio-title">{SAMPLE.title}</strong>
              <p className="gemist-studio-body">{SAMPLE.body}</p>
              <p className="gemist-studio-price">{SAMPLE.price}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function DetailPreview({
  styles,
  rootRef,
}: {
  styles: WidgetStyles;
  rootRef?: Ref<HTMLDivElement>;
}) {
  const style = buildDetailPreviewStyle(styles.detail);

  return (
    <div
      className="gemist-studio-preview gemist-studio-preview--detail"
      ref={rootRef}
      style={style}
    >
      <p className="gemist-studio-detail-back">
        <span aria-hidden="true">←</span> Back to products
      </p>
      <div className="gemist-studio-detail">
        <div className="gemist-studio-detail-media">
          <div className="gemist-studio-hero-frame">
            <div className="gemist-studio-hero" />
          </div>
          <div className="gemist-studio-thumbs">
            <span />
            <span data-active="true" />
            <span />
          </div>
        </div>

        <div className="gemist-studio-detail-info">
          <p className="gemist-studio-detail-eyebrow">{SAMPLE.badge}</p>
          <h3 className="gemist-studio-detail-title">{SAMPLE.title}</h3>
          <p className="gemist-studio-detail-price">{SAMPLE.price}</p>
          <p className="gemist-studio-detail-body">{SAMPLE.body}</p>

          <div className="gemist-studio-detail-meta">
            <h4 className="gemist-studio-detail-section-title">Product information</h4>
            <dl>
              <div>
                <dt>Customer SKU</dt>
                <dd>Z1104B1.35Y64</dd>
              </div>
            </dl>
          </div>

          <div className="gemist-studio-detail-actions">
            <span className="gemist-studio-detail-btn gemist-studio-detail-btn--primary">
              Add to cart
            </span>
            <span className="gemist-studio-detail-btn gemist-studio-detail-btn--secondary">
              Customize your ring
            </span>
            <span className="gemist-studio-detail-btn gemist-studio-detail-btn--link">
              Schedule an appointment →
            </span>
          </div>

          <div className="gemist-studio-detail-specs">
            <h4 className="gemist-studio-detail-section-title">Product details</h4>
            <ul className="gemist-studio-specs">
              {SAMPLE_SPECS.map(([label, value]) => (
                <li key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
