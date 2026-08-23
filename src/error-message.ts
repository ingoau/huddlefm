export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function redactSecrets(text: string) {
  return text
    .replace(/xox[acpbrs]-[^\s,}"']+/gi, "[redacted]")
    .replace(
      /\bauthorization\b\s*[=:]\s*(Bearer\s+|Token\s+)?[^\s,}"']+/gi,
      "authorization=[redacted]",
    )
    .replace(
      /["']?\b(token|cookie|JoinToken|api[_-]?key|session[_-]?key)\b["']?\s*[=:]\s*["']?[^\s,}"']+/gi,
      "$1=[redacted]",
    );
}

export function safeError(error: unknown) {
  return redactSecrets(errorMessage(error));
}
