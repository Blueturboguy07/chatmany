/** Pages the app may open in the system browser. */
export function isOpenableUrl(raw: unknown, origin: string): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.origin === new URL(origin).origin) return true;
    return url.protocol === "https:" && ["publikhq.com", "www.instagram.com", "instagram.com"].includes(url.hostname);
  } catch {
    return false;
  }
}
