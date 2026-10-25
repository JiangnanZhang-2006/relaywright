const PUBLIC_SUFFIX_PAIRS = new Set([
  'edu.cn',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'ac.cn',
  'co.uk',
  'ac.uk',
  'org.uk',
  'co.jp',
  'com.au',
  'com.hk',
  'com.tw',
]);

/** Registrable domain without a public-suffix list dependency. IPs and localhost stay as-is. */
export function registrableDomain(host: string): string {
  let normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  if (!normalized || normalized === 'localhost' || isIp(normalized)) return normalized;
  const labels = normalized.split('.').filter((label) => label.length > 0);
  if (labels.length <= 2) return labels.join('.');
  const pair = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
  if (PUBLIC_SUFFIX_PAIRS.has(pair)) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

export function hostOfUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname;
  } catch {
    return null;
  }
}

function isIp(host: string): boolean {
  if (host.includes(':')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
