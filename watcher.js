require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const Anthropic = require("@anthropic-ai/sdk");
const chokidar = require("chokidar");

// ---- Config
const SIGNALS_FOLDER = process.env.SIGNALS_FOLDER;
const SCORE_THRESHOLD = parseInt(process.env.SCORE_THRESHOLD || "6");
const PUSHOVER_USER = process.env.PUSHOVER_USER_KEY;
const PUSHOVER_TOKEN = process.env.PUSHOVER_APP_TOKEN;
const VERBOSE = process.argv.includes("--verbose");

const anthropic = new Anthropic();
const systemPrompt = fs.readFileSync(
  path.join(__dirname, "system-prompt.txt"),
  "utf-8"
);

// ---- Logging
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function debug(...args) {
  if (VERBOSE) console.log(`[DEBUG]`, ...args);
}

// ---- Wait for file to be fully written
function waitForFile(filePath, maxWait = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > 0) return resolve();
      } catch {}
      if (Date.now() - start > maxWait) return reject(new Error(`Timeout waiting for ${filePath}`));
      setTimeout(check, 300);
    };
    check();
  });
}

// ---- Score signal with Claude
async function scoreSignal(jsonPath, pngPath) {
  const context = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const imageData = fs.readFileSync(pngPath).toString("base64");

  const contextText =
    `Signal context:\n` +
    `Symbol: ${context.symbol}\n` +
    `Direction: ${context.direction}\n` +
    `Time: ${context.time}\n` +
    `Timeframe: M${context.timeframe}\n` +
    `Bid: ${context.bid} | Ask: ${context.ask} | Spread: ${context.spread}\n` +
    `Signal bar — O: ${context.open} H: ${context.high} L: ${context.low} C: ${context.close}\n` +
    `Channel — Upper: ${context.upperChannel} Lower: ${context.lowerChannel} Direction: ${context.channelDirection}\n` +
    `ATR: ${context.atr} | ATR Short: ${context.atrShort}\n` +
    `Bar Size ATR: ${context.barSizeATR}\n` +
    `Entry Ratio: ${context.entryRatio}\n` +
    `Swing Ratio: ${context.swingRatio}\n` +
    `Account Balance: ${context.accountBalance} | Equity: ${context.accountEquity} | Leverage: ${context.leverage}`;

  debug("Sending to Claude:", contextText);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6-20250514",
    max_tokens: 300,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: imageData,
            },
          },
          { type: "text", text: contextText },
        ],
      },
    ],
  });

  const result = response.content[0].text;
  debug("Claude response:", result);

  // Parse structured response
  const scoreMatch = result.match(/SCORE:\s*(\d+)/);
  const verdictMatch = result.match(/VERDICT:\s*(GO|CAUTION|SKIP)/);
  const reasonMatch = result.match(/REASON:\s*(.+)/);

  return {
    raw: result,
    score: scoreMatch ? parseInt(scoreMatch[1]) : 0,
    verdict: verdictMatch ? verdictMatch[1] : "SKIP",
    reason: reasonMatch ? reasonMatch[1].trim() : "Could not parse response",
    context,
  };
}

// ---- Send Pushover notification
function sendPushover(title, message, imagePath) {
  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Date.now();
    const parts = [];

    const addField = (name, value) => {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`
      );
    };

    addField("token", PUSHOVER_TOKEN);
    addField("user", PUSHOVER_USER);
    addField("title", title);
    addField("message", message);
    addField("priority", "1");
    addField("sound", "cashregister");

    // Attach image if under 2.5MB
    let imageBuffer;
    if (imagePath) {
      try {
        imageBuffer = fs.readFileSync(imagePath);
        if (imageBuffer.length < 2500000) {
          parts.push(
            `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${path.basename(imagePath)}"\r\nContent-Type: image/png\r\n\r\n`
          );
        } else {
          imageBuffer = null;
        }
      } catch {
        imageBuffer = null;
      }
    }

    let body;
    const textPart = parts.join("\r\n") + (imageBuffer ? "" : `\r\n--${boundary}--\r\n`);

    if (imageBuffer) {
      // Build multipart body with binary image
      const textBeforeImage = parts.slice(0, -1).join("\r\n") + "\r\n";
      const imageHeader = parts[parts.length - 1] + "\r\n";
      const ending = `\r\n--${boundary}--\r\n`;

      const bufBefore = Buffer.from(textBeforeImage, "utf-8");
      const bufImageHeader = Buffer.from(imageHeader, "utf-8");
      const bufEnding = Buffer.from(ending, "utf-8");

      body = Buffer.concat([bufBefore, bufImageHeader, imageBuffer, bufEnding]);
    } else {
      body = Buffer.from(textPart, "utf-8");
    }

    const options = {
      hostname: "api.pushover.net",
      path: "/1/messages.json",
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        debug("Pushover response:", res.statusCode, data);
        res.statusCode === 200 ? resolve(data) : reject(new Error(data));
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---- Process a signal
async function processSignal(jsonPath) {
  const baseName = jsonPath.replace(/\.json$/, "");
  const pngPath = baseName + ".png";

  log(`New signal: ${path.basename(jsonPath)}`);

  try {
    // Wait for both files to be fully written
    await waitForFile(jsonPath);
    await waitForFile(pngPath);

    // Score with Claude
    log("Scoring with Claude...");
    const result = await scoreSignal(jsonPath, pngPath);
    log(
      `Score: ${result.score}/10 | Verdict: ${result.verdict} | ${result.reason}`
    );

    // Always notify — include score so you can judge yourself
    const emoji =
      result.verdict === "GO"
        ? ">>>"
        : result.verdict === "CAUTION"
        ? ">>"
        : ">";
    const title = `${emoji} ${result.context.direction} ${result.context.symbol} [${result.score}/10]`;
    const message = `${result.verdict}: ${result.reason}`;

    if (PUSHOVER_USER && PUSHOVER_TOKEN) {
      await sendPushover(title, message, pngPath);
      log("Pushover sent");
    } else {
      log("Pushover not configured, skipping notification");
    }

    // Save the score alongside the signal files
    fs.writeFileSync(
      baseName + ".score.txt",
      result.raw,
      "utf-8"
    );
  } catch (err) {
    log("Error processing signal:", err.message);
    debug(err.stack);
  }
}

// ---- Main
function main() {
  if (!SIGNALS_FOLDER) {
    console.error("SIGNALS_FOLDER not set in .env");
    process.exit(1);
  }

  if (!fs.existsSync(SIGNALS_FOLDER)) {
    fs.mkdirSync(SIGNALS_FOLDER, { recursive: true });
    log(`Created signals folder: ${SIGNALS_FOLDER}`);
  }

  log(`Watching: ${SIGNALS_FOLDER}`);
  log(`Score threshold: ${SCORE_THRESHOLD}`);
  log(`Pushover: ${PUSHOVER_USER ? "configured" : "NOT configured"}`);

  const watcher = chokidar.watch(path.join(SIGNALS_FOLDER, "*.json"), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on("add", (filePath) => {
    processSignal(filePath);
  });

  watcher.on("error", (err) => {
    log("Watcher error:", err.message);
  });

  log("Watcher started. Waiting for signals...");
}

main();
