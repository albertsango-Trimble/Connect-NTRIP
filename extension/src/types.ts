/** Shapes of the caster's dashboard feed (see caster/src/state.js and dashboard.js). */
export interface Gga {
  utc: string | null;
  lat: number | null;
  lon: number | null;
  hasPosition: boolean;
  quality: number;
  fix: string;
  sats: number;
  hdop: number | null;
  alt: number | null;
  geoidSep: number | null;
  ageOfCorrections: number | null;
  refStationId: string | null;
}

/** [lat, lon, time ms, fix quality] */
export type TrackPoint = [number, number, number, number];

export interface Rover {
  id: string;
  serial: string;
  label: string;
  mount: string;
  addr: string;
  protocol: string;
  agent: string;
  connectedAt: number;
  bytesOut: number;
  rateBps: number;
  gga: Gga | null;
  ggaAt: number | null;
  track?: TrackPoint[];
}

export interface Mountpoint {
  name: string;
  identifier: string;
  format: string;
  navSystem: string;
  online: boolean;
  addr: string | null;
  protocol: string | null;
  connectedAt: number | null;
  lastDataAt: number | null;
  bytesIn: number;
  rateBps: number;
  messageTypes: number[];
  position: { lat: number; lon: number; h: number | null; stationId?: number; antennaHeight?: number | null; from: string } | null;
  rovers: number;
}

export interface Device {
  serial: string;
  label: string;
  mountpoints: string[];
  enabled: boolean;
  created: string;
  updated: string;
}

export interface LogEvent {
  type: string;
  time: string;
  serial?: string;
  mount?: string;
  protocol?: string;
  addr?: string;
  reason?: string;
  by?: string;
  [key: string]: unknown;
}

export interface Snapshot {
  casterName: string;
  host: string | null;
  ntripPort: number;
  serverTime: number;
  startedAt: number;
  mountpoints: Mountpoint[];
  rovers: Rover[];
  log: LogEvent[];
}

export type CasterMessage =
  | { type: 'hello'; user: { email: string; name: string }; snapshot: Snapshot; devices: Device[] }
  | { type: 'tick'; serverTime: number; positions: { id: string; gga: Gga; ggaAt: number; point: TrackPoint | null }[]; mountpoints: Mountpoint[]; rovers: Rover[] }
  | { type: 'event'; event: LogEvent }
  | { type: 'devices'; devices: Device[] };
