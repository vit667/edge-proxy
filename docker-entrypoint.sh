#!/bin/sh
set -e
# First start: seed the configuration so the agent can boot; edit it later in the panel.
if [ ! -f "$CONFIG_PATH" ]; then
  cp /app/config.example.json "$CONFIG_PATH"
  echo "Created $CONFIG_PATH from config.example.json — set your origins in the control panel."
fi
exec "$@"
