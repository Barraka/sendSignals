# Signal Watcher

Watches MQL4's `Signals/` folder for trading signals and market state updates from the **Channel Confirmed** indicator, then routes them to Discord and Kit (OpenClaw) for analysis.

## Architecture

```
MT4 (Channel Confirmed indicator)
  │
  ├── Signal rotation (LONG/SHORT)
  │     writes: SYMBOL_DIR_TIMESTAMP.json + .png + _H1.png
  │
  └── Market state (every 15 min)
        writes: market_state_SYMBOL.json (overwrites)
  │
  ▼
watcher.js (chokidar)
  │
  ├── Signals ──► Discord webhook (screenshots + summary)
  │            └► Kit hook (scoring prompt + bundled market state history)
  │
  └── Market state ──► Kit hook (context update, stored in memory)
                       + appends to daily history file
```

## Setup

```bash
npm install
cp .env.example .env   # fill in values
```

### Environment variables

| Variable | Description |
|---|---|
| `SIGNALS_FOLDER` | Path to MT4's `MQL4/Files/Signals/` folder |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for #trading channel |
| `OPENCLAW_HOOK_TOKEN` | Bearer token for Kit agent hook |
| `OPENCLAW_HOOK_URL` | Kit hook endpoint (default: `http://127.0.0.1:18789/hooks/agent`) |

## Running

```bash
# Direct
node watcher.js
node watcher.js --verbose

# With pm2 (production)
pm2 start watcher.js --name signal-watcher
pm2 restart signal-watcher
pm2 logs signal-watcher
```

## Market state history

Each market state snapshot is appended to `market_state_history/SYMBOL.json` (one file per instrument). The history accumulates throughout the day and is flushed when a new day is detected.

Market state reaches Kit two ways:
- **With signals** — when a signal fires, the full day's accumulated market state history for that symbol is bundled directly into the signal payload, giving Kit immediate context for analysis
- **Standalone updates** — every 15 min, the latest snapshot + history is sent to Kit via hook (`sessionKey: agent:main:hook:trading`) for background storage

All hooks use the `agent:main:hook:trading` session key for routing.

### Market state schema

```json
{
  "type": "market_state",
  "symbol": "GER40",
  "time": "2026-02-26 14:30",
  "session": "London",
  "price": 22845.5,
  "channelDir": "bull",
  "channelUpper": 22850.2,
  "channelLower": 22838.1,
  "freeBars": true,
  "channelFlips1h": 2,
  "atr14": 28.5,
  "adrPct": 67.3,
  "dayHigh": 22890.0,
  "dayLow": 22780.0,
  "spread": 1.2
}
```

## MQL4 indicator

The **Barraka - Channel Confirmed** indicator (on M5 charts) is the data source. It lives in two MT4 instances:

- `C:\05 - Trading\MT4 Portable Pepperstone\MQL4\Indicators\`
- `C:\05 - Trading\MT4 Portable FTMO\MQL4\Indicators\`

Key inputs on the indicator:
- `alerts` — enable signal alerts on channel rotation
- `saveScreenshot` — write signal JSON + screenshots
- `sendMarketState` — write market state JSON every 15 min
- `screenshotFolder` — output folder (default: `Signals`)
