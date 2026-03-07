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

function wakeKit(jsonData, { h1Available = false, marketState = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!HOOK_TOKEN) { log("No OPENCLAW_HOOK_TOKEN — Kit won't auto-analyze"); return resolve(); }

    const signalData = JSON.stringify(jsonData);
    const h1Line = h1Available
      ? "\n6. The Discord message also contains an H1 screenshot — use it for higher-timeframe context when scoring the signal"
      : "";
    const marketStateLine = marketState && marketState.length > 0
      ? `\n\nMarket state context (${marketState.length} snapshots today): ${JSON.stringify(marketState)}`
      : "";
    const msg = `New trading signal: ${jsonData.direction} ${jsonData.symbol} at ${jsonData.time} (M${jsonData.timeframe}).

Signal data: ${signalData}${marketStateLine}

Instructions:
1. Check #trading channel (1475598923795136646), read the latest signal from MT4 Signals webhook
2. Fetch and analyze the attached M5 screenshot
3. Read the scoring methodology from /home/manu/.openclaw/workspace/memory/trading/scoring-system.txt
4. Post your analysis to #trading using the message tool (target: 1475598923795136646). Format: SCORE (0-10), DIRECTION, SETUP TYPE, VERDICT (GO/CAUTION/SKIP), RED FLAGS, REASON, EXIT SUGGESTION
5. After posting, log the signal to SQLite: sqlite3 /home/manu/.openclaw/workspace/memory/trading/signals.db "INSERT INTO signals (timestamp, instrument, direction, score, verdict, setup_type, entry_price, atr, bar_size_atr, entry_ratio, swing_ratio, red_flags) VALUES ('YYYY-MM-DD HH:MM', 'SYMBOL', 'DIR', SCORE, 'VERDICT', 'SETUP', PRICE, ATR, BSATR, ER, SR, 'flags')"
6. Update the Google Sheet (ID: 1D9kG6-mkB67V6JxIuQHZ0q-myzD8lwWFpr8PT-Iwe84) — append a row to the instrument's tab (GER40/XAUUSD/NAS100/BTCUSD) with: Date, Time, Direction, Score, Verdict, Setup Type, Entry Price, ATR, BarSize/ATR, Entry Ratio, Swing Ratio, Red Flags. Use GOOGLE_APPLICATION_CREDENTIALS=/home/manu/.openclaw/credentials/google/drive-reader-key.json${h1Line}`;

    const payload = JSON.stringify({ sessionKey: "agent:main:hook:trading", message: msg });

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

    const msg = `Market state update for ${symbol} at ${time}.

Current snapshot: ${JSON.stringify(jsonData)}

Today's history (${history.length} snapshots): ${JSON.stringify(history)}

Instructions: Store this market state context in your working memory for use when analyzing the next signal for ${symbol}. Do not post anything to Discord and do not type in any channel.`;

    const payload = JSON.stringify({ sessionKey: "agent:main:hook:trading", message: msg });

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

function wakeKitFollowup(jsonData, { h1Available = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!HOOK_TOKEN) { log("No OPENCLAW_HOOK_TOKEN — Kit won't review follow-up"); return resolve(); }

    const h1Line = h1Available
      ? "\n5. The Discord message also contains an H1 screenshot — use it for higher-timeframe context in your review"
      : "";
    const msg = `End-of-day follow-up for ${jsonData.symbol} at ${jsonData.time}.

This is a review screenshot taken at market close. Signals that fired today: ${jsonData.signalsToday}

Current price: ${jsonData.price} | Day High: ${jsonData.dayHigh} | Day Low: ${jsonData.dayLow}

Instructions:
1. Check #trading channel (1475598923795136646), read the latest signals from today
2. Query SQLite: sqlite3 /home/manu/.openclaw/workspace/memory/trading/signals.db "SELECT * FROM signals WHERE timestamp LIKE 'YYYY-MM-DD%' AND instrument='${jsonData.symbol.replace('.r','')}' ORDER BY timestamp"
3. For each signal, compare your verdict (GO/CAUTION/SKIP) against actual price action using the close price (${jsonData.price}). Was the call correct?
4. Post a detailed review to #trading for this instrument. Format: Day stats (high/low/close/range), then each signal reviewed with verdict assessment, then lessons learned.
5. Update SQLite: UPDATE signals SET price_at_close=CLOSE, outcome='CORRECT SKIP|MISSED|WRONG GO|etc', post_analysis='what happened' WHERE timestamp='...' AND instrument='...'
6. Update Google Sheet "EOD Reviews" tab (ID: 1D9kG6-mkB67V6JxIuQHZ0q-myzD8lwWFpr8PT-Iwe84): append one row with Date, Instrument, Day High, Day Low, Close, Range, total signals, reviewed count, correct count, missed count, wrong count, accuracy %, and your full EOD analysis text in column M. Use GOOGLE_APPLICATION_CREDENTIALS=/home/manu/.openclaw/credentials/google/drive-reader-key.json${h1Line}`;

    const payload = JSON.stringify({ sessionKey: "agent:main:hook:trading", message: msg });

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
      log("Follow-up hook failed (is SSH tunnel running?):", err.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
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
      log(`H1 screenshot not found (timeout) — proceeding without it`);
    }

    // Post to Discord with distinct follow-up formatting
    const images = [pngPath];
    if (h1Available) images.push(h1PngPath);
    await postFollowupToDiscord(images, jsonData);
    log(`Posted follow-up to Discord: ${jsonData.symbol} — signals: ${jsonData.signalsToday}${h1Available ? " (M5+H1)" : " (M5 only)"}`);

    // Wake Kit for review (non-blocking)
    wakeKitFollowup(jsonData, { h1Available })
      .then(() => log("Kit notified for follow-up review"))
      .catch((err) => log("Kit follow-up wake error:", err.message));

  } catch (err) {
    log("Follow-up error:", err.message);
  }
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

    // Load accumulated market state for this symbol
    const marketState = loadHistory(jsonData.symbol);
    verbose(`Bundling ${marketState.length} market state snapshots with signal`);

    // Wake Kit for analysis (non-blocking)
    wakeKit(jsonData, { h1Available, marketState })
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
      // Market state is bundled into signal payloads via loadHistory() — no standalone hook needed
      // This eliminates ghost "typing" indicators and saves tokens
    } else if (jsonData.type === "followup") {
      processFollowup(jsonPath);
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

// --- EOD Follow-up Timer ---
// Fires at 22:00 broker time. Uses market state history for closing prices.
// No MQL4 changes needed — watcher generates follow-up data from accumulated snapshots.
const EOD_BROKER_HOUR = 22;
let eodFiredToday = false;
let lastEodDate = "";

function getBrokerUtcOffset() {
  // Most MT4 brokers use EET/EEST (Eastern European Time)
  // UTC+2 in winter (last Sunday of October → last Sunday of March)
  // UTC+3 in summer (last Sunday of March → last Sunday of October)
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed

  // Find last Sunday of March (month 2) and last Sunday of October (month 9)
  const lastSunMar = new Date(Date.UTC(year, 2, 31));
  lastSunMar.setUTCDate(31 - lastSunMar.getUTCDay());
  const lastSunOct = new Date(Date.UTC(year, 9, 31));
  lastSunOct.setUTCDate(31 - lastSunOct.getUTCDay());

  // DST switches at 01:00 UTC on the last Sunday
  const dstStart = new Date(Date.UTC(year, 2, lastSunMar.getUTCDate(), 1, 0, 0));
  const dstEnd = new Date(Date.UTC(year, 9, lastSunOct.getUTCDate(), 1, 0, 0));

  return (now >= dstStart && now < dstEnd) ? 3 : 2;
}

function getBrokerTime() {
  const now = new Date();
  return new Date(now.getTime() + (getBrokerUtcOffset() * 3600000));
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
    log("EOD: No signals today — skipping follow-up");
    return;
  }

  log(`EOD: Firing follow-up for ${instruments.size} instruments: ${[...instruments.keys()].join(", ")}`);

  for (const [symbol, count] of instruments) {
    const history = loadHistory(symbol);
    const snap = history.length > 0 ? history[history.length - 1] : {};

    const followupData = {
      type: "followup",
      symbol: symbol,
      time: getBrokerTime().toISOString().slice(0, 19).replace("T", " "),
      price: snap.bid || "N/A",
      dayHigh: snap.dayHigh || "N/A",
      dayLow: snap.dayLow || "N/A",
      spread: snap.spread || "N/A",
      signalsToday: count,
    };

    try {
      await wakeKitFollowup(followupData, { h1Available: false });
      log(`EOD: Kit notified for ${symbol} (${count} signals, close: ${followupData.price})`);
    } catch (err) {
      log(`EOD: Failed for ${symbol}: ${err.message}`);
    }

    // Small delay between instruments
    await new Promise(r => setTimeout(r, 3000));
  }

  log("EOD: All follow-ups sent");
}

setInterval(() => {
  const b = getBrokerTime();
  const bd = b.toISOString().slice(0, 10);

  // Reset flag at midnight broker time
  if (bd !== lastEodDate) {
    eodFiredToday = false;
    lastEodDate = bd;
  }

  // Fire at 22:00 broker time
  if (b.getUTCHours() === EOD_BROKER_HOUR && b.getUTCMinutes() === 0 && !eodFiredToday) {
    // Skip weekends (Saturday=6, Sunday=0)
    const dow = b.getUTCDay();
    if (dow === 0 || dow === 6) {
      eodFiredToday = true;
      verbose("EOD: Weekend — skipping");
      return;
    }

    eodFiredToday = true;
    log("EOD: 22:00 broker time — firing end-of-day review");
    fireEodFollowup().catch(err => log("EOD error:", err.message));
  }
}, 60000); // Check every 60 seconds

log("EOD follow-up timer armed (22:00 broker, currently UTC+" + getBrokerUtcOffset() + ", auto-DST)");
log("Watcher started. Signals → Discord + Kit analysis");
