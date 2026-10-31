# Connect-NTRIP

An NTRIP caster for a Trimble base station, with a Trimble Connect extension that shows the
base and every machine receiving corrections on a live map.

```
 Trimble base ──(NTRIP source, v1 or v2)──►  Caster on cloud VM  ◄──(NTRIP client, v1 or v2)── Rovers / machines
  RTCM3 / CMRx / CMR+                           :2101 NTRIP               serial no. + password      sends GGA back
                                                :443 dashboard API + WebSocket (via Caddy TLS)
                                                        ▲
                                                        │ wss:// live feed, Trimble Connect sign-in
                                       Trimble Connect extension (GitHub Pages)
```

## What it does

**Caster (`caster/`)** — Node.js 20+, one dependency (`ws`).

- NTRIP 1.0 and 2.0 on the same port, for both bases and rovers. Rovers pick the version in their own NTRIP settings.
- Relays RTCM 3, CMRx and CMR+ byte-for-byte: one mountpoint per format.
- Rover login: **username = receiver serial number**, password chosen by the user. Passwords are stored as scrypt hashes. Each login can be limited to specific mountpoints, disabled, or deleted; changes kick any live session.
- Reads the NMEA GGA each rover sends back to get its position, fix type, satellites, HDOP and correction age.
- Decodes RTCM 1005/1006 to put the base on the map at its broadcast position (CMRx/CMR+ mountpoints use the position in the config).
- One live session per serial: a reconnecting machine replaces its stale session.
- Dashboard API and WebSocket, authenticated with the user's Trimble Connect token and an email allowlist.

**Extension (`extension/`)** — TypeScript + Vite + MapLibre, same stack as the 360 Imagery Viewer.

- Base maps, the same as the 360 Imagery Viewer's map: **Street** (OpenStreetMap), **Satellite** (Esri World Imagery), **WMTS** (a capabilities URL with a layer picker, or any `{z}/{x}/{y}` tile URL) and **GeoTIFF** (several at once, from this computer or read in place from the Connect project, reprojected from their own CRS, Cloud Optimized GeoTIFFs streamed at full resolution). GeoTIFFs and the chosen base map are remembered per project in the browser, and ticking **Share these GeoTIFFs with everyone on the project** in the GeoTIFF panel saves them to `ntrip-caster-map.json` in the project's top folder (plus a reduced picture for GeoTIFFs added from someone's PC), so everyone who opens the extension gets them. Removing a shared GeoTIFF removes it for everyone. The shared modules are copies of Connect-360's `core/geotiff*.ts`, `core/wmts.ts`, `core/geo.ts`, `ui/sourceDialog.ts`, `connect/projectFiles.ts` and its shared-setup pattern (`connect/sharedSession.ts`).
- Map: base(s) as purple triangles, machines as dots coloured by fix (green fixed, orange float, blue DGPS, grey autonomous/stale), optional trails and labels.
- Machines tab: each connected rover with fix, satellites, HDOP, correction age, data rate, time connected, and a Disconnect button.
- Bases tab: each mountpoint's status, data rate, RTCM message types seen, machines on it.
- Logins tab: add/edit/disable/delete rover logins.
- Log tab: connections, refused logins (with reason), base drop-outs.

## 1. Set up the VM

Any small Ubuntu 22.04/24.04 VM is enough (1 vCPU, 1 GB RAM should comfortably handle a large fleet: the caster only relays bytes).

1. Point a DNS name at the VM, e.g. `caster.yourdomain.com`.
2. Open inbound TCP **2101** (NTRIP), **80** and **443** (dashboard/TLS) in the cloud provider's firewall / security group.
3. Copy this repo to the VM and run:
   ```bash
   sudo DOMAIN=caster.yourdomain.com bash deploy/setup-ubuntu.sh
   ```
4. Edit `/etc/connect-ntrip/config.json`:
   - `sourcePassword` for each mountpoint (the base uses these)
   - `adminEmails`: Trimble Connect accounts allowed to open the dashboard
   - `lat`/`lon` per mountpoint (used for the sourcetable and for CMRx/CMR+ base markers)
   - mountpoint names, if you want different ones
5. `sudo systemctl restart connect-ntrip`, then check `https://caster.yourdomain.com/api/health`.

Logs: `journalctl -u connect-ntrip -f`. Rover logins live in `/var/lib/connect-ntrip/devices.json` (hashed).

## 2. Point the Trimble base at the caster

A caster relays streams; it does not convert formats. So the receiver sends **one stream per format**, each to its own mountpoint. In the receiver's web interface (I/O configuration), add an NTRIP output for each format:

| Output | Mountpoint | Password | Format |
|---|---|---|---|
| 1 | `UPG_RTCM3` | `sourcePassword` from config | RTCM 3.x (include 1005 or 1006 so the map can place the base) |
| 2 | `UPG_CMRX`  | its `sourcePassword` | CMRx |
| 3 | `UPG_CMRP`  | its `sourcePassword` | CMR+ |

Caster address `caster.yourdomain.com`, port `2101`, NTRIP version 1 or 2 (both accepted). For NTRIP 2 the username is ignored; only the password is checked.

## 3. Set up rovers

1. In the extension's **Logins** tab, add the receiver's serial number, a machine name, and the password the user picked. Optionally tick the mountpoints it may use.
2. On the rover / machine control system: caster `caster.yourdomain.com:2101`, mountpoint as above, username = serial number, password = theirs.
3. **Turn on sending the NMEA GGA position to the caster.** Without it the machine still gets corrections and appears in the Machines list, but can't be shown on the map.

Before the dashboard is running you can also create logins on the VM with the caster stopped:
```bash
sudo systemctl stop connect-ntrip
cd /opt/connect-ntrip/caster && sudo -u ntrip CASTER_CONFIG=/etc/connect-ntrip/config.json DATA_DIR=/var/lib/connect-ntrip \
  node tools/add-device.js 5834R00123 theirpassword "Excavator 3"
sudo systemctl start connect-ntrip
```

## 4. Install the extension in Trimble Connect

1. Push this repo to GitHub as `albertsango-Trimble/Connect-NTRIP`. In the repo's **Settings → Pages**, set Source to **GitHub Actions**; the included workflow builds `extension/` and publishes it.
2. If your Pages URL differs, update `extension/public/manifest.json` and the menu icon URL in `extension/src/connect/workspace.ts`.
3. Add `https://albertsango-trimble.github.io` (and any other origin you load the page from) to `allowedOrigins` in the caster config.
4. In the Trimble Connect project: **Settings → Extensions → add custom extension**, and paste
   `https://albertsango-trimble.github.io/Connect-NTRIP/manifest.json`.
5. Open the extension, click the gear, enter `https://caster.yourdomain.com`, and allow the access-token prompt.

The caster checks the Trimble Connect token against the Connect API (`/users/me`) and lets the user in only if their email is in `adminEmails`. For testing the page outside Connect, set `dashboardToken` in the config and enter it in the extension's settings; leave it empty in production.

## Testing without hardware

```bash
cd caster && npm install
cp config.example.json config.json   # set "dashboardToken": "devtoken"
node tools/add-device.js SIM001 secret1 "Sim excavator"
npm start
# another terminal: a base plus a rover driving loops around it
node tools/simulate.js --mount UPG_RTCM3 --source-password change-me-rtcm --rovers SIM001:secret1
# add --v2 to use NTRIP 2.0 (chunked) for both
```
Then `cd extension && npm install && npm run dev`, open http://localhost:5173, and set the caster URL to `http://localhost:8080` with the dev token.

## Notes and limits

- **NTRIP credentials travel in clear text** (Basic auth over plain TCP), which is how NTRIP works and what rovers expect. Use per-machine passwords, not passwords people reuse elsewhere.
- Dead rover connections are detected by TCP keepalive, so a machine that loses signal can take a minute or two to drop off the list. Its marker turns grey after 15 s without a position.
- A base that sends nothing for `sourceIdleTimeoutSec` (default 60 s) is disconnected so it can reconnect cleanly.
- The Trimble Connect API host list (`tcApiHosts`) covers the regional Connect servers; the first one that accepts the token is used.
