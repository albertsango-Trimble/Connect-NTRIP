/**
 * Reads files from the current Trimble Connect project with the Connect REST API, using the
 * access token the extension was granted. The API is hosted per region, so the right host is
 * found by trying the project's own region first and then the others.
 */

export interface ProjectItem {
  id: string;
  name: string;
  isFolder: boolean;
  versionId?: string;
  size?: number;
}

const HOSTS: Record<string, string> = {
  northamerica: 'https://app.connect.trimble.com',
  europe: 'https://app21.connect.trimble.com',
  asia: 'https://app31.connect.trimble.com',
  australia: 'https://app32.connect.trimble.com',
};
const ALL_HOSTS = Object.values(HOSTS);
const API = '/tc/api/2.0';

export class ProjectFiles {
  private base: string | null = null;

  constructor(
    private readonly projectId: string,
    private readonly token: () => string | undefined,
    private readonly location?: string,
  ) {}

  private headers(): HeadersInit {
    const token = this.token();
    if (!token) throw new Error('Trimble Connect has not given this extension an access token yet');
    return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  }

  private hostOrder(): string[] {
    const first = HOSTS[(this.location ?? '').replace(/[^a-z]/gi, '').toLowerCase()];
    return first ? [first, ...ALL_HOSTS.filter((h) => h !== first)] : ALL_HOSTS;
  }

  /** The API host for this project, found once and then reused. */
  private async host(): Promise<string> {
    if (this.base) return this.base;
    const failures: string[] = [];
    for (const host of this.hostOrder()) {
      try {
        const res = await fetch(`${host}${API}/projects/${encodeURIComponent(this.projectId)}`, { headers: this.headers() });
        if (res.ok) {
          this.base = host;
          return host;
        }
        failures.push(`${new URL(host).hostname} ${res.status}`);
        if (res.status === 401) break;
      } catch {
        failures.push(`${new URL(host).hostname} unreachable`);
      }
    }
    throw new Error(`Could not reach the project's files (${failures.join(', ')})`);
  }

  /** The project's data region as Connect reports it, e.g. "australia" */
  region(): string {
    return (this.location ?? '').replace(/[^a-z]/gi, '').toLowerCase();
  }

  /** The regional API host for this project (found once, then reused). */
  apiHost(): Promise<string> {
    return this.host();
  }

  /** Authorization headers for other Connect services on the same host. */
  authHeaders(): HeadersInit {
    return this.headers();
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await fetch(`${await this.host()}${API}${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Trimble Connect replied ${res.status} for ${path}`);
    return res.json();
  }

  /** The project's members, for assigning topics. Tries the usual Connect endpoints and returns [] if none answer. */
  async users(): Promise<{ email: string; name: string }[]> {
    const pid = encodeURIComponent(this.projectId);
    for (const path of [`/projects/${pid}/users`, `/projects/${pid}/members`]) {
      try {
        const reply = (await this.getJson(path)) as unknown;
        const rows = Array.isArray(reply) ? reply : ((reply as { items?: unknown[]; users?: unknown[] } | null)?.items ?? (reply as { users?: unknown[] } | null)?.users ?? []);
        const out: { email: string; name: string }[] = [];
        for (const r of rows as Record<string, unknown>[]) {
          const email = typeof r?.email === 'string' ? r.email : undefined;
          if (!email) continue;
          if (typeof r.status === 'string' && /^(inactive|removed|rejected)$/i.test(r.status)) continue;
          const name = [r.firstName, r.lastName].filter((v) => typeof v === 'string' && v).join(' ');
          out.push({ email, name: name || email });
        }
        if (out.length) return out.sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        // try the next endpoint
      }
    }
    return [];
  }

  /** The project's top-level folder. */
  async root(): Promise<{ id: string; name: string }> {
    const project = (await this.getJson(`/projects/${encodeURIComponent(this.projectId)}`)) as { rootId?: string; name?: string };
    if (!project.rootId) throw new Error("The project's root folder wasn't in Trimble Connect's reply");
    return { id: project.rootId, name: project.name ?? 'Project' };
  }

  /** The files and folders directly inside a folder, folders first. */
  async list(folderId: string): Promise<ProjectItem[]> {
    const reply = (await this.getJson(`/folders/${encodeURIComponent(folderId)}/items`)) as unknown;
    const rows = Array.isArray(reply) ? reply : ((reply as { items?: unknown[] } | null)?.items ?? []);
    const items: ProjectItem[] = [];
    for (const row of rows as Record<string, unknown>[]) {
      if (typeof row?.id !== 'string' || typeof row.name !== 'string') continue;
      const type = String(row.type ?? '').toLowerCase();
      items.push({
        id: row.id,
        name: row.name,
        isFolder: type === 'folder' || row.isFolder === true,
        versionId: typeof row.versionId === 'string' ? row.versionId : undefined,
        size: typeof row.size === 'number' ? row.size : undefined,
      });
    }
    return items.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  /** A temporary address the file can be fetched from. */
  async downloadUrl(item: ProjectItem): Promise<string> {
    for (const path of [`/files/fs/${encodeURIComponent(item.id)}/downloadurl`, `/files/${encodeURIComponent(item.id)}/downloadurl`]) {
      try {
        const reply = (await this.getJson(path)) as { url?: string };
        if (reply?.url) return reply.url;
      } catch {
        /* try the next form of the address */
      }
    }
    throw new Error(`Trimble Connect didn't give a download address for ${item.name}`);
  }

  /**
   * Fetches only the start of a file. Photo metadata sits in the first few hundred kilobytes,
   * so this reads a few percent of an image. It asks for a byte range and also stops reading
   * after `bytes`, in case the server sends the whole file anyway.
   */
  async fetchHead(item: ProjectItem, bytes: number): Promise<File> {
    const url = await this.downloadUrl(item);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } });
    } catch {
      throw new Error(`The browser blocked the download of ${item.name}`);
    }
    if (!res.ok) throw new Error(`Downloading ${item.name} failed (${res.status})`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      while (total < bytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      void reader.cancel().catch(() => undefined);
    } else {
      chunks.push(new Uint8Array(await res.arrayBuffer()));
    }
    return new File(chunks as BlobPart[], item.name, { type: res.headers.get('content-type') ?? undefined });
  }

  /** Downloads a file's contents. */
  async download(item: ProjectItem): Promise<File> {
    const url = await this.downloadUrl(item);
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new Error(`The browser blocked the download of ${item.name}`);
    }
    if (!res.ok) throw new Error(`Downloading ${item.name} failed (${res.status})`);
    return new File([await res.blob()], item.name, { type: res.headers.get('content-type') ?? undefined });
  }

  /** Finds a file by name directly inside a folder. */
  async find(folderId: string, name: string): Promise<ProjectItem | undefined> {
    return (await this.list(folderId)).find((i) => !i.isFolder && i.name.toLowerCase() === name.toLowerCase());
  }

  private async post(path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${await this.host()}${API}${path}`, {
      method: 'POST',
      headers: { ...(this.headers() as Record<string, string>), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Trimble Connect replied ${res.status} for ${path}${text ? `: ${text.slice(0, 160)}` : ''}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  /**
   * Saves a file (text or a picture) into a project folder (a new file, or a new version when the name already exists).
   * Connect uploads are a few steps: start the upload, send the bytes to the address it gives back, then commit.
   */
  async writeFile(folderId: string, name: string, content: string | Blob, contentType = 'application/json'): Promise<void> {
    const pid = encodeURIComponent(folderId);
    const existing = await this.find(folderId, name).catch(() => undefined);
    const query = `parentId=${pid}&parentType=FOLDER&name=${encodeURIComponent(name)}`;
    // A file that already exists gets a new version; if Connect doesn't take the plain request, name the file it should update.
    const bodies: Record<string, unknown>[] = [{ parentId: folderId, parentType: 'FOLDER', name }];
    if (existing) bodies.push({ parentId: folderId, parentType: 'FOLDER', name, fileId: existing.id }, { fileId: existing.id, name });
    let started: Record<string, unknown> | undefined;
    let startError: unknown;
    for (const body of bodies) {
      try {
        started = (await this.post(`/files/fs/initiate?${query}`, body)) as Record<string, unknown>;
        break;
      } catch (err) {
        startError = err;
      }
    }
    if (!started) throw startError instanceof Error ? startError : new Error('Could not start the upload');
    const uploadId = String(started.uploadId ?? started.id ?? '');
    const contents = Array.isArray(started.contents) ? (started.contents as Record<string, unknown>[]) : [];
    const target = (contents[0] ?? started) as Record<string, unknown>;
    const url = String(target.url ?? target.uploadURL ?? target.uploadUrl ?? started.uploadURL ?? started.uploadUrl ?? '');
    if (!url) throw new Error("Trimble Connect didn't give an upload address");
    const extra = (target.headers ?? started.headers ?? {}) as Record<string, string>;
    const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType, ...extra }, body: content instanceof Blob ? content : new Blob([content], { type: contentType }) });
    if (!put.ok) throw new Error(`Sending the file failed (${put.status})`);
    const etag = put.headers.get('etag');
    const id = encodeURIComponent(uploadId);
    const parts = etag ? [{ partNumber: 1, etag }] : [];
    // The commit reply asked for uploadId in the request body, so try the likely body shapes, with and without the folder in the URL.
    const attempts: [string, unknown][] = [
      [`/files/fs/commit`, { uploadId }],
      [`/files/fs/commit?${query}`, { uploadId }],
      [`/files/fs/commit?uploadId=${id}&${query}`, { uploadId }],
      [`/files/fs/commit?${query}`, { uploadId, parts }],
      [`/files/fs/commit?${query}`, { uploadId, etag }],
      [`/files/fs/commit`, { uploadId, name, parentId: folderId }],
      [`/files/fs/commit`, { uploadId, parentId: folderId, parentType: 'FOLDER', name, ...(existing ? { fileId: existing.id } : {}) }],
      [`/files/fs/commit?${query}`, { uploadId, parentId: folderId, parentType: 'FOLDER', name }],
    ];
    const failures: string[] = [];
    for (const [path, body] of attempts) {
      try {
        await this.post(path, body);
        return;
      } catch (err) {
        failures.push(err instanceof Error ? err.message.replace('Trimble Connect replied ', '').replace(/"instance":"[^"]*",?/, '').slice(0, 150) : String(err));
      }
    }
    throw new Error(`could not finish the upload. Start reply keys: ${Object.keys(started).join(',')}. Tried: ${failures.join(' || ')}`);
  }
}
