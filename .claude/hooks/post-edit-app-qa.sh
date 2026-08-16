#!/bin/sh
case "$1" in
  src/*|src-tauri/*) echo "Desktop code changed. Run /app-qa before reporting completion." ;;
esac
