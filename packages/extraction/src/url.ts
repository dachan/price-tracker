const TRACKING_PARAM_PREFIXES = ["utm_", "fbclid", "gclid", "msclkid", "ref", "ref_", "source"];

export function normalizeTrackedUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";

  const paramsToDelete: string[] = [];
  for (const [key] of url.searchParams.entries()) {
    if (TRACKING_PARAM_PREFIXES.some((prefix) => key.toLowerCase().startsWith(prefix))) {
      paramsToDelete.push(key);
    }
  }

  for (const key of paramsToDelete) {
    url.searchParams.delete(key);
  }

  const sortedParams = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of sortedParams) {
    url.searchParams.append(key, value);
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}
