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

### Remote Screenshot Upload via Tailscale VPN
```
REMOTE_HOST=100.90.146.47
REMOTE_USER=manu
REMOTE_SCREENSHOTS_DIR=/home/manu/.openclaw/workspace/memory/trading/signals/screenshots
```

**Note:** `REMOTE_PASS` NOT needed — uses SSH key authentication (ed25519). Private IP (192.168.1.98) does NOT work from public VPS; use Tailscale VPN IPs instead.

## Setup Instructions

### 1. Install Tailscale on VPS (if not already installed)
```cmd
choco install tailscale
REM or: Download from https://tailscale.com/download/windows
tailscale login
tailscale status  REM Verify VPS IP (e.g., 100.88.74.45)
```

### 2. Verify Pi is on Tailscale
```bash
# On Pi:
tailscale status
# Should show IP like 100.90.146.47
```

### 3. Generate SSH Key on VPS (ed25519)
```cmd
ssh-keygen -t ed25519 -f C:\Users\Administrateur\.ssh\id_ed25519 -N ""
```

### 4. Copy Public Key to Pi
```cmd
scp C:\Users\Administrateur\.ssh\id_ed25519.pub manu@100.90.146.47:/tmp/
REM On Pi:
cat /tmp/id_ed25519.pub >> ~/.ssh/authorized_keys
```

### 5. Test SSH Connectivity
```cmd
ssh -i C:\Users\Administrateur\.ssh\id_ed25519 manu@100.90.146.47 "ls -la /home/manu/.openclaw/workspace/memory/trading/signals/screenshots/"
```

### 6. Create .env file on VPS
Create `C:\signal-watcher\.env` with values above (use Tailscale IPs, no REMOTE_PASS)

### 7. Restart Watcher
```cmd
pm2 restart signal-watcher
pm2 logs signal-watcher  REM Watch for successful uploads
```

## Architecture

**Problem Solved:** Public VPS (82.26.157.161) cannot reach Pi's private IP (192.168.1.98) directly. Solution: Tailscale VPN overlay.

**New Flow:** 
1. MT4 signals fire → screenshots saved to `C:\signal-watcher\screenshots\` (local VPS storage)
2. watcher.js **uploads to Pi via Tailscale VPN** (100.88.74.45 → 100.90.146.47)
   - Uses SSH key auth (ed25519), no passwords
   - Non-blocking SCP, 1-2s latency
3. Kit analyzes from Pi-persistent paths: `/home/manu/.openclaw/workspace/memory/trading/signals/screenshots/`
4. Screenshots also posted to Discord (ephemeral, for historical reference)

**Why Tailscale?**
- VPS is on public internet (exposed to DDoS, can't receive inbound)
- Pi is on private LAN (192.168.1.0/24, no public IP)
- Tailscale creates encrypted WireGuard mesh between any two devices
- Both VPS + Pi join the same Tailscale network
- Can reach each other via Tailscale IPs even if public/private mix

## Benefits
- **Reliability:** Screenshots persist indefinitely on Pi (24+ hours minimum)
- **Speed:** Auto-uploads within 1-2s of signal fire, analysis immediate
- **Security:** SSH key auth (no passwords), Tailscale encrypted, private IPs protected
- **No CDN Risk:** Local Pi storage, no Discord CDN expiration issues
- **Auditability:** Copies on VPS (backup) + Pi (analysis) + Discord (reference)

## Troubleshooting

### Verify Tailscale is Running
```cmd
REM On VPS:
tailscale status
REM Should show VPS Tailscale IP (e.g., 100.88.74.45) with state "running"

REM On Pi:
tailscale status
REM Should show Pi Tailscale IP (e.g., 100.90.146.47)
```

### Ping Pi from VPS via Tailscale
```cmd
REM On VPS, use Tailscale IP (not private IP):
ping 100.90.146.47
REM If using private IP (192.168.1.98) → will fail (by design)
```

### SSH Key Issues
```cmd
REM Test SSH key auth manually:
ssh -i C:\Users\Administrateur\.ssh\id_ed25519 manu@100.90.146.47 "hostname"

REM If "Permission denied":
1. Verify public key is in Pi's ~/.ssh/authorized_keys
2. Check Pi SSH config: /etc/ssh/sshd_config (PubkeyAuthentication yes)
3. Check file permissions on Pi: chmod 600 ~/.ssh/authorized_keys
```

### Check VPS Watcher Logs
```cmd
pm2 logs signal-watcher --lines 50
pm2 describe signal-watcher
```

### Verify Screenshots Uploaded to Pi
```bash
REM On Pi:
ls -lah /home/manu/.openclaw/workspace/memory/trading/signals/screenshots/
REM Should show recent .png files with timestamps matching signals
```

### SCP Upload Hangs or Times Out
- **Tailscale not connected:** Run `tailscale login` on both devices
- **Network blocked:** Check firewall on Pi (SSH port 22 accessible via Tailscale)
- **Wrong IP:** Verify using `tailscale status` output, not private IPs

### Manual Upload Test
```cmd
REM On VPS:
scp -i C:\Users\Administrateur\.ssh\id_ed25519 C:\signal-watcher\screenshots\test.png manu@100.90.146.47:/home/manu/.openclaw/workspace/memory/trading/signals/screenshots/
```
