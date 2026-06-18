#!/bin/sh
node dist/index.js &
sleep 2
exec mcp-proxy http://localhost:3000/mcp
