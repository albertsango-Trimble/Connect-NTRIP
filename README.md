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
- Bases tab: each base receiver (with its **web UI**, opened inside the extension) and each mountpoint's status, data rate, RTCM message types seen, machines on it.
- Logins tab: add/edit/disable/delete rover logins, each with a **company** (name, phone, email) and **operator** (name, phone, email). These show on the machine's card and map popup with tap-to-call and email links.
- **Online history** per rover (History button on a machine or login): every connection with start/end, duration, mountpoint, fix quality over the session, data sent, address and why it ended, plus refused logins; filter by period and export to CSV.
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

Logs: `journalctl -u connect-ntrip -f`. To update the caster to the latest version later: `cd ~/Connect-NTRIP && bash deploy/update.sh` (keeps your config, logins and history).

 Rover logins live in `/var/lib/connect-ntrip/devices.json` (hashed).

## Projects

Everything in the extension belongs to the Trimble Connect project it is opened in: bases (mountpoints), base receivers, rover logins, online history and the log. A new project starts empty.

- **Each project has its own base password.** Only Connect project admins can see or change it. Open the extension in the project, go to **Bases → Connect a base to this project**, and enter the caster address, port and that password in the base receiver. Whatever mountpoint name the base uses ends up in that project. **Change password…** gives the project a new one (bases using the old one are refused until updated).
- **Rovers sign in against the logins of the base's project.** A machine working on two projects needs a login in each.
- **Copy logins between projects** with **Logins → Export** (downloads a file) and **Logins → Import** in the other project. Passwords travel hashed, so machines keep their existing password; logins already in the project are kept unless you tick *Replace*. Allowed-mountpoint limits are not copied.
- **Upgrading from before projects:** the first project to open the extension takes over the existing bases, logins, history and receivers, and keeps the `autoMountpoints.sourcePassword` from the config, so those bases carry on without changes. Open the extension in the right project first.
- Access is checked with Trimble Connect: you must be in `adminEmails` and be able to open the project.

## 2. Point the Trimble base at the caster

### Let the base name its own mountpoints (simplest)

With `autoMountpoints` on (it is in the example config), you don't need to set up mountpoints on the caster at all. In the receiver's NTRIP output, type **any mountpoint name you like** and use the project's base password shown in **Bases → Connect a base to this project** (see Projects above). The caster creates the mountpoint when the base connects, and works out the format from the data: RTCM 3, CMR+ or CMRx. The base's position comes from the base's own data: RTCM 1005/1006, or CMR message Type 1 (reference station coordinates, decoded per Trimble's CMR specification). Streams without either, such as CMRx, take it from another stream the same base is sending. NTRIP 2 bases that send an `Ntrip-STR` header can also supply it.

**Bases with no position in their data** (for example CMRx only): in the Bases tab click **Set position**, then click the base's spot on the map, drag the pin, or type its latitude/longitude (or easting/northing in the Connect project's coordinate system). You can apply the same position to the base's other mountpoints in one go. A position set by hand is used whenever the base's own data doesn't give one; RTCM 1005/1006, CMR Type 1 or another stream from the same base still take priority while it is sending.

These mountpoints show as **Set by base** in the Bases tab, appear in the sourcetable while the base is sending, and are remembered for rover logins and history. Once a base stops sending to one, you can remove it from the Bases tab. Configured mountpoints (below) still use their own passwords; the shared password can't take them over.

### Or configure them yourself

A caster relays streams; it does not convert formats. So the receiver sends **one stream per format**, each to its own mountpoint. In the receiver's web interface (I/O configuration), add an NTRIP output for each format:

| Output | Mountpoint | Password | Format |
|---|---|---|---|
| 1 | `UPG_RTCM3` | `sourcePassword` from config | RTCM 3.x (include 1005 or 1006 so the map can place the base) |
| 2 | `UPG_CMRX`  | its `sourcePassword` | CMRx |
| 3 | `UPG_CMRP`  | its `sourcePassword` | CMR+ |

Caster address `caster.yourdomain.com`, port `2101`, NTRIP version 1 or 2 (both accepted). For NTRIP 2 the username is ignored; only the password is checked.

## 2a. Open the base receiver's own web UI from the extension

Each base receiver listed in the config gets an **Open web UI** button (Bases tab, and the base's popup on the map). The receiver's web interface opens in a panel over the map, or in a new tab.

How it works: the caster proxies the receiver's web server at `https://<receiver id>.bases.yourdomain.com`. Caddy issues that certificate automatically (only for receivers in the config). The extension asks the caster for a one-time link valid for 60 seconds, which only `adminEmails` users can get; opening it signs that browser in to that one receiver for 8 hours. The proxy fills in the receiver's own login, so users never need the receiver password, and it fixes the receiver's headers so its pages can be shown inside Connect.

**Adding a receiver from the extension:** Bases tab → **+ Add base receiver**: name, model, the receiver's web address (as the caster server can reach it), its web login, and which mountpoints are its streams. Receivers added this way are kept in `/var/lib/connect-ntrip/receivers.json` (readable only by the caster; the password is never sent back to the browser) and can be edited or removed with **Edit**. Receivers listed in the config file (below) also show, marked *server config*.

Setup:

1. Add a wildcard DNS record `*.bases.yourdomain.com` → the VM's IP (the setup script uses `bases.<DOMAIN>` unless you set `BASES_DOMAIN`).
2. Make the receiver's web server reachable **from the VM** (see below).
3. Add it to `/etc/connect-ntrip/config.json`:
   ```json
   "webUi": { "domain": "bases.yourdomain.com", "port": 8081 },
   "receivers": [
     {
       "id": "melbourne",
       "name": "Melbourne base",
       "model": "Trimble Alloy",
       "mountpoints": ["UPG_RTCM3", "UPG_CMRX", "UPG_CMRP"],
       "webUrl": "http://10.8.0.2",
       "username": "admin",
       "password": "receiver web password"
     }
   ]
   ```
   `id` becomes the web address (`melbourne.bases.yourdomain.com`). `mountpoints` ties the receiver to its streams so the map marker and Bases tab show it. `username`/`password` are the receiver's web login (HTTP Basic or Digest are both handled); leave them out to have users log in to the receiver themselves.
4. `sudo systemctl restart connect-ntrip`. The Bases tab shows whether the caster can reach each receiver (checked every minute).

**Getting the VM to the receiver.** Bases usually sit behind a site router or a cellular modem, so the VM can't reach them directly. Two ways:

- **VPN (recommended).** Most industrial/cellular routers (Teltonika, Cradlepoint, Digi, etc.) can run WireGuard or OpenVPN. Put the VM and the site router on a small VPN and use the receiver's LAN address as `webUrl` (e.g. `http://192.168.1.50`). The receiver is never exposed to the internet and the traffic is encrypted.
- **Port forward.** Forward a port on the site router to the receiver's web port, allow it **only from the VM's IP**, and use the site's public address as `webUrl` (e.g. `http://203.0.113.10:8080`). Simpler, but the link between the VM and the site is plain HTTP.

If someone's browser blocks cookies for pages embedded in other sites, the panel shows a message and **Open in new tab** works instead.

## 3. Set up rovers

1. In the extension's **Logins** tab, add the receiver's serial number, a machine name, the password the user picked, and the company and operator contact details. Optionally tick the mountpoints it may use.
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
- Online history is kept for `historyDays` (default 365; 0 keeps everything) in `/var/lib/connect-ntrip/history/<serial>.jsonl`. Deleting a login keeps its history; adding the same serial again brings it back. Editing names or contact details doesn't disconnect a machine; disabling it, changing its password or removing its mountpoint does.
- Each base web UI session lasts 8 hours and is tied to one receiver. Openings are recorded in the Log tab.
- The Trimble Connect API host list (`tcApiHosts`) covers the regional Connect servers; the first one that accepts the token is used.
