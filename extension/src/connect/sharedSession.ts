/**
 * Base maps shared with everyone on the Connect project, saved as a file in the project's top-level folder.
 * Same approach as the 360 Imagery Viewer's shared setup (Connect-360 src/connect/sharedSession.ts), with its own file names.
 */
import type { ProjectFiles, ProjectItem } from './projectFiles';
import type { TilesInfo } from '../core/geotiffTiles';

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
  const root = await project.root();
  const item = await project.find(root.id, SHARED_FILE);
  if (!item) return null;
  const file = await project.download(item);
  const data = JSON.parse(await file.text()) as SharedMap;
  return data && Array.isArray(data.geotiffs) ? data : null;
}

/** Saves the base maps into the project so everyone who opens the extension gets them. */
export async function saveShared(project: ProjectFiles, shared: SharedMap): Promise<void> {
  const root = await project.root();
  await project.writeFile(root.id, SHARED_FILE, JSON.stringify(shared));
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
  const root = await project.root();
  const item = await project.find(root.id, SETTINGS_FILE);
  if (!item) return null;
  const data = JSON.parse(await (await project.download(item)).text()) as ProjectSettings;
  return data && typeof data.casterUrl === 'string' && data.casterUrl ? data : null;
}

export async function saveProjectSettings(project: ProjectFiles, settings: ProjectSettings): Promise<void> {
  const root = await project.root();
  await project.writeFile(root.id, SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
