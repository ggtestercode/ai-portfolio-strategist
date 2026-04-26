export const usd = (n: number, opts: Intl.NumberFormatOptions = {}) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
    ...opts,
  }).format(n);

export const usdShort = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

export const pct = (n: number, digits = 1) =>
  `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;

export const pctNoSign = (n: number, digits = 1) => `${n.toFixed(digits)}%`;

export const trendColor = (n: number) =>
  n > 0
    ? "text-emerald-500"
    : n < 0
      ? "text-rose-500"
      : "text-muted-foreground";

export const trendBg = (n: number) =>
  n > 0
    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : n < 0
      ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
      : "bg-muted text-muted-foreground";
