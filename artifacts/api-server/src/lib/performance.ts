type Range = "1D" | "7D" | "1M" | "3M" | "1Y" | "ALL";

const RANGE_DAYS: Record<Range, number> = {
  "1D": 1,
  "7D": 7,
  "1M": 30,
  "3M": 90,
  "1Y": 365,
  ALL: 365 * 3,
};

const RANGE_POINTS: Record<Range, number> = {
  "1D": 24,
  "7D": 28,
  "1M": 30,
  "3M": 36,
  "1Y": 52,
  ALL: 60,
};

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildPerformanceSeries(
  range: Range,
  startValue: number,
  endValue: number,
) {
  const days = RANGE_DAYS[range];
  const count = RANGE_POINTS[range];
  const rand = mulberry32(7349 + days * 13);
  const benchRand = mulberry32(2113 + days * 7);

  const portfolioGrowth = endValue / startValue;
  const benchmarkGrowth = 1 + (portfolioGrowth - 1) * 0.6;

  const points: { timestamp: string; portfolio: number; benchmark: number }[] =
    [];
  const now = new Date();
  let pVal = startValue;
  let bVal = startValue;
  const targetPortfolio = endValue;
  const targetBenchmark = startValue * benchmarkGrowth;

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const baseP = startValue + (targetPortfolio - startValue) * t;
    const baseB = startValue + (targetBenchmark - startValue) * t;
    const noiseP = (rand() - 0.5) * startValue * 0.012;
    const noiseB = (benchRand() - 0.5) * startValue * 0.008;
    pVal = baseP + noiseP;
    bVal = baseB + noiseB;

    const ts = new Date(
      now.getTime() - (days * 24 * 60 * 60 * 1000 * (count - 1 - i)) / (count - 1),
    );
    points.push({
      timestamp: ts.toISOString(),
      portfolio: Number(pVal.toFixed(2)),
      benchmark: Number(bVal.toFixed(2)),
    });
  }

  return { range, points };
}
