#!/bin/bash

echo "Checking for Brave Browser..."

# Check if brave-browser is installed
if ! command -v brave-browser &> /dev/null; then
    echo "Brave Browser not found. Installing..."
    sudo apt update
    sudo apt install -y curl xvfb
    sudo curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" | sudo tee /etc/apt/sources.list.d/brave-browser-release.list
    sudo apt update
    sudo apt install -y brave-browser
    echo "Brave installed successfully!"
else
    echo "Brave is already installed."
fi

# Ensure xvfb is installed for the virtual display
if ! command -v xvfb-run &> /dev/null; then
    echo "Installing xvfb..."
    sudo apt install -y xvfb
fi

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "PM2 not found. Installing PM2 globally..."
    sudo npm install -g pm2
fi

echo "Starting Brave Browser in the background via PM2 with virtual display..."

# Delete old process if it exists so we don't duplicate
pm2 delete brave-bg 2>/dev/null

# Start brave using pm2 and xvfb on port 9222
pm2 start "xvfb-run -a -s '-screen 0 1280x720x24' brave-browser --remote-debugging-port=9222 --no-sandbox --disable-dev-shm-usage" --name "brave-bg"

echo "Saving PM2 state..."
pm2 save

echo "Done! Brave is now running in the background."
