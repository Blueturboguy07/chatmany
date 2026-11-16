import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InstallStore, StoredInstall } from "./publik";

/**
 * Where the publik install lives on this computer: one small file in the
 * app's data folder (mode 0600) with the install id and the claim link, and
 * the key itself encrypted by the operating system: Electron's safeStorage
 * uses the macOS Keychain and Windows DPAPI. The file never holds the key
 * in clear text.
 *
 * When the system cannot encrypt (some Linux desktops without a keyring),
 * the key stays in memory for this run only, and the next start asks the
 * person to sign in again.
 */
export interface Cipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(sealed: Buffer): string;
}

interface FileShape {
  v: 1;
  install_id: string;
  claim_url: string | null;
  key_sealed: string | null;
}

export function keychainStore(file: string, cipher: Cipher): InstallStore {
  let memoryKey: string | null = null;

  return {
    read(): StoredInstall | null {
      let raw: Partial<FileShape>;
      try {
        raw = JSON.parse(readFileSync(file, "utf8")) as Partial<FileShape>;
      } catch {
        return null;
      }
      if (typeof raw.install_id !== "string") return null;
      let key: string | null = memoryKey;
      if (typeof raw.key_sealed === "string" && raw.key_sealed) {
        try {
          key = cipher.available() ? cipher.decrypt(Buffer.from(raw.key_sealed, "base64")) : null;
        } catch {
          // The keychain item changed (a new signature, a restored backup): treat the key as gone.
          key = null;
        }
      }
      return {
        install_id: raw.install_id,
        key: key && key.startsWith("pk_") ? key : null,
        claim_url: typeof raw.claim_url === "string" ? raw.claim_url : null,
      };
    },

    write(value: StoredInstall | null): void {
      if (!value) {
        memoryKey = null;
        rmSync(file, { force: true });
        return;
      }
      let sealed: string | null = null;
      if (value.key && cipher.available()) {
        sealed = cipher.encrypt(value.key).toString("base64");
        memoryKey = null;
      } else {
        memoryKey = value.key;
      }
      const shape: FileShape = { v: 1, install_id: value.install_id, claim_url: value.claim_url, key_sealed: sealed };
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(shape)}\n`, { mode: 0o600 });
    },
  };
}
