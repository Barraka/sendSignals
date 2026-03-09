# VPS Deployment Configuration

## Environment Variables Required

The watcher.js requires these environment variables to be set in `.env` on the VPS (`C:\signal-watcher\.env`):

### Core Discord/Signal Configuration
```
SIGNALS_FOLDER=C:\signal-watcher\Signals
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1475602989967478916/{WEBHOOK_TOKEN}
OPENCLAW_HOOK_URL=http://127.0.0.1:18789/hooks/agent
OPENCLAW_HOOK_TOKEN={HOOK_TOKEN_FROM_PI}
```

### Remote Screenshot Upload (NEW)
```
REMOTE_HOST=192.168.1.98
REMOTE_USER=manu
REMOTE_PASS={PI_PASSWORD}
REMOTE_SCREENSHOTS_DIR=/home/manu/.openclaw/workspace/memory/trading/signals/screenshots
```

## Setup Instructions

1. **Create .env file** on VPS at `C:\signal-watcher\.env` with values above
2. **Verify SSH connectivity** from VPS to Pi:
   ```cmd
   scp -o ConnectTimeout=5 test.txt manu@192.168.1.98:/tmp/
   ```
3. **Add SSH key** (optional, instead of REMOTE_PASS):
   - Generate: `ssh-keygen -t ed25519`
   - Add to Pi: `ssh-copy-id -i ~/.ssh/id_ed25519.pub manu@192.168.1.98`
4. **Restart watcher**:
   ```cmd
   pm2 restart signal-watcher
   ```

## Architecture

**Old Flow:** MT4 → watcher.js → Discord CDN → Kit analysis (expires in 1 hour)

**New Flow:** 
1. MT4 signals fire → screenshots saved to `C:\signal-watcher\screenshots\` (local VPS storage)
2. watcher.js **uploads to Pi** via SCP (non-blocking, 1.5s delay before Kit notified)
3. Kit analyzes from Pi-accessible paths (persistent, no CDN expiration)
4. Screenshots also posted to Discord (ephemeral, for reference/review)

## Benefits
- **Reliability:** Screenshots persist indefinitely on Pi
- **Speed:** Analysis can happen anytime, no CDN race condition
- **Auditability:** Local copies available on both VPS and Pi

## Troubleshooting

### SCP Upload Fails with "Permission denied" or Timeout
**Check SSH connectivity first:**
```cmd
scp -o ConnectTimeout=5 test.txt manu@192.168.1.98:/tmp/
ssh manu@192.168.1.98 "ls -la /home/manu/.openclaw/workspace/memory/trading/signals/screenshots/"
```

### Password Escaping Issues (Special Characters)
If `REMOTE_PASS` contains special shell characters (`!`, `$`, `"`, `\`, etc.), they need escaping:
- Instead of storing raw password in .env, use SSH key authentication (recommended)
- **SSH Key Alternative** (better than passwords):
  ```cmd
  REM On VPS, generate key:
  ssh-keygen -t ed25519 -f C:\Users\Administrateur\.ssh\id_ed25519 -N ""
  
  REM Copy public key to Pi:
  scp C:\Users\Administrateur\.ssh\id_ed25519.pub manu@192.168.1.98:/tmp/
  ssh manu@192.168.1.98 "cat /tmp/id_ed25519.pub >> ~/.ssh/authorized_keys"
  
  REM Then remove REMOTE_PASS from .env and use SSH agent
  ```
- If using REMOTE_PASS with special chars, properly escape them:
  ```
  REMOTE_PASS=password!with$special
  ```
  Becomes (in .env):
  ```
  REMOTE_PASS="password!with\$special"
  ```

### Check VPS Watcher Logs
```cmd
pm2 logs signal-watcher --lines 100
pm2 describe signal-watcher
```

### Manual Verification
```cmd
REM On VPS, test SCP:
sshpass -p "PASSWORD" scp -o ConnectTimeout=5 "C:\signal-watcher\screenshots\test.png" "manu@192.168.1.98:/home/manu/.openclaw/workspace/memory/trading/signals/screenshots/"

REM Verify on Pi:
ls -lah /home/manu/.openclaw/workspace/memory/trading/signals/screenshots/
```

### Windows OpenSSH Limitations
- Windows OpenSSH (built-in) only works over SSH, not other protocols
- Paths use Windows conventions locally (`C:\...`) but SSH server expects Unix paths (`/home/...`)
- The watcher.js handles this automatically — just ensure proper quoting in .env
