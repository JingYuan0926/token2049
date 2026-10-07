// Parses a buyer's task text into a tier and a contract source.

export const TIER_NAMES = ['see', 'write', 'audit'];
export const MAX_CODE_BYTES = 200_000;

const GITHUB_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+?))?\/?(?=$|[\s)>\]"'])/i;
const FENCE_RE = /```[\w-]*\n([\s\S]*?)```/g;

// "audit" is also a normal English word, so the tier must be marked explicitly:
// "tier: write", "[write]", or a line that holds only the tier word.
export function parseTier(text) {
  const marked = /\btier\s*[:=]?\s*(see|write|audit)\b/i.exec(text)
    || /\[(see|write|audit)\]/i.exec(text)
    || /^\s*(see|write|audit)\s*$/im.exec(text);
  return marked ? marked[1].toLowerCase() : 'see';
}

export function parseGithub(text) {
  const m = GITHUB_RE.exec(text);
  if (!m) return null;
  const [, owner, repo, rest] = m;
  // A /tree/<ref>/<path> link: the first segment is the branch, the rest a subfolder.
  const [ref, ...pathParts] = rest ? rest.split('/') : [];
  return {
    url: `https://github.com/${owner}/${repo}.git`,
    display: `https://github.com/${owner}/${repo}${rest ? `/tree/${rest}` : ''}`,
    ref: ref || null,
    subdir: pathParts.join('/') || null,
  };
}

export function extractCode(text) {
  const fenced = [...text.matchAll(FENCE_RE)].map((m) => m[1].trim()).filter(Boolean);
  if (fenced.length) return fenced.join('\n\n');
  if (/\bvalidator\b/.test(text)) {
    return text
      .split('\n')
      .filter((line) => !/^\s*(tier\s*[:=]?\s*)?\[?(see|write|audit)\]?\s*$/i.test(line))
      .join('\n')
      .trim();
  }
  return null;
}

export function parseTaskInput(text) {
  const source = String(text ?? '');
  const tier = parseTier(source);
  const code = extractCode(source);
  if (code) {
    if (Buffer.byteLength(code) > MAX_CODE_BYTES) {
      throw new Error(`The pasted code is larger than ${MAX_CODE_BYTES / 1000} KB.`);
    }
    return { tier, source: { kind: 'code', code } };
  }
  const github = parseGithub(source);
  if (github) return { tier, source: { kind: 'github', ...github } };
  throw new Error('No Aiken code or public GitHub link found. Paste the validator code in a ``` block, or add a https://github.com link.');
}
