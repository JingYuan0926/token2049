// Prices a job after the agent has looked at the contract.
// Base price by contract size (fixed steps for now), times a tier factor.

const SIZE_STEPS = [
  { maxLines: 150, label: 'small', usdm: 0.5 },
  { maxLines: 400, label: 'medium', usdm: 1 },
  { maxLines: Infinity, label: 'large', usdm: 1.5 },
];
const TIER_FACTOR = { see: 1, write: 3, audit: 10 };

// Code lines only: blank lines and // comments do not count.
export function countCodeLines(files) {
  return files.reduce((sum, f) => sum + f.content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length, 0);
}

export function quote({ tier, files }) {
  const lines = countCodeLines(files);
  const step = SIZE_STEPS.find((s) => lines <= s.maxLines);
  const usdm = step.usdm * TIER_FACTOR[tier];
  return {
    lines,
    files: files.length,
    size: step.label,
    usdm,
    amount: String(Math.round(usdm * 1_000_000)),
  };
}

export function quoteMessage(tier, q) {
  return `Price: ${q.usdm} test USDM. I checked your contract: ${q.files} file(s), ${q.lines} lines of code (${q.size}), ${tier} tier. `
    + 'Your payment locks in the Masumi escrow on Cardano. I start the audit when it is locked. No report, no charge.';
}
