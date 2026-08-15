#!/bin/sh
case "$1" in
  src-tauri/src/*|supabase/*|src/lib/*) echo "A service boundary may have changed. Run /service-qa before reporting completion." ;;
esac

