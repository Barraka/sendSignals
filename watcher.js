require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const chokidar = require("chokidar");

const SIGNALS_FOLDER = process.env.SIGNALS_FOLDER;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN;
const VERBOSE = process.argv.includes("--verbose");
const HISTORY_DIR = path.join(__dirname, "market_state_history");

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }
function verbose(...args) { if (VERBOSE) log("[VERBOSE]", ...args); }

function waitForFile(filePath, maxWait = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      try { if (fs.statSync(filePath).size > 0) return resolve(); } catch {}
      if (Date.now() - start > maxWait) return reject(new Error(`Timeout: ${filePath}`));
      setTimeout(check, 300);
    };
    check();
  });
}

function postToDiscord(imagePaths, jsonData) {
  return new Promise((resolve, reject) => {
    const url = new URL(DISCORD_WEBHOOK);
    const boundary = "----FormBoundary" + Date.now();

    const content = [
      `**📊 Signal: ${jsonData.direction} ${jsonData.symbol}**`,
      `Time: ${jsonData.time} | TF: M${jsonData.timeframe}`,
      `Bid: ${jsonData.bid} | Spread: ${jsonData.spread}`,
      `Bar — O: ${jsonData.open} H: ${jsonData.high} L: ${jsonData.low} C: ${jsonData.close}`,
      `Channel — Upper: ${jsonData.upperChannel} Lower: ${jsonData.lowerChannel} Dir: ${jsonData.channelDirection > 0 ? "BULL" : "BEAR"}`,
      `ATR: ${jsonData.atr} | BarSize/ATR: ${jsonData.barSizeATR}`,
      `Entry Ratio: ${jsonData.entryRatio} | Swing Ratio: ${jsonData.swingRatio}`,
    ].join("\n");

    const payload = JSON.stringify({ content });
    const parts = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${payload}\r\n`, "utf-8")];

    imagePaths.forEach((imgPath, i) => {
      const imageHeader = `--${boundary}\r\nContent-Disposition: form-data; name="files[${i}]"; filename="${path.basename(imgPath)}"\r\nContent-Type: image/png\r\n\r\n`;
      parts.push(Buffer.from(imageHeader, "utf-8"));
      parts.push(fs.readFileSync(imgPath));
      parts.push(Buffer.from("\r\n", "utf-8"));
    });

    parts.push(Buffer.from(`--${boundary}--\r\n`, "utf-8"));
    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => res.statusCode < 300 ? resolve(data) : reject(new Error(`Discord ${res.statusCode}: ${data}`)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function wakeKit(jsonData, { h1Available = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!HOOK_TOKEN) { log("No OPENCLAW_HOOK_TOKEN — Kit won't auto-analyze"); return resolve(); }

    const signalData = JSON.stringify(jsonData);
    const h1Line = h1Available
      ? "\n6. The Discord message also contains an H1 screenshot — use it for higher-timeframe context when scoring the signal"
      : "";
    const msg = `New trading signal: ${jsonData.direction} ${jsonData.symbol} at ${jsonData.time} (M${jsonData.timeframe}).

Signal data: ${signalData}

Instructions:
1. Check #trading channel (1475598923795136646), read the latest signal from MT4 Signals webhook
2. Fetch and analyze the attached M5 screenshot
3. Read the scoring methodology from /home/manu/.openclaw/workspace/memory/trading/scoring-system.txt
4. Post your analysis to #trading using the message tool (target: 1475598923795136646). Format: SCORE (0-10), DIRECTION, SETUP TYPE, VERDICT (GO/CAUTION/SKIP), RED FLAGS, REASON, EXIT SUGGESTION
5. After posting, append a one-line JSON log to /home/manu/.openclaw/workspace/memory/trading/signals/${new Date().toISOString().slice(0,10)}.jsonl with: {"time":"${jsonData.time}","symbol":"${jsonData.symbol}","direction":"${jsonData.direction}","score":N,"verdict":"GO|CAUTION|SKIP","setup":"type","reason":"one-line summary"}${h1Line}`;

    const payload = JSON.stringify({ message: msg });

    const hookUrl = new URL(process.env.OPENCLAW_HOOK_URL || "http://127.0.0.1:18789/hooks/agent");
    const req = http.request({
      hostname: hookUrl.hostname,
      port: hookUrl.port,
      path: hookUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HOOK_TOKEN}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        res.statusCode < 300 ? resolve(data) : reject(new Error(`Hook ${res.statusCode}: ${data}`));
      });
    });
    req.on("error", (err) => {
      log("Hook failed (is SSH tunnel running?):", err.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

function getHistoryPath(symbol) {
  return path.join(HISTORY_DIR, `${symbol}.json`);
}

function loadHistory(symbol) {
  const filePath = getHistoryPath(symbol);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(data)) return [];
    return data;
  } catch { return []; }
}

function appendHistory(snapshot) {
  const symbol = snapshot.symbol || "unknown";
  const today = (snapshot.time || "").slice(0, 10);
  let history = loadHistory(symbol);

  // Flush if the day changed
  if (history.length > 0) {
    const lastDay = (history[0].time || "").slice(0, 10);
    if (lastDay !== today) {
      verbose(`New day detected for ${symbol} — flushing history`);
      history = [];
    }
  }

  history.push(snapshot);
  fs.writeFileSync(getHistoryPath(symbol), JSON.stringify(history, null, 2));
  return history;
}

function sendMarketState(jsonData, history) {
  return new Promise((resolve, reject) => {
    if (!HOOK_TOKEN) { log("No OPENCLAW_HOOK_TOKEN — skipping market state"); return resolve(); }

    const symbol = jsonData.symbol || "unknown";
    const time = jsonData.time || new Date().toISOString();

    const msg = `Market state update for ${symbol} at ${time}. Log this silently for context — do not post to Discord.

Current snapshot: ${JSON.stringify(jsonData)}

Today's history (${history.length} snapshots): ${JSON.stringify(history)}`;

    const payload = JSON.stringify({ message: msg });

    const hookUrl = new URL(process.env.OPENCLAW_HOOK_URL || "http://127.0.0.1:18789/hooks/agent");
    const req = http.request({
      hostname: hookUrl.hostname,
      port: hookUrl.port,
      path: hookUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HOOK_TOKEN}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        res.statusCode < 300 ? resolve(data) : reject(new Error(`Hook ${res.statusCode}: ${data}`));
      });
    });
    req.on("error", (err) => {
      log("Market state hook failed (is SSH tunnel running?):", err.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

async function processSignal(jsonPath) {
  const pngPath = jsonPath.replace(/\.json$/, ".png");
  const h1PngPath = jsonPath.replace(/\.json$/, "_H1.png");
  log(`New signal: ${path.basename(jsonPath)}`);
  try {
    await waitForFile(jsonPath);
    await waitForFile(pngPath);
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

    // Wait for H1 screenshot (longer timeout, soft fail)
    let h1Available = false;
    try {
      verbose(`Waiting for H1 screenshot: ${path.basename(h1PngPath)}`);
      await waitForFile(h1PngPath, 15000);
      h1Available = true;
      verbose("H1 screenshot found");
    } catch {
      log(`H1 screenshot not found (timeout) — proceeding without it`);
    }

    // Post to Discord with available screenshots
    const images = [pngPath];
    if (h1Available) images.push(h1PngPath);
    await postToDiscord(images, jsonData);
    log(`Posted to Discord: ${jsonData.direction} ${jsonData.symbol}${h1Available ? " (M5+H1)" : " (M5 only)"}`);

    // Wake Kit for analysis (non-blocking)
    wakeKit(jsonData, { h1Available })
      .then(() => log("Kit notified for analysis"))
      .catch((err) => log("Kit wake error:", err.message));

  } catch (err) {
    log("Error:", err.message);
  }
}

async function handleJson(jsonPath) {
  try {
    await waitForFile(jsonPath);
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

    if (jsonData.type === "market_state") {
      verbose(`Market state file detected: ${path.basename(jsonPath)}`);
      const history = appendHistory(jsonData);
      log(`Market state: ${jsonData.symbol} — ${history.length} snapshots today`);
      sendMarketState(jsonData, history)
        .then(() => verbose("Market state sent to Kit"))
        .catch((err) => log("Market state error:", err.message));
    } else {
      processSignal(jsonPath);
    }
  } catch (err) {
    log("Error reading JSON:", err.message);
  }
}

if (!SIGNALS_FOLDER || !DISCORD_WEBHOOK) {
  console.error("Set SIGNALS_FOLDER and DISCORD_WEBHOOK_URL in .env");
  process.exit(1);
}
if (!fs.existsSync(SIGNALS_FOLDER)) fs.mkdirSync(SIGNALS_FOLDER, { recursive: true });
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

log(`Watching: ${SIGNALS_FOLDER}`);
log(`Kit hook: ${HOOK_TOKEN ? "enabled (needs SSH tunnel)" : "disabled"}`);
const watcher = chokidar.watch(SIGNALS_FOLDER, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});
watcher.on("add", (f) => path.extname(f).toLowerCase() === ".json" && handleJson(f));
watcher.on("change", (f) => path.extname(f).toLowerCase() === ".json" && handleJson(f));
log("Watcher started. Signals → Discord + Kit analysis");
