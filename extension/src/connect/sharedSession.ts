/**
 * Base maps shared with everyone on the Connect project, saved as a file in the project's top-level folder.
 * Same approach as the 360 Imagery Viewer's shared setup (Connect-360 src/connect/sharedSession.ts), with its own file names.
 */
import type { ProjectFiles, ProjectItem } from './projectFiles';
import type { TilesInfo } from '../core/geotiffTiles';
import { openJson, sealJson } from './sealedFile';

/** Reads one of the extension's project files; a file saved before encryption is saved again encrypted. */
async function readFile<T>(project: ProjectFiles, name: string, folderId?: string): Promise<T | null> {
  const dir = folderId ?? (await project.root()).id;
  const item = await project.find(dir, name);
  if (!item) return null;
  const { value, sealed } = await openJson<T>(project.projectId, await (await project.download(item)).text());
  if (!sealed && value) {
    // Encrypt older plain files the first time they are read (needs permission to write to the folder)
    void writeFile(project, name, value, dir).catch(() => undefined);
  }
  return value;
}

async function writeFile(project: ProjectFiles, name: string, value: unknown, folderId?: string): Promise<void> {
  const dir = folderId ?? (await project.root()).id;
  await project.writeFile(dir, name, await sealJson(project.projectId, value));
}

/** The file the shared base maps are saved in, in the project's top-level folder. */
export const SHARED_FILE = 'ntrip-caster-map.json';

/** A GeoTIFF base map shared with the project: where it is and what it is; its picture is a separate project file. */
export interface SharedGeoTiff {
  id: string;
  name: string;
  crs: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  width: number;
  height: number;
  addedAt: number;
  /** Set when the GeoTIFF is a project file read in pieces at its own resolution; there is then no separate picture */
  item?: ProjectItem;
  tiles?: TilesInfo;
}

export interface SharedMap {
  version: 1;
  savedAt: number;
  geotiffs: SharedGeoTiff[];
}

// ------------------------------------------------------------------ the extension's folder
/** Everything the extension saves in a project goes in this folder, which only project admins can see. */
export const EXT_FOLDER = 'NTRIP Caster Extension';
const REPORT_PREFIX = 'NTRIP Caster Monthly Report - ';

export interface ExtFolder {
  id: string;
  /** False when the folder still looks open to all project members (a reminder is in `warning`) */
  restricted: boolean;
  warning?: string;
  /** Files moved into it from the project's top folder this time */
  moved: string[];
}

const folders = new WeakMap<ProjectFiles, Promise<ExtFolder>>();
/** Forgets the folder check for this page, so the next call sets it up (and its permissions) again. */
export function resetExtensionFolder(project: ProjectFiles): void {
  folders.delete(project);
}
/**
 * The extension's folder (created if needed), with files the extension saved in the top folder before moved into
 * it (they keep their versions). Its permissions are set by the project admin in Connect. Done once per page load.
 */
export function extensionFolder(project: ProjectFiles): Promise<ExtFolder> {
  let f = folders.get(project);
  if (!f) {
    f = (async () => {
      const root = await project.root();
      const id = await project.ensureFolder(root.id, EXT_FOLDER);
      // Permissions are left to the project admin to set in Connect
      const restricted = true;
      const warning: string | undefined = undefined;
      const moved: string[] = [];
      for (const item of await project.list(root.id)) {
        if (item.isFolder) continue;
        const ours = item.name === SETTINGS_FILE || item.name === SHARED_FILE || /^ntrip-caster-map-geotiff-.+\.png$/.test(item.name) || item.name.startsWith(REPORT_PREFIX);
        if (!ours) continue;
        try {
          await project.move(item.id, id);
          moved.push(item.name);
        } catch (err) {
          console.warn(`[ntrip] could not move ${item.name} into ${EXT_FOLDER}`, err);
        }
      }
      return { id, restricted, warning, moved };
    })();
    f.catch(() => folders.delete(project));
    folders.set(project, f);
  }
  return f;
}

/** Reads the base maps saved with the project, or null if there are none. */
export async function loadShared(project: ProjectFiles, folderId?: string): Promise<SharedMap | null> {
  const data = await readFile<SharedMap>(project, SHARED_FILE, folderId);
  return data && Array.isArray(data.geotiffs) ? data : null;
}

/** Saves the base maps into the project so everyone who opens the extension gets them. */
export async function saveShared(project: ProjectFiles, shared: SharedMap): Promise<void> {
  await writeFile(project, SHARED_FILE, shared);
}

/** Name of the project file holding a shared GeoTIFF's picture. */
export const geotiffPictureName = (id: string) => `ntrip-caster-map-geotiff-${id}.png`;

export async function saveSharedPicture(project: ProjectFiles, id: string, picture: Blob): Promise<void> {
  const root = await project.root();
  await project.writeFile(root.id, geotiffPictureName(id), picture, 'image/png');
}

export async function loadSharedPicture(project: ProjectFiles, id: string, folderId?: string): Promise<Blob | null> {
  const dir = folderId ?? (await project.root()).id;
  const item = await project.find(dir, geotiffPictureName(id));
  return item ? project.download(item) : null;
}

/** The project's caster connection, saved in the project's top-level folder so everyone on the project uses it. */
export const SETTINGS_FILE = 'ntrip-caster-settings.json';

export interface ProjectSettings {
  version: 1;
  casterUrl: string;
  savedAt: number;
  savedBy?: string;
}

/** Reads the caster connection saved with the project (in the admins-only folder), or null if there is none. */
export async function loadProjectSettings(project: ProjectFiles): Promise<ProjectSettings | null> {
  const root = await project.root();
  const folder = await project.findFolder(root.id, EXT_FOLDER);
  // Members who aren't admins can't see the folder; they use the built-in caster or the one remembered here
  const data = folder ? await readFile<ProjectSettings>(project, SETTINGS_FILE, folder.id) : await readFile<ProjectSettings>(project, SETTINGS_FILE);
  return data && typeof data.casterUrl === 'string' && data.casterUrl ? data : null;
}

export async function saveProjectSettings(project: ProjectFiles, settings: ProjectSettings): Promise<void> {
  const folder = await extensionFolder(project);
  await writeFile(project, SETTINGS_FILE, settings, folder.id);
}
