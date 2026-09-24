(() => {
  const cards = document.querySelectorAll("[data-gemist-card]");
  if (!cards.length) return;

  cards.forEach((card) => {
    const toggle = card.querySelector("[data-gemist-toggle]");
    const extra = card.querySelector("[data-gemist-extra]");
    if (!toggle || !extra) return;

    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      extra.hidden = expanded;
    });
  });
})();
