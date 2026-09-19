// Per-tenant secrets at rest (R30 §3.3).
//
// One hosted Worker holds N creators' Instagram tokens and (path L) N creators' Meta app
// secrets. They are AES-256-GCM encrypted with a Worker-secret KEK before they touch D1, with a
// fresh 96-bit IV per value and the tenant id as additional authenticated data — so a ciphertext
// lifted from one tenant's row cannot be decrypted as another tenant's, even by this code.
//
// Plaintext exists only inside that tenant's Durable Object, for the moment of use. Nothing here
// ever logs, returns or stringifies a plaintext secret; errors carry the tenant id and nothing
// else. Rotation: set TOKEN_KEK to the new key and leave the old one in TOKEN_KEK_PREVIOUS —
// decrypt tries every key in order, so rows re-encrypt lazily as they are written.

const IV_BYTES = 12;
const PREFIX = "v1:";

/** Derive the 256-bit AES key from the KEK secret string (any length, >= 32 chars required). */
async function importKek(kek: string): Promise<CryptoKey> {
  if (!kek || kek.length < 32) {
    throw new Error("TOKEN_KEK is missing or too short (need >= 32 characters of random secret)");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(kek));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a secret for one tenant. Returns "v1:<base64(iv || ciphertext)>". */
export async function encryptSecret(kek: string, tenantId: string, plaintext: string): Promise<string> {
  if (!tenantId) throw new Error("encryptSecret requires a tenant id (it is the AAD)");
  const key = await importKek(kek);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(tenantId) },
    key,
    new TextEncoder().encode(plaintext),
  );
  const packed = new Uint8Array(IV_BYTES + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), IV_BYTES);
  return PREFIX + toBase64(packed);
}

/**
 * Decrypt a secret for one tenant. `keks` is the current KEK first, then any previous KEK still
 * needed during a rotation. Throws (without the ciphertext or any plaintext in the message) if
 * no key opens it or the tenant id does not match the AAD it was sealed with.
 */
export async function decryptSecret(keks: string[], tenantId: string, blob: string): Promise<string> {
  if (!blob.startsWith(PREFIX)) throw new Error(`stored secret for ${tenantId} is not in v1 format`);
  const packed = fromBase64(blob.slice(PREFIX.length));
  const iv = packed.slice(0, IV_BYTES);
  const ct = packed.slice(IV_BYTES);
  const aad = new TextEncoder().encode(tenantId);
  for (const kek of keks.filter(Boolean)) {
    try {
      const key = await importKek(kek);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ct);
      return new TextDecoder().decode(pt);
    } catch {
      // try the next key in the rotation
    }
  }
  throw new Error(`cannot decrypt stored secret for tenant ${tenantId} with the configured KEK(s)`);
}

/** A URL-safe random token (webhook verify tokens, tenant ids, idempotency keys). */
export function randomToken(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (verify tokens, admin bearer tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
