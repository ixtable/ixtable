#!/bin/sh
case "$1" in
  supabase/*|web/src/contexts/*|web/src/pages/login.*|web/src/pages/account.*|web/src/pages/forgot-password.*|web/src/pages/reset-password.*|web/src/lib/*) echo "A SaaS service boundary changed. Run /service-qa before reporting completion." ;;
esac
