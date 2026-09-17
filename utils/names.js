// Person-name normalisation/validation shared by the admin rename endpoint.
// Letters (any script) plus combining marks, spaces, dots, apostrophes and
// hyphens; 1–50 characters after NFC + whitespace collapse. No digits, no
// control characters, no bidi overrides, no HTML.
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u;
const MAX_LEN = 50;

function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

// Returns null when valid, otherwise a message.
function validateName(value, { required = true, label = "Name" } = {}) {
  if (value === "") return required ? `${label} is required` : null;
  if (value.length > MAX_LEN) return `${label} must be ${MAX_LEN} characters or fewer`;
  if (!NAME_RE.test(value)) return `${label} may only contain letters, spaces, dots, apostrophes and hyphens`;
  return null;
}

module.exports = { normalizeName, validateName, NAME_RE, MAX_LEN };
