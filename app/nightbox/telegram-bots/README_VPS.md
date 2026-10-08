# VPS Deployment Guide (Telegram Bots)

Follow these steps to move your bots from Windows to your VPS permanently.

## 1. Stop Bots on Windows (IMPORTANT)
Before starting on the VPS, you **must** stop the bots on your computer to avoid the `AuthKeyDuplicated` error.
Open PowerShell and run:
```powershell
Get-Process python | Stop-Process -Force
```

## 2. Sync Files to VPS
Upload the following files to your VPS folder:
- `hider_bot.py`
- `convert_bot.py`
- `upload_bot.py`
- `ecosystem.config.js`
- `requirements.txt`
- `.env`
- `deploy.sh`

## 3. Run the Deployment Script
On your VPS terminal, navigate to the folder and run:
```bash
chmod +x deploy.sh
./deploy.sh
```

## 4. Verify Everything is Running
Run this command to see the status of all 3 bots:
```bash
pm2 status
```

To see live logs for any bot (e.g., upload-bot):
```bash
pm2 logs upload-bot
```

## 5. Troubleshooting
If a bot fails to start, delete the session files on the VPS and restart:
```bash
rm *.session
pm2 restart all
```
