#!/bin/sh
# CI only: grants Accessibility, Input Monitoring, Screen Recording and event posting to each path
# given, by writing TCC.db (needs sudo and SIP off; GitHub's macOS images run with SIP off).
# Exit 0 when granted, 3 when it can't be (SIP on, no sudo): the e2e then skips those checks loudly.
#
#   sh test/e2e/mac-tcc.sh <path>...
set -u

if ! csrutil status 2>/dev/null | grep -qi disabled; then
  echo "::warning::e2e: SIP is enabled ($(csrutil status 2>&1)): cannot grant TCC permissions on this runner"
  exit 3
fi
if ! sudo -n true 2>/dev/null; then
  echo "::warning::e2e: no passwordless sudo: cannot grant TCC permissions on this runner"
  exit 3
fi

now=$(date +%s)
sql=""
for path in "$@"; do
  for service in kTCCServiceAccessibility kTCCServiceListenEvent kTCCServiceScreenCapture kTCCServicePostEvent; do
    sql="$sql INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier, flags, last_modified) VALUES ('$service', '$path', 1, 2, 4, 1, 'UNUSED', 0, $now);"
  done
done

status=0
for db in "/Library/Application Support/com.apple.TCC/TCC.db" "$HOME/Library/Application Support/com.apple.TCC/TCC.db"; do
  if [ -f "$db" ]; then
    if sudo sqlite3 "$db" "$sql"; then
      echo "granted in $db"
    else
      echo "::warning::e2e: could not write $db"
      status=3
    fi
  fi
done

# Screen Recording on macOS 15+: skip the "bypass the private window picker" re-approval.
approvals="$HOME/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist"
mkdir -p "$(dirname "$approvals")"
for path in "$@"; do
  defaults write "$approvals" "$path" -date "3024-01-01 00:00:00 +0000" 2>/dev/null || true
done

# tccd caches decisions: restart both (launchd brings them back).
sudo killall tccd 2>/dev/null || true
killall tccd 2>/dev/null || true
sleep 2

echo "TCC rows now:"
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "SELECT service, client, auth_value FROM access WHERE client LIKE '%autotrack%' OR client LIKE '%e2e%';" 2>/dev/null || true
exit $status
