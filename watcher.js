/**
 * watcher.js v3 -- Signal Watcher + Position Manager + Market State + EOD
 *
 * Merged from VPS v2 (position management) and Pi version (market state, followup, EOD).
 *
 * Watches for:
 * 1. Trading signals from Channel Confirmed indicator -> Discord + Kit analysis
 * 2. Market state snapshots -> accumulated history, bundled into signal payloads
 * 3. Followup files -> Discord EOD post + Kit review
 * 4. Position opens from KitExitManager EA -> Kit exit management
 * 5. Position closes from KitExitManager EA -> Kit close logging
 *
 * Also fires an automatic EOD review at 22:00 broker time for instruments with signals.
 */

require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const chokidar = require("chokidar");
const { execFile } = require("child_process");

// === Configuration ===
const SIGNALS_FOLDER = process.env.SIGNALS_FOLDER;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN;
const HOOK_URL = process.env.OPENCLAW_HOOK_URL || "http://127.0.0.1:18789/hooks/agent";
const VPS_SSH_CMD = process.env.VPS_SSH_CMD || "ssh vps";
const REMOTE_HOST = process.env.REMOTE_HOST;
const REMOTE_USER = process.env.REMOTE_USER;
const REMOTE_SCREENSHOT_DIR = "/home/manu/.openclaw/workspace/memory/trading/signals/screenshots";
const LOCAL_SCREENSHOT_DIR = path.join(__dirname, "screenshots");
const HISTORY_DIR = path.join(__dirname, "market_state_history");
const VERBOSE = process.argv.includes("--verbose");

// === Momentum Detection Config ===
const MOMENTUM_ATR_THRESHOLD = 2.0; // Alert if move > 2x ATR over recent snapshots
const MOMENTUM_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown per instrument
const momentumCooldowns = new Map();

// Position management directories (relative to MQL4/Files/)
const MQL4_FILES_DIR = path.dirname(SIGNALS_FOLDER || ".");
const POSITIONS_DIR = path.join(MQL4_FILES_DIR, "Positions");
const CLOSED_DIR = path.join(MQL4_FILES_DIR, "Closed");
const EXITS_DIR = path.join(MQL4_FILES_DIR, "Exits");

// === Logging ===
function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }
function verbose(...args) { if (VERBOSE) log("[VERBOSE]", ...args); }

// === Utility Functions ===

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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log(`Created directory: ${dir}`);
  }
}

// === Screenshot Upload ===

const SCP_MAX_RETRIES = 3;
const SCP_RETRY_DELAYS = [5000, 15000, 45000]; // 5s, 15s, 45s
const uploadQueue = [];
let uploadRunning = false;

function uploadScreenshot(localPath) {
  const filename = path.basename(localPath);

  // Save to local screenshots folder
  try {
    fs.copyFileSync(localPath, path.join(LOCAL_SCREENSHOT_DIR, filename));
  } catch (e) { log("Local screenshot copy error:", e.message); }

  // Queue SCP upload to Pi
  if (!REMOTE_HOST || !REMOTE_USER) {
    log(`WARNING: SCP upload skipped for ${filename} -- REMOTE_HOST/REMOTE_USER not set`);
    return;
  }

  if (!fs.existsSync(localPath)) {
    log(`WARNING: SCP upload skipped for ${filename} -- source file not found`);
    return;
  }

  // Use local copy as source (original may be overwritten by MT4)
  const stablePath = path.join(LOCAL_SCREENSHOT_DIR, filename);
  uploadQueue.push({ path: stablePath, filename, attempt: 0 });
  drainUploadQueue();
}

function drainUploadQueue() {
  if (uploadRunning || uploadQueue.length === 0) return;
  uploadRunning = true;
  const item = uploadQueue.shift();
  scpUpload(item);
}

function scpUpload(item) {
  const { path: localPath, filename, attempt } = item;

  if (!fs.existsSync(localPath)) {
    log(`WARNING: SCP retry skipped for ${filename} -- local file gone`);
    uploadRunning = false;
    drainUploadQueue();
    return;
  }

  const remotePath = `${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_SCREENSHOT_DIR}/${filename}`;
  execFile("scp", ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10", localPath, remotePath], (err, stdout, stderr) => {
    if (err) {
      if (attempt < SCP_MAX_RETRIES) {
        const delay = SCP_RETRY_DELAYS[attempt] || 45000;
        log(`SCP upload FAILED for ${filename} (attempt ${attempt + 1}/${SCP_MAX_RETRIES + 1}): ${stderr || err.message} -- retrying in ${delay / 1000}s`);
        setTimeout(() => {
          scpUpload({ path: localPath, filename, attempt: attempt + 1 });
        }, delay);
      } else {
        log(`SCP upload FAILED for ${filename} (all ${SCP_MAX_RETRIES + 1} attempts exhausted): ${stderr || err.message}`);
        uploadRunning = false;
        drainUploadQueue();
      }
    } else {
      log(`SCP uploaded: ${filename}`);
      uploadRunning = false;
      drainUploadQueue();
    }
  });
}

// === Raw JSONL Append to Pi ===

const REMOTE_JSONL_DIR = "/home/manu/.openclaw/workspace/memory/trading/signals";

function appendRawSignalToPi(jsonData, screenshotPaths) {
  if (!REMOTE_HOST || !REMOTE_USER) {
    log("WARNING: Raw JSONL append skipped -- REMOTE_HOST/REMOTE_USER not set");
    return;
  }

  const brokerDate = getBrokerTime().toISOString().slice(0, 10);
  const targetFile = `${REMOTE_JSONL_DIR}/${brokerDate}.jsonl`;

  const entry = {
    time: jsonData.time || "",
    symbol: jsonData.symbol || "",
    direction: jsonData.direction || "",
    entry_price: parseFloat(jsonData.bid) || 0,
    atr: parseFloat(jsonData.atr) || 0,
    bar_size_atr: parseFloat(jsonData.barSizeATR) || 0,
    entry_ratio: parseFloat(jsonData.entryRatio) || 0,
    swing_ratio: parseFloat(jsonData.swingRatio) || 0,
    channel_dir: parseFloat(jsonData.channelDirection) || 0,
    spread: parseFloat(jsonData.spread) || 0,
    screenshot_m5: screenshotPaths.m5 || "",
    screenshot_h1: screenshotPaths.h1 || "",
    source: "watcher",
  };

  const jsonLine = JSON.stringify(entry);
  // Escape single quotes for shell safety
  const escaped = jsonLine.replace(/'/g, "'\\''");

  execFile("ssh", [
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    `${REMOTE_USER}@${REMOTE_HOST}`,
    `mkdir -p "${REMOTE_JSONL_DIR}" && echo '${escaped}' >> "${targetFile}"`,
  ], (err, stdout, stderr) => {
    if (err) {
      log(`WARNING: Raw JSONL append failed for ${jsonData.symbol}: ${stderr || err.message}`);
    } else {
      log(`Raw JSONL appended: ${jsonData.symbol} -> ${brokerDate}.jsonl`);
    }
  });
}

// === Market State History ===

function getHistoryPath(symbol) {
  return path.join(HISTORY_DIR, `${symbol}.json`);
}

function loadHistory(symbol) {
  try {
    const data = JSON.parse(fs.readFileSync(getHistoryPath(symbol), "utf-8"));
    return Array.isArray(data) ? data : [];
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
      verbose(`New day detected for ${symbol} -- flushing history`);
      history = [];
    }
  }

  history.push(snapshot);
  fs.writeFileSync(getHistoryPath(symbol), JSON.stringify(history, null, 2));
  return history;
}

// === Discord Functions ===

function postToDiscord(imagePaths, jsonData) {
  return new Promise((resolve, reject) => {
    const url = new URL(DISCORD_WEBHOOK);
    const boundary = "----FormBoundary" + Date.now();

    const content = [
      `**Signal: ${jsonData.direction} ${jsonData.symbol}**`,
      `Time: ${jsonData.time} | TF: M${jsonData.timeframe}`,
      `Bid: ${jsonData.bid} | Spread: ${jsonData.spread}`,
      `Bar -- O: ${jsonData.open} H: ${jsonData.high} L: ${jsonData.low} C: ${jsonData.close}`,
      `Channel -- Upper: ${jsonData.upperChannel} Lower: ${jsonData.lowerChannel} Dir: ${jsonData.channelDirection > 0 ? "BULL" : "BEAR"}`,
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

function postFollowupToDiscord(imagePaths, jsonData) {
  return new Promise((resolve, reject) => {
    const url = new URL(DISCORD_WEBHOOK);
    const boundary = "----FormBoundary" + Date.now();

    const content = [
      `**End-of-day follow-up for ${jsonData.symbol}**`,
      `Time: ${jsonData.time} | Price: ${jsonData.price}`,
      `Day High: ${jsonData.dayHigh} | Day Low: ${jsonData.dayLow} | Spread: ${jsonData.spread}`,
      `Signals today: ${jsonData.signalsToday}`,
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

// === Kit Webhook Functions ===

function sendHook(message, sessionKey) {
  return new Promise((resolve, reject) => {
    if (!HOOK_TOKEN) { log("No OPENCLAW_HOOK_TOKEN -- skipping"); return resolve(); }

    const body = { message };
    if (sessionKey) body.sessionKey = sessionKey;

    const payload = JSON.stringify(body);
    const hookUrl = new URL(HOOK_URL);

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

function wakeKitForSignal(jsonData, { h1Available = false, marketState = null, screenshotPaths = {} } = {}) {
  const signalData = JSON.stringify(jsonData);
  const m5Line = screenshotPaths.m5 ? `\nM5 screenshot: ${screenshotPaths.m5}` : "";
  const h1Line = h1Available && screenshotPaths.h1
    ? `\nH1 screenshot: ${screenshotPaths.h1}`
    : "";
  const marketStateLine = marketState && marketState.length > 0
    ? `\n\nMarket state context (${marketState.length} snapshots today): ${JSON.stringify(marketState)}`
    : "";

  const msg = `New trading signal: ${jsonData.direction} ${jsonData.symbol} at ${jsonData.time} (M${jsonData.timeframe}).

Signal data: ${signalData}${m5Line}${h1Line}${marketStateLine}

Instructions:
1. Analyze the screenshots using the image tool (paths above). If not yet available, check #trading channel (1475598923795136646) for the Discord-posted screenshot
2. Read the scoring methodology from /home/manu/.openclaw/workspace/reference/trading/scoring-system.txt
3. Check /home/manu/.openclaw/workspace/memory/trading/news/${new Date().toISOString().slice(0, 10)}-calendar.json for scheduled high-impact events. If any event is within +/-30 minutes of this signal, add "NEWS RISK: [event] in [X]min" as a RED FLAG.
4. Post your analysis to #trading using the message tool (target: 1475598923795136646). Format: SCORE (0-10), DIRECTION, SETUP TYPE, VERDICT (GO/CAUTION/SKIP), RED FLAGS, REASON, EXIT SUGGESTION
5. After posting, log the signal TWO ways:
   a) Append to /home/manu/.openclaw/workspace/memory/trading/signals/${new Date().toISOString().slice(0, 10)}.jsonl: {"time":"${jsonData.time}","symbol":"${jsonData.symbol}","direction":"${jsonData.direction}","score":N,"verdict":"GO|CAUTION|SKIP","setup":"type","reason":"one-line summary"}
   b) INSERT into SQLite DB at /home/manu/.openclaw/workspace/memory/trading/signals/signals.db table 'signals': (timestamp, instrument, direction, score, verdict, setup, entry_price, bar_size_atr, entry_ratio, swing_ratio, channel_direction, atr, spread, red_flags, screenshot_m5, screenshot_h1). Use the signal data for raw fields and your analysis for score/verdict/setup/red_flags.${screenshotPaths.m5 ? ` Use these screenshot paths: screenshot_m5="${screenshotPaths.m5}", screenshot_h1="${screenshotPaths.h1 || ""}".` : ""}
6. Update the Google Sheet (ID: 1D9kG6-mkB67V6JxIuQHZ0q-myzD8lwWFpr8PT-Iwe84) -- append a row to the instrument's tab (GER40/XAUUSD/NAS100/BTCUSD) with: Date, Time, Direction, Score, Verdict, Setup Type, Entry Price, ATR, BarSize/ATR, Entry Ratio, Swing Ratio, Red Flags. Use GOOGLE_APPLICATION_CREDENTIALS=/home/manu/.openclaw/credentials/google/drive-reader-key.json`;

  return sendHook(msg, "agent:main:hook:trading");
}

function wakeKitFollowup(jsonData, { h1Available = false, screenshotPaths = {} } = {}) {
  const m5Line = screenshotPaths.m5 ? `\nM5 screenshot: ${screenshotPaths.m5}` : "";
  const h1Line = h1Available && screenshotPaths.h1
    ? `\nH1 screenshot: ${screenshotPaths.h1}`
    : "";

  const msg = `End-of-day follow-up for ${jsonData.symbol} at ${jsonData.time}.${m5Line}${h1Line}

This is a review screenshot taken at market close. Signals that fired today: ${jsonData.signalsToday}

Current price: ${jsonData.price} | Day High: ${jsonData.dayHigh} | Day Low: ${jsonData.dayLow}

Instructions:
1. Check #trading channel (1475598923795136646), read the latest signals from today
2. Query SQLite: sqlite3 /home/manu/.openclaw/workspace/memory/trading/signals/signals.db "SELECT * FROM signals WHERE timestamp LIKE '${new Date().toISOString().slice(0, 10)}%' AND instrument='${(jsonData.symbol || "").replace(".r", "")}' ORDER BY timestamp"
3. For each signal, compare your verdict (GO/CAUTION/SKIP) against actual price action using the close price (${jsonData.price}). Was the call correct?
4. Post a detailed review to #trading for this instrument. Format: Day stats (high/low/close/range), then each signal reviewed with verdict assessment, then lessons learned.
5. Update SQLite: UPDATE signals SET price_at_close=${jsonData.price}, outcome='CORRECT SKIP|MISSED|WRONG GO|etc', post_analysis='what happened' WHERE timestamp LIKE '${new Date().toISOString().slice(0, 10)}%' AND instrument='${(jsonData.symbol || "").replace(".r", "")}'
6. Update Google Sheet "EOD Reviews" tab (ID: 1D9kG6-mkB67V6JxIuQHZ0q-myzD8lwWFpr8PT-Iwe84): append one row with Date, Instrument, Day High, Day Low, Close, Range, total signals, reviewed count, correct count, missed count, wrong count, accuracy %, and your full EOD analysis text in column M. Use GOOGLE_APPLICATION_CREDENTIALS=/home/manu/.openclaw/credentials/google/drive-reader-key.json`;

  return sendHook(msg, "agent:main:hook:trading");
}

function wakeKitForPosition(positionData) {
  const data = JSON.stringify(positionData);

  const msg = `POSITION OPENED -- Exit management needed.

Position data: ${data}

Instructions:
1. Read the exit manager reference: /home/manu/.openclaw/workspace/reference/trading/exit-manager.md
2. Read the scoring system for instrument-specific rules: /home/manu/.openclaw/workspace/reference/trading/scoring-system.txt
3. Analyze the entry: determine optimal SL, TP, and trailing stop levels based on:
   - ATR (M5 and H1 provided)
   - Swing levels (M5 50-bar and H1 20-bar provided)
   - Day high/low
   - Instrument-specific rules (GER40 needs R:R >= 2:1)
4. Write the exit plan to the VPS via SSH:
   ${VPS_SSH_CMD} "node C:\\signal-watcher\\position-manager.js write-exit ${positionData.ticket} <SL> <TP> <trailActivation> <trailDistance>"
5. Post to #trading (1475598923795136646): [LOCK] Managing [instrument] [direction] [lots]L @ [entry] | SL: [level] | TP: [level] | R:R: [ratio] | Trail: [details]
6. If R:R < 1.0, do NOT write exit plan. Instead post warning: [WARN] Cannot manage -- R:R too low`;

  return sendHook(msg, "agent:main:hook:trading");
}

function wakeKitForClose(closeData) {
  const data = JSON.stringify(closeData);
  const emoji = closeData.profit >= 0 ? "[OK]" : "[X]";

  const msg = `POSITION CLOSED ${emoji}

Close data: ${data}

Instructions:
1. Post to #trading (1475598923795136646):
   ${emoji} ${closeData.instrument} ${closeData.direction} closed (${closeData.closeReason})
   Entry: ${closeData.entryPrice} -> Exit: ${closeData.closePrice}
   P/L: EUR${closeData.profit}
   ${closeData.wasManaged ? "Managed by Kit" : "Not managed"}
2. Log the result: append to /home/manu/.openclaw/workspace/memory/trading/signals/${new Date().toISOString().slice(0, 10)}.jsonl`;

  return sendHook(msg, "agent:main:hook:trading");
}

// === Momentum Detection ===

function checkMomentum(snapshot, history) {
  const symbol = snapshot.symbol;
  if (!symbol || !snapshot.atr || !snapshot.bid || history.length < 5) return;

  const lastAlert = momentumCooldowns.get(symbol) || 0;
  if (Date.now() - lastAlert < MOMENTUM_COOLDOWN_MS) return;

  const atr = parseFloat(snapshot.atr);
  if (!atr || atr <= 0) return;

  // Compare current price to ~5 snapshots ago
  const prevSnapshot = history[history.length - 5];
  if (!prevSnapshot || !prevSnapshot.bid) return;

  const currentPrice = parseFloat(snapshot.bid);
  const prevPrice = parseFloat(prevSnapshot.bid);
  const move = Math.abs(currentPrice - prevPrice);

  if (move >= atr * MOMENTUM_ATR_THRESHOLD) {
    const direction = currentPrice > prevPrice ? "UP" : "DOWN";
    log(`[!!] MOMENTUM SPIKE: ${symbol} moved ${direction} ${move.toFixed(5)} (${(move / atr).toFixed(1)}x ATR)`);

    momentumCooldowns.set(symbol, Date.now());

    wakeKitForMomentum({
      symbol,
      direction,
      move: move.toFixed(5),
      moveAtrRatio: (move / atr).toFixed(1),
      currentPrice: currentPrice.toFixed(5),
      prevPrice: prevPrice.toFixed(5),
      atr: atr.toFixed(5),
      time: snapshot.time || new Date().toISOString(),
    }).then(() => log("Kit notified for momentum alert"))
      .catch(err => log("Kit momentum hook error:", err.message));
  }
}

function wakeKitForMomentum(data) {
  const today = new Date().toISOString().slice(0, 10);

  const msg = `[!!] MOMENTUM ALERT: ${data.symbol} moved ${data.direction} ${data.move} (${data.moveAtrRatio}x ATR) at ${data.time}.

Current: ${data.currentPrice} | Previous: ${data.prevPrice} | ATR: ${data.atr}

Instructions:
1. Search for breaking news that could explain this move:
   - web_search "${data.symbol} news today"
   - web_search "market moving news today" or "breaking financial news"
   - Check for: central bank surprises, geopolitical events, Trump/policy announcements, earnings, OPEC, natural disasters
2. Check the morning calendar file at /home/manu/.openclaw/workspace/memory/trading/news/${today}-calendar.json -- is there a scheduled high-impact event right now?
3. Post to #trading (1475598923795136646):
   [!!] **Momentum Alert: ${data.symbol} ${data.direction} ${data.move} (${data.moveAtrRatio}x ATR)**
   Catalyst: [what you found, or "No news found -- possible liquidity event / technical breakout"]
4. If a significant unscheduled news event was found, append to /home/manu/.openclaw/workspace/memory/trading/news/${today}-events.jsonl:
   {"time":"${data.time}","symbol":"${data.symbol}","direction":"${data.direction}","move":"${data.move}","catalyst":"what you found"}`;

  return sendHook(msg, "agent:main:hook:trading");
}

// === Signal Processing ===

async function processSignal(jsonPath) {
  const pngPath = jsonPath.replace(/\.json$/, ".png");
  const h1PngPath = jsonPath.replace(/\.json$/, "_H1.png");
  log(`New signal: ${path.basename(jsonPath)}`);
  try {
    await waitForFile(jsonPath);
    await waitForFile(pngPath);
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

    // Wait for H1 screenshot (soft fail)
    let h1Available = false;
    try {
      verbose(`Waiting for H1 screenshot: ${path.basename(h1PngPath)}`);
      await waitForFile(h1PngPath, 15000);
      h1Available = true;
      verbose("H1 screenshot found");
    } catch {
      log("H1 screenshot not found (timeout) -- proceeding without it");
    }

    // Upload M5 + H1 screenshots to local storage and Pi via SCP
    uploadScreenshot(pngPath);
    if (h1Available) uploadScreenshot(h1PngPath);

    // Post to Discord with available screenshots
    const images = [pngPath];
    if (h1Available) images.push(h1PngPath);
    await postToDiscord(images, jsonData);
    log(`Posted to Discord: ${jsonData.direction} ${jsonData.symbol}${h1Available ? " (M5+H1)" : " (M5 only)"}`);

    // Load accumulated market state for this symbol
    const marketState = loadHistory(jsonData.symbol);
    verbose(`Bundling ${marketState.length} market state snapshots with signal`);

    // Build remote screenshot paths for Kit
    const baseName = path.basename(jsonPath).replace(/\.json$/, "");
    const screenshotPaths = {
      m5: `${REMOTE_SCREENSHOT_DIR}/${baseName}.png`,
      h1: h1Available ? `${REMOTE_SCREENSHOT_DIR}/${baseName}_H1.png` : null,
    };

    // Append raw signal to JSONL on Pi (fallback for when Kit drops signals)
    appendRawSignalToPi(jsonData, screenshotPaths);

    // Wake Kit for analysis (non-blocking, slight delay for SCP)
    setTimeout(() => {
      wakeKitForSignal(jsonData, { h1Available, marketState, screenshotPaths })
        .then(() => log("Kit notified for signal analysis"))
        .catch((err) => log("Kit wake error:", err.message));
    }, 1500);

  } catch (err) {
    log("Error processing signal:", err.message);
  }
}

async function processFollowup(jsonPath) {
  const pngPath = jsonPath.replace(/\.json$/, ".png");
  const h1PngPath = jsonPath.replace(/\.json$/, "_H1.png");
  log(`Follow-up: ${path.basename(jsonPath)}`);
  try {
    await waitForFile(pngPath);
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

    // Wait for H1 screenshot (soft fail)
    let h1Available = false;
    try {
      verbose(`Waiting for H1 screenshot: ${path.basename(h1PngPath)}`);
      await waitForFile(h1PngPath, 15000);
      h1Available = true;
      verbose("H1 screenshot found");
    } catch {
      log("H1 screenshot not found (timeout) -- proceeding without it");
    }

    // Upload screenshots
    uploadScreenshot(pngPath);
    if (h1Available) uploadScreenshot(h1PngPath);

    // Post to Discord with distinct follow-up formatting
    const images = [pngPath];
    if (h1Available) images.push(h1PngPath);
    await postFollowupToDiscord(images, jsonData);
    log(`Posted follow-up to Discord: ${jsonData.symbol} -- signals: ${jsonData.signalsToday}${h1Available ? " (M5+H1)" : " (M5 only)"}`);

    // Build remote screenshot paths for Kit
    const baseName = path.basename(jsonPath).replace(/\.json$/, "");
    const screenshotPaths = {
      m5: `${REMOTE_SCREENSHOT_DIR}/${baseName}.png`,
      h1: h1Available ? `${REMOTE_SCREENSHOT_DIR}/${baseName}_H1.png` : null,
    };

    // Wake Kit for review (non-blocking)
    setTimeout(() => {
      wakeKitFollowup(jsonData, { h1Available, screenshotPaths })
        .then(() => log("Kit notified for follow-up review"))
        .catch((err) => log("Kit follow-up wake error:", err.message));
    }, 1500);

  } catch (err) {
    log("Follow-up error:", err.message);
  }
}

// === JSON Router (dispatches by type) ===

async function handleJson(jsonPath) {
  try {
    await waitForFile(jsonPath);
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

    if (jsonData.type === "market_state") {
      verbose(`Market state file detected: ${path.basename(jsonPath)}`);
      const history = appendHistory(jsonData);
      log(`Market state: ${jsonData.symbol} -- ${history.length} snapshots today`);
      checkMomentum(jsonData, history);
    } else if (jsonData.type === "followup") {
      processFollowup(jsonPath);
    } else {
      processSignal(jsonPath);
    }
  } catch (err) {
    log("Error reading JSON:", err.message);
  }
}

// === Position Processing ===

const processedPositions = new Set();

async function processPositionFile(filepath) {
  const filename = path.basename(filepath);
  if (processedPositions.has(filename)) return;
  processedPositions.add(filename);
  setTimeout(() => processedPositions.delete(filename), 60000);

  try {
    await waitForFile(filepath, 3000);
    const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));

    log(`[fox] New position: ${data.instrument} ${data.direction} ${data.lots}L @ ${data.entryPrice}`);

    wakeKitForPosition(data)
      .then(() => log("Kit notified for exit management"))
      .catch((err) => log("Kit position hook error:", err.message));

    // Archive the file
    try {
      fs.renameSync(filepath, filepath + ".processed");
    } catch (e) {
      try { fs.unlinkSync(filepath); } catch (e2) {}
    }
  } catch (err) {
    log("Error processing position:", err.message);
  }
}

async function processCloseFile(filepath) {
  const filename = path.basename(filepath);
  if (processedPositions.has(filename)) return;
  processedPositions.add(filename);
  setTimeout(() => processedPositions.delete(filename), 60000);

  try {
    await waitForFile(filepath, 3000);
    const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));

    const emoji = data.profit >= 0 ? "[OK]" : "[X]";
    log(`${emoji} Position closed: ${data.instrument} ${data.direction} | P/L: EUR${data.profit} | ${data.closeReason}`);

    wakeKitForClose(data)
      .then(() => log("Kit notified of close"))
      .catch((err) => log("Kit close hook error:", err.message));

    // Archive
    try {
      fs.renameSync(filepath, filepath + ".processed");
    } catch (e) {
      try { fs.unlinkSync(filepath); } catch (e2) {}
    }
  } catch (err) {
    log("Error processing close:", err.message);
  }
}

// === EOD Follow-up Timer ===

const EOD_BROKER_HOUR = 22;
let eodFiredToday = false;
let lastEodDate = "";

function getBrokerUtcOffset() {
  // Most MT4 brokers use EET/EEST (Eastern European Time)
  // UTC+2 in winter, UTC+3 in summer (DST)
  const now = new Date();
  const year = now.getUTCFullYear();

  const lastSunMar = new Date(Date.UTC(year, 2, 31));
  lastSunMar.setUTCDate(31 - lastSunMar.getUTCDay());
  const lastSunOct = new Date(Date.UTC(year, 9, 31));
  lastSunOct.setUTCDate(31 - lastSunOct.getUTCDay());

  const dstStart = new Date(Date.UTC(year, 2, lastSunMar.getUTCDate(), 1, 0, 0));
  const dstEnd = new Date(Date.UTC(year, 9, lastSunOct.getUTCDate(), 1, 0, 0));

  return (now >= dstStart && now < dstEnd) ? 3 : 2;
}

function getBrokerTime() {
  return new Date(Date.now() + getBrokerUtcOffset() * 3600000);
}

function getTodayInstruments() {
  const today = getBrokerTime().toISOString().slice(0, 10).replace(/-/g, "");
  const files = fs.readdirSync(SIGNALS_FOLDER).filter(f =>
    f.endsWith(".json") && f.includes(today) && !f.includes("_state") && !f.includes("followup")
  );
  const instruments = new Map();
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SIGNALS_FOLDER, f), "utf-8"));
      if (d.type !== "market_state" && d.type !== "followup" && d.symbol) {
        instruments.set(d.symbol, (instruments.get(d.symbol) || 0) + 1);
      }
    } catch {}
  }
  return instruments;
}

async function fireEodFollowup() {
  const instruments = getTodayInstruments();
  if (instruments.size === 0) {
    log("EOD: No signals today -- skipping follow-up");
    return;
  }

  log(`EOD: Firing follow-up for ${instruments.size} instruments: ${[...instruments.keys()].join(", ")}`);

  for (const [symbol, count] of instruments) {
    // Try exact symbol, then with/without .r suffix (signal vs market_state naming)
    let history = loadHistory(symbol);
    if (history.length === 0 && symbol.endsWith(".r")) {
      const alt = symbol.replace(/\.r$/, "");
      history = loadHistory(alt);
      if (history.length > 0) log(`EOD: Found history under "${alt}" instead of "${symbol}"`);
    }
    if (history.length === 0 && !symbol.endsWith(".r")) {
      const alt = symbol + ".r";
      history = loadHistory(alt);
      if (history.length > 0) log(`EOD: Found history under "${alt}" instead of "${symbol}"`);
    }

    if (history.length === 0) {
      log(`EOD: WARNING -- no market state history for ${symbol}, prices will be N/A`);
    } else {
      log(`EOD: ${symbol} -- ${history.length} snapshots, latest bid: ${history[history.length - 1].bid}`);
    }

    const snap = history.length > 0 ? history[history.length - 1] : {};

    const followupData = {
      type: "followup",
      symbol,
      time: getBrokerTime().toISOString().slice(0, 19).replace("T", " "),
      price: snap.bid || snap.close || snap.price || "N/A",
      dayHigh: snap.dayHigh || snap.day_high || snap.high || "N/A",
      dayLow: snap.dayLow || snap.day_low || snap.low || "N/A",
      spread: snap.spread || "N/A",
      signalsToday: count,
    };

    try {
      await wakeKitFollowup(followupData, { h1Available: false });
      log(`EOD: Kit notified for ${symbol} (${count} signals, close: ${followupData.price})`);
    } catch (err) {
      log(`EOD: Failed for ${symbol}: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  log("EOD: All follow-ups sent");
}

// === Startup ===

if (!SIGNALS_FOLDER || !DISCORD_WEBHOOK) {
  console.error("FATAL: Set SIGNALS_FOLDER and DISCORD_WEBHOOK_URL in .env");
  process.exit(1);
}

if (!REMOTE_HOST || !REMOTE_USER) {
  log("[WARN]  WARNING: REMOTE_HOST and/or REMOTE_USER not set -- screenshot uploads to Pi will be skipped");
  log("   Set REMOTE_HOST and REMOTE_USER in .env to enable SCP uploads");
}

// Ensure all directories exist
[SIGNALS_FOLDER, POSITIONS_DIR, CLOSED_DIR, EXITS_DIR, LOCAL_SCREENSHOT_DIR, HISTORY_DIR].forEach(ensureDir);

log("=== watcher.js v3 -- Signal Watcher + Position Manager + Market State + EOD ===");
log(`Signals:     ${SIGNALS_FOLDER}`);
log(`Positions:   ${POSITIONS_DIR}`);
log(`Closes:      ${CLOSED_DIR}`);
log(`Exits:       ${EXITS_DIR}`);
log(`Screenshots: ${LOCAL_SCREENSHOT_DIR}`);
log(`SCP upload:  ${REMOTE_HOST && REMOTE_USER ? `${REMOTE_USER}@${REMOTE_HOST}` : "DISABLED"}`);
log(`Kit hook:    ${HOOK_TOKEN ? "enabled" : "disabled"}`);

// Watch signals
const signalWatcher = chokidar.watch(SIGNALS_FOLDER, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});
signalWatcher.on("add", (f) => {
  if (path.extname(f).toLowerCase() === ".json" && !f.includes(".processed")) handleJson(f);
});
signalWatcher.on("change", (f) => {
  if (path.extname(f).toLowerCase() === ".json" && !f.includes(".processed")) handleJson(f);
});

// Watch positions
const positionWatcher = chokidar.watch(POSITIONS_DIR, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});
positionWatcher.on("add", (f) => {
  if (path.extname(f).toLowerCase() === ".json" && !f.includes(".processed")) processPositionFile(f);
});

// Watch closes
const closeWatcher = chokidar.watch(CLOSED_DIR, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});
closeWatcher.on("add", (f) => {
  if (path.extname(f).toLowerCase() === ".json" && !f.includes(".processed")) processCloseFile(f);
});

// EOD timer -- checks every 60s, fires at 22:00 broker time on weekdays
setInterval(() => {
  const b = getBrokerTime();
  const bd = b.toISOString().slice(0, 10);

  if (bd !== lastEodDate) {
    eodFiredToday = false;
    lastEodDate = bd;
  }

  if (b.getUTCHours() === EOD_BROKER_HOUR && b.getUTCMinutes() === 0 && !eodFiredToday) {
    const dow = b.getUTCDay();
    if (dow === 0 || dow === 6) {
      eodFiredToday = true;
      verbose("EOD: Weekend -- skipping");
      return;
    }
    eodFiredToday = true;
    log("EOD: 22:00 broker time -- firing end-of-day review");
    fireEodFollowup().catch(err => log("EOD error:", err.message));
  }
}, 60000);

log(`EOD timer:   armed (22:00 broker, UTC+${getBrokerUtcOffset()}, auto-DST)`);
log(`Momentum:    armed (threshold: ${MOMENTUM_ATR_THRESHOLD}x ATR, cooldown: ${MOMENTUM_COOLDOWN_MS / 60000}min)`);
log("All watchers started. Ready. [fox]");
