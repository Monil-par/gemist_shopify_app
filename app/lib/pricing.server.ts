export function applyMarkup(amount: number, markupPercent = 0) {
  const markup = Number.isFinite(markupPercent) ? markupPercent : 0;
  const priced = amount * (1 + Math.max(markup, 0) / 100);
  return Math.round(priced * 100) / 100;
}

export function formatMoney(amount: number) {
  return amount.toFixed(2);
}
