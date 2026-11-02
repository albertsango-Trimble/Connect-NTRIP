/**
 * The extension's files in the Connect project (caster settings, shared base maps) are saved encrypted
 * (AES-GCM, with a key worked out from the project and a key built into the extension), so opening them in
 * Connect shows only scrambled text. This keeps casual viewers out; it is not a vault: the extension itself
 * must be able to read them, so someone who takes the extension's code apart could too.
 * Files saved before this are plain JSON and are still read.
 */
const FORMAT = 'connect-ntrip-sealed';
// Built into the extension; changing it makes existing encrypted files unreadable.
const APP_SECRET = 'cN7r!p-UPG·k2v9·8f3a1d6e4b0c5927·sealed-project-files';

const enc = new TextEncoder();
function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(buf as ArrayBuffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const keys = new Map<string, Promise<CryptoKey>>();
function keyFor(projectId: string): Promise<CryptoKey> {
  let k = keys.get(projectId);
  if (!k) {
    k = crypto.subtle
      .importKey('raw', enc.encode(APP_SECRET), 'HKDF', false, ['deriveKey'])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(`connect-ntrip:${projectId}`), info: enc.encode('project-file-v1') },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
    keys.set(projectId, k);
  }
  return k;
}

/** Encrypts a value for saving as a project file. */
export async function sealJson(projectId: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(projectId), enc.encode(JSON.stringify(value)));
  return JSON.stringify({ format: FORMAT, v: 1, iv: b64(iv), data: b64(data) });
}

/** Reads a project file saved by sealJson, or an older plain JSON one (then `sealed` is false). */
export async function openJson<T>(projectId: string, text: string): Promise<{ value: T; sealed: boolean }> {
  const outer = JSON.parse(text) as { format?: string; iv?: string; data?: string };
  if (outer?.format !== FORMAT) return { value: outer as T, sealed: false };
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(outer.iv!) }, await keyFor(projectId), unb64(outer.data!));
  return { value: JSON.parse(new TextDecoder().decode(plain)) as T, sealed: true };
}
