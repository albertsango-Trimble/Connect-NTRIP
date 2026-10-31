import * as WorkspaceAPI from 'trimble-connect-workspace-api';

export type WorkspaceApi = Awaited<ReturnType<typeof WorkspaceAPI.connect>>;

export interface HostConnection {
  api: WorkspaceApi;
  projectId: string;
  projectName?: string;
  /** The project's data region, e.g. "europe" */
  location?: string;
  /** The project's coordinate reference system, e.g. name "GDA2020 / MGA zone 56 (EPSG:7856)" */
  crs?: { name?: string; csib64?: string };
  /** The current access token, if the user has granted permission */
  token(): string | undefined;
  /** Called with the first token and every refresh. Returns an unsubscribe function. */
  onToken(callback: (token: string) => void): () => void;
}

const isToken = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value !== 'pending' && value !== 'denied';

const MENU_TITLE = 'NTRIP Caster';
const MENU_ICON = 'https://albertsango-trimble.github.io/Connect-NTRIP/icon.png';
const MENU_COMMAND = 'open_ntrip_caster';

/**
 * Connects to Trimble Connect when this page runs inside it as a project extension.
 * Returns null when opened on its own (for example `npm run dev` in a browser tab),
 * so the map can still be developed without Connect.
 */
export async function connectToHost(): Promise<HostConnection | null> {
  if (window.parent === window) return null;

  let token: string | undefined;
  const listeners = new Set<(token: string) => void>();
  const setToken = (value: unknown) => {
    if (!isToken(value)) return;
    token = value;
    listeners.forEach((l) => l(value));
  };

  const api = await WorkspaceAPI.connect(
    window.parent,
    (event: string, args: unknown) => {
      if (event === 'extension.accessToken') {
        // Connect has sent the token as `data` or as `accessToken` depending on version.
        const a = args as { data?: unknown; accessToken?: unknown } | undefined;
        setToken(a?.data ?? a?.accessToken);
      }
    },
    30000,
  );

  // Connect only adds a left-menu entry for a project extension once the extension
  // registers one itself. Being enabled in Apps & Capabilities is not enough.
  try {
    await api.ui.setMenu({ title: MENU_TITLE, icon: MENU_ICON, command: MENU_COMMAND });
  } catch (err) {
    console.warn('Could not register the Connect menu entry', err);
  }

  // The first call returns "pending" while Connect asks the user for consent;
  // the token then arrives through the extension.accessToken event.
  setToken(await api.extension.requestPermission('accesstoken'));

  const project = await api.project.getProject();
  return {
    api,
    projectId: project.id,
    projectName: project.name,
    location: project.location,
    crs: project.crs,
    token: () => token,
    onToken(callback) {
      listeners.add(callback);
      if (token) callback(token);
      return () => listeners.delete(callback);
    },
  };
}
