#!/bin/bash
echo "Launching Brave visibly in your XRDP session..."

# If running via SSH, you might need to specify the display manually.
# Uncomment the line below if you get a "cannot open display" error via SSH.
# export DISPLAY=:10.0

brave-browser \
  --remote-debugging-port=9222 \
  --user-data-dir="/tmp/ekkoscope-profile" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage &

echo "Brave is running on port 9222!"
