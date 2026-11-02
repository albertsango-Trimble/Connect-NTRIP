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
  position: { lat: number; lon: number; h: number | null; stationId?: number; antennaHeight?: number | null; accuracy?: string; from: string; by?: string; at?: string } | null;
  /** Position set by hand in the extension (used when the base's data doesn't give one) */
  manualPosition?: { lat: number; lon: number; h: number | null; by: string; at: string } | null;
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
  /** The caster has this login's password on record, so it can be included when emailing the login */
  passwordOnRecord?: boolean;
}

/** A login's details written up as an email to its operator. */
export interface LoginEmail {
  serial?: string;
  label?: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  passwordOnRecord?: boolean;
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
  /** Points kept in this session's trail (sessions from before trails were kept have none) */
  trailPoints?: number;
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
  /** Receiver web address and login name (the password is never sent to the browser) */
  webUrl?: string;
  username?: string;
  hasPassword?: boolean;
  /** "extension" when added here (can be edited here), "config" when set in the server config file */
  source?: 'extension' | 'config';
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

/** The Connect project this extension is open in, and how its bases connect to the caster. */
export interface ProjectInfo {
  id: string;
  name: string;
  /** True when the user is an admin of the Connect project */
  isAdmin: boolean;
  /** The caster can send email itself (an SMTP server is set up) */
  emailEnabled?: boolean;
  /** Only sent to project admins */
  baseConnection: { host: string | null; port: number; password: string } | null;
}

/** A login as exported from one project for importing into another (the password stays hashed). */
export interface ExportedLogin {
  serial: string;
  label?: string;
  enabled?: boolean;
  profile?: Record<string, string>;
  passwordHash: string;
}

export interface LoginExport {
  format: 'connect-ntrip-logins';
  version: number;
  exportedAt: string;
  fromProject: string;
  logins: ExportedLogin[];
}

export type CasterMessage =
  | { type: 'hello'; user: { email: string; name: string }; project: ProjectInfo; snapshot: Snapshot; devices: Device[] }
  | { type: 'project'; project: ProjectInfo }
  | { type: 'tick'; serverTime: number; positions: { id: string; gga: Gga; ggaAt: number; point: TrackPoint | null }[]; mountpoints: Mountpoint[]; rovers: Rover[]; receivers?: Receiver[] }
  | { type: 'event'; event: LogEvent }
  | { type: 'devices'; devices: Device[] }
  | { type: 'mountpoints'; mountpoints: Mountpoint[] }
  | { type: 'receivers'; receivers: Receiver[] };
