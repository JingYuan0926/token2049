// Renders the audit result as a Markdown report.

const TIER_LABEL = { see: 'See (findings report)', write: 'Write (report + fixed code)', audit: 'Audit (human-reviewed)' };
const ORDER = ['Critical', 'High', 'Medium', 'Low', 'Info'];

const buildLine = (c) => c.ok
  ? `✅ Compiles · ${c.warnings ?? 0} warnings · tests ${c.passed}/${c.tests} passed`
  : `❌ Does not compile · ${c.errors ?? '?'} errors`;

export function renderReport({ tier, label, inputHash, model, date, files, check, review, fix, humanReview, proof }) {
  const counts = ORDER.map((s) => [s, review.findings.filter((f) => f.severity === s).length]).filter(([, n]) => n);
  const findings = [...review.findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  const coverage = { finding: 0, clear: 0, 'not-applicable': 0 };
  for (const p of review.checked_patterns) coverage[p.result] += 1;

  const out = [];
  out.push(`# Aiken Audit Report: ${TIER_LABEL[tier]}`);
  out.push(`Contract: ${label}  \nInput SHA-256: \`${inputHash}\`  \nDate: ${date}  \nReviewer: Aiken Auditor (model ${model})`);

  out.push('## Summary');
  out.push(`**Overall risk: ${review.overall_risk}** · Findings: ${counts.length ? counts.map(([s, n]) => `${n} ${s}`).join(', ') : 'none'}`);
  out.push(`What the contract does: ${review.contract_purpose}`);
  out.push(review.summary);

  out.push('## Scope');
  out.push(files.map((f) => `- \`${f.path}\` (${f.content.split('\n').length} lines)`).join('\n'));
  out.push(`Build and tests (\`aiken check\`): ${buildLine(check)}`);

  out.push('## Findings');
  if (!findings.length) {
    out.push('No vulnerabilities found in the checked classes.');
  } else {
    out.push([
      '| # | Severity | Finding | Location |',
      '| --- | --- | --- | --- |',
      ...findings.map((f, i) => `| ${i + 1} | ${f.severity} | ${f.title.replaceAll('|', '/')} | \`${f.location}\` |`),
    ].join('\n'));
    findings.forEach((f, i) => {
      out.push(`### ${i + 1}. [${f.severity}] ${f.title}`);
      out.push([
        `**Location:** \`${f.location}\`  `,
        `**Pattern:** ${f.pattern_id ? `#${f.pattern_id} ` : ''}${f.pattern}  `,
        `**Description:** ${f.description}  `,
        `**Impact:** ${f.impact}  `,
        `**Recommendation:** ${f.recommendation}`,
      ].join('\n'));
    });
  }

  out.push('## Checklist coverage');
  out.push(`${review.checked_patterns.length} eUTxO vulnerability classes checked: ${coverage.finding} with findings, ${coverage.clear} clear, ${coverage['not-applicable']} not applicable.`);

  if (fix) {
    out.push('## Fixed code');
    if (fix.check?.ok) {
      out.push(`${fix.explanation}\n\nBuild after the fix: ${buildLine(fix.check)}`);
      if (fix.testsAdded.length) out.push(`Tests added:\n${fix.testsAdded.map((t) => `- ${t}`).join('\n')}`);
      for (const f of fix.files) out.push(`\`${f.path}\`\n\n\`\`\`aiken\n${f.content.trim()}\n\`\`\``);
    } else {
      out.push(`The fix did not compile after ${fix.attempts} attempts, so no fixed code is included. ${fix.explanation ?? ''}`.trim());
    }
  }

  if (tier === 'audit') {
    out.push('## Design and operational observations');
    out.push('These are not vulnerabilities. They are points to check before deployment.');
    out.push(review.design_observations.length ? review.design_observations.map((o) => `- ${o}`).join('\n') : 'None.');
    out.push('## Human review');
    out.push(humanReview
      ? `Reviewed and approved by ${humanReview.reviewer} on ${humanReview.date}.${humanReview.notes ? `\n\n${humanReview.notes}` : ''}`
      : 'Pending reviewer sign-off.');
  }

  out.push('## Cardano proof');
  out.push(proof || 'Offline run: no payment and no on-chain record.');

  out.push('## Method and limits');
  out.push('Method: `aiken check` build and tests, then a review against the 32-class eUTxO vulnerability checklist from the Cardano Foundation `review-contract` skill (Apache-2.0). This report lowers risk but does not guarantee that the contract is safe. Get an independent audit before you lock real funds.');

  return `${out.join('\n\n')}\n`;
}
