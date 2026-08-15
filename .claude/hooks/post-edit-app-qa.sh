#!/bin/sh
case "$1" in
  src/*|src-tauri/src/*) echo "UI-affecting code changed. Run /app-qa before reporting completion." ;;
esac

