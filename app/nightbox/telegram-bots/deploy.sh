#!/bin/bash

# 1. Update system and install system dependencies
echo "Updating system..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3 python3-pip python3-venv ffmpeg git curl

# 2. Install Node.js and PM2 if not present
if ! command -v pm2 &> /dev/null
then
    echo "Installing Node.js and PM2..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt install -y nodejs
    sudo npm install -g pm2
fi

# 3. Set up Python Virtual Environment
echo "Setting up virtual environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

# 4. Install/Update Python dependencies
echo "Installing/Updating requirements..."
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# 5. CLEAR CONFLICTING SESSIONS (Crucial for VPS move)
echo "Cleaning up session files to prevent conflicts..."
rm -f *.session *.session-journal

# 6. Stop existing processes to start fresh
echo "Restarting bots with PM2..."
pm2 stop all 2>/dev/null || true
pm2 delete all 2>/dev/null || true

# 7. Start bots using the ecosystem config
pm2 start ecosystem.config.js
pm2 save

echo "-------------------------------------------------------"
echo "Deployment complete! Your bots are now running on VPS."
echo "-------------------------------------------------------"
echo "Check status: pm2 status"
echo "Check logs:   pm2 logs"
echo "-------------------------------------------------------"
