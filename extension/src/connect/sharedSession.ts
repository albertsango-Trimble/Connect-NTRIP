/**
 * Base maps shared with everyone on the Connect project, saved as a file in the project's top-level folder.
 * Same approach as the 360 Imagery Viewer's shared setup (Connect-360 src/connect/sharedSession.ts), with its own file names.
 */
import type { ProjectFiles, ProjectItem } from './projectFiles';
import type { TilesInfo } from '../core/geotiffTiles';
import { openJson, sealJson } from './sealedFile';

/** Reads one of the extension's project files; a file saved before encryption is saved again encrypted. */
async function readFile<T>(project: ProjectFiles, name: string): Promise<T | null> {
  const root = await project.root();
  const item = await project.find(root.id, name);
  if (!item) return null;
  const { value, sealed } = await openJson<T>(project.projectId, await (await project.download(item)).text());
  if (!sealed && value) {
    // Encrypt older plain files the first time they are read (needs permission to write to the project folder)
    void writeFile(project, name, value).catch(() => undefined);
  }
  return value;
}

async function writeFile(project: ProjectFiles, name: string, value: unknown): Promise<void> {
  const root = await project.root();
  await project.writeFile(root.id, name, await sealJson(project.projectId, value));
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

/** Reads the base maps saved with the project, or null if there are none. */
export async function loadShared(project: ProjectFiles): Promise<SharedMap | null> {
  const data = await readFile<SharedMap>(project, SHARED_FILE);
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

export async function loadSharedPicture(project: ProjectFiles, id: string): Promise<Blob | null> {
  const root = await project.root();
  const item = await project.find(root.id, geotiffPictureName(id));
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

/** Reads the caster connection saved with the project, or null if none has been saved. */
export async function loadProjectSettings(project: ProjectFiles): Promise<ProjectSettings | null> {
  const data = await readFile<ProjectSettings>(project, SETTINGS_FILE);
  return data && typeof data.casterUrl === 'string' && data.casterUrl ? data : null;
}

export async function saveProjectSettings(project: ProjectFiles, settings: ProjectSettings): Promise<void> {
  await writeFile(project, SETTINGS_FILE, settings);
}
