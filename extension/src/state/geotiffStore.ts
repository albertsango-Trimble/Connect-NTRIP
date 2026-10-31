import type { ProjectItem } from '../connect/projectFiles';
import type { TilesInfo } from '../core/geotiffTiles';

/**
 * Remembers the GeoTIFF base maps added to a project, in this browser, so they are there next time.
 * What is kept is the picture drawn from the GeoTIFF (not the original file) and where it belongs.
 */

export interface SavedGeoTiff {
  id: string;
  name: string;
  crs: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  width: number;
  height: number;
  /** A reduced picture drawn from the file, for files that can't be reopened (added from this computer) */
  png?: Blob;
  /** The project file, which is read in pieces whenever it is shown, at its own resolution */
  item?: ProjectItem;
  tiles?: TilesInfo;
  /** The coarse overview built for a file that has none, so it needn't be built again */
  overview?: Blob;
  addedAt: number;
}

const DB_NAME = 'connect-ntrip-geotiffs';
const STORE = 'geotiffs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

const key = (projectId: string, id: string) => `${projectId}/${id}`;

/** Everything saved for the project, oldest first. */
export async function listGeoTiffs(projectId: string): Promise<SavedGeoTiff[]> {
  const range = IDBKeyRange.bound(`${projectId}/`, `${projectId}/￿`);
  const all = await withStore<SavedGeoTiff[]>('readonly', (s) => s.getAll(range));
  return all.sort((a, b) => a.addedAt - b.addedAt);
}

export const putGeoTiff = (projectId: string, item: SavedGeoTiff) => withStore('readwrite', (s) => s.put(item, key(projectId, item.id))).then(() => undefined);

export const deleteGeoTiff = (projectId: string, id: string) => withStore('readwrite', (s) => s.delete(key(projectId, id))).then(() => undefined);
