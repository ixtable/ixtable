const SECRET_KEYS =
  /^(access_token|refresh_token|token|token_hash|secret|password|dek|wrapped_dek|ciphertext|nonce|aad|signature|private_key|code_verifier)$/i;

/** Defense in depth for support tooling: drops secret-looking fields even if a server sends them. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        SECRET_KEYS.test(key) ? "[redacted]" : redactSecrets(inner),
      ]),
    );
  }
  return value;
}
