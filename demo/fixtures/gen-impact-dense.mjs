// Writes demo/fixtures/review/impact-dense.json: an invented Impact result (impact.js computeImpact's model) of a
// large PR, for the Impact section with many callers (impact.js isDense): 16 changed symbols of a web shop's
// checkout, 99 callers not in the PR, 31 in the diff with their call untouched, 11 changed, 5 of them keeping an
// unchanged call to a changed signature, and a few tests. Nothing here is from a real repository.
//   node demo/fixtures/gen-impact-dense.mjs
import { writeFileSync } from "node:fs";

const SRC = "web/src/features/checkout";
// [file, name, kind, container, line, sig?, outside, untouched, changed, tests]
const SYMBOLS = [
  ["CheckoutSessionContext.ts", "useCheckoutSession", "function", "", 24, ["export function useCheckoutSession(): CheckoutSession {", "export function useCheckoutSession(scope: SessionScope): CheckoutSession {"], 3, 2, 4, 2],
  ["price-breakdown-by-region.ts", "priceBreakdown", "function", "", 18, null, 21, 5, 1, 3],
  ["CheckoutSessionContext.ts", "CheckoutSessionProvider", "function", "", 61, null, 14, 3, 0, 1],
  ["cart-totals.ts", "cartTotals", "function", "", 9, null, 12, 4, 2, 4],
  ["shipping-options.ts", "shippingOptionsFor", "function", "", 33, null, 11, 2, 0, 1],
  ["address-form-schema.ts", "addressSchema", "constant", "", 12, null, 9, 3, 1, 0],
  ["payment-intent-client.ts", "createIntent", "method", "PaymentIntentClient", 47, null, 8, 4, 1, 2],
  ["payment-intent-client.ts", "confirmIntent", "method", "PaymentIntentClient", 88, null, 7, 2, 0, 1],
  ["voucher-rules.ts", "applyVoucher", "function", "", 21, null, 6, 3, 1, 3],
  ["tax-rates-by-country.ts", "taxRateFor", "function", "", 14, null, 5, 1, 0, 1],
  ["order-summary-view-model.ts", "OrderSummaryViewModel", "class", "", 16, null, 3, 0, 0, 0],
  ["cart-line-item.ts", "lineItemKey", "function", "", 7, null, 0, 2, 1, 1],
  ["cart-line-item.ts", "mergeLineItems", "function", "", 30, null, 0, 0, 0, 2],
  ["checkout-analytics-events.ts", "trackStep", "function", "", 11, null, 0, 0, 0, 0],
  ["delivery-date-estimate.ts", "estimateDelivery", "function", "", 19, null, 0, 0, 0, 1],
  ["voucher-rules.ts", "isStackable", "function", "", 58, null, 0, 0, 0, 0],
];
// Where callers live: files outside the PR, files of the PR whose call is untouched, files of the PR that changed it.
const OUTSIDE = ["web/src/pages/cart/CartPageContainer.tsx", "web/src/pages/checkout/CheckoutStepsLayout.tsx", "web/src/pages/checkout/PaymentStepForm.tsx", "web/src/pages/account/OrderHistoryList.tsx",
  "web/src/pages/account/SavedAddressesPanel.tsx", "web/src/components/minicart/MiniCartDrawer.tsx", "web/src/components/price/PriceTagWithTax.tsx", "web/src/services/orders/order-export-job.ts",
  "web/src/services/orders/refund-calculator.ts", "web/src/services/mail/order-confirmation-mail.ts", "web/src/admin/reports/revenue-by-region-report.ts", "web/src/admin/vouchers/VoucherPreviewDialog.tsx"];
const UNTOUCHED = ["web/src/features/checkout/CheckoutPage.tsx", "web/src/features/checkout/OrderSummaryCard.tsx", "web/src/features/checkout/ShippingStep.tsx", "web/src/features/checkout/checkout-reducer.ts"];
const CHANGED = ["web/src/features/checkout/PaymentStep.tsx", "web/src/features/checkout/VoucherField.tsx", "web/src/features/checkout/checkout-saga.ts"];
const NAMES = ["render", "load", "submit", "refresh", "validate", "summarize", "handleChange", "mapRows", "build", "onRetry", "prepare", "select"];

const baseOf = (p) => p.split("/").pop().replace(/\.[a-z]+$/, "");
let seq = 0; // a counter instead of chance: the same file every run
const callersOf = (name, files, n, mark, start) => Array.from({ length: n }, (_x, i) => {
  const path = files[(start + i) % files.length], line = 20 + ((seq++ * 37) % 400), fn = `${NAMES[(start + i * 5) % NAMES.length]}${baseOf(path).replace(/[^A-Za-z]/g, "").slice(0, 14)}${i >= files.length ? Math.floor(i / files.length) + 1 : ""}`;
  return { id: `${path}#${line}`, name: fn, kind: "function", path, line, sites: [{ line: line + 3, text: `const value = ${name}(input);`, mark }], mark, test: false };
});
const functions = SYMBOLS.map(([file, name, kind, container, line, sig, out, same, changed, tests], k) => {
  const path = `${SRC}/${file}`;
  return { id: `${path}#${line}`, path, name, kind, container, line, end: line + 18, nameLine: line, character: 16, isNew: false, sig: sig ? { old: sig[0], now: sig[1] } : null,
    callers: [...callersOf(name, OUTSIDE, out, "outside", k * 3), ...callersOf(name, UNTOUCHED, same, "untouched", k), ...callersOf(name, CHANGED, changed, "changed", k),
      ...Array.from({ length: tests }, (_x, i) => ({ id: `${SRC}/__tests__/${baseOf(file)}.test.ts#${10 + i * 12}`, name: `${name} case ${i + 1}`, kind: "function", path: `${SRC}/__tests__/${baseOf(file)}.test.ts`, line: 10 + i * 12,
        sites: [{ line: 12 + i * 12, text: `expect(${name}(sample)).toMatchSnapshot();`, mark: "changed" }], mark: "changed", test: true }))], outside: 0, more: 0 };
});
writeFileSync(new URL("./review/impact-dense.json", import.meta.url), `${JSON.stringify({ v: 2, infra: 0, servers: ["TypeScript"], uncovered: [], failed: [], functions, skipped: 0, ms: 41870 }, null, 1)}\n`);
