# Load test

Simulates many projects, each with one base (RTCM 3 MSM4 at 1 Hz) and many rovers (GGA at 1 Hz, timing how long corrections take to arrive). **Run it against a separate test caster, never the live one**: it writes thousands of logins and trails.

```bash
cd caster
mkdir -p /tmp/lt/data
# test config at /tmp/lt/config.json: dashboardToken "devtoken123", ntripPort 32101, dashboardPort 38080,
# dataDir /tmp/lt/data, autoMountpoints enabled
node tools/loadtest/setup.mjs /tmp/lt/data /tmp/lt/plan.json          # 50 projects x 200 logins
CASTER_CONFIG=/tmp/lt/config.json node src/index.js > /tmp/lt/caster.log &
node tools/loadtest/watch.mjs $(pgrep -f "node src/index.js")         # CPU, memory, API and live-feed timing every 5 s
node tools/loadtest/gen.mjs /tmp/lt/plan.json 0 25 60000 &            # projects 0-24, rovers connect over 60 s
node tools/loadtest/gen.mjs /tmp/lt/plan.json 25 50 60000 &           # projects 25-49
```

Run the generators on another machine (change 127.0.0.1 in gen.mjs) to measure the caster on its own.
