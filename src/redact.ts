// Secret scrubbing utilities. No I/O, no deps.

const PLACEHOLDER = "[REDACTED]";

// PEM blocks first (largest, multi-line spans) so inner content isn't partially matched.
const PEM_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]{8,}/g;
const OPENAI_RE = /sk-[A-Za-z0-9_-]{16,}/g;
const AWS_RE = /AKIA[0-9A-Z]{16}/g;

// Generic secret assignments. The NAME is a whole identifier ending in a
// sensitive token; a negative lookbehind anchors it to an identifier start so
// ordinary words that merely END in the token (monkey, turkey, "foreign key",
// "secret sauce") don't trip it. The value is 6+ chars: a double/single-quoted
// run (spaces allowed) or an unquoted non-space run. Keep the name, redact value.
//
// Delimiter handling differs to avoid mangling prose (the output of a planning
// tool IS prose, full of "secret: rotate it" / "key: value"):
//   `=`  — rare in prose, treated as a secret delimiter for any value.
//   `:`  — common in prose, so only treated as a delimiter when the value is
//          quoted OR follows with no intervening space (structured/JSON shapes
//          like `"api_key":"x"` or `password:hunter2hunter`); `secret: rotate`
//          (`:` + space + unquoted word) is left as ordinary prose.
// The optional closing quote before the delimiter lets JSON keys (`"api_key":`)
// match while the delimiter rule stays intact.
const NAME = '(?<![A-Za-z0-9_])([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|APIKEY)[A-Za-z0-9_]*["\']?\\s*';
const QUOTED = '(?:"([^"]{6,})"|\'([^\']{6,})\')';
// The lookahead keeps redaction idempotent: a prior pass leaves `name:[REDACTED]`,
// and without it the no-space `:` branch would re-consume `[REDACTED]` as a value.
const UNQUOTED = '(?!\\[REDACTED\\])([^\\s"\']{6,})';
const ASSIGN_RE = new RegExp(
  // `=` delimiter: quoted (spaces ok) or unquoted value.
  `${NAME}=\\s*)(?:${QUOTED}|${UNQUOTED})` +
    '|' +
    // `:` delimiter: quoted value (any spacing) OR an unquoted value with NO
    // space after the colon, so free-prose "name: word" passes through.
    // Alt 3 adds a negative lookahead for a quote so it never overlaps with
    // alt 2's quoted-value capture, keeping the alternation unambiguous.
    `${NAME}:\\s*)${QUOTED}` +
    '|' +
    `${NAME}:)(?!\s*["\'])${UNQUOTED}`,
  'gi',
);

/**
 * Scrub secrets from text. Coerces non-strings via String() (null/undefined -> '').
 * Never throws. Idempotent: redact(redact(x)) === redact(x).
 */
export function redact(text: unknown): string {
  let s: string;
  if (text === null || text === undefined) return "";
  try {
    s = typeof text === "string" ? text : String(text);
  } catch {
    return "";
  }

  // Order matters so replacements compose without double-processing.
  // PEM first (spans lines, may contain other patterns inside).
  s = s.replace(PEM_RE, PLACEHOLDER);
  // Bearer before the generic key=value rule so "Bearer xxx" stays as "Bearer [REDACTED]".
  s = s.replace(BEARER_RE, "Bearer " + PLACEHOLDER);
  s = s.replace(OPENAI_RE, PLACEHOLDER);
  s = s.replace(AWS_RE, PLACEHOLDER);
  // Generic assignments last: a prior redaction yields "[REDACTED]" which contains no
  // 6+ char unquoted value after a delimiter for these names, keeping it idempotent.
  // Three alternatives, each capturing its name+delimiter as a separate group
  // (groups 1, 5, 8). Whichever matched, re-emit it and redact the value.
  s = s.replace(
    ASSIGN_RE,
    (_m, n1: string, _2, _3, _4, n5: string, _6, _7, n8: string) =>
      (n1 ?? n5 ?? n8) + PLACEHOLDER,
  );

  return s;
}

// A sensitive KEY name redacts its string value wholesale, regardless of the
// value's shape — a secret stored as `{ API_KEY: "plainword" }` has no in-value
// pattern for redact() to catch, so key-name matching is the only defense. Kept
// tight (whole sensitive segments) so benign keys like `apiVersion`, `author`,
// or `foreignKey` are not over-redacted.
const SENSITIVE_KEY =
  /(?:^|[_-])(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|authorization)(?:[_-]|$)/i;

/**
 * Deep clone applying redact() to every string value, and redacting any string
 * whose KEY name is sensitive wholesale. Non-strings pass through. Never throws.
 * Handles cycles defensively via a seen set.
 */
export function redactObject<T>(o: T): T {
  try {
    return clone(o, new WeakSet<object>()) as T;
  } catch {
    return o;
  }
}

function clone(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value as object)) return "[CIRCULAR]"; // break cycles
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => clone(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    const v = (value as Record<string, unknown>)[key];
    // Sensitive key + non-empty string value -> redact the whole value, since
    // the value alone (e.g. "hunter2") carries no detectable secret pattern.
    if (typeof v === "string" && v.length > 0 && SENSITIVE_KEY.test(key)) {
      out[key] = PLACEHOLDER;
    } else {
      out[key] = clone(v, seen);
    }
  }
  return out;
}
