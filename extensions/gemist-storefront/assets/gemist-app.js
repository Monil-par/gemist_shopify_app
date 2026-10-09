(() => {
  const DEFAULT_API_BASE = "https://classique.dev.gemist.co";
  const PRODUCTS_PROXY = "/apps/gemist/products";
  // The theme editor may preview the grid before the store has subscribed.
  const DESIGN_MODE = Boolean(window.Shopify && window.Shopify.designMode);
  function withPreview(url) {
    if (!DESIGN_MODE) return url;
    return `${url}${url.includes("?") ? "&" : "?"}preview=1`;
  }
  const PRODUCT_PARAM = "gemist_product";
  const SLUG_PARAM = "gemist_slug";
  const PAGE_PARAM = "gemist_page";
  const CUSTOMIZE_PARAM = "gemist_customize";
  const STORAGE_KEY = "gemist-product-cache-v5";
  const CATALOG_TTL_MS = 48 * 60 * 60 * 1000;
  const PAGE_CONCURRENCY = 1;
  const OPTION_ORDER = [
    "style",
    "metal",
    "metal_color",
    "stone",
    "shape",
    "ring_size",
    "coverage",
    "orientation",
    "band_width",
  ];
  // Gemist resolves parts in this order: values for a key depend only on
  // the keys before it. Do not reorder this to match the UI tab order.
  const PART_CHAIN = [
    "style",
    "shape",
    "orientation",
    "coverage",
    "metal",
    "metal_color",
    "band_width",
    "stone",
    "ring_size",
  ];
  const AVAILABILITY_STORAGE_KEY = "gemist-availability-v1";
  const PARTS_MAP_STORAGE_KEY = "gemist-parts-map-v1";
  const AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1000;
  const AVAILABILITY_MAX_ENTRIES = 400;
  // prefix key -> { map } once resolved, or a pending Promise.
  const availabilityMemory = new Map();
  let partsMapState = { map: null, promise: null };

  const commerce = {
    apiBaseUrl: "",
    markupPercent: 0,
    markupRules: [],
    appointmentsEnabled: false,
    appointmentUrl: "",
    appointmentEmail: "",
    appointmentLabel: "Schedule an Appointment",
  };

  function normalizePartKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function productPartsMap(product) {
    const parts = {};
    const sources = [
      product?.selectedProductParts,
      product?.productParts,
      product?.defaultProductMetadata,
      product?.manufacturerMetadata,
    ];
    if (product?.metal) parts["Metal Type"] = String(product.metal);
    const labels = {
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
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const [key, value] of Object.entries(source)) {
        if (value == null || value === "" || typeof value === "object") continue;
        const label =
          labels[key] ||
          (key.includes(" ")
            ? key
            : key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()));
        if (!parts[label]) parts[label] = String(value);
        if (!parts[key]) parts[key] = String(value);
      }
    }
    return parts;
  }

  /** Most-specific matching rule wins; else default markupPercent. */
  function resolveMarkupMultiplier(product) {
    const parts = productPartsMap(product);
    const partLookup = new Map(
      Object.entries(parts).map(([key, value]) => [normalizePartKey(key), normalizePartKey(value)]),
    );
    let best = null;
    for (const rule of commerce.markupRules || []) {
      const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
      if (!conditions.length) continue;
      const matches = conditions.every((condition) => {
        const have = partLookup.get(normalizePartKey(condition.optionType));
        return have != null && have === normalizePartKey(condition.optionValue);
      });
      if (!matches) continue;
      const specificity = Number(rule.specificity) || conditions.length;
      const multiplier = Number(rule.multiplier);
      if (!Number.isFinite(multiplier) || multiplier <= 0) continue;
      if (
        !best ||
        specificity > best.specificity ||
        (specificity === best.specificity && multiplier > best.multiplier)
      ) {
        best = { specificity, multiplier };
      }
    }
    if (best) return best.multiplier;
    return 1 + (Number(commerce.markupPercent) || 0) / 100;
  }
  const ENGRAVING_MAX_CHARS = 20;
  // Letters, numbers, spaces, and common engraving punctuation only.
  const ENGRAVING_ALLOWED_RE = /^[A-Za-z0-9 ,.'\-!?&]*$/;
  const DEFAULT_ENGRAVING_FONTS = ["Classic", "Serif", "Script", "Modern"];
  const designerState = {
    engraving: "",
    engravingEnabled: false,
    engravingFont: "Script",
    activeOptionKey: "",
    // Number of designer tabs the shopper may open; tabs unlock in order.
    unlockedCount: 1,
  };
  const catalogFilterState = {
    categories: new Set(),
    material: new Set(),
    designer: new Set(),
    price: new Set(),
    stone: new Set(),
  };

  const memory = {
    slugs: null,
    bySlug: {},
    byId: {},
    baseBySlug: {},
    inflight: new Map(),
  };

  readStorage();

  let commercePromise;
  let listening = false;
  let designerListening = false;

  function initApp(root) {
    if (licenseLocked) {
      root.hidden = true;
      return;
    }
    if (root.dataset.gemistReady === "true") return;
    root.dataset.gemistReady = "true";
    render(root);
    if (!listening) {
      listening = true;
      window.addEventListener("popstate", () => {
        document.querySelectorAll("[data-gemist-products]").forEach((node) => {
          if (node.dataset.gemistReady === "true") render(node);
        });
      });
    }
    ensureDesignerMessageListener();
  }

  function render(root) {
    const productId = queryParam(PRODUCT_PARAM);
    if (productId && queryParam(CUSTOMIZE_PARAM) === "1") {
      showDesigner(root, productId);
    } else if (productId) {
      showDetail(root, productId);
    } else {
      showCatalog(root);
    }
  }

  function setGemistPageMode(mode) {
    const rootEl = document.documentElement;
    const body = document.body;
    const modes = ["gemist-catalog-open", "gemist-detail-open", "gemist-designer-open"];
    modes.forEach((cls) => {
      rootEl.classList.remove(cls);
      body.classList.remove(cls);
    });
    if (mode === "catalog") {
      rootEl.classList.add("gemist-catalog-open");
      body.classList.add("gemist-catalog-open");
    } else if (mode === "detail") {
      rootEl.classList.add("gemist-detail-open");
      body.classList.add("gemist-detail-open");
    } else if (mode === "designer") {
      rootEl.classList.add("gemist-designer-open");
      body.classList.add("gemist-designer-open");
    }
  }

  async function showCatalog(root) {
    const catalog = root.querySelector("[data-gemist-catalog]");
    const detail = root.querySelector("[data-gemist-detail]");
    const designerPage = root.querySelector("[data-gemist-designer-page]");
    const status = root.querySelector("[data-gemist-products-status]");
    const grid = root.querySelector("[data-gemist-products-grid]");
    const pager = root.querySelector("[data-gemist-products-pager]");
    const filtersEl = root.querySelector("[data-gemist-filters]");
    if (!catalog || !detail || !status || !grid || !pager) return;

    catalog.hidden = false;
    detail.hidden = true;
    detail.replaceChildren();
    if (designerPage) {
      designerPage.hidden = true;
      designerPage.replaceChildren();
    }
    setGemistPageMode("catalog");

    const pageSize = Math.max(Number(root.dataset.limit) || 8, 1);
    const cardOptions = cardOptionsOf(root);
    const page = Math.max(Number(queryParam(PAGE_PARAM) || 1), 1);
    const showFilters = root.dataset.showFilters !== "false";

    catalog.querySelector("[data-gemist-retry]")?.remove();

    let allSlugs = Array.isArray(memory.slugs) ? memory.slugs.slice() : [];

    const paint = (nextSlugs) => {
      allSlugs = nextSlugs.slice();
      if (showFilters && filtersEl) {
        renderCatalogFilters(filtersEl, allSlugs, () => paint(allSlugs));
      } else if (filtersEl) {
        filtersEl.hidden = true;
        filtersEl.replaceChildren();
      }

      const filtered = showFilters
        ? filterCatalogSlugs(allSlugs)
        : allSlugs;
      const total = filtered.length;
      const pageCount = Math.max(Math.ceil(total / pageSize), 1);
      const safePage = Math.min(page, pageCount);
      const start = (safePage - 1) * pageSize;
      const pageSlugs = filtered.slice(start, start + pageSize);
      grid.replaceChildren();
      if (!pageSlugs.length) {
        status.hidden = false;
        status.textContent = root.dataset.emptyLabel || "No products found";
        grid.hidden = true;
        pager.hidden = true;
        return [];
      }
      pageSlugs.forEach((slug) => {
        const cached = memory.bySlug[slug];
        grid.appendChild(
          cached
            ? renderCard(cached, cardOptions, safePage)
            : renderSkeleton(slug),
        );
      });
      status.hidden = true;
      grid.hidden = false;
      renderPager(pager, safePage, pageCount, total, root);
      return pageSlugs;
    };

    if (allSlugs.length) {
      paint(allSlugs);
    }

    let slugs;
    try {
      const payload = await loadCatalogPage(pageSize, (page - 1) * pageSize);
      slugs = payload.slugs;
      (payload.products || []).forEach((product) =>
        cacheProduct(product, product.slug),
      );
      const warmBase = (payload.products || []).find((item) => item && item.baseProductId);
      if (warmBase && !cachedPartsMap()) {
        const warm = () => loadPartsMap(warmBase.baseProductId).catch(() => {});
        if ("requestIdleCallback" in window) window.requestIdleCallback(warm);
        else window.setTimeout(warm, 1500);
      }
    } catch (error) {
      if (licenseLocked) return;
      slugs = Array.isArray(memory.slugs) ? memory.slugs : [];
      if (!slugs.length) {
        status.hidden = false;
        status.textContent =
          (error instanceof Error && error.message) ||
          root.dataset.errorLabel ||
          "Could not load products";
        grid.hidden = true;
        pager.hidden = true;
        status.after(retryButton(root, () => showCatalog(root)));
        return;
      }
    }

    const pageSlugs = paint(slugs);
    if (!pageSlugs.length) return;

    const pageSet = new Set(pageSlugs);
    const fillCard = (slug, product) => {
      if (!pageSet.has(slug) || !product) return;
      const item = grid.querySelector(`[data-gemist-slug="${cssEscape(slug)}"]`);
      if (!item) return;
      const next = renderCard(product, cardOptions, page);
      item.replaceWith(next);
    };

    const missingPage = pageSlugs.filter((slug) => !memory.bySlug[slug]);
    await mapPool(missingPage, PAGE_CONCURRENCY, async (slug) => {
      const product = await loadStyleProduct(slug);
      fillCard(slug, product);
    });

    // Refresh filter counts once page products are hydrated.
    if (showFilters && filtersEl) {
      renderCatalogFilters(filtersEl, allSlugs, () => paint(allSlugs));
    }
  }

  function productCategory(product) {
    return (
      product.type ||
      product.subtype ||
      (product.productParts && product.productParts.coverage) ||
      "Rings"
    );
  }

  function productMaterial(product) {
    return (
      product.metal ||
      (product.selectedProductParts && product.selectedProductParts.metal) ||
      (product.productParts && product.productParts.metal) ||
      ""
    );
  }

  function productDesigner(product) {
    return product.vendor || product.style || "Gemist";
  }

  function productStone(product) {
    return (
      (product.selectedProductParts && product.selectedProductParts.stone) ||
      (product.productParts && product.productParts.stone) ||
      ""
    );
  }

  function productPriceAmount(product) {
    const raw = product.salePrice ?? product.price;
    const amount = typeof raw === "number" ? raw : parseFloat(raw);
    if (!Number.isFinite(amount)) return null;
    return amount * resolveMarkupMultiplier(product);
  }

  function productPriceBucket(product) {
    const amount = productPriceAmount(product);
    if (amount == null) return "";
    if (amount < 1000) return "Under $1,000";
    if (amount < 2000) return "$1,000 – $2,000";
    if (amount < 3500) return "$2,000 – $3,500";
    if (amount < 5000) return "$3,500 – $5,000";
    return "$5,000+";
  }

  function filterCatalogSlugs(slugs) {
    const active = catalogFilterState;
    const hasAny =
      active.categories.size ||
      active.material.size ||
      active.designer.size ||
      active.price.size ||
      active.stone.size;
    if (!hasAny) return slugs;

    return slugs.filter((slug) => {
      const product = memory.bySlug[slug];
      if (!product) return false;
      if (
        active.categories.size &&
        !active.categories.has(String(productCategory(product)))
      ) {
        return false;
      }
      if (
        active.material.size &&
        !active.material.has(String(productMaterial(product)))
      ) {
        return false;
      }
      if (
        active.designer.size &&
        !active.designer.has(String(productDesigner(product)))
      ) {
        return false;
      }
      if (
        active.price.size &&
        !active.price.has(String(productPriceBucket(product)))
      ) {
        return false;
      }
      if (active.stone.size && !active.stone.has(String(productStone(product)))) {
        return false;
      }
      return true;
    });
  }

  function collectFilterOptions(slugs) {
    const counts = {
      categories: new Map(),
      material: new Map(),
      designer: new Map(),
      price: new Map(),
      stone: new Map(),
    };
    const bump = (map, key) => {
      if (!key) return;
      const label = String(key).trim();
      if (!label) return;
      map.set(label, (map.get(label) || 0) + 1);
    };
    slugs.forEach((slug) => {
      const product = memory.bySlug[slug];
      if (!product) return;
      bump(counts.categories, productCategory(product));
      bump(counts.material, productMaterial(product));
      bump(counts.designer, productDesigner(product));
      bump(counts.price, productPriceBucket(product));
      bump(counts.stone, productStone(product));
    });
    return counts;
  }

  function renderCatalogFilters(container, slugs, onChange) {
    const counts = collectFilterOptions(slugs);
    container.hidden = false;
    container.replaceChildren();

    const groups = [
      { key: "categories", label: "Categories", open: true },
      { key: "material", label: "Material", open: false },
      { key: "designer", label: "Designer", open: false },
      { key: "price", label: "Price", open: false },
      { key: "stone", label: "Stone", open: false },
    ];

    groups.forEach((group) => {
      const options = [...(counts[group.key] || new Map()).entries()].sort(
        (a, b) => a[0].localeCompare(b[0]),
      );
      if (!options.length) return;

      const section = document.createElement("details");
      section.className = "gemist-catalog__filter";
      section.open = group.open || catalogFilterState[group.key].size > 0;

      const summary = document.createElement("summary");
      summary.className = "gemist-catalog__filter-title";
      summary.textContent = group.label;
      section.appendChild(summary);

      const list = document.createElement("div");
      list.className = "gemist-catalog__filter-options";

      options.forEach(([label, count]) => {
        const row = document.createElement("label");
        row.className = "gemist-catalog__filter-option";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = catalogFilterState[group.key].has(label);
        input.addEventListener("change", () => {
          if (input.checked) catalogFilterState[group.key].add(label);
          else catalogFilterState[group.key].delete(label);
          onChange();
        });
        const text = document.createElement("span");
        text.textContent = `${label} (${count})`;
        row.appendChild(input);
        row.appendChild(text);
        list.appendChild(row);
      });

      section.appendChild(list);
      container.appendChild(section);
    });

    if (!container.children.length) {
      container.hidden = true;
    }
  }

  async function showDetail(root, productId) {
    const catalog = root.querySelector("[data-gemist-catalog]");
    const detail = root.querySelector("[data-gemist-detail]");
    const designerPage = root.querySelector("[data-gemist-designer-page]");
    if (!catalog || !detail) return;

    catalog.hidden = true;
    detail.hidden = false;
    if (designerPage) {
      designerPage.hidden = true;
      designerPage.replaceChildren();
    }
    setGemistPageMode("detail");

    const cached = resolveCachedProduct(productId);
    if (cached) {
      detail.replaceChildren(renderDetail(root, cached));
    } else {
      detail.replaceChildren();
      const loading = document.createElement("p");
      loading.className = "gemist-products__status";
      loading.textContent = "Loading product…";
      detail.appendChild(loading);
    }

    try {
      const product = await resolveProduct(productId, { preferCache: Boolean(cached) });
      if (queryParam(PRODUCT_PARAM) !== productId) return;
      if (queryParam(CUSTOMIZE_PARAM) === "1") {
        showDesigner(root, productId);
        return;
      }
      if (!cached || product.id !== cached.id) {
        detail.replaceChildren(renderDetail(root, product));
      }
      // Prefetch option map while the shopper reads the product page so
      // Customize can open with tabs already available.
      prefetchConfiguredProduct(product).catch((error) => {
        console.warn("[gemist] configure prefetch skipped", error);
      });
    } catch (error) {
      if (cached && isRenderableProduct(cached)) return;
      detail.replaceChildren();
      const failed = document.createElement("p");
      failed.className = "gemist-products__status";
      failed.textContent =
        (error instanceof Error && error.message) ||
        root.dataset.errorLabel ||
        "Could not load products";
      detail.appendChild(failed);
      detail.appendChild(retryButton(root, () => showDetail(root, productId)));
    }
  }

  async function showDesigner(root, productId) {
    const catalog = root.querySelector("[data-gemist-catalog]");
    const detail = root.querySelector("[data-gemist-detail]");
    const designerPage = root.querySelector("[data-gemist-designer-page]");
    if (!catalog || !designerPage) {
      showDetail(root, productId);
      return;
    }

    catalog.hidden = true;
    if (detail) {
      detail.hidden = true;
      detail.replaceChildren();
    }
    designerPage.hidden = false;
    setGemistPageMode("designer");
    designerState.unlockedCount = 1;
    designerState.activeOptionKey = "";

    const cached = resolveCachedProduct(productId);
    if (cached) {
      prefetchConfiguredProduct(cached).catch(() => {});
      designerPage.replaceChildren(renderDesignerPage(root, cached));
    } else {
      designerPage.replaceChildren();
      const loading = document.createElement("p");
      loading.className = "gemist-products__status";
      loading.textContent = "Loading designer…";
      designerPage.appendChild(loading);
    }

    const stillHere = () =>
      queryParam(PRODUCT_PARAM) === productId &&
      queryParam(CUSTOMIZE_PARAM) === "1";

    try {
      // Tabs and current selections come from the product's own parts, so
      // the panel renders as soon as the product is known. Per-tab
      // availability loads in parallel inside the panel.
      const product = await resolveProduct(productId, {
        preferCache: Boolean(cached),
      });
      if (!stillHere()) return;
      if (!cached || product.id !== cached.id) {
        prefetchConfiguredProduct(product).catch(() => {});
        designerPage.replaceChildren(renderDesignerPage(root, product));
      }
    } catch (error) {
      if (cached && isRenderableProduct(cached)) return;
      designerPage.replaceChildren();
      const failed = document.createElement("p");
      failed.className = "gemist-products__status";
      failed.textContent =
        (error instanceof Error && error.message) ||
        root.dataset.errorLabel ||
        "Could not load products";
      designerPage.appendChild(failed);
      designerPage.appendChild(retryButton(root, () => showDesigner(root, productId)));
    }
  }

  async function loadCatalogPage(limit, offset) {
    const cachedSlugs = Array.isArray(memory.slugs) ? memory.slugs : [];
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 45000);
    try {
      const payload = await readJson(
        await fetch(withPreview(`${PRODUCTS_PROXY}?limit=${limit}&offset=${offset}`), {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        }),
      );
      const slugs = Array.isArray(payload.slugs)
        ? payload.slugs.filter((slug) => typeof slug === "string" && slug)
        : cachedSlugs;
      if (slugs.length) memory.slugs = slugs;
      writeStorage();
      return {
        slugs,
        products: Array.isArray(payload.products) ? payload.products : [],
      };
    } catch (error) {
      if (cachedSlugs.length && !licenseLocked) return { slugs: cachedSlugs, products: [] };
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function loadStyleProduct(slug) {
    if (memory.bySlug[slug]) return memory.bySlug[slug];
    const key = `slug:${slug}`;
    if (memory.inflight.has(key)) return memory.inflight.get(key);

    const request = (async () => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 25000);
      try {
        const payload = await readJson(
          await fetch(
            withPreview(`${PRODUCTS_PROXY}?slug=${encodeURIComponent(slug)}`),
            {
              credentials: "same-origin",
              headers: { Accept: "application/json" },
              signal: controller.signal,
            },
          ),
        ).catch(() => ({}));
        const product = payload.product || null;
        if (product) {
          cacheProduct(product, slug);
          return product;
        }
      } catch (error) {
        console.error("[gemist] style load failed", slug, error);
      } finally {
        window.clearTimeout(timer);
      }
      return null;
    })().finally(() => memory.inflight.delete(key));

    memory.inflight.set(key, request);
    return request;
  }

  async function loadProductById(_apiBase, productId) {
    const key = `id:${productId}`;
    if (memory.inflight.has(key)) return memory.inflight.get(key);

    const request = (async () => {
      const payload = await readJson(
        await fetch(withPreview(`${PRODUCTS_PROXY}?id=${encodeURIComponent(productId)}`), {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        }),
      );
      let product = asProduct(payload && payload.product);
      if (
        !product &&
        Array.isArray(payload && payload.products)
      ) {
        product = asProduct(
          payload.products.find((item) => item && item.id === productId),
        );
      }
      if (!product) {
        throw new Error(
          (payload && payload.error) || "Could not load this product.",
        );
      }
      cacheProduct(product);
      return product;
    })().finally(() => memory.inflight.delete(key));

    memory.inflight.set(key, request);
    return request;
  }

  async function resolveProduct(productId, options = {}) {
    const cached = resolveCachedProduct(productId);
    if (options.preferCache && cached && isRenderableProduct(cached)) {
      loadProductById(null, productId).catch(() => {});
      return cached;
    }

    try {
      return await loadProductById(null, productId);
    } catch (idError) {
      const slug = queryParam(SLUG_PARAM) || (cached && cached.slug) || "";
      if (!slug) throw idError;
      const product = await loadStyleProduct(slug);
      if (!isRenderableProduct(product)) throw idError;
      return product;
    }
  }

  function resolveCachedProduct(productId) {
    const byId = memory.byId[productId];
    if (isRenderableProduct(byId)) return byId;
    const slug = queryParam(SLUG_PARAM);
    if (slug && isRenderableProduct(memory.bySlug[slug])) {
      return memory.bySlug[slug];
    }
    return null;
  }

  function asProduct(value) {
    return isRenderableProduct(value) ? value : null;
  }

  function isRenderableProduct(product) {
    return Boolean(
      product &&
        typeof product === "object" &&
        (product.id || product.slug) &&
        (product.title ||
          product.shortTitle ||
          product.style ||
          product.slug ||
          (product.images && product.images.length)),
    );
  }

  function cacheProduct(product, slug) {
    if (!isRenderableProduct(product)) return;
    const compact = compactProduct(product);
    if (compact.id) memory.byId[compact.id] = compact;
    if (slug) memory.bySlug[slug] = compact;
    if (compact.slug) memory.bySlug[compact.slug] = compact;
    writeStorage();
  }

  function compactProduct(product) {
    return {
      id: product.id,
      baseProductId: product.baseProductId,
      title: product.title,
      shortTitle: product.shortTitle,
      subtitle: product.subtitle,
      description: product.description,
      slug: product.slug,
      price: product.price,
      salePrice: product.salePrice,
      sku: product.sku,
      vendor: product.vendor,
      style: product.style,
      metal: product.metal,
      type: product.type,
      subtype: product.subtype,
      customizable: product.customizable,
      isCustomizable: product.isCustomizable,
      canCustomize: product.canCustomize,
      thumbnail: product.thumbnail,
      images: product.images,
      images360: product.images360,
      productParts: product.productParts,
      defaultProductMetadata: product.defaultProductMetadata,
      manufacturerMetadata: product.manufacturerMetadata,
      availableProductParts: product.availableProductParts,
      selectedProductParts: product.selectedProductParts,
    };
  }

  function renderSkeleton(slug) {
    const item = document.createElement("li");
    item.dataset.gemistSlug = slug;
    item.className = "gemist-product-skeleton-wrap";

    const card = document.createElement("div");
    card.className = "gemist-product-card gemist-product-card--skeleton";
    card.innerHTML =
      '<div class="gemist-product-card__media"><div class="gemist-product-card__image is-active"></div><span class="gemist-product-card__badge gemist-skel" style="width:7rem;height:1.1rem;"></span></div><div class="gemist-product-card__body"><span class="gemist-skel gemist-skel--line"></span><span class="gemist-skel gemist-skel--title"></span></div>';
    item.appendChild(card);
    return item;
  }

  function cardOptionsOf(root) {
    return {
      showTitle: root.dataset.showTitle !== "false",
      showDescription: root.dataset.showDescription !== "false",
      showPrice: root.dataset.showPrice !== "false",
      showActions: root.dataset.showActions !== "false",
      viewLabel: root.dataset.viewLabel || "View product",
      customizeLabel:
        root.dataset.cardCustomizeLabel ||
        root.dataset.customizeLabel ||
        "Customize",
    };
  }

  function isProductCustomizable(product) {
    if (!product || typeof product !== "object") return false;
    if (
      product.customizable === false ||
      product.isCustomizable === false ||
      product.canCustomize === false
    ) {
      return false;
    }
    if (
      product.customizable === true ||
      product.isCustomizable === true ||
      product.canCustomize === true
    ) {
      return true;
    }
    const available = product.availableProductParts;
    if (available && typeof available === "object") {
      const keys = Object.keys(available);
      if (keys.length) {
        return keys.some(
          (key) => Array.isArray(available[key]) && available[key].length > 0,
        );
      }
    }
    return Boolean(product.baseProductId || product.style);
  }

  function renderCard(product, options, page) {
    const opts =
      options && typeof options === "object" && !Array.isArray(options)
        ? options
        : {
            showTitle: true,
            showDescription: false,
            showPrice: options !== false,
            showActions: true,
          };

    const item = document.createElement("li");
    if (product.slug) item.dataset.gemistSlug = product.slug;

    const card = document.createElement("div");
    card.className = "gemist-product-card";

    const link = document.createElement("a");
    link.className = "gemist-product-card__link";
    link.href = catalogUrl({
      productId: product.id,
      slug: product.slug,
      page,
    });
    link.addEventListener(
      "pointerenter",
      () => {
        const root = document.querySelector("[data-gemist-products]");
        if (root && product.id) loadProductById(apiBaseOf(root), product.id).catch(() => {});
      },
      { once: true },
    );

    const media = document.createElement("div");
    media.className = "gemist-product-card__media";

    const gallery = productCardImages(product);
    const imgs = [];
    if (gallery.length) {
      gallery.forEach((src, index) => {
        const image = document.createElement("img");
        image.className = "gemist-product-card__image";
        if (index === 0) image.classList.add("is-active");
        image.src = src;
        image.alt = index === 0 ? productTitle(product) : "";
        image.loading = index === 0 ? "lazy" : "lazy";
        if (index > 0) image.setAttribute("aria-hidden", "true");
        media.appendChild(image);
        imgs.push(image);
      });
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "gemist-product-card__image is-active";
      media.appendChild(placeholder);
    }

    const customizable = isProductCustomizable(product);

    const badge = document.createElement("span");
    badge.className = "gemist-product-card__badge";
    badge.textContent = "Customizable";
    if (customizable) media.appendChild(badge);
    link.appendChild(media);

    if (imgs.length > 1) {
      let slideIndex = 0;
      let timer = null;
      const HOVER_INTERVAL_MS = 1000;

      const showSlide = (next) => {
        imgs[slideIndex]?.classList.remove("is-active");
        slideIndex = ((next % imgs.length) + imgs.length) % imgs.length;
        imgs[slideIndex]?.classList.add("is-active");
      };

      const stopHoverGallery = () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        showSlide(0);
      };

      const startHoverGallery = () => {
        if (timer || imgs.length < 2) return;
        showSlide(slideIndex + 1);
        timer = window.setInterval(() => showSlide(slideIndex + 1), HOVER_INTERVAL_MS);
      };

      card.addEventListener("pointerenter", startHoverGallery);
      card.addEventListener("pointerleave", stopHoverGallery);
      card.addEventListener("focusin", startHoverGallery);
      card.addEventListener("focusout", (event) => {
        if (!card.contains(event.relatedTarget)) stopHoverGallery();
      });
    }

    const body = document.createElement("div");
    body.className = "gemist-product-card__body";

    const meta = document.createElement("div");
    meta.className = "gemist-product-card__meta";

    const brand = document.createElement("span");
    brand.className = "gemist-product-card__brand";
    brand.textContent = productDesigner(product);
    meta.appendChild(brand);

    if (opts.showPrice) {
      const price = formatPrice(product);
      if (price) {
        const priceEl = document.createElement("span");
        priceEl.className = "gemist-product-card__price";
        const from = document.createElement("span");
        from.className = "gemist-product-card__price-from";
        from.textContent = "From ";
        priceEl.appendChild(from);
        priceEl.appendChild(document.createTextNode(price));
        meta.appendChild(priceEl);
      }
    }

    body.appendChild(meta);

    if (opts.showTitle) {
      const title = document.createElement("h3");
      title.className = "gemist-product-card__title";
      title.textContent = productTitle(product);
      body.appendChild(title);
    }

    if (opts.showDescription) {
      const subtitle = product.subtitle || product.description;
      if (subtitle) {
        const subtitleEl = document.createElement("p");
        subtitleEl.className = "gemist-product-card__subtitle";
        subtitleEl.textContent = subtitle;
        body.appendChild(subtitleEl);
      }
    }

    link.appendChild(body);
    card.appendChild(link);

    if (opts.showActions) {
      const root = document.querySelector("[data-gemist-products]");
      const viewLabel =
        opts.viewLabel || root?.dataset.viewLabel || "View product";
      const customizeLabel =
        opts.customizeLabel ||
        root?.dataset.cardCustomizeLabel ||
        root?.dataset.customizeLabel ||
        "Customize";

      const actions = document.createElement("div");
      actions.className = "gemist-product-card__actions";

      const view = document.createElement("a");
      view.className = "gemist-product-card__action gemist-product-card__action--view";
      view.href = catalogUrl({ productId: product.id, slug: product.slug, page });
      view.textContent = viewLabel;
      actions.appendChild(view);

      if (customizable) {
        const customize = document.createElement("a");
        customize.className =
          "gemist-product-card__action gemist-product-card__action--customize";
        customize.href = catalogUrl({
          productId: product.id,
          slug: product.slug,
          page,
          customize: true,
        });
        customize.textContent = customizeLabel;
        const warm = () => {
          prefetchConfiguredProduct(product).catch(() => {});
        };
        customize.addEventListener("pointerenter", warm, { once: true });
        customize.addEventListener("focus", warm, { once: true });
        actions.appendChild(customize);
      }

      card.appendChild(actions);
    }

    item.appendChild(card);
    return item;
  }

  function renderDetail(root, product) {
    const wrap = document.createElement("div");
    wrap.className = "gemist-detail__layout";

    const back = document.createElement("a");
    back.className = "gemist-detail__back";
    back.href = catalogUrl({ page: queryParam(PAGE_PARAM) || "1" });
    back.setAttribute("aria-label", root.dataset.backLabel || "Back to products");
    back.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
    wrap.appendChild(back);

    const media = renderMedia(root, product);

    const info = document.createElement("div");
    info.className = "gemist-detail__info";

    const header = document.createElement("header");
    header.className = "gemist-detail__header";

    const eyebrow = document.createElement("p");
    eyebrow.className = "gemist-detail__eyebrow";
    eyebrow.textContent = product.vendor || product.style || "Gemist";
    header.appendChild(eyebrow);

    const title = document.createElement("h1");
    title.className = "gemist-detail__title";
    title.textContent = productTitle(product);
    header.appendChild(title);

    const price = formatPrice(product);
    if (price) {
      const priceEl = document.createElement("p");
      priceEl.className = "gemist-detail__price";
      priceEl.textContent = price;
      header.appendChild(priceEl);
    }

    info.appendChild(header);

    if (product.description) {
      const description = document.createElement("p");
      description.className = "gemist-detail__description";
      description.textContent = product.description;
      info.appendChild(description);
    }

    const metaBlock = renderMetaBlock(root, product);
    if (metaBlock) info.appendChild(metaBlock);

    info.appendChild(renderActions(root, product));

    const parts = product.productParts || product.defaultProductMetadata;
    const specsSection = renderSpecsSection(root, parts);
    if (specsSection) info.appendChild(specsSection);

    wrap.appendChild(media);
    wrap.appendChild(info);

    return wrap;
  }

  function renderMetaBlock(root, product) {
    const rows = [];
    if (product.sku) {
      rows.push([
        root.dataset.oemSkuLabel || "Customer SKU",
        product.sku,
      ]);
    }
    if (product.id) {
      rows.push([
        root.dataset.gemistIdLabel || "Gemist product ID",
        product.id,
      ]);
      rows.push([
        root.dataset.configIdLabel || "Configuration ID",
        product.id,
      ]);
    }
    if (!rows.length) return null;

    const block = document.createElement("section");
    block.className = "gemist-detail__meta-block";

    const heading = document.createElement("h2");
    heading.className = "gemist-detail__meta-heading";
    heading.textContent = root.dataset.metaLabel || "Product information";
    block.appendChild(heading);

    const list = document.createElement("dl");
    list.className = "gemist-detail__meta";
    rows.forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "gemist-detail__meta-row";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = String(value);
      row.appendChild(dt);
      row.appendChild(dd);
      list.appendChild(row);
    });
    block.appendChild(list);
    return block;
  }

  function renderSpecsSection(root, parts) {
    if (!parts || typeof parts !== "object") return null;

    const list = document.createElement("ul");
    list.className = "gemist-detail__specs";
    Object.entries(parts).forEach(([label, value]) => {
      if (value == null || value === "") return;
      const row = document.createElement("li");
      row.innerHTML = `<span class="gemist-detail__spec-label">${escapeHtml(formatLabel(label))}</span><strong class="gemist-detail__spec-value">${escapeHtml(String(value))}</strong>`;
      list.appendChild(row);
    });
    if (!list.children.length) return null;

    const section = document.createElement("section");
    section.className = "gemist-detail__specs-section";

    const heading = document.createElement("h2");
    heading.className = "gemist-detail__specs-heading";
    heading.textContent = root.dataset.specsLabel || "Product details";
    section.appendChild(heading);
    section.appendChild(list);
    return section;
  }

  function renderDesignerPage(root, product, options = {}) {
    if ((root.dataset.designerEmbed || "").toLowerCase() === "iframe") {
      return renderDesignerIframePage(root, product);
    }
    return renderDesignerStudioPage(root, product, options);
  }

  function renderDesignerIframePage(root, product) {
    const wrap = document.createElement("div");
    wrap.className = "gemist-designer-page__layout gemist-designer-page__layout--iframe";

    const back = document.createElement("a");
    back.className = "gemist-detail__back gemist-designer-page__back";
    back.href = catalogUrl({
      productId: product.id,
      slug: product.slug,
      page: queryParam(PAGE_PARAM),
    });
    back.innerHTML = `<span class="gemist-detail__back-arrow" aria-hidden="true">←</span> ${escapeHtml(
      root.dataset.backProductLabel || "Back to product",
    )}`;
    wrap.appendChild(back);

    const container = document.createElement("div");
    container.className = "designer-iframe-container";

    const iframe = document.createElement("iframe");
    iframe.id = "designer-iframe";
    iframe.className = "designer-iframe-content";
    iframe.width = "100%";
    iframe.height = "100%";
    iframe.setAttribute("referrerpolicy", "unsafe-url");
    iframe.setAttribute("allow", "clipboard-read; clipboard-write");
    iframe.setAttribute(
      "sandbox",
      "allow-same-origin allow-scripts allow-top-navigation allow-downloads allow-forms",
    );
    iframe.title = root.dataset.designerTitle || "Designer";
    iframe.src = buildDesignerIframeUrl(root, product);
    container.appendChild(iframe);
    wrap.appendChild(container);

    return wrap;
  }

  // Tabs come from the product's own parts so they render instantly; the
  // shared option map only adds keys the product does not carry.
  function designerOptionKeys(product) {
    const present = new Set(Object.keys(currentParts(product)));
    const map = cachedPartsMap() || product.availableProductParts || {};
    Object.keys(map).forEach((key) => {
      if (Array.isArray(map[key]) && map[key].length) present.add(key);
    });
    if (!present.size) return [];
    return OPTION_ORDER.filter((key) => present.has(key)).concat(
      [...present].filter((key) => !OPTION_ORDER.includes(key)),
    );
  }

  function renderDesignerStudioPage(root, product, options = {}) {
    const wrap = document.createElement("div");
    wrap.className = "gemist-designer-page__layout gemist-designer-page__layout--studio";
    wrap.dataset.gemistDesignerStudio = "true";

    const stage = renderDesignerStage(root, product);
    const panel = renderDesignerPanel(root, product, options);
    wrap.appendChild(stage);
    wrap.appendChild(panel);
    return wrap;
  }

  function renderDesignerStage(root, product) {
    const stage = document.createElement("section");
    stage.className = "gemist-designer-stage";

    const toolbar = document.createElement("div");
    toolbar.className = "gemist-designer-stage__toolbar";
    toolbar.style.gap = "1rem";

    const backBtn = document.createElement("a");
    backBtn.className = "gemist-designer-stage__icon-btn gemist-designer-stage__icon-btn--back";
    backBtn.setAttribute("aria-label", "Back");
    backBtn.href = catalogUrl({
      productId: product.id,
      slug: product.slug,
      page: queryParam(PAGE_PARAM),
    });
    backBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
    backBtn.style.textDecoration = "none";
    backBtn.style.color = "inherit";
    toolbar.appendChild(backBtn);

    const share = document.createElement("button");
    share.type = "button";
    share.className = "gemist-designer-stage__icon-btn";
    share.setAttribute("aria-label", "Share");
    share.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/></svg>';
    share.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const url = window.location.href;
      const title = productTitle(product);
      try {
        if (navigator.share) {
          await navigator.share({ title, url });
          return;
        }
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
        } else {
          const input = document.createElement("input");
          input.value = url;
          input.setAttribute("readonly", "");
          input.style.position = "fixed";
          input.style.opacity = "0";
          document.body.appendChild(input);
          input.select();
          document.execCommand("copy");
          input.remove();
        }
        share.setAttribute("data-copied", "true");
        share.setAttribute("aria-label", "Link copied");
        window.setTimeout(() => {
          share.removeAttribute("data-copied");
          share.setAttribute("aria-label", "Share");
        }, 1600);
      } catch {
        window.prompt("Copy this link:", url);
      }
    });
    toolbar.appendChild(share);

    const fullscreenIconExpand =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    const fullscreenIconCollapse =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M16 3v3a2 2 0 0 0 2 2h3"/><path d="M8 21v-3a2 2 0 0 0-2-2H3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';

    const fullscreen = document.createElement("button");
    fullscreen.type = "button";
    fullscreen.className = "gemist-designer-stage__icon-btn gemist-designer-stage__icon-btn--end";
    fullscreen.setAttribute("aria-label", "Fullscreen");
    fullscreen.setAttribute("aria-pressed", "false");
    fullscreen.innerHTML = fullscreenIconExpand;

    const fullscreenElement = () =>
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement ||
      null;

    const requestFs = (el) => {
      if (el.requestFullscreen) return el.requestFullscreen();
      if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
      if (el.webkitRequestFullScreen) return el.webkitRequestFullScreen();
      if (el.msRequestFullscreen) return el.msRequestFullscreen();
      return Promise.reject(new Error("Fullscreen API unavailable"));
    };

    const exitFs = () => {
      if (document.exitFullscreen) return document.exitFullscreen();
      if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
      if (document.webkitCancelFullScreen) return document.webkitCancelFullScreen();
      if (document.msExitFullscreen) return document.msExitFullscreen();
      return Promise.resolve();
    };

    const setImmersive = (active) => {
      stage.classList.toggle("is-immersive", Boolean(active));
      document.documentElement.classList.toggle("gemist-stage-immersive", Boolean(active));
      document.body.classList.toggle("gemist-stage-immersive", Boolean(active));
    };

    const updateFullscreenButton = () => {
      const active = Boolean(fullscreenElement()) || stage.classList.contains("is-immersive");
      fullscreen.setAttribute("aria-pressed", active ? "true" : "false");
      fullscreen.setAttribute("aria-label", active ? "Exit fullscreen" : "Fullscreen");
      fullscreen.innerHTML = active ? fullscreenIconCollapse : fullscreenIconExpand;
    };

    const syncFullscreenUi = () => {
      if (!fullscreenElement()) {
        // Native fullscreen exited; keep CSS immersive only if still explicitly on.
        updateFullscreenButton();
        return;
      }
      setImmersive(false);
      updateFullscreenButton();
    };

    fullscreen.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nativeActive = Boolean(fullscreenElement());
      const immersiveActive = stage.classList.contains("is-immersive");

      if (nativeActive) {
        try {
          await exitFs();
        } catch {
          /* ignore */
        }
        setImmersive(false);
        updateFullscreenButton();
        return;
      }

      if (immersiveActive) {
        setImmersive(false);
        updateFullscreenButton();
        return;
      }

      try {
        await requestFs(stage);
        setImmersive(false);
        updateFullscreenButton();
      } catch {
        // iOS Safari and some mobile browsers lack element fullscreen — use CSS fallback.
        setImmersive(true);
        updateFullscreenButton();
      }
    });

    document.addEventListener("fullscreenchange", syncFullscreenUi);
    document.addEventListener("webkitfullscreenchange", syncFullscreenUi);
    document.addEventListener("MSFullscreenChange", syncFullscreenUi);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && stage.classList.contains("is-immersive")) {
        setImmersive(false);
        updateFullscreenButton();
      }
    });

    toolbar.appendChild(fullscreen);
    stage.appendChild(toolbar);

    const title = document.createElement("h1");
    title.className = "gemist-designer-stage__title";
    title.textContent = productTitle(product);
    stage.appendChild(title);

    const stills = (product.images || []).map(mediaUrl).filter(Boolean);
    const heroSrc = stills[0] || productImage(product) || "";
    let index = 0;

    const viewport = document.createElement("div");
    viewport.className = "gemist-designer-stage__viewport";

    const thumbs = document.createElement("div");
    thumbs.className = "gemist-designer-stage__thumbs";
    const gallery = stills.length ? stills : heroSrc ? [heroSrc] : [];

    const heroWrap = document.createElement("div");
    heroWrap.className = "gemist-designer-stage__hero-wrap";

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "gemist-designer-stage__nav gemist-designer-stage__nav--prev";
    prev.setAttribute("aria-label", "Previous image");
    prev.textContent = "‹";

    const next = document.createElement("button");
    next.type = "button";
    next.className = "gemist-designer-stage__nav gemist-designer-stage__nav--next";
    next.setAttribute("aria-label", "Next image");
    next.textContent = "›";

    const hero = document.createElement(heroSrc ? "img" : "div");
    hero.className = "gemist-designer-stage__hero";
    if (hero.tagName === "IMG") {
      hero.src = heroSrc;
      hero.alt = productTitle(product);
      hero.draggable = false;
      hero.style.userSelect = "none";
    }

    const show = (i) => {
      if (!gallery.length || hero.tagName !== "IMG") return;
      index = ((i % gallery.length) + gallery.length) % gallery.length;
      hero.src = gallery[index];
      thumbs.querySelectorAll("[aria-current]").forEach((el) => el.removeAttribute("aria-current"));
      const active = thumbs.children[index];
      if (active) active.setAttribute("aria-current", "true");
    };

    gallery.forEach((src, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gemist-designer-stage__thumb";
      if (i === 0) button.setAttribute("aria-current", "true");
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      button.appendChild(img);
      button.addEventListener("click", () => show(i));
      thumbs.appendChild(button);
    });

    prev.addEventListener("click", () => show(index - 1));
    next.addEventListener("click", () => show(index + 1));
    if (gallery.length < 2) {
      prev.hidden = true;
      next.hidden = true;
    }

    heroWrap.appendChild(prev);
    heroWrap.appendChild(hero);
    heroWrap.appendChild(next);

    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    heroWrap.style.touchAction = "pan-y";
    heroWrap.style.overflow = "hidden"; // Prevents horizontal scrollbar during swipe

    const snapBack = () => {
      hero.style.transition = "transform 0.25s ease-out, opacity 0.25s ease-out";
      hero.style.transform = "translateX(0)";
      hero.style.opacity = "1";
    };

    heroWrap.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      startX = e.clientX;
      currentX = startX;
      isDragging = true;
      hero.style.transition = "none";
      heroWrap.setPointerCapture(e.pointerId);
    }, { passive: true });

    heroWrap.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      currentX = e.clientX;
      const diff = currentX - startX;
      hero.style.transform = `translateX(${diff}px)`;
      hero.style.opacity = 1 - Math.min(Math.abs(diff) / 250, 0.6);
    }, { passive: true });

    heroWrap.addEventListener("pointerup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      heroWrap.releasePointerCapture(e.pointerId);
      
      const diff = currentX - startX;
      if (Math.abs(diff) > 50) {
        const sign = diff < 0 ? -1 : 1;
        hero.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out";
        hero.style.transform = `translateX(${sign * 150}px)`;
        hero.style.opacity = "0";
        
        setTimeout(() => {
          if (diff < 0) show(index + 1);
          else show(index - 1);
          
          hero.style.transition = "none";
          hero.style.transform = `translateX(${-sign * 100}px)`;
          void hero.offsetWidth; // force browser reflow
          snapBack();
        }, 200);
      } else {
        snapBack();
      }
    }, { passive: true });

    heroWrap.addEventListener("pointercancel", (e) => {
      if (!isDragging) return;
      isDragging = false;
      snapBack();
    });

    viewport.appendChild(thumbs);
    viewport.appendChild(heroWrap);
    stage.appendChild(viewport);

    const powered = document.createElement("p");
    powered.className = "gemist-designer-stage__powered";
    stage.appendChild(powered);

    return stage;
  }

  function renderDesignerPanel(root, product, options = {}) {
    const panel = document.createElement("aside");
    panel.className = "gemist-designer-panel";

    const heading = document.createElement("h2");
    heading.className = "gemist-designer-panel__title";
    heading.textContent = productTitle(product);
    panel.appendChild(heading);

    const optionKeys = designerOptionKeys(product);
    const keys = optionKeys.length ? [...optionKeys, "engraving"] : [];
    let partsMap = cachedPartsMap() || product.availableProductParts || {};
    let updateCta = () => {};
    const selected = {
      ...(product.selectedProductParts ||
        product.productParts ||
        product.defaultProductMetadata ||
        {}),
    };

    const failedKeys = new Set();
    const pendingKeys = new Set();
    // Array of allowed values, null when unconstrained, undefined while loading.
    const allowedFor = (key) => {
      if (key === "style" || failedKeys.has(key)) return null;
      return knownAllowedValues(selected, key);
    };
    const valuesFor = (key) => {
      const out = [];
      const seen = new Set();
      const add = (list) =>
        (list || []).forEach((value) => {
          const text = String(value);
          if (seen.has(text)) return;
          seen.add(text);
          out.push(text);
        });
      add(partsMap[key]);
      if (key === "style") {
        add(Object.values(memory.bySlug).map((item) => item && item.style).filter(Boolean));
      }
      const allowed = allowedFor(key);
      if (Array.isArray(allowed)) add(allowed);
      if (selected[key] != null && selected[key] !== "") add([selected[key]]);
      return sortOptionValues(key, out);
    };

    const unlockedCount = () =>
      Math.max(1, Math.min(Number(designerState.unlockedCount) || 1, keys.length));
    const isUnlocked = (key) => keys.indexOf(key) < unlockedCount();

    const preferredKey = options.activeKey || designerState.activeOptionKey || "";
    let activeKey =
      keys.includes(preferredKey) && isUnlocked(preferredKey) ? preferredKey : keys[0] || "";
    designerState.activeOptionKey = activeKey;

    const tabs = document.createElement("div");
    tabs.className = "gemist-designer-panel__tabs";
    tabs.setAttribute("role", "tablist");

    const refreshTabLocks = () => {
      tabs.querySelectorAll("[role='tab']").forEach((tab) => {
        const locked = !isUnlocked(tab.dataset.key);
        tab.disabled = locked;
        tab.dataset.locked = locked ? "true" : "false";
        tab.setAttribute("aria-disabled", locked ? "true" : "false");
        tab.title = locked ? "Complete the previous step first" : "";
      });
    };
    const unlockAfter = (key) => {
      const index = keys.indexOf(key);
      if (index < 0) return;
      designerState.unlockedCount = Math.max(unlockedCount(), index + 2);
      refreshTabLocks();
    };
    const revealTab = (key, behavior = "smooth") => {
      const index = keys.indexOf(key);
      if (index < 0) return;
      const current = tabs.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (!current) return;
      const next = keys[index + 1]
        ? tabs.querySelector(`[data-key="${CSS.escape(keys[index + 1])}"]`)
        : null;
      const prev = keys[index - 1]
        ? tabs.querySelector(`[data-key="${CSS.escape(keys[index - 1])}"]`)
        : null;
      const viewLeft = tabs.scrollLeft;
      const viewRight = viewLeft + tabs.clientWidth;
      const edge = next || current;
      const rightNeeded = edge.offsetLeft + edge.offsetWidth;
      const leftNeeded = (prev || current).offsetLeft;
      let target = viewLeft;
      if (rightNeeded > viewRight) target = rightNeeded - tabs.clientWidth;
      if (leftNeeded < target) target = leftNeeded;
      if (target !== viewLeft) tabs.scrollTo({ left: Math.max(0, target), behavior });
    };

    const grid = document.createElement("div");
    grid.className = "gemist-designer-panel__grid";
    grid.setAttribute("role", "tabpanel");

    const status = document.createElement("p");
    status.className = "gemist-designer-panel__status";
    status.hidden = true;
    panel.appendChild(status);

    const renderGrid = () => {
      grid.replaceChildren();
      grid.classList.toggle(
        "gemist-designer-panel__grid--select",
        activeKey === "ring_size" || activeKey === "engraving",
      );
      if (activeKey === "engraving") {
        grid.appendChild(renderEngravingPanel(root, status, updateCta));
        return;
      }
      const allowed = allowedFor(activeKey);
      const isPending = allowed === undefined;
      const allowedSet = Array.isArray(allowed) ? new Set(allowed) : null;
      const values = valuesFor(activeKey);
      if (!values.length) {
        if (isPending) {
          for (let index = 0; index < 4; index += 1) {
            const skeleton = document.createElement("div");
            skeleton.className =
              "gemist-designer-panel__option gemist-designer-panel__option--skeleton";
            skeleton.setAttribute("aria-hidden", "true");
            grid.appendChild(skeleton);
          }
          return;
        }
        const empty = document.createElement("p");
        empty.className = "gemist-designer-panel__empty";
        empty.textContent = keys.length
          ? "No options available for this step."
          : "Configuration options will appear when Gemist returns available parts.";
        grid.appendChild(empty);
        return;
      }
      const stateOf = (value) => {
        if (String(selected[activeKey] || "") === String(value)) return "available";
        if (isPending) return "pending";
        if (allowedSet && !allowedSet.has(String(value))) return "unavailable";
        return "available";
      };

      if (activeKey === "ring_size") {
        const field = document.createElement("label");
        field.className = "gemist-designer-panel__select-field";
        const caption = document.createElement("span");
        caption.className = "gemist-designer-panel__select-label";
        caption.textContent = formatLabel(activeKey);
        field.appendChild(caption);

        const select = document.createElement("select");
        select.className = "gemist-designer-panel__select";
        select.dataset.gemistOption = activeKey;
        select.setAttribute("aria-label", formatLabel(activeKey));

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = isPending
          ? "Checking available sizes…"
          : root.dataset.ringSizePlaceholder || "Select ring size";
        placeholder.disabled = true;
        if (!selected[activeKey]) placeholder.selected = true;
        select.appendChild(placeholder);
        if (isPending) select.disabled = true;

        values.forEach((value) => {
          const option = document.createElement("option");
          option.value = value;
          const state = stateOf(value);
          option.textContent =
            state === "unavailable"
              ? `${optionDisplayLabel(activeKey, value)} (unavailable)`
              : optionDisplayLabel(activeKey, value);
          option.disabled = state === "unavailable";
          if (String(selected[activeKey] || "") === String(value)) {
            option.selected = true;
          }
          select.appendChild(option);
        });

        select.addEventListener("change", () => {
          if (!select.value) return;
          // Ring size is a fit attribute — apply locally so Gemist search
          // does not drop the rest of the option tabs.
          selected[activeKey] = select.value;
          designerState.activeOptionKey = activeKey;
          status.hidden = true;
          product.selectedProductParts = { ...selected };
          cacheProduct(product, product.slug);
          unlockAfter(activeKey);
        });
        field.appendChild(select);
        grid.appendChild(field);
        return;
      }

      values.forEach((value) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "gemist-designer-panel__option";
        card.dataset.gemistOption = activeKey;
        card.dataset.value = value;
        const pressed = String(selected[activeKey] || "") === String(value);
        card.setAttribute("aria-pressed", pressed ? "true" : "false");
        const state = stateOf(value);
        if (state === "pending") {
          card.dataset.pending = "true";
          card.disabled = true;
          card.setAttribute("aria-busy", "true");
        } else if (state === "unavailable") {
          card.dataset.unavailable = "true";
          card.disabled = true;
          card.setAttribute("aria-disabled", "true");
          card.title = "Not available with your current selections";
        }

        const thumb = document.createElement("span");
        thumb.className = "gemist-designer-panel__option-media";
        if (activeKey === "metal_color" || activeKey === "metal") {
          thumb.classList.add("gemist-designer-panel__option-media--swatch");
          thumb.style.background = metalSwatch(value);
        } else if (activeKey === "style") {
          fillStyleThumb(thumb, product, selected, value);
        } else {
          thumb.classList.add("gemist-designer-panel__option-media--label");
          const mark = document.createElement("span");
          mark.className = "gemist-designer-panel__option-mark";
          mark.textContent = optionMark(value);
          thumb.appendChild(mark);
        }
        card.appendChild(thumb);

        const copy = document.createElement("span");
        copy.className = "gemist-designer-panel__option-copy";
        const label = document.createElement("span");
        label.className = "gemist-designer-panel__option-label";
        label.textContent = optionDisplayLabel(activeKey, value);
        copy.appendChild(label);
        card.appendChild(copy);

        card.addEventListener("click", () => {
          if (card.dataset.unavailable === "true" || card.dataset.pending === "true") return;
          if (pressed) {
            // Confirming the current value still completes this step.
            unlockAfter(activeKey);
            return;
          }
          applyOption(activeKey, value);
        });
        grid.appendChild(card);
      });
    };

    const ensureAvailability = () => {
      keys.forEach((key) => {
        if (key === "engraving" || key === "style") return;
        if (pendingKeys.has(key) || allowedFor(key) !== undefined) return;
        pendingKeys.add(key);
        loadAllowedValues(product, selected, key)
          .catch(() => null)
          .finally(() => {
            pendingKeys.delete(key);
            if (allowedFor(key) === undefined) failedKeys.add(key);
            if (panel.isConnected && key === activeKey && !updating) renderGrid();
          });
      });
      if (!cachedPartsMap() && product.baseProductId) {
        loadPartsMap(product.baseProductId).then((map) => {
          if (!map || !panel.isConnected || updating) return;
          partsMap = map;
          if (activeKey !== "engraving") renderGrid();
        });
      }
    };

    let updating = false;
    const applyOption = async (key, value) => {
      if (updating) return;
      updating = true;
      designerState.activeOptionKey = key;
      panel.classList.add("is-updating");
      panel.setAttribute("aria-busy", "true");
      grid.querySelectorAll("button[data-gemist-option]").forEach((card) => {
        const chosen =
          card.dataset.gemistOption === key && card.dataset.value === String(value);
        card.setAttribute("aria-pressed", chosen ? "true" : "false");
      });
      status.hidden = false;
      status.textContent = "Updating configuration…";
      // Warm the next tab's availability while Gemist resolves the product.
      loadPrefixAvailability(product.baseProductId, {
        ...upstreamParts(selected, key),
        [key]: value,
      }).catch(() => {});
      try {
        const next = await configureSelection(root, product, selected, key, value);
        unlockAfter(key);
        const url = catalogUrl({
          productId: next.id,
          slug: next.slug,
          page: queryParam(PAGE_PARAM),
          customize: true,
        });
        window.history.replaceState({}, "", url);
        const designerPage = root.querySelector("[data-gemist-designer-page]");
        if (designerPage) {
          designerPage.replaceChildren(
            renderDesignerPage(root, next, { activeKey: key }),
          );
        }
      } catch {
        updating = false;
        panel.classList.remove("is-updating");
        panel.removeAttribute("aria-busy");
        status.hidden = false;
        status.textContent = "That combination is not available. Try another option.";
        renderGrid();
      }
    };

    keys.forEach((key) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "gemist-designer-panel__tab";
      tab.setAttribute("role", "tab");
      tab.dataset.key = key;
      tab.textContent = designerTabLabel(key);
      if (key === activeKey) tab.setAttribute("aria-selected", "true");
      tab.addEventListener("click", () => {
        if (!isUnlocked(key)) return;
        activeKey = key;
        designerState.activeOptionKey = key;
        tabs.querySelectorAll("[role='tab']").forEach((el) => {
          el.setAttribute("aria-selected", el === tab ? "true" : "false");
        });
        unlockAfter(key);
        revealTab(key);
        renderGrid();
        updateCta();
      });
      tabs.appendChild(tab);
    });

    unlockAfter(activeKey);
    if (keys.length) panel.appendChild(tabs);
    requestAnimationFrame(() => revealTab(activeKey, "auto"));
    panel.appendChild(grid);
    renderGrid();
    ensureAvailability();

    if (product.id) {
      const config = document.createElement("p");
      config.className = "gemist-designer-panel__config";
      config.textContent = [
        `${root.dataset.configIdLabel || "Configuration ID"}: ${product.id}`,
        product.sku ? `SKU: ${product.sku}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      panel.appendChild(config);
    }

    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "gemist-designer-panel__cta";
    const priceLine = document.createElement("p");
    priceLine.className = "gemist-designer-panel__price-line";
    priceLine.hidden = true;
    panel.appendChild(priceLine);
    updateCta = () => {
      const isLast = !keys.length || keys.indexOf(activeKey) >= keys.length - 1;
      const label = isLast
        ? root.dataset.addLabel || "Add to cart"
        : root.dataset.nextStepLabel || "Next Step";
      const total = formatConfiguredPrice(root, product);
      cta.textContent = total ? `${label} • ${total}` : label;
      const fee = engravingFeeAmount(root);
      if (designerState.engravingEnabled && fee > 0) {
        priceLine.hidden = false;
        priceLine.textContent = `Engraving: +${formatMoneyAmount(fee)} · Configuration ${formatPrice(product) || ""}`.trim();
      } else {
        priceLine.hidden = true;
        priceLine.textContent = "";
      }
    };
    updateCta();
    cta.addEventListener("click", async () => {
      const idx = keys.indexOf(activeKey);
      if (idx >= 0 && idx < keys.length - 1) {
        // "Next Step" accepts the current selection for this step.
        unlockAfter(activeKey);
        const nextKey = keys[idx + 1];
        const nextTab = tabs.querySelector(`[data-key="${CSS.escape(nextKey)}"]`);
        if (nextTab) nextTab.click();
        return;
      }
      cta.disabled = true;
      status.hidden = false;
      const engravingError = validateEngravingState(root);
      if (engravingError) {
        status.textContent = engravingError;
        cta.disabled = false;
        if (activeKey !== "engraving") {
          const engravingTab = tabs.querySelector('[data-key="engraving"]');
          if (engravingTab) engravingTab.click();
        }
        return;
      }
      status.textContent = "Adding to cart…";
      try {
        await addGemistLineToShopifyCart(product.id, {
          engraving: designerState.engravingEnabled
            ? designerState.engraving.trim()
            : "",
          engravingFont: designerState.engravingEnabled
            ? designerState.engravingFont
            : "",
          engravingFee: designerState.engravingEnabled
            ? engravingFeeAmount(root)
            : 0,
          sku: product.sku || "",
          ring_size: selected.ring_size || "",
        });
        window.location.href = "/cart";
      } catch (error) {
        status.textContent =
          error instanceof Error ? error.message : "Could not add this item to the cart.";
        cta.disabled = false;
      }
    });
    panel.appendChild(cta);

    return panel;
  }

  function engravingMaxChars(root) {
    const configured = Number(root?.dataset?.engravingMaxChars);
    return Number.isFinite(configured) && configured > 0
      ? Math.min(configured, 40)
      : ENGRAVING_MAX_CHARS;
  }

  function validateEngravingState(root) {
    if (!designerState.engravingEnabled) return "";
    const text = String(designerState.engraving || "").trim();
    if (!text) {
      return (
        root.dataset.engravingRequired ||
        "Enter your engraving text, or choose No Engraving."
      );
    }
    if (text.length > engravingMaxChars(root)) {
      return (
        root.dataset.engravingTooLong ||
        `Engraving can be at most ${engravingMaxChars(root)} characters.`
      );
    }
    if (!ENGRAVING_ALLOWED_RE.test(text)) {
      return (
        root.dataset.engravingInvalid ||
        "Engraving supports letters, numbers, spaces, and , . ' - ! ? & only."
      );
    }
    const fonts = engravingFontOptions(root);
    if (fonts.length && !fonts.includes(designerState.engravingFont)) {
      return "Select an engraving font.";
    }
    return "";
  }

  function renderEngravingPanel(root, status, updateCta) {
    const wrap = document.createElement("div");
    wrap.className = "gemist-designer-panel__engraving-wrap";

    const caption = document.createElement("span");
    caption.className = "gemist-designer-panel__select-label";
    caption.textContent = root.dataset.engravingLabel || "Engraving";
    wrap.appendChild(caption);

    const choices = document.createElement("div");
    choices.className = "gemist-designer-panel__engraving-choices";
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", root.dataset.engravingLabel || "Engraving");

    const makeChoice = (enabled, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gemist-designer-panel__engraving-choice";
      button.textContent = label;
      button.setAttribute(
        "aria-pressed",
        designerState.engravingEnabled === enabled ? "true" : "false",
      );
      button.addEventListener("click", () => {
        designerState.engravingEnabled = enabled;
        if (!enabled) designerState.engraving = "";
        status.hidden = true;
        if (typeof updateCta === "function") updateCta();
        wrap.replaceWith(renderEngravingPanel(root, status, updateCta));
      });
      return button;
    };

    choices.appendChild(
      makeChoice(false, root.dataset.engravingNoneLabel || "No Engraving"),
    );
    choices.appendChild(
      makeChoice(true, root.dataset.engravingAddLabel || "Add Engraving"),
    );
    wrap.appendChild(choices);

    if (designerState.engravingEnabled) {
      const maxChars = engravingMaxChars(root);
      const fonts = engravingFontOptions(root);
      if (!fonts.includes(designerState.engravingFont)) {
        designerState.engravingFont = fonts[0] || "Classic";
      }
      const fee = engravingFeeAmount(root);

      const field = document.createElement("label");
      field.className = "gemist-designer-panel__select-field";

      const textLabel = document.createElement("span");
      textLabel.className = "gemist-designer-panel__select-label";
      textLabel.textContent =
        root.dataset.engravingTextLabel || "Enter your engraving";
      field.appendChild(textLabel);

      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = maxChars;
      input.className = "gemist-designer-panel__select gemist-designer-panel__engraving";
      input.placeholder =
        root.dataset.engravingPlaceholder ||
        `Maximum ${maxChars} characters`;
      input.value = designerState.engraving;
      input.setAttribute("aria-describedby", "gemist-engraving-hint");
      field.appendChild(input);

      const hint = document.createElement("p");
      hint.id = "gemist-engraving-hint";
      hint.className = "gemist-designer-panel__engraving-hint";
      const refreshHint = () => {
        const length = String(designerState.engraving || "").length;
        const invalid =
          designerState.engraving &&
          !ENGRAVING_ALLOWED_RE.test(designerState.engraving);
        hint.textContent = invalid
          ? root.dataset.engravingInvalid ||
            "Engraving supports letters, numbers, spaces, and , . ' - ! ? & only."
          : `Maximum ${maxChars} characters · ${length}/${maxChars}`;
        hint.dataset.invalid = invalid ? "true" : "false";
      };
      refreshHint();
      wrap.appendChild(field);

      const fontCaption = document.createElement("span");
      fontCaption.className = "gemist-designer-panel__select-label";
      fontCaption.textContent = root.dataset.engravingFontLabel || "Engraving Font";
      wrap.appendChild(fontCaption);

      const fontGrid = document.createElement("div");
      fontGrid.className = "gemist-designer-panel__engraving-fonts";
      fontGrid.setAttribute("role", "group");
      fontGrid.setAttribute("aria-label", fontCaption.textContent);

      const preview = document.createElement("p");
      preview.className = "gemist-designer-panel__engraving-preview";
      preview.setAttribute("aria-live", "polite");

      const refreshPreview = () => {
        const sample = designerState.engraving.trim() || "Forever";
        preview.dataset.font = designerState.engravingFont;
        preview.textContent = sample;
        preview.title =
          root.dataset.engravingPreviewNote ||
          "Representation only — final engraving may vary.";
      };

      fonts.forEach((font) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gemist-designer-panel__engraving-font";
        button.dataset.font = font;
        button.setAttribute(
          "aria-pressed",
          designerState.engravingFont === font ? "true" : "false",
        );
        const sample = document.createElement("span");
        sample.className = "gemist-designer-panel__engraving-font-sample";
        sample.dataset.font = font;
        sample.textContent = "Forever";
        const name = document.createElement("span");
        name.className = "gemist-designer-panel__engraving-font-name";
        name.textContent = font;
        button.appendChild(sample);
        button.appendChild(name);
        button.addEventListener("click", () => {
          designerState.engravingFont = font;
          fontGrid.querySelectorAll(".gemist-designer-panel__engraving-font").forEach((el) => {
            el.setAttribute(
              "aria-pressed",
              el.dataset.font === font ? "true" : "false",
            );
          });
          refreshPreview();
          status.hidden = true;
          if (typeof updateCta === "function") updateCta();
        });
        fontGrid.appendChild(button);
      });
      wrap.appendChild(fontGrid);

      const previewCaption = document.createElement("span");
      previewCaption.className = "gemist-designer-panel__select-label";
      previewCaption.textContent =
        root.dataset.engravingPreviewLabel || "Preview (representation)";
      wrap.appendChild(previewCaption);
      wrap.appendChild(preview);
      refreshPreview();

      input.addEventListener("input", () => {
        designerState.engraving = input.value.slice(0, maxChars);
        if (input.value !== designerState.engraving) {
          input.value = designerState.engraving;
        }
        refreshHint();
        refreshPreview();
        status.hidden = true;
        if (typeof updateCta === "function") updateCta();
      });
      field.appendChild(hint);

      if (fee > 0) {
        const feeLine = document.createElement("p");
        feeLine.className = "gemist-designer-panel__engraving-fee";
        feeLine.textContent = `Engraving: +${formatMoneyAmount(fee)}`;
        wrap.appendChild(feeLine);
      }

      const note = document.createElement("p");
      note.className = "gemist-designer-panel__engraving-note";
      note.textContent =
        root.dataset.engravingPreviewNote ||
        "Representation only — final engraving may vary.";
      wrap.appendChild(note);
    }

    return wrap;
  }

  function engravingFontOptions(root) {
    const raw = String(root?.dataset?.engravingFonts || "").trim();
    const parsed = raw
      ? raw.split("|").map((part) => part.trim()).filter(Boolean)
      : DEFAULT_ENGRAVING_FONTS.slice();
    return parsed.length ? parsed : DEFAULT_ENGRAVING_FONTS.slice();
  }

  function engravingFeeAmount(root) {
    const value = Number(root?.dataset?.engravingFee);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function productAmount(product) {
    const raw = product?.salePrice ?? product?.price;
    const amount = typeof raw === "number" ? raw : parseFloat(raw);
    if (!Number.isFinite(amount)) return NaN;
    return amount * resolveMarkupMultiplier(product);
  }

  function formatMoneyAmount(amount) {
    if (!Number.isFinite(amount)) return "";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      return `$${Math.round(amount)}`;
    }
  }

  function formatConfiguredPrice(root, product) {
    const base = productAmount(product);
    if (!Number.isFinite(base)) return "";
    const fee =
      designerState.engravingEnabled && root ? engravingFeeAmount(root) : 0;
    return formatMoneyAmount(base + fee);
  }

  function optionDisplayLabel(key, value) {
    const raw = String(value ?? "");
    if (!raw || raw.toUpperCase() === "NA") return "None";
    if (key === "coverage") {
      const map = {
        "1/2 Eternity": "Half Pavé",
        "3/4 Eternity": "¾ Pavé",
        "Full Eternity": "Full Pavé",
      };
      return map[raw] || raw;
    }
    if (key === "stone") {
      if (/laboratory\s*grown/i.test(raw)) return "Lab-Grown Diamond";
      if (/natural/i.test(raw)) return "Natural Diamond";
    }
    return raw;
  }

  function chainIndex(key) {
    const index = PART_CHAIN.indexOf(key);
    return index === -1 ? PART_CHAIN.length : index;
  }

  function upstreamParts(selected, key) {
    const limit = chainIndex(key);
    const parts = {};
    Object.entries(selected || {}).forEach(([partKey, value]) => {
      if (partKey === "ring_size") return;
      if (value == null || value === "" || typeof value === "object") return;
      if (chainIndex(partKey) < limit) parts[partKey] = String(value);
    });
    return parts;
  }

  function readPersistent(storageKey) {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || "null");
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function writePersistent(storageKey, value) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* storage full or blocked */
    }
  }

  function availabilityPrefixKey(parts) {
    const sorted = Object.keys(parts)
      .sort()
      .map((key) => `${key}=${parts[key]}`)
      .join("|");
    return `${apiScopeKey()}::${sorted}`;
  }

  function apiScopeKey() {
    return (commerce.apiBaseUrl || DEFAULT_API_BASE).replace(/\/+$/, "");
  }

  let availabilityStore = null;

  function availabilityEntries() {
    if (!availabilityStore) {
      const store = readPersistent(AVAILABILITY_STORAGE_KEY);
      availabilityStore =
        store?.entries && typeof store.entries === "object" ? store.entries : {};
    }
    return availabilityStore;
  }

  function readStoredAvailability(prefixKey) {
    const entry = availabilityEntries()[prefixKey];
    if (!entry || Date.now() - Number(entry.t || 0) > AVAILABILITY_TTL_MS) return null;
    return entry.m && typeof entry.m === "object" ? entry.m : null;
  }

  function storeAvailability(prefixKey, map) {
    const entries = availabilityEntries();
    entries[prefixKey] = { t: Date.now(), m: map };
    const keys = Object.keys(entries);
    if (keys.length > AVAILABILITY_MAX_ENTRIES) {
      keys
        .sort((a, b) => Number(entries[a].t || 0) - Number(entries[b].t || 0))
        .slice(0, keys.length - AVAILABILITY_MAX_ENTRIES)
        .forEach((key) => delete entries[key]);
    }
    writePersistent(AVAILABILITY_STORAGE_KEY, { entries });
  }

  // Availability for a key depends only on the parts before it in
  // PART_CHAIN, so one search per prefix answers that key for every product
  // sharing the prefix. Results persist for 24h across products and visits.
  function loadPrefixAvailability(baseProductId, parts) {
    const prefixKey = availabilityPrefixKey(parts);
    const known = availabilityMemory.get(prefixKey);
    if (known) return known instanceof Promise ? known : Promise.resolve(known.map);
    const stored = readStoredAvailability(prefixKey);
    if (stored) {
      availabilityMemory.set(prefixKey, { map: stored });
      return Promise.resolve(stored);
    }
    const request = proxySearch({
      ...(baseProductId ? { baseProductId } : {}),
      productParts: parts,
      limit: 1,
      offset: 0,
    })
      .then((payload) => {
        const map = payload?.availableProductParts;
        if (!map || typeof map !== "object" || !Object.keys(map).length) {
          availabilityMemory.delete(prefixKey);
          return null;
        }
        availabilityMemory.set(prefixKey, { map });
        storeAvailability(prefixKey, map);
        return map;
      })
      .catch(() => {
        availabilityMemory.delete(prefixKey);
        return null;
      });
    availabilityMemory.set(prefixKey, request);
    return request;
  }

  // Synchronous lookup: array of allowed values, null when every value is
  // allowed (no upstream constraint), or undefined while still unknown.
  function knownAllowedValues(selected, key) {
    const parts = upstreamParts(selected, key);
    if (!Object.keys(parts).length) return null;
    const known = availabilityMemory.get(availabilityPrefixKey(parts));
    if (known && !(known instanceof Promise)) {
      const values = known.map?.[key];
      return Array.isArray(values) ? values.map(String) : null;
    }
    const stored = readStoredAvailability(availabilityPrefixKey(parts));
    if (stored) {
      availabilityMemory.set(availabilityPrefixKey(parts), { map: stored });
      const values = stored[key];
      return Array.isArray(values) ? values.map(String) : null;
    }
    return undefined;
  }

  async function loadAllowedValues(product, selected, key) {
    const parts = upstreamParts(selected, key);
    if (!Object.keys(parts).length) return null;
    const map = await loadPrefixAvailability(product?.baseProductId, parts);
    const values = map?.[key];
    return Array.isArray(values) ? values.map(String) : null;
  }

  function warmAvailability(product, selected) {
    const parts = selected || currentParts(product || {});
    PART_CHAIN.forEach((key) => {
      if (parts[key] == null && key !== "ring_size") return;
      loadAllowedValues(product, parts, key).catch(() => {});
    });
  }

  function cachedPartsMap() {
    if (partsMapState.map) return partsMapState.map;
    const stored = readPersistent(PARTS_MAP_STORAGE_KEY);
    const entry = stored?.[apiScopeKey()];
    if (entry && Date.now() - Number(entry.t || 0) <= AVAILABILITY_TTL_MS && entry.m) {
      partsMapState.map = entry.m;
      return entry.m;
    }
    return null;
  }

  // The unconstrained search is slow (5-10s) but identical for every
  // product, so it is fetched once in the background and shared.
  function loadPartsMap(baseProductId) {
    const cached = cachedPartsMap();
    if (cached) return Promise.resolve(cached);
    if (partsMapState.promise) return partsMapState.promise;
    if (!baseProductId) return Promise.resolve(null);
    partsMapState.promise = proxySearch({ baseProductId, limit: 1, offset: 0 })
      .then((payload) => {
        const map = payload?.availableProductParts;
        if (!map || typeof map !== "object" || !Object.keys(map).length) return null;
        partsMapState.map = map;
        const stored = readPersistent(PARTS_MAP_STORAGE_KEY) || {};
        stored[apiScopeKey()] = { t: Date.now(), m: map };
        writePersistent(PARTS_MAP_STORAGE_KEY, stored);
        return map;
      })
      .catch(() => null)
      .finally(() => {
        partsMapState.promise = null;
      });
    return partsMapState.promise;
  }

  function sortOptionValues(key, values) {
    const numeric = (value) => {
      const match = String(value).replace(/^~/, "").match(/^(\d+(?:\.\d+)?)/);
      return match ? Number(match[1]) : NaN;
    };
    if (
      (key === "ring_size" || key === "band_width") &&
      values.every((value) => Number.isFinite(numeric(value)))
    ) {
      return values.slice().sort((a, b) => numeric(a) - numeric(b));
    }
    return values;
  }

  function mergeAvailableParts(nextParts, prevParts) {
    const prev = prevParts && typeof prevParts === "object" ? prevParts : {};
    const next = nextParts && typeof nextParts === "object" ? { ...nextParts } : {};
    const nextKeys = Object.keys(next).filter((key) => Array.isArray(next[key]) && next[key].length);
    if (!nextKeys.length) return { ...prev };

    // Keep prior option lists when the API returns a sparse/partial map
    // (common after ring_size updates).
    Object.keys(prev).forEach((key) => {
      if ((!next[key] || !next[key].length) && Array.isArray(prev[key]) && prev[key].length) {
        next[key] = prev[key];
      }
    });
    return next;
  }

  function buildDesignerIframeUrl(root, product) {
    const base = apiBaseOf(root).replace(/\/+$/, "") + "/";
    const path = (root.dataset.designerPath || "designer/bands").replace(/^\/+/, "");
    const defaultShape = root.dataset.designerDefaultShape || "Asscher";

    const pageParams = new URLSearchParams(window.location.search);
    const styleId =
      pageParams.get("style_id") ||
      product.baseProductId ||
      product.id ||
      "";
    const settingTag = pageParams.get("setting_tag") || "";
    const style = pageParams.get("style") || product.style || "";

    let iframeUrl = `${base}${path}?shape=${encodeURIComponent(defaultShape)}`;
    if (styleId) {
      iframeUrl = `${base}${path}?style_id=${encodeURIComponent(styleId)}`;
    }

    if (settingTag) {
      const iframeUrlObject = new URL(iframeUrl);
      iframeUrlObject.searchParams.set("setting_tag", settingTag);
      if (style) iframeUrlObject.searchParams.set("style", style);
      iframeUrl = iframeUrlObject.toString();
    }

    return iframeUrl;
  }

  function ensureDesignerMessageListener() {
    if (designerListening) return;
    designerListening = true;

    window.addEventListener("message", (event) => {
      if (!event.data) return;

      let message;
      try {
        message =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || !message.type) return;

      const designerIframe = document.getElementById("designer-iframe");

      switch (message.type) {
        case "buy":
          handleDesignerBuy(message, designerIframe);
          break;
        case "updateParams":
          handleDesignerUpdateParams(message);
          break;
        case "download":
          if (message.downloadHref) window.open(message.downloadHref, "_blank");
          break;
        case "copywindowlocation":
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(window.location.href).catch((error) => {
              console.error("[gemist designer] clipboard copy failed", error);
            });
          }
          break;
        case "sendemail":
          handleDesignerSendEmail(message);
          break;
        case "requestParentWindowHref":
          if (designerIframe?.contentWindow) {
            designerIframe.contentWindow.postMessage(window.location.href, "*");
          }
          break;
        case "requestfullscreen":
          if (designerIframe?.requestFullscreen) {
            designerIframe.requestFullscreen().catch(() => {});
          }
          break;
        default:
          break;
      }
    });
  }

  function handleDesignerUpdateParams(message) {
    const paramNames = Array.isArray(message.paramNames) ? message.paramNames : [];
    if (!paramNames.length) return;
    const currentURL = new URL(window.location.href);
    paramNames.forEach((paramName) => {
      const paramValue = message[paramName];
      if (paramValue !== undefined && paramValue !== null) {
        currentURL.searchParams.set(paramName, String(paramValue));
      }
    });
    window.history.replaceState({}, "", currentURL.toString());
  }

  function handleDesignerSendEmail(message) {
    let emailContent = String(message.emailContent || "");
    const subject = String(message.subject || "");
    const recipient = String(message.recipient || "");
    emailContent = emailContent.replace("{{currentPageLink}}", window.location.href);
    const mailtoLink =
      "mailto:" +
      recipient +
      "?subject=" +
      encodeURIComponent(subject) +
      "&body=" +
      encodeURIComponent(emailContent);
    window.open(mailtoLink, "_blank");
  }

  async function handleDesignerBuy(message, designerIframe) {
    const ring = message.ring || {};
    const diamond = message.diamond || {};
    const ringProductId = String(
      ring.variantId || ring.productId || ring.id || "",
    ).trim();
    const ringSku = String(ring.sku || "").trim();

    if (!ringProductId) {
      postDesignerCartStatus(designerIframe, "error");
      return;
    }

    try {
      await addGemistLineToShopifyCart(ringProductId, {
        sku: ringSku,
        engraving: designerState.engraving,
      });

      const diamondProductId = String(
        diamond.variantId || diamond.productId || diamond.id || "",
      ).trim();
      if (diamondProductId) {
        await addGemistLineToShopifyCart(diamondProductId, {
          sku: String(diamond.vendorsProductId || diamond.sku || "").trim(),
        });
      }

      window.location.href = "/cart";
    } catch (error) {
      console.error("[gemist designer] buy failed", error);
      postDesignerCartStatus(designerIframe, "error");
    }
  }

  function postDesignerCartStatus(designerIframe, status) {
    if (!designerIframe?.contentWindow) return;
    designerIframe.contentWindow.postMessage({ type: "cart", status }, "*");
  }

  async function addGemistLineToShopifyCart(gemistProductId, options = {}) {
    const proxyRes = await fetch("/apps/gemist/cart/add", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        gemistProductId,
        engraving: options.engraving || "",
        engravingFont: options.engravingFont || "",
        engravingFee: options.engravingFee || 0,
        sku: options.sku || "",
        ring_size: options.ring_size || "",
      }),
    });
    const payload = await readJson(proxyRes);
    if (!payload.variantId) {
      throw new Error(payload.error || "Could not add this item to the cart.");
    }

    const properties = { ...(payload.properties || {}) };
    if (options.ring_size) properties["Ring Size"] = String(options.ring_size);
    if (options.engraving) {
      properties.Engraving = String(options.engraving);
      if (options.engravingFont) {
        properties["Engraving Font"] = String(options.engravingFont);
      }
      if (Number(options.engravingFee) > 0) {
        properties["Engraving Cost"] = `+$${Math.round(Number(options.engravingFee))}`;
      }
    }

    const cartRes = await fetch("/cart/add.js", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [
          {
            id: payload.variantId,
            quantity: 1,
            properties,
          },
        ],
      }),
    });
    const cartPayload = await cartRes.json().catch(() => ({}));
    if (!cartRes.ok) {
      throw new Error(
        cartPayload.description ||
          cartPayload.message ||
          "Could not add this item to the Shopify cart.",
      );
    }
    return cartPayload;
  }

  function renderMedia(root, product) {
    const media = document.createElement("div");
    media.className = "gemist-detail__media";
    const stills = (product.images || []).map(mediaUrl).filter(Boolean);
    const spin = (product.images360 || []).map(mediaUrl).filter(Boolean);
    const imageSrc = stills[0] || productImage(product) || "";
    const hero = document.createElement(imageSrc || spin.length ? "img" : "div");
    hero.className = "gemist-detail__hero";
    if (hero.tagName === "IMG") {
      hero.alt = productTitle(product);
    } else {
      hero.setAttribute("aria-label", productTitle(product));
    }

    const frame = document.createElement("div");
    frame.className = "gemist-detail__hero-frame";

    if (spin.length > 1) {
      hero.classList.add("gemist-detail__hero--spin");
      bindSpin(hero, spin);
      frame.appendChild(hero);
      media.appendChild(frame);
      const hint = document.createElement("p");
      hint.className = "gemist-detail__rotate";
      hint.textContent = root.dataset.rotateLabel || "Drag to rotate";
      media.appendChild(hint);
    } else {
      if (hero.tagName === "IMG") {
        hero.src = imageSrc;
        hero.draggable = false;
        hero.style.userSelect = "none";
      }
      frame.appendChild(hero);
      media.appendChild(frame);

      if (stills.length > 1) {
        let detailIndex = 0;
        let detailStartX = 0;
        let detailDragging = false;
        frame.style.touchAction = "pan-y";
        frame.style.overflow = "hidden";

        const detailSnapBack = () => {
          hero.style.transition = "transform 0.25s ease-out, opacity 0.25s ease-out";
          hero.style.transform = "translateX(0)";
          hero.style.opacity = "1";
        };

        const detailShow = (i) => {
          if (hero.tagName !== "IMG") return;
          detailIndex = ((i % stills.length) + stills.length) % stills.length;
          hero.src = stills[detailIndex];
          const thumbButtons = media.querySelectorAll(".gemist-detail__thumb");
          thumbButtons.forEach((el) => el.removeAttribute("aria-current"));
          if (thumbButtons[detailIndex]) thumbButtons[detailIndex].setAttribute("aria-current", "true");
        };

        frame.addEventListener("pointerdown", (e) => {
          if (e.target.closest("button")) return;
          detailStartX = e.clientX;
          detailDragging = true;
          hero.style.transition = "none";
          frame.setPointerCapture(e.pointerId);
        }, { passive: true });

        frame.addEventListener("pointermove", (e) => {
          if (!detailDragging) return;
          const diff = e.clientX - detailStartX;
          hero.style.transform = `translateX(${diff}px)`;
          hero.style.opacity = 1 - Math.min(Math.abs(diff) / 250, 0.6);
        }, { passive: true });

        frame.addEventListener("pointerup", (e) => {
          if (!detailDragging) return;
          detailDragging = false;
          frame.releasePointerCapture(e.pointerId);
          const diff = e.clientX - detailStartX;
          if (Math.abs(diff) > 50) {
            const sign = diff < 0 ? -1 : 1;
            hero.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out";
            hero.style.transform = `translateX(${sign * 150}px)`;
            hero.style.opacity = "0";
            setTimeout(() => {
              if (diff < 0) detailShow(detailIndex + 1);
              else detailShow(detailIndex - 1);
              hero.style.transition = "none";
              hero.style.transform = `translateX(${-sign * 100}px)`;
              void hero.offsetWidth;
              detailSnapBack();
            }, 200);
          } else {
            detailSnapBack();
          }
        }, { passive: true });

        frame.addEventListener("pointercancel", () => {
          if (!detailDragging) return;
          detailDragging = false;
          detailSnapBack();
        });
      }
    }

    if (stills.length > 1) {
      const thumbs = document.createElement("div");
      thumbs.className = "gemist-detail__thumbs";
      stills.forEach((src, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gemist-detail__thumb";
        if (index === 0 && spin.length < 2) button.setAttribute("aria-current", "true");
        const thumb = document.createElement("img");
        thumb.src = src;
        thumb.alt = "";
        button.appendChild(thumb);
        const handleSelect = () => {
          hero.src = src;
          thumbs.querySelectorAll("[aria-current]").forEach((el) => {
            el.removeAttribute("aria-current");
          });
          button.setAttribute("aria-current", "true");
        };
        button.addEventListener("click", handleSelect);
        button.addEventListener("mouseenter", handleSelect);
        thumbs.appendChild(button);
      });
      media.appendChild(thumbs);
    }

    return media;
  }

  function bindSpin(hero, frames) {
    let index = 0;
    let startX = 0;
    let startIndex = 0;
    let dragging = false;
    const step = Math.max(6, Math.round(280 / frames.length));
    hero.src = frames[0];
    hero.draggable = false;

    const show = (next) => {
      index = ((next % frames.length) + frames.length) % frames.length;
      hero.src = frames[index];
    };

    hero.addEventListener("pointerdown", (event) => {
      dragging = true;
      startX = event.clientX;
      startIndex = index;
      hero.setPointerCapture(event.pointerId);
    });
    hero.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      show(startIndex + Math.round((event.clientX - startX) / step));
    });
    const stop = () => {
      dragging = false;
    };
    hero.addEventListener("pointerup", stop);
    hero.addEventListener("pointercancel", stop);
  }

  function retryButton(root, onRetry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gemist-retry";
    button.dataset.gemistRetry = "true";
    button.textContent = root.dataset.retryLabel || "Try again";
    button.addEventListener("click", onRetry);
    return button;
  }

  function renderActions(root, product) {
    const wrap = document.createElement("div");
    wrap.className = "gemist-detail__actions";

    wrap.appendChild(renderAddToCart(root, product));

    if (isProductCustomizable(product)) {
      const customize = document.createElement("a");
      customize.className = "gemist-detail__secondary";
      customize.href = catalogUrl({
        productId: product.id,
        slug: product.slug,
        page: queryParam(PAGE_PARAM),
        customize: true,
      });
      customize.textContent =
        root.dataset.cardCustomizeLabel ||
        root.dataset.customizeLabel ||
        "Customize your ring";
      const warm = () => {
        prefetchConfiguredProduct(product).catch(() => {});
      };
      customize.addEventListener("pointerenter", warm, { once: true });
      customize.addEventListener("focus", warm, { once: true });
      wrap.appendChild(customize);
    }

    const appointment = renderAppointment(root);
    if (appointment) {
      appointment.className = "gemist-detail__tertiary";
      wrap.appendChild(appointment);
    }

    return wrap;
  }

  function renderAppointment(root) {
    // Deferred / out of SOW unless the commerce proxy enables appointments.
    if (commerce.appointmentsEnabled === false) return null;
    if (!commerce.appointmentUrl && !commerce.appointmentEmail) return null;
    const label = commerce.appointmentLabel || root.dataset.appointmentLabel || "Schedule an appointment";
    if (commerce.appointmentUrl) {
      const link = document.createElement("a");
      link.className = "gemist-detail__tertiary";
      link.href = commerce.appointmentUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `${label} →`;
      return link;
    }
    if (commerce.appointmentEmail) {
      const link = document.createElement("a");
      link.className = "gemist-detail__tertiary";
      link.href = `mailto:${commerce.appointmentEmail}`;
      link.textContent = `${label} →`;
      return link;
    }
    return null;
  }

  function renderDesigner(root, product, options = {}) {
    const pageMode = Boolean(options.pageMode);
    const wrap = document.createElement("section");
    wrap.className = "gemist-designer";
    wrap.id = "gemist-designer";
    wrap.dataset.gemistDesigner = "true";

    const heading = document.createElement("h2");
    heading.className = "gemist-designer__heading";
    heading.textContent = root.dataset.designerLabel || "Customize your ring";
    wrap.appendChild(heading);

    const status = document.createElement("p");
    status.className = "gemist-designer__status";
    status.hidden = true;
    wrap.appendChild(status);

    const available = product.availableProductParts || {};
    const selected =
      product.selectedProductParts ||
      product.productParts ||
      product.defaultProductMetadata ||
      {};
    const keys = Object.keys(available).length
      ? OPTION_ORDER.filter((key) => available[key]?.length).concat(
          Object.keys(available).filter((key) => !OPTION_ORDER.includes(key)),
        )
      : [];

    if (!keys.length) {
      status.hidden = false;
      status.textContent = "Configuration options will appear when Gemist returns available parts.";
      return wrap;
    }

    const applyChange = async () => {
      const nextParts = readDesignerParts(wrap, selected);
      status.hidden = false;
      status.textContent = "Updating configuration…";
      setDesignerDisabled(wrap, true);
      try {
        const next = await configureProduct(apiBaseOf(root), product, nextParts);
        const url = catalogUrl({
          productId: next.id,
          slug: next.slug,
          page: queryParam(PAGE_PARAM),
          customize: true,
        });
        window.history.replaceState({}, "", url);
        if (pageMode) {
          const designerPage = root.querySelector("[data-gemist-designer-page]");
          if (designerPage) {
            designerPage.replaceChildren(renderDesignerPage(root, next));
          }
        } else {
          const detail = root.querySelector("[data-gemist-detail]");
          if (detail) {
            detail.replaceChildren(renderDetail(root, next));
          }
        }
      } catch {
        status.hidden = false;
        status.textContent = "That combination is not available. Try another option.";
        setDesignerDisabled(wrap, false);
      }
    };

    keys.forEach((key) => {
      const values = available[key] || [];
      const field = document.createElement("div");
      field.className = "gemist-designer__field";
      const caption = document.createElement("span");
      caption.textContent = designerTabLabel(key);
      field.appendChild(caption);

      if (values.length > 16 || key === "ring_size") {
        const select = document.createElement("select");
        select.dataset.gemistOption = key;
        values.forEach((value) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = optionDisplayLabel(key, value);
          if (String(selected[key] || "") === String(value)) option.selected = true;
          select.appendChild(option);
        });
        select.addEventListener("change", applyChange);
        field.appendChild(select);
      } else {
        const chips = document.createElement("div");
        chips.className = "gemist-designer__chips";
        chips.setAttribute("role", "group");
        chips.setAttribute("aria-label", designerTabLabel(key));
        values.forEach((value) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "gemist-designer__chip";
          if (key === "metal_color" || key === "metal") {
            chip.classList.add("gemist-designer__chip--swatch");
            const dot = document.createElement("span");
            dot.className = "gemist-designer__swatch";
            dot.style.background = metalSwatch(value);
            chip.appendChild(dot);
          }
          chip.dataset.gemistOption = key;
          chip.dataset.value = value;
          const label = document.createElement("span");
          label.textContent = optionDisplayLabel(key, value);
          chip.appendChild(label);
          chip.setAttribute(
            "aria-pressed",
            String(selected[key] || "") === String(value) ? "true" : "false",
          );
          chip.addEventListener("click", () => {
            chips.querySelectorAll("[data-gemist-option]").forEach((el) => {
              el.setAttribute("aria-pressed", "false");
            });
            chip.setAttribute("aria-pressed", "true");
            applyChange();
          });
          chips.appendChild(chip);
        });
        field.appendChild(chips);
      }
      wrap.appendChild(field);
    });

    wrap.appendChild(renderEngravingPanel(root, document.createElement("p"), () => {}));

    return wrap;
  }

  function readDesignerParts(wrap, fallback) {
    const parts = { ...fallback };
    wrap.querySelectorAll("select[data-gemist-option]").forEach((select) => {
      parts[select.dataset.gemistOption] = select.value;
    });
    wrap.querySelectorAll("button[data-gemist-option][aria-pressed='true']").forEach((chip) => {
      parts[chip.dataset.gemistOption] = chip.dataset.value;
    });
    return parts;
  }

  function setDesignerDisabled(wrap, disabled) {
    wrap.querySelectorAll("button, select, input").forEach((el) => {
      el.disabled = disabled;
    });
  }

  function metalSwatch(value) {
    const text = String(value).toLowerCase();
    const metallic = (dark, mid, light) =>
      `linear-gradient(135deg, ${dark} 0%, ${mid} 38%, ${light} 52%, ${mid} 66%, ${dark} 100%)`;
    // Colour words must win over karat words: "14K White Gold" is white.
    if (text.includes("rose")) return metallic("#a8646c", "#c98b8f", "#f1cfc9");
    if (text.includes("white") || text.includes("rhodium")) {
      return metallic("#b9bcc0", "#dcdee1", "#ffffff");
    }
    if (text.includes("platinum")) return metallic("#9da1a8", "#c9ccd1", "#f2f3f5");
    if (text.includes("silver")) return metallic("#a3a6aa", "#cfd1d4", "#f7f7f8");
    if (text.includes("yellow") || text.includes("gold")) {
      return metallic("#b58a2e", "#d9b25a", "#f6e3a4");
    }
    return metallic("#8a8a8a", "#b0b0b0", "#dcdcdc");
  }

  function slugifyPart(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function styleSlugFor(product, selected, styleValue) {
    const valueSlug = slugifyPart(styleValue);
    if (!valueSlug) return "";
    const known = Array.isArray(memory.slugs) && memory.slugs.length
      ? memory.slugs
      : Object.keys(memory.bySlug);
    // Shortest match so "milgrain-high-polish" beats "knife-edge-w-milgrain-high-polish".
    const matches = known
      .filter((slug) => slug === valueSlug || slug.endsWith(`-${valueSlug}`))
      .sort((a, b) => a.length - b.length);
    if (matches.length) return matches[0];
    const currentStyle = slugifyPart(selected?.style || product?.style);
    const productSlug = String(product?.slug || "");
    if (currentStyle && productSlug.endsWith(currentStyle)) {
      return productSlug.slice(0, productSlug.length - currentStyle.length) + valueSlug;
    }
    return "";
  }

  function fillStyleThumb(thumb, product, selected, styleValue) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    const show = (src) => {
      if (!src) return;
      img.src = src;
      if (!img.isConnected) thumb.appendChild(img);
    };

    const currentStyle = String(selected?.style || product?.style || "");
    if (currentStyle && currentStyle === String(styleValue)) {
      show(productImage(product));
      return;
    }
    const slug = styleSlugFor(product, selected, styleValue);
    if (!slug) return;
    const cached = memory.bySlug[slug];
    if (cached && productImage(cached)) {
      show(productImage(cached));
      return;
    }
    loadStyleProduct(slug)
      .then((styleProduct) => show(styleProduct && productImage(styleProduct)))
      .catch(() => {});
  }

  function optionMark(value) {
    const text = String(value || "").trim();
    if (!text || text.toUpperCase() === "NA") return "—";
    if (/^1\/2\b/i.test(text)) return "½";
    if (/^3\/4\b/i.test(text)) return "¾";
    if (/^full\b/i.test(text)) return "Full";
    if (/laboratory\s*grown/i.test(text)) return "Lab";
    if (/natural/i.test(text)) return "Nat";
    if (/^[~\d]/.test(text) || text.length <= 4) return text;
    const words = text.split(/[\s/-]+/).filter(Boolean);
    return words
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join("");
  }

  async function proxySearch(body) {
    return readJson(
      await fetch(withPreview(PRODUCTS_PROXY), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  // Warms everything the designer needs (shared option map + per-tab
  // availability) without blocking any render.
  async function prefetchConfiguredProduct(product) {
    if (!product?.baseProductId) return product;
    loadPartsMap(product.baseProductId).catch(() => {});
    warmAvailability(product, currentParts(product));
    return product;
  }

  async function configureProduct(_apiBase, product, productParts) {
    const payload = await proxySearch({
      baseProductId: product.baseProductId,
      productParts,
      limit: 1,
      offset: 0,
    });
    const next = asProduct(payload.products && payload.products[0]);
    if (!next) throw new Error("That combination is not available.");
    next.availableProductParts = mergeAvailableParts(
      payload.availableProductParts,
      product.availableProductParts,
    );
    next.selectedProductParts = {
      ...(product.selectedProductParts || {}),
      ...(payload.selectedProductParts || productParts || {}),
    };
    cacheProduct(next, next.slug);
    return next;
  }

  // Tries the full selection and an upstream-only fallback in parallel so an
  // invalid downstream combination costs one round trip, not two.
  async function configureSelection(root, product, selected, key, value) {
    const strictParts = { ...selected, [key]: value };
    const fallbackParts = { ...upstreamParts(selected, key), [key]: value };
    if (selected.ring_size) fallbackParts.ring_size = selected.ring_size;
    const strict = configureProduct(apiBaseOf(root), product, strictParts);
    const fallback =
      JSON.stringify(fallbackParts) === JSON.stringify(strictParts)
        ? strict
        : configureProduct(apiBaseOf(root), product, fallbackParts);
    try {
      return await strict;
    } catch {
      return fallback;
    }
  }

  function currentParts(product) {
    const source =
      product.selectedProductParts ||
      product.productParts ||
      product.defaultProductMetadata ||
      {};
    const parts = {};
    Object.entries(source).forEach(([key, value]) => {
      if (value == null || value === "" || typeof value === "object") return;
      parts[key] = String(value);
    });
    return parts;
  }

  async function loadCommerce() {
    if (commercePromise) return commercePromise;
    commercePromise = loadCommerceOnce();
    return commercePromise;
  }

  async function loadCommerceOnce() {
    const embeddedStyles = document.getElementById("gemist-widget-styles");
    if (embeddedStyles && embeddedStyles.textContent) {
      try {
        applyWidgetStyles(JSON.parse(embeddedStyles.textContent));
      } catch {
        /* ignore invalid metafield json */
      }
    }
    const embedded = document.getElementById("gemist-commerce-settings");
    if (embedded && embedded.textContent) {
      try {
        applyCommerce(JSON.parse(embedded.textContent));
      } catch {
        /* ignore invalid metafield json */
      }
    }
    try {
      const payload = await readJson(
        await fetch(withPreview("/apps/gemist/commerce"), {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        }),
      );
      applyCommerce(payload);
    } catch {
      /* keep metafield or defaults */
    }
  }

  function applyCommerce(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.apiBaseUrl) {
      commerce.apiBaseUrl = String(payload.apiBaseUrl).replace(/\/+$/, "");
    }
    if (payload.markupPercent != null) {
      commerce.markupPercent = Number(payload.markupPercent) || 0;
    }
    if (Array.isArray(payload.markupRules)) {
      commerce.markupRules = payload.markupRules;
    }
    if (payload.appointmentsEnabled != null) {
      commerce.appointmentsEnabled = Boolean(payload.appointmentsEnabled);
    }
    if (payload.appointmentUrl != null) {
      commerce.appointmentUrl = payload.appointmentUrl || "";
    }
    if (payload.appointmentEmail != null) {
      commerce.appointmentEmail = payload.appointmentEmail || "";
    }
    if (payload.appointmentLabel) {
      commerce.appointmentLabel = payload.appointmentLabel;
    }
    if (payload.styles) {
      applyWidgetStyles(payload.styles);
    }
  }

  function applyWidgetStyles(styles) {
    if (!styles || typeof styles !== "object") return;
    document.querySelectorAll("[data-gemist-products]").forEach((root) => {
      const catalog =
        root.querySelector("[data-gemist-catalog]") || root;
      const detailRoots = [
        root.querySelector("[data-gemist-detail]"),
        root.querySelector("[data-gemist-designer-page]"),
      ].filter(Boolean);

      const products = styles.products;
      if (products && typeof products === "object") {
        // Grid-only vars — do not put these on the shared root or PDP inherits card sizing.
        setCssVar(catalog, "--gemist-heading-size", px(products.headingFontSize));
        setCssVar(catalog, "--gemist-title-size", px(products.titleFontSize));
        setCssVar(catalog, "--gemist-body-size", px(products.bodyFontSize));
        setCssVar(catalog, "--gemist-price-size", px(products.priceFontSize));
        setCssVar(catalog, "--gemist-image-size", px(products.imageSize));
        setCssVar(catalog, "--gemist-card-max-width", px(products.cardMaxWidth));
        setCssVar(catalog, "--gemist-card-padding", px(products.cardPadding));
        setCssVar(catalog, "--gemist-setting-radius", px(products.cardRadius));
        setCssVar(catalog, "--gemist-radius", px(products.cardRadius));
        setCssVar(catalog, "--gemist-gap", px(products.gridGap));
        if (products.columns != null) {
          setCssVar(root, "--gemist-cols", String(products.columns));
          setCssVar(catalog, "--gemist-cols", String(products.columns));
        }
        if (products.background) {
          setCssVar(catalog, "--gemist-setting-bg", products.background);
          setCssVar(catalog, "--gemist-bg", products.background);
        }
        if (products.textColor) {
          setCssVar(catalog, "--gemist-setting-text", products.textColor);
          setCssVar(catalog, "--gemist-text", products.textColor);
        }
        if (products.accentColor) {
          setCssVar(catalog, "--gemist-setting-accent", products.accentColor);
          setCssVar(catalog, "--gemist-accent", products.accentColor);
        }
      }

      const detail = styles.detail;
      if (detail && typeof detail === "object") {
        detailRoots.forEach((el) => {
          setCssVar(el, "--gemist-detail-title-size", px(clampNum(detail.titleFontSize, 32, 56)));
          setCssVar(el, "--gemist-detail-body-size", px(clampNum(detail.bodyFontSize, 14, 20)));
          setCssVar(el, "--gemist-detail-price-size", px(clampNum(detail.priceFontSize, 22, 36)));
          setCssVar(el, "--gemist-detail-image-size", px(clampNum(detail.imageSize, 320, 640)));
          setCssVar(el, "--gemist-detail-thumb-size", px(clampNum(detail.thumbSize, 72, 88)));
          setCssVar(el, "--gemist-detail-gap", px(clampNum(detail.cardPadding, 8, 32)));
          setCssVar(el, "--gemist-detail-radius", px(clampNum(detail.cardRadius, 0, 28)));
          setCssVar(el, "--gemist-detail-specs-heading-size", px(clampNum(detail.specsHeadingSize, 10, 16)));
          setCssVar(el, "--gemist-detail-specs-label-size", px(clampNum(detail.specsLabelSize, 11, 18)));
          setCssVar(el, "--gemist-detail-specs-value-size", px(clampNum(detail.specsValueSize, 12, 20)));
          setCssVar(el, "--gemist-detail-specs-row-gap", px(clampNum(detail.specsRowGap, 4, 24)));
          setCssVar(el, "--gemist-detail-specs-column-gap", px(clampNum(detail.specsColumnGap, 16, 48)));
          setCssVar(el, "--gemist-detail-specs-section-gap", px(clampNum(detail.specsSectionGap, 16, 64)));
          if (detail.specsColumns != null) {
            setCssVar(el, "--gemist-detail-specs-columns", String(detail.specsColumns));
          }
          if (detail.background) {
            setCssVar(el, "--gemist-setting-bg", detail.background);
            setCssVar(el, "--gemist-bg", detail.background);
            setCssVar(el, "--gemist-lux-bg", detail.background);
          }
          if (detail.textColor) {
            setCssVar(el, "--gemist-setting-text", detail.textColor);
            setCssVar(el, "--gemist-text", detail.textColor);
            setCssVar(el, "--gemist-lux-primary", detail.textColor);
          }
          if (detail.accentColor) {
            setCssVar(el, "--gemist-setting-accent", detail.accentColor);
            setCssVar(el, "--gemist-accent", detail.accentColor);
            setCssVar(el, "--gemist-lux-accent", detail.accentColor);
          }
        });
      }
    });
    applyCustomCss(styles);
  }

  function applyCustomCss(styles) {
    if (!styles || typeof styles !== "object") return;
    const ids = {
      products: "gemist-custom-css-products",
      detail: "gemist-custom-css-detail",
    };
    for (const key of Object.keys(ids)) {
      const id = ids[key];
      const block = styles[key]?.customCss;
      const css = sanitizeCustomCss(block);
      let el = document.getElementById(id);
      if (!css) {
        if (el) el.remove();
        continue;
      }
      if (!el) {
        el = document.createElement("style");
        el.id = id;
        document.head.appendChild(el);
      }
      el.textContent = css;
    }
  }

  function sanitizeCustomCss(input) {
    if (typeof input !== "string") return "";
    let css = input.trim();
    if (!css) return "";
    css = css.replace(/<\/style/gi, "");
    css = css.replace(/<script/gi, "");
    css = css.replace(/javascript:/gi, "");
    css = css.replace(/expression\s*\(/gi, "");
    return css.slice(0, 12000);
  }

  function setCssVar(el, name, value) {
    if (value == null || value === "") return;
    el.style.setProperty(name, String(value), "important");
  }

  function px(value) {
    if (value == null || value === "") return "";
    const text = String(value);
    return /px$/.test(text) ? text : `${text}px`;
  }

  function clampNum(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return min;
    return Math.min(max, Math.max(min, numeric));
  }

  function renderAddToCart(root, product) {
    const wrap = document.createElement("div");
    wrap.className = "gemist-detail__cart";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "gemist-detail__add";
    const idleLabel = root.dataset.addLabel || "Add to cart";
    button.textContent = idleLabel;

    const errorEl = document.createElement("p");
    errorEl.className = "gemist-detail__cart-error";
    errorEl.hidden = true;

    button.addEventListener("click", async () => {
      if (!product.id) {
        errorEl.hidden = false;
        errorEl.textContent = "This product is missing an id.";
        return;
      }

      errorEl.hidden = true;
      const engravingError = validateEngravingState(root);
      if (engravingError) {
        errorEl.hidden = false;
        errorEl.textContent = engravingError;
        return;
      }
      button.disabled = true;
      button.textContent = root.dataset.addingLabel || "Adding…";

      try {
        await addGemistLineToShopifyCart(product.id, {
          engraving: designerState.engravingEnabled
            ? designerState.engraving.trim()
            : "",
          engravingFont: designerState.engravingEnabled
            ? designerState.engravingFont
            : "",
          engravingFee: designerState.engravingEnabled
            ? engravingFeeAmount(root)
            : 0,
          sku: product.sku || "",
        });
        window.location.href = "/cart";
      } catch (error) {
        errorEl.hidden = false;
        errorEl.textContent =
          error instanceof Error
            ? error.message
            : root.dataset.cartErrorLabel || "Could not add this item to the cart.";
        button.disabled = false;
        button.textContent = idleLabel;
      }
    });

    wrap.appendChild(button);
    wrap.appendChild(errorEl);
    return wrap;
  }

  function renderPager(pager, page, pageCount, total, root) {
    pager.replaceChildren();
    if (pageCount <= 1) {
      pager.hidden = true;
      return;
    }

    const numbers = document.createElement("div");
    numbers.className = "gemist-products__page-numbers";
    const maxVisible = 7;
    let start = 1;
    let end = pageCount;
    if (pageCount > maxVisible) {
      start = Math.max(1, page - 2);
      end = Math.min(pageCount, start + maxVisible - 1);
      start = Math.max(1, end - maxVisible + 1);
    }
    for (let index = start; index <= end; index += 1) {
      const link = document.createElement("a");
      link.className = "gemist-products__page-num";
      link.textContent = String(index);
      if (index === page) {
        link.setAttribute("aria-current", "page");
        link.setAttribute("aria-label", `Page ${index}`);
      } else {
        link.href = catalogUrl({ page: index });
        link.setAttribute("aria-label", `Go to page ${index}`);
      }
      numbers.appendChild(link);
    }

    const nav = document.createElement("div");
    nav.className = "gemist-products__page-nav";

    const chevron = (dir) =>
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
        dir === "prev"
          ? '<polyline points="15 18 9 12 15 6"/>'
          : '<polyline points="9 18 15 12 9 6"/>'
      }</svg>`;

    const prev = document.createElement("a");
    prev.className = "gemist-products__page-btn gemist-products__page-btn--prev";
    prev.innerHTML = chevron("prev");
    prev.setAttribute("aria-label", root.dataset.prevLabel || "Previous");
    if (page <= 1) prev.setAttribute("aria-disabled", "true");
    else prev.href = catalogUrl({ page: page - 1 });

    const next = document.createElement("a");
    next.className = "gemist-products__page-btn gemist-products__page-btn--next";
    next.innerHTML = chevron("next");
    next.setAttribute("aria-label", root.dataset.nextLabel || "Next");
    if (page >= pageCount) next.setAttribute("aria-disabled", "true");
    else next.href = catalogUrl({ page: page + 1 });

    nav.appendChild(prev);
    nav.appendChild(next);

    pager.appendChild(numbers);
    pager.appendChild(nav);
    pager.hidden = false;
  }

  async function mapPool(items, limit, worker) {
    if (!items.length) return;
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          try {
            await worker(item);
          } catch (error) {
            console.error("[gemist] load failed", item, error);
          }
        }
      }),
    );
  }

  let licenseLocked = false;

  function lockStorefront() {
    if (licenseLocked) return;
    licenseLocked = true;
    memory.slugs = [];
    memory.bySlug = {};
    memory.byId = {};
    writeStorage();
    setGemistPageMode("");
    document.querySelectorAll("[data-gemist-products]").forEach((node) => {
      node.hidden = true;
      node.replaceChildren();
    });
  }

  let previewNoticeShown = false;

  function showPreviewNotice() {
    if (previewNoticeShown) return;
    previewNoticeShown = true;
    document.querySelectorAll("[data-gemist-products]").forEach((node) => {
      const notice = document.createElement("div");
      notice.className = "gemist-preview-notice";
      notice.textContent =
        "Preview only — shoppers can't see this grid until you subscribe in the Gemist app.";
      node.parentNode && node.parentNode.insertBefore(notice, node);
    });
  }

  async function readJson(response) {
    const payload = await response.json().catch(() => ({}));
    if (payload && payload.licenseInactive) {
      if (DESIGN_MODE) {
        throw new Error(payload.error || "Subscribe in the Gemist app to use this on your live store.");
      }
      lockStorefront();
      throw new Error("Gemist is not active on this store.");
    }
    if (payload && payload.previewOnly && DESIGN_MODE) showPreviewNotice();
    if (!response.ok) {
      throw new Error(
        payload.error || payload.message || `Could not load products (${response.status})`,
      );
    }
    if (payload.error) throw new Error(payload.error);
    return payload;
  }

  function productTitle(product) {
    return (
      product.title ||
      product.shortTitle ||
      product.style ||
      product.slug ||
      "Untitled product"
    );
  }

  function productImage(product) {
    return mediaUrl(product.thumbnail) || mediaUrl(product.images && product.images[0]);
  }

  function productCardImages(product) {
    const urls = [];
    const seen = new Set();
    const push = (value) => {
      const url = mediaUrl(value);
      if (!url || seen.has(url)) return;
      seen.add(url);
      urls.push(url);
    };
    push(product.thumbnail);
    (product.images || []).forEach(push);
    return urls;
  }

  function mediaUrl(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    return value.url || value.src || "";
  }

  function formatPrice(product) {
    const raw = product.salePrice ?? product.price;
    const amount = typeof raw === "number" ? raw : parseFloat(raw);
    if (!Number.isFinite(amount)) return "";
    const marked = amount * resolveMarkupMultiplier(product);
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(marked);
    } catch {
      return `$${Math.round(marked)}`;
    }
  }

  function designerTabLabel(key) {
    const labels = {
      style: "Band Style",
      band_width: "Band Width",
      metal: "Metal Type",
      metal_color: "Metal Color",
      stone: "Stone Type",
      shape: "Stone Shape",
      coverage: "Pavé",
      orientation: "Side Stones",
      ring_size: "Ring Size",
      engraving: "Engraving",
    };
    return labels[key] || formatLabel(key);
  }

  function formatLabel(value) {
    return String(value).replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  function apiBaseOf(root) {
    return (commerce.apiBaseUrl || root.dataset.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  }

  function queryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function catalogUrl({ productId, page, customize, slug } = {}) {
    const url = new URL(window.location.href);
    if (productId) url.searchParams.set(PRODUCT_PARAM, productId);
    else url.searchParams.delete(PRODUCT_PARAM);
    if (slug) url.searchParams.set(SLUG_PARAM, slug);
    else if (!productId) url.searchParams.delete(SLUG_PARAM);
    if (page && Number(page) > 1) url.searchParams.set(PAGE_PARAM, String(page));
    else url.searchParams.delete(PAGE_PARAM);
    if (customize) url.searchParams.set(CUSTOMIZE_PARAM, "1");
    else url.searchParams.delete(CUSTOMIZE_PARAM);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function readStorage() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.savedAt && Date.now() - Number(parsed.savedAt) > CATALOG_TTL_MS) {
        sessionStorage.removeItem(STORAGE_KEY);
        return;
      }
      memory.byId = parsed.byId || {};
      memory.bySlug = parsed.bySlug || {};
      memory.baseBySlug = parsed.baseBySlug || {};
      memory.slugs = Array.isArray(parsed.slugs) ? parsed.slugs : null;
    } catch {
      /* ignore */
    }
  }

  function writeStorage() {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          slugs: memory.slugs,
          byId: memory.byId,
          bySlug: memory.bySlug,
          baseBySlug: memory.baseBySlug,
        }),
      );
    } catch {
      /* ignore quota */
    }
  }

  window.GemistProducts = {
    mount(root) {
      loadCommerce().finally(() => initApp(root));
    },
  };
})();
