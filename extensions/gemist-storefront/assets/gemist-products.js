(() => {
  const SCRIPT_ID = "gemist-app-script";

  const start = () => {
    const roots = document.querySelectorAll("[data-gemist-products]");
    if (!roots.length) return;

    const mountAll = () => {
      if (!window.GemistProducts) return;
      roots.forEach((root) => window.GemistProducts.mount(root));
    };

    if (window.GemistProducts) {
      mountAll();
      return;
    }

    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", mountAll, { once: true });
      return;
    }

    const src = roots[0].dataset.appSrc;
    if (!src) {
      const status = roots[0].querySelector("[data-gemist-products-status]");
      if (status) {
        status.hidden = false;
        status.textContent = roots[0].dataset.errorLabel || "Could not load products";
      }
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = src;
    script.onload = mountAll;
    script.onerror = () => {
      roots.forEach((root) => {
        const status = root.querySelector("[data-gemist-products-status]");
        if (status) {
          status.hidden = false;
          status.textContent = root.dataset.errorLabel || "Could not load products";
        }
      });
    };
    document.head.appendChild(script);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
