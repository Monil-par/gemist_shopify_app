(() => {
  const DEFAULT_API_BASE = "https://classique.dev.gemist.co";
  const PRODUCTS_PROXY = "/apps/gemist/products";
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
    "coverage",
    "band_width",
    "orientation",
    "ring_size",
  ];

  const commerce = {
    apiBaseUrl: "",
    markupPercent: 0,
    appointmentUrl: "",
    appointmentEmail: "",
    appointmentLabel: "Schedule an Appointment",
  };
  const designerState = { engraving: "" };

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

  function initApp(root) {
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

  async function showCatalog(root) {
    const catalog = root.querySelector("[data-gemist-catalog]");
    const detail = root.querySelector("[data-gemist-detail]");
    const designerPage = root.querySelector("[data-gemist-designer-page]");
    const status = root.querySelector("[data-gemist-products-status]");
    const grid = root.querySelector("[data-gemist-products-grid]");
    const pager = root.querySelector("[data-gemist-products-pager]");
    if (!catalog || !detail || !status || !grid || !pager) return;

    catalog.hidden = false;
    detail.hidden = true;
    detail.replaceChildren();
    if (designerPage) {
      designerPage.hidden = true;
      designerPage.replaceChildren();
    }

    const pageSize = Math.max(Number(root.dataset.limit) || 8, 1);
    const cardOptions = cardOptionsOf(root);
    const page = Math.max(Number(queryParam(PAGE_PARAM) || 1), 1);

    catalog.querySelector("[data-gemist-retry]")?.remove();

    const paint = (nextSlugs) => {
      const total = nextSlugs.length;
      const pageCount = Math.max(Math.ceil(total / pageSize), 1);
      const safePage = Math.min(page, pageCount);
      const start = (safePage - 1) * pageSize;
      const pageSlugs = nextSlugs.slice(start, start + pageSize);
      if (!pageSlugs.length) return [];
      grid.replaceChildren();
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

    if (Array.isArray(memory.slugs) && memory.slugs.length) {
      paint(memory.slugs);
    }

    let slugs;
    try {
      const payload = await loadCatalogPage(pageSize, (page - 1) * pageSize);
      slugs = payload.slugs;
      (payload.products || []).forEach((product) =>
        cacheProduct(product, product.slug),
      );
    } catch (error) {
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
    if (!pageSlugs.length) {
      status.hidden = false;
      status.textContent = root.dataset.emptyLabel || "No products found";
      grid.hidden = true;
      pager.hidden = true;
      return;
    }

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
      let product = await resolveProduct(productId);
      try {
        product = await loadConfiguredProduct(apiBaseOf(root), product);
      } catch (error) {
        console.warn("[gemist] configure skipped", error);
      }
      if (queryParam(PRODUCT_PARAM) !== productId) return;
      if (queryParam(CUSTOMIZE_PARAM) === "1") {
        showDesigner(root, productId);
        return;
      }
      detail.replaceChildren(renderDetail(root, product));
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

    const cached = resolveCachedProduct(productId);
    if (cached) {
      designerPage.replaceChildren(renderDesignerPage(root, cached));
    } else {
      designerPage.replaceChildren();
      const loading = document.createElement("p");
      loading.className = "gemist-products__status";
      loading.textContent = "Loading designer…";
      designerPage.appendChild(loading);
    }

    try {
      let product = await resolveProduct(productId);
      try {
        product = await loadConfiguredProduct(apiBaseOf(root), product);
      } catch (error) {
        console.warn("[gemist] configure skipped", error);
      }
      if (queryParam(PRODUCT_PARAM) !== productId || queryParam(CUSTOMIZE_PARAM) !== "1") {
        return;
      }
      designerPage.replaceChildren(renderDesignerPage(root, product));
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
        await fetch(`${PRODUCTS_PROXY}?limit=${limit}&offset=${offset}`, {
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
      if (cachedSlugs.length) return { slugs: cachedSlugs, products: [] };
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
            `${PRODUCTS_PROXY}?slug=${encodeURIComponent(slug)}`,
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
        await fetch(`${PRODUCTS_PROXY}?id=${encodeURIComponent(productId)}`, {
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

  async function resolveProduct(productId) {
    const cached = resolveCachedProduct(productId);
    if (cached && isRenderableProduct(cached)) {
      // Refresh in background; show cached immediately via caller.
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
      '<div class="gemist-product-card__image"></div><div class="gemist-product-card__body"><span class="gemist-skel gemist-skel--title"></span><span class="gemist-skel gemist-skel--line"></span></div>';
    item.appendChild(card);
    return item;
  }

  function cardOptionsOf(root) {
    return {
      showTitle: root.dataset.showTitle !== "false",
      showDescription: root.dataset.showDescription !== "false",
      showPrice: root.dataset.showPrice !== "false",
      showActions: root.dataset.showActions !== "false",
    };
  }

  function renderCard(product, options, page) {
    const opts =
      options && typeof options === "object" && !Array.isArray(options)
        ? options
        : {
            showTitle: true,
            showDescription: true,
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

    const imageUrl = productImage(product);
    if (imageUrl) {
      const image = document.createElement("img");
      image.className = "gemist-product-card__image";
      image.src = imageUrl;
      image.alt = productTitle(product);
      image.loading = "lazy";
      link.appendChild(image);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "gemist-product-card__image";
      link.appendChild(placeholder);
    }

    const body = document.createElement("div");
    body.className = "gemist-product-card__body";

    if (opts.showTitle) {
      const title = document.createElement("h3");
      title.className = "gemist-product-card__title";
      title.textContent = productTitle(product);
      body.appendChild(title);
    }

    if (opts.showDescription) {
      const subtitle = product.subtitle || product.description || product.style;
      if (subtitle) {
        const subtitleEl = document.createElement("p");
        subtitleEl.className = "gemist-product-card__subtitle";
        subtitleEl.textContent = subtitle;
        body.appendChild(subtitleEl);
      }
    }

    if (opts.showPrice) {
      const price = formatPrice(product);
      if (price) {
        const priceEl = document.createElement("p");
        priceEl.className = "gemist-product-card__price";
        priceEl.textContent = price;
        body.appendChild(priceEl);
      }
    }

    link.appendChild(body);
    card.appendChild(link);

    if (opts.showActions) {
      const actions = document.createElement("div");
      actions.className = "gemist-product-card__actions";
      const view = document.createElement("a");
      view.href = catalogUrl({ productId: product.id, slug: product.slug, page });
      view.textContent = "View product";
      const customize = document.createElement("a");
      customize.href = catalogUrl({
        productId: product.id,
        slug: product.slug,
        page,
        customize: true,
      });
      customize.textContent = "Customize";
      actions.appendChild(view);
      actions.appendChild(customize);
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
    const backLabel = root.dataset.backLabel || "Back to products";
    back.innerHTML = `<span class="gemist-detail__back-arrow" aria-hidden="true">←</span> ${escapeHtml(backLabel)}`;
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

  function renderDesignerPage(root, product) {
    const wrap = document.createElement("div");
    wrap.className = "gemist-designer-page__layout";

    const back = document.createElement("a");
    back.className = "gemist-detail__back";
    back.href = catalogUrl({
      productId: product.id,
      slug: product.slug,
      page: queryParam(PAGE_PARAM),
    });
    back.textContent = root.dataset.backProductLabel || "Back to product";
    wrap.appendChild(back);

    const media = renderMedia(root, product);

    const info = document.createElement("div");
    info.className = "gemist-detail__info";

    const eyebrow = document.createElement("p");
    eyebrow.className = "gemist-detail__eyebrow";
    eyebrow.textContent = root.dataset.designerTitle || "Designer";
    info.appendChild(eyebrow);

    const title = document.createElement("h1");
    title.className = "gemist-detail__title";
    title.textContent = productTitle(product);
    info.appendChild(title);

    const price = formatPrice(product);
    if (price) {
      const priceEl = document.createElement("p");
      priceEl.className = "gemist-detail__price";
      priceEl.dataset.gemistLivePrice = "true";
      priceEl.textContent = price;
      info.appendChild(priceEl);
    }

    if (product.id) {
      const config = document.createElement("p");
      config.className = "gemist-detail__sku";
      config.dataset.gemistLiveConfig = "true";
      config.textContent = `${root.dataset.configIdLabel || "Configuration ID"} ${product.id}`;
      info.appendChild(config);
    }

    if (product.sku) {
      const sku = document.createElement("p");
      sku.className = "gemist-detail__sku";
      sku.dataset.gemistLiveSku = "true";
      sku.textContent = `${root.dataset.oemSkuLabel || "OEM / Customer SKU"} ${product.sku}`;
      info.appendChild(sku);
    }

    info.appendChild(renderDesigner(root, product, { pageMode: true }));
    info.appendChild(renderAddToCart(root, product));

    wrap.appendChild(media);
    wrap.appendChild(info);
    return wrap;
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
      if (hero.tagName === "IMG") hero.src = imageSrc;
      frame.appendChild(hero);
      media.appendChild(frame);
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
        button.addEventListener("click", () => {
          hero.src = src;
          thumbs.querySelectorAll("[aria-current]").forEach((el) => {
            el.removeAttribute("aria-current");
          });
          button.setAttribute("aria-current", "true");
        });
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

    const customize = document.createElement("a");
    customize.className = "gemist-detail__secondary";
    customize.href = catalogUrl({
      productId: product.id,
      slug: product.slug,
      page: queryParam(PAGE_PARAM),
      customize: true,
    });
    customize.textContent = root.dataset.customizeLabel || "Customize your ring";
    wrap.appendChild(customize);

    const appointment = renderAppointment(root);
    appointment.className = "gemist-detail__tertiary";
    wrap.appendChild(appointment);

    return wrap;
  }

  function renderAppointment(root) {
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
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gemist-detail__tertiary";
    button.textContent = `${label} →`;
    button.addEventListener("click", () => {
      window.alert(
        root.dataset.appointmentMissing ||
          "Set an appointment URL or email in the Gemist app settings.",
      );
    });
    return button;
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
      caption.textContent = formatLabel(key);
      field.appendChild(caption);

      if (values.length > 16 || key === "ring_size") {
        const select = document.createElement("select");
        select.dataset.gemistOption = key;
        values.forEach((value) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          if (String(selected[key] || "") === String(value)) option.selected = true;
          select.appendChild(option);
        });
        select.addEventListener("change", applyChange);
        field.appendChild(select);
      } else {
        const chips = document.createElement("div");
        chips.className = "gemist-designer__chips";
        chips.setAttribute("role", "group");
        chips.setAttribute("aria-label", formatLabel(key));
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
          label.textContent = value;
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

    const engraving = document.createElement("label");
    engraving.className = "gemist-designer__field";
    const engravingLabel = document.createElement("span");
    engravingLabel.textContent = root.dataset.engravingLabel || "Engraving";
    const engravingInput = document.createElement("input");
    engravingInput.type = "text";
    engravingInput.maxLength = 24;
    engravingInput.placeholder = root.dataset.engravingPlaceholder || "Optional, up to 24 characters";
    engravingInput.value = designerState.engraving;
    engravingInput.addEventListener("input", () => {
      designerState.engraving = engravingInput.value;
    });
    engraving.appendChild(engravingLabel);
    engraving.appendChild(engravingInput);
    wrap.appendChild(engraving);

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
    if (text.includes("rose")) return "#b76e79";
    if (text.includes("yellow")) return "#d4af37";
    if (text.includes("white") || text.includes("rhodium")) return "#d9d9d9";
    if (text.includes("platinum")) return "#c5c8ce";
    if (text.includes("silver")) return "#c0c0c0";
    return "#8a8a8a";
  }

  async function proxySearch(body) {
    return readJson(
      await fetch(PRODUCTS_PROXY, {
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

  async function loadConfiguredProduct(_apiBase, product) {
    if (!product?.baseProductId) return product;
    const parts = currentParts(product);
    const payload = await proxySearch({
      baseProductId: product.baseProductId,
      productParts: parts,
      limit: 1,
      offset: 0,
    });
    const next = asProduct(payload.products && payload.products[0]) || product;
    next.availableProductParts =
      payload.availableProductParts || product.availableProductParts || {};
    next.selectedProductParts =
      payload.selectedProductParts || parts || product.selectedProductParts || {};
    cacheProduct(next, next.slug);
    return next;
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
    next.availableProductParts = payload.availableProductParts || {};
    next.selectedProductParts = payload.selectedProductParts || productParts;
    cacheProduct(next, next.slug);
    return next;
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
        await fetch("/apps/gemist/commerce", {
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
      button.disabled = true;
      button.textContent = root.dataset.addingLabel || "Adding…";

      try {
        const proxyRes = await fetch("/apps/gemist/cart/add", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            gemistProductId: product.id,
            engraving: designerState.engraving,
          }),
        });
        const payload = await readJson(proxyRes);
        if (!payload.variantId) {
          throw new Error(
            payload.error || root.dataset.cartErrorLabel || "Could not add this item to the cart.",
          );
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
                properties: payload.properties || {},
              },
            ],
          }),
        });
        const cartPayload = await cartRes.json().catch(() => ({}));
        if (!cartRes.ok) {
          throw new Error(
            cartPayload.description ||
              cartPayload.message ||
              root.dataset.cartErrorLabel ||
              "Could not add this item to the Shopify cart.",
          );
        }

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

    const prev = document.createElement("a");
    prev.className = "gemist-products__page-btn";
    prev.textContent = root.dataset.prevLabel || "Previous";
    if (page <= 1) prev.setAttribute("aria-disabled", "true");
    else prev.href = catalogUrl({ page: page - 1 });

    const next = document.createElement("a");
    next.className = "gemist-products__page-btn";
    next.textContent = root.dataset.nextLabel || "Next";
    if (page >= pageCount) next.setAttribute("aria-disabled", "true");
    else next.href = catalogUrl({ page: page + 1 });

    const status = document.createElement("p");
    status.className = "gemist-products__page-status";
    const template = root.dataset.pageLabel || "Page {current} of {total}";
    status.textContent = template
      .replace("{current}", String(page))
      .replace("{total}", String(pageCount));

    const numbers = document.createElement("div");
    numbers.className = "gemist-products__page-numbers";
    for (let index = 1; index <= pageCount; index += 1) {
      const link = document.createElement("a");
      link.className = "gemist-products__page-num";
      link.textContent = String(index);
      if (index === page) link.setAttribute("aria-current", "page");
      else link.href = catalogUrl({ page: index });
      numbers.appendChild(link);
    }

    pager.appendChild(prev);
    pager.appendChild(status);
    pager.appendChild(numbers);
    pager.appendChild(next);
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

  async function readJson(response) {
    const payload = await response.json().catch(() => ({}));
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

  function mediaUrl(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    return value.url || value.src || "";
  }

  function formatPrice(product) {
    const raw = product.salePrice ?? product.price;
    const amount = typeof raw === "number" ? raw : parseFloat(raw);
    if (!Number.isFinite(amount)) return "";
    const marked = amount * (1 + (Number(commerce.markupPercent) || 0) / 100);
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
