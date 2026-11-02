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
  /** Created by a base that named its own mountpoint */
  auto?: boolean;
  /** Format worked out from the data while the base is sending */
  detectedFormat?: string | null;
  lastSeen?: string | null;
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

export interface Profile {
  companyName: string;
  companyPhone: string;
  companyEmail: string;
  operatorName: string;
  operatorPhone: string;
  operatorEmail: string;
}

export interface Device {
  serial: string;
  label: string;
  mountpoints: string[];
  enabled: boolean;
  profile: Profile;
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

/** A finished connection in a rover's online history */
export interface SessionRecord {
  type: 'session';
  start: number;
  end: number;
  durationSec: number;
  mount: string;
  label?: string;
  protocol: string;
  addr: string;
  agent?: string;
  bytes: number;
  endReason: string;
  sentPosition: boolean;
  fixSec: { fixed: number; float: number; other: number; none: number };
  firstPos: [number, number] | null;
  lastPos: [number, number] | null;
}

/** A refused login attempt by a known rover */
export interface RejectedRecord {
  type: 'rejected';
  time: number;
  mount: string;
  addr: string;
  reason: string;
  agent?: string;
}

export type HistoryRecord = SessionRecord | RejectedRecord;

export interface HistoryReply {
  device: Device;
  days: number;
  keepDays: number;
  live: Rover[];
  records: HistoryRecord[];
}

/** A base receiver whose own web interface can be opened through the caster */
export interface Receiver {
  id: string;
  name: string;
  model: string;
  mountpoints: string[];
  webUi: boolean;
  /** null until the caster has checked */
  reachable: boolean | null;
  httpStatus?: number;
  error?: string;
  checkedAt?: number;
}

export interface Snapshot {
  casterName: string;
  host: string | null;
  ntripPort: number;
  serverTime: number;
  startedAt: number;
  mountpoints: Mountpoint[];
  rovers: Rover[];
  receivers?: Receiver[];
  log: LogEvent[];
}

export type CasterMessage =
  | { type: 'hello'; user: { email: string; name: string }; snapshot: Snapshot; devices: Device[] }
  | { type: 'tick'; serverTime: number; positions: { id: string; gga: Gga; ggaAt: number; point: TrackPoint | null }[]; mountpoints: Mountpoint[]; rovers: Rover[]; receivers?: Receiver[] }
  | { type: 'event'; event: LogEvent }
  | { type: 'devices'; devices: Device[] };
