#!/bin/bash

# Default to using sudo
USE_SUDO=true

# Check for --nosudo flag
for arg in "$@"; do
  if [ "$arg" == "--nosudo" ]; then
    USE_SUDO=false
  fi
done

# Function to run commands with or without sudo
run_cmd() {
  if [ "$USE_SUDO" = true ]; then
    sudo "$@"
  else
    "$@"
  fi
}

# Determine project root directory
if [[ "$PWD" == */linux ]]; then
    PROJECT_ROOT=$(dirname "$PWD")
else
    PROJECT_ROOT="$PWD"
fi

echo "Installing from Project Root: $PROJECT_ROOT"

# 1. Install Node dependencies
echo "Installing NPM dependencies..."
cd "$PROJECT_ROOT" && npm install

# 2. Create the Systemd service file
SERVICE_FILE="/etc/systemd/system/alexa-todoist-sync.service"

echo "Creating systemd service..."
SERVICE_CONTENT="[Unit]
Description=Alexa Todoist Sync Service
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$PROJECT_ROOT
ExecStart=$(which node) $PROJECT_ROOT/shared/sync.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target"

# Write the file using a temporary location to handle redirection + sudo
echo "$SERVICE_CONTENT" > /tmp/alexa-todoist-sync.service
run_cmd mv /tmp/alexa-todoist-sync.service $SERVICE_FILE

# 3. Reload systemd and enable service
echo "Reloading systemd and enabling service..."
run_cmd systemctl daemon-reload
run_cmd systemctl enable alexa-todoist-sync
run_cmd systemctl start alexa-todoist-sync

echo "-------------------------------------------------------"
echo "Installation Complete!"
echo "Check status: systemctl status alexa-todoist-sync"
echo "View logs:    journalctl -u alexa-todoist-sync -f"
echo "-------------------------------------------------------"
