/** Strip bearer tokens and key-shaped strings. Never pass a secret into a message that is stored. */
export function redactSecrets(text: string, secret?: string): string {
  let out = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  if (secret) out = out.split(secret).join('[redacted]');
  return out;
}

export function publicError(err: unknown, secret?: string): string {
  const text = err instanceof Error ? err.message : String(err);
  return redactSecrets(text, secret).slice(0, 2000);
}
