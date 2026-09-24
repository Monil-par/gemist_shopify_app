import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  getWidgetStyles,
  saveWidgetStyles,
} from "../models/widget-styles.server";
import {
  DEFAULT_WIDGET_STYLES,
  WIDGETS,
  mergeWidgetStyles,
  widgetById,
  type StyleField,
  type WidgetDefinition,
  type WidgetId,
  type WidgetInstallTarget,
  type WidgetStyles,
} from "../widgets/registry";
import { WidgetPreview, applyPreviewStyle } from "../widgets/widget-preview";
import { ShopBanner } from "../components/shop-banner";
import { getShopProfile } from "../lib/shop-profile.server";
import studioStyles from "../widgets/studio.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: studioStyles },
];

type ActionData = { ok: true } | { ok: false; error: string };

type InstallUrls = Record<WidgetInstallTarget, string>;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [styles, profile] = await Promise.all([
    getWidgetStyles(admin),
    getShopProfile(admin, session.shop),
  ]);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const editorBase = `https://${session.shop}/admin/themes/current/editor`;

  const installUrls: InstallUrls = {
    collection: `${editorBase}?template=collection&addAppBlockId=${apiKey}/gemist-products&target=newAppsSection`,
    home: `${editorBase}?template=index&addAppBlockId=${apiKey}/gemist-products&target=newAppsSection`,
  };

  return { styles, profile, installUrls };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  try {
    const styles = mergeWidgetStyles(
      JSON.parse(String(formData.get("styles") || "{}")),
    );
    await saveWidgetStyles(admin, styles);
    return { ok: true } satisfies ActionData;
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not save widget styles.",
    } satisfies ActionData;
  }
};

const FIELD_GROUPS: {
  id: NonNullable<StyleField["group"]>;
  label: string;
}[] = [
  { id: "typography", label: "Typography" },
  { id: "layout", label: "Size & spacing" },
  { id: "specs", label: "Product details" },
  { id: "colors", label: "Colors" },
  { id: "advanced", label: "Custom CSS" },
];

function groupFields(fields: StyleField[]) {
  return FIELD_GROUPS.map((group) => ({
    ...group,
    fields: fields.filter((field) => (field.group || "layout") === group.id),
  })).filter((group) => group.fields.length > 0);
}

function clampRange(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function RangeControl({
  field,
  value,
  onChange,
}: {
  field: StyleField;
  value: string | number;
  onChange: (value: number) => void;
}) {
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  const step = field.step ?? 1;
  const external = clampRange(Number(value), min, max);
  const [current, setCurrent] = useState(external);
  const draggingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!draggingRef.current) {
      setCurrent(external);
    }
  }, [external]);

  const setProgress = (next: number) => {
    const percent = ((next - min) / Math.max(max - min, 1)) * 100;
    inputRef.current?.style.setProperty("--range-progress", `${percent}%`);
  };

  useEffect(() => {
    setProgress(current);
  }, [current, min, max]);

  const handleInput = (nextRaw: number) => {
    const next = clampRange(nextRaw, min, max);
    setCurrent(next);
    setProgress(next);
    onChange(next);
  };

  return (
    <label className="gemist-studio-option">
      <span className="gemist-studio-option__label">
        {field.label}
        <span className="gemist-studio-option__value">
          {current}
          {field.unit}
        </span>
      </span>
      <input
        ref={inputRef}
        className="gemist-studio-option__range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onPointerDown={() => {
          draggingRef.current = true;
        }}
        onPointerUp={() => {
          draggingRef.current = false;
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
        onInput={(event) => handleInput(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function StyleFieldControl({
  field,
  value,
  onChange,
}: {
  field: StyleField;
  value: string | number;
  onChange: (value: string | number) => void;
}) {
  if (field.type === "color") {
    return (
      <label className="gemist-studio-option gemist-studio-option--color">
        <span className="gemist-studio-option__label">{field.label}</span>
        <span className="gemist-studio-option__color">
          <input
            type="color"
            value={String(value)}
            onInput={(event) => onChange(event.currentTarget.value)}
          />
          <span className="gemist-studio-option__hex">{String(value)}</span>
        </span>
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <label className="gemist-studio-option">
        <span className="gemist-studio-option__label">{field.label}</span>
        <select
          className="gemist-studio-option__select"
          value={String(value)}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.type === "textarea") {
    return (
      <CustomCssControl
        field={field}
        value={String(value ?? "")}
        onChange={onChange}
      />
    );
  }

  return (
    <RangeControl
      field={field}
      value={value}
      onChange={(next) => onChange(next)}
    />
  );
}

function CustomCssControl({
  field,
  value,
  onChange,
}: {
  field: StyleField;
  value: string;
  onChange: (value: string) => void;
}) {
  const lines = value ? value.split("\n").length : 0;

  return (
    <div className="gemist-studio-css">
      {field.hint ? <p className="gemist-studio-css__intro">{field.hint}</p> : null}
      <div className="gemist-studio-css__editor">
        <div className="gemist-studio-css__editor-bar">
          <span className="gemist-studio-css__badge">CSS</span>
          <span className="gemist-studio-css__meta">
            {lines > 0 ? `${lines} line${lines === 1 ? "" : "s"}` : "Optional"}
          </span>
        </div>
        <textarea
          className="gemist-studio-css__textarea"
          rows={10}
          spellCheck={false}
          aria-label={field.label}
          placeholder={field.placeholder}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </div>
    </div>
  );
}

function WidgetCardPreview({ widget }: { widget: WidgetDefinition }) {
  if (widget.id === "detail") {
    return (
      <div className="gemist-widget-mini">
        <div className="gemist-widget-mini__bar">
          <span className="gemist-widget-mini__swatch" />
          <div className="gemist-widget-mini__lines">
            <span className="gemist-widget-mini__line" />
            <span className="gemist-widget-mini__line gemist-widget-mini__line--mid" />
          </div>
        </div>
        <p className="gemist-widget-mini__price">$5,635</p>
        <div className="gemist-widget-mini__chips">
          <span className="gemist-widget-mini__chip" data-on="true" />
          <span className="gemist-widget-mini__chip" />
          <span className="gemist-widget-mini__chip" />
        </div>
        <div className="gemist-widget-mini__cta" />
      </div>
    );
  }

  return (
    <div className="gemist-widget-mini gemist-widget-mini--wide">
      <div className="gemist-widget-mini-grid">
        {Array.from({ length: 3 }).map((_, index) => (
          <article key={index}>
            <div className="gemist-widget-mini-grid__img" />
            <div className="gemist-widget-mini-grid__body">
              <span className="gemist-widget-mini__line gemist-widget-mini__line--mid" />
              <span className="gemist-widget-mini__line gemist-widget-mini__line--short" />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export default function WidgetsPage() {
  const { styles: savedStyles, profile, installUrls } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [activeId, setActiveId] = useState<WidgetId | null>(null);
  const [styles, setStyles] = useState<WidgetStyles>(savedStyles);
  const previewRef = useRef<HTMLDivElement>(null);
  const widget = activeId ? widgetById(activeId) : null;
  const values = activeId ? styles[activeId] : null;

  const isSaving = fetcher.state !== "idle";
  const dirty = useMemo(
    () => JSON.stringify(styles) !== JSON.stringify(savedStyles),
    [styles, savedStyles],
  );

  useEffect(() => {
    setStyles(savedStyles);
  }, [savedStyles]);

  useEffect(() => {
    if (!fetcher.data || !("ok" in fetcher.data) || !fetcher.data.ok) return;
    shopify.toast.show(
      "Styles saved for this store. Refresh the storefront to see them.",
    );
  }, [fetcher.data, shopify]);

  const setField = (id: string, value: string | number) => {
    if (!activeId) return;
    setStyles((current) => {
      const next = {
        ...current,
        [activeId]: {
          ...current[activeId],
          [id]: value,
        },
      };
      applyPreviewStyle(previewRef.current, activeId, next);
      return next;
    });
  };

  useEffect(() => {
    if (!activeId) return;
    applyPreviewStyle(previewRef.current, activeId, styles);
  }, [activeId]);

  if (activeId && widget && values) {
    return (
      <s-page heading="Customize widget">
        <ShopBanner shopName={profile.name} shopDomain={profile.domain} />
        <s-section>
          <s-stack direction="inline" gap="base">
            <s-button
              type="button"
              variant="tertiary"
              onClick={() => setActiveId(null)}
            >
              Back to widgets
            </s-button>
            <s-button href={installUrls[widget.installTarget]} target="_blank">
              Install in theme
            </s-button>
          </s-stack>
        </s-section>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            fetcher.submit(
              { styles: JSON.stringify(styles) },
              { method: "post" },
            );
          }}
        >
          <div className="gemist-widget-customize">
            <section className="gemist-widget-customize__preview">
              <WidgetPreview
                widgetId={activeId}
                styles={styles}
                rootRef={previewRef}
              />
            </section>

            <section className="gemist-widget-customize__controls">
              <div className="gemist-studio-panel-head">
                <h2 className="gemist-studio-panel-title">{widget.name}</h2>
                <p className="gemist-studio-panel-copy">{widget.description}</p>
              </div>

              {groupFields(widget.fields).map((group) => (
                <div
                  key={group.id}
                  className={`gemist-studio-group${
                    group.id === "advanced" ? " gemist-studio-group--advanced" : ""
                  }`}
                >
                  <h3 className="gemist-studio-group__title">{group.label}</h3>
                  <div className="gemist-studio-group__body">
                    {group.fields.map((field) => (
                      <StyleFieldControl
                        key={field.id}
                        field={field}
                        value={values[field.id]}
                        onChange={(next) => setField(field.id, next)}
                      />
                    ))}
                  </div>
                </div>
              ))}

              <div className="gemist-studio-panel-actions">
                <s-button
                  type="submit"
                  variant="primary"
                  {...(isSaving ? { loading: true } : {})}
                  {...(!dirty && !isSaving ? { disabled: true } : {})}
                >
                  Save styles
                </s-button>
                <s-button
                  type="button"
                  variant="tertiary"
                  onClick={() =>
                    setStyles((current) => {
                      const next = {
                        ...current,
                        [activeId]: { ...DEFAULT_WIDGET_STYLES[activeId] },
                      };
                      applyPreviewStyle(previewRef.current, activeId, next);
                      return next;
                    })
                  }
                >
                  Reset
                </s-button>
              </div>
              {fetcher.data && "ok" in fetcher.data && !fetcher.data.ok ? (
                <s-banner tone="critical">{fetcher.data.error}</s-banner>
              ) : null}
            </section>
          </div>
        </form>
      </s-page>
    );
  }

  return (
    <s-page heading="Widgets">
      <ShopBanner shopName={profile.name} shopDomain={profile.domain} />
      <s-section heading="Storefront widgets">
        <s-paragraph>
          Install the product grid in the theme, then customize fonts, colors,
          and sizes for this store.
        </s-paragraph>
      </s-section>

      <s-section>
        <div className="gemist-widget-library">
          {WIDGETS.map((item) => (
            <s-box
              key={item.id}
              padding="none"
              borderWidth="base"
              borderRadius="base"
              background="base"
            >
              <article className="gemist-widget-card gemist-widget-card--boxed">
                <div
                  className="gemist-widget-card__preview"
                  data-tone={item.previewTone}
                >
                  <WidgetCardPreview widget={item} />
                </div>
                <div className="gemist-widget-card__body">
                  <h3 className="gemist-widget-card__title">{item.name}</h3>
                  <p className="gemist-widget-card__copy">{item.description}</p>
                  <p className="gemist-widget-card__placement">{item.placement}</p>
                  <s-stack direction="inline" gap="base">
                    <s-button
                      href={installUrls[item.installTarget]}
                      target="_blank"
                      variant="secondary"
                    >
                      Install
                    </s-button>
                    <s-button
                      type="button"
                      variant="tertiary"
                      onClick={() => setActiveId(item.id)}
                    >
                      Customize
                    </s-button>
                  </s-stack>
                </div>
              </article>
            </s-box>
          ))}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
