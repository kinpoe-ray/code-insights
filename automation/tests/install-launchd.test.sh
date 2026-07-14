#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/automation/install-launchd.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/code-insights-launchd-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

mkdir -p "$TMP_ROOT/home" "$TMP_ROOT/bin"
real_node=$(command -v node)
ln -s "$real_node" "$TMP_ROOT/bin/node"
cat > "$TMP_ROOT/bin/code-insights" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${CLI_CALL_LOG:-}" ]]; then
  printf '%s\n' "$*" >> "$CLI_CALL_LOG"
fi
if [[ "${1:-}" == 'install-hook' && "${MUTATE_SETTINGS_THEN_FAIL:-0}" == '1' ]]; then
  mkdir -p "$HOME/.claude"
  printf '%s\n' '{"mutated":true}' > "$HOME/.claude/settings.json"
  chmod 600 "$HOME/.claude/settings.json"
  exit 1
fi
if [[ "${1:-}" == 'install-hook' && "${REPLACE_SYMLINK_THEN_FAIL:-0}" == '1' ]]; then
  printf '%s\n' '{"mutatedTarget":true}' > "$HOME/.claude/settings.json"
  rm -f "$HOME/.claude/settings.json"
  printf '%s\n' '{"replacementFile":true}' > "$HOME/.claude/settings.json"
  exit 1
fi
if [[ "${1:-}" == 'install-hook' && "${REPLACE_SYMLINK_WITH_DIR_THEN_FAIL:-0}" == '1' ]]; then
  printf '%s\n' '{"mutatedTarget":true}' > "$HOME/.claude/settings.json"
  rm -f "$HOME/.claude/settings.json"
  mkdir -p "$HOME/.claude/settings.json"
  printf 'do not delete\n' > "$HOME/.claude/settings.json/user-file"
  exit 1
fi
if [[ "${1:-}" == 'install-hook' && "${FAIL_INSTALL_HOOK:-0}" == '1' ]]; then
  exit 1
fi
if [[ "${1:-}" == 'uninstall-hook' && "${FAIL_UNINSTALL_HOOK:-0}" == '1' ]]; then
  exit 42
fi
exit 0
EOF
chmod +x "$TMP_ROOT/bin/code-insights"

HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  "$SCRIPT" --render "$TMP_ROOT/maintenance.plist"

grep -Fq '<string>com.code-insights.maintenance</string>' "$TMP_ROOT/maintenance.plist" || fail 'missing launchd label'
grep -Fq "$ROOT/automation/code-insights-maintenance.sh" "$TMP_ROOT/maintenance.plist" || fail 'missing absolute maintenance path'
grep -Fq "$TMP_ROOT/bin" "$TMP_ROOT/maintenance.plist" || fail 'missing executable directory in PATH'
grep -Fq '<key>CODE_INSIGHTS_CONFIG_DIR</key>' "$TMP_ROOT/maintenance.plist" || fail 'missing config directory environment key'
grep -Fq "<string>$TMP_ROOT/home/.code-insights</string>" "$TMP_ROOT/maintenance.plist" || fail 'missing rendered config directory'
grep -Fq '<integer>3</integer>' "$TMP_ROOT/maintenance.plist" || fail 'missing scheduled hour'
grep -Fq '<integer>15</integer>' "$TMP_ROOT/maintenance.plist" || fail 'missing scheduled minute'
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$TMP_ROOT/maintenance.plist" >/dev/null
fi

# Uninstall is a recovery action: it must unload/remove the agent even when the
# checkout or CLI it originally referenced no longer exists.
cat > "$TMP_ROOT/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LAUNCHCTL_LOG"
if [[ "${1:-}" == "print" ]]; then
  [[ "${PRINT_LOADED_WITHOUT_PLIST:-0}" == "1" ]] && exit 0
  [[ "${PRINT_UNLOADED:-0}" == "1" ]] && exit 1
  [[ -n "${FAKE_INSTALLED_PLIST:-}" && ( -e "$FAKE_INSTALLED_PLIST" || -L "$FAKE_INSTALLED_PLIST" ) ]] && exit 0
  exit 1
fi
if [[ "${1:-}" == "bootout" && "${FAIL_BOOTOUT:-0}" == "1" ]]; then
  exit 1
fi
if [[ "${1:-}" == "bootout" && "${FAIL_SECOND_BOOTOUT:-0}" == "1" ]]; then
  count=0
  [[ -f "$BOOTOUT_COUNT_FILE" ]] && read -r count < "$BOOTOUT_COUNT_FILE"
  count=$((count + 1))
  printf '%s\n' "$count" > "$BOOTOUT_COUNT_FILE"
  [[ "$count" -ne 2 ]] || exit 1
fi
if [[ "${1:-}" == "bootout" && -n "${SIGNAL_ON_BOOTOUT:-}" ]]; then
  kill "-${SIGNAL_ON_BOOTOUT}" "$PPID"
  exit 0
fi
if [[ "${1:-}" == "bootstrap" && "${FAIL_ALL_BOOTSTRAP:-0}" == "1" ]]; then
  exit 1
fi
if [[ "${1:-}" == "bootstrap" && "${FAIL_FIRST_BOOTSTRAP:-0}" == "1" ]]; then
  count=0
  [[ -f "$BOOTSTRAP_COUNT_FILE" ]] && read -r count < "$BOOTSTRAP_COUNT_FILE"
  count=$((count + 1))
  printf '%s\n' "$count" > "$BOOTSTRAP_COUNT_FILE"
  [[ "$count" -gt 1 ]] || exit 1
fi
exit 0
EOF
cat > "$TMP_ROOT/bin/plutil" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${PLUTIL_LOG:-}" ]]; then
  printf '%s\n' "$*" >> "$PLUTIL_LOG"
fi
exit "${PLUTIL_STATUS:-0}"
EOF
cat > "$TMP_ROOT/bin/mv" <<'EOF'
#!/usr/bin/env bash
arguments=("$@")
last_index=$((${#arguments[@]} - 1))
destination=${arguments[$last_index]}
source=${arguments[$((last_index - 1))]}
if [[ -n "${PLIST_MV_LOG:-}" && "$destination" == *'/com.code-insights.maintenance.plist' ]]; then
  printf '%s|%s\n' "$source" "$destination" >> "$PLIST_MV_LOG"
fi
if [[ "${FAIL_PLIST_MV:-0}" == '1' && "$destination" == *'/com.code-insights.maintenance.plist' ]]; then
  if [[ -z "${FAIL_PLIST_MV_ONCE_FILE:-}" || ! -e "$FAIL_PLIST_MV_ONCE_FILE" ]]; then
    [[ -z "${FAIL_PLIST_MV_ONCE_FILE:-}" ]] || : > "$FAIL_PLIST_MV_ONCE_FILE"
    exit 1
  fi
fi
/bin/mv "$@" || exit $?
if [[ -n "${SIGNAL_AFTER_PLIST_MV:-}" && "$destination" == *'/com.code-insights.maintenance.plist' ]]; then
  kill "-${SIGNAL_AFTER_PLIST_MV}" "$PPID"
fi
EOF
cat > "$TMP_ROOT/bin/cp" <<'EOF'
#!/usr/bin/env bash
arguments=("$@")
last_index=$((${#arguments[@]} - 1))
destination=${arguments[$last_index]}
/bin/cp "$@" || exit $?
if [[ "${CREATE_SETTINGS_RACE_AFTER_RESTORE_COPY:-0}" == '1' && "$destination" == *'/.settings.json.restore.'* ]]; then
  printf '%s\n' '{"concurrentDuringRestore":true}' > "$SETTINGS_RACE_DESTINATION"
fi
if [[ "${CREATE_SETTINGS_DIRECTORY_AFTER_RESTORE_COPY:-0}" == '1' && "$destination" == *'/.settings.json.restore.'* ]]; then
  mkdir -p "$SETTINGS_RACE_DESTINATION"
  printf 'concurrent directory entry\n' > "$SETTINGS_RACE_DESTINATION/user-file"
fi
if [[ "${MUTATE_SETTINGS_AFTER_BACKUP_COPY:-0}" == '1' && "$destination" == *'/.settings.json.previous.'* ]]; then
  printf '%s\n' '{"changedDuringBackup":true}' > "$SETTINGS_BACKUP_SOURCE"
fi
if [[ "${REPLACE_PLIST_AFTER_SETTINGS_BACKUP:-0}" == '1' && "$destination" == *'/.settings.json.previous.'* ]]; then
  rm -f "$PLIST_RACE_PATH"
  ln -s "$PLIST_RACE_TARGET" "$PLIST_RACE_PATH"
fi
if [[ "${EDIT_PLIST_SAME_SIZE_AFTER_SETTINGS_BACKUP:-0}" == '1' && "$destination" == *'/.settings.json.previous.'* ]]; then
  printf 'BBBB\n' > "$PLIST_RACE_PATH"
fi
EOF
cat > "$TMP_ROOT/bin/uname" <<'EOF'
#!/usr/bin/env bash
printf 'Darwin\n'
EOF
chmod +x "$TMP_ROOT/bin/cp" "$TMP_ROOT/bin/launchctl" "$TMP_ROOT/bin/mv" "$TMP_ROOT/bin/plutil" "$TMP_ROOT/bin/uname"
export LAUNCHCTL_LOG="$TMP_ROOT/launchctl.log"
export CLI_CALL_LOG="$TMP_ROOT/cli-calls.log"
export PLUTIL_LOG="$TMP_ROOT/plutil.log"
export PLIST_MV_LOG="$TMP_ROOT/plist-mv.log"
installed_plist="$TMP_ROOT/home/Library/LaunchAgents/com.code-insights.maintenance.plist"
export FAKE_INSTALLED_PLIST="$installed_plist"
mkdir -p "$(dirname "$installed_plist")"
printf 'obsolete agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/missing/code-insights" \
  CODE_INSIGHTS_MAINTENANCE_SCRIPT="$TMP_ROOT/missing/maintenance.sh" \
  CODE_INSIGHTS_LAUNCHD_TEMPLATE="$TMP_ROOT/missing/maintenance.plist.in" \
  "$SCRIPT" --uninstall > "$TMP_ROOT/uninstall.log" 2>&1
uninstall_status=$?
set -e
[[ "$uninstall_status" -ne 0 ]] || fail 'missing CLI must make uninstall report a partial failure'
[[ ! -e "$installed_plist" ]] || fail 'uninstall did not remove the existing plist'
grep -Fq "bootout gui/$(id -u) $installed_plist" "$LAUNCHCTL_LOG" || fail 'uninstall did not bootout the existing plist'
grep -Fq 'Skipping Claude hook removal' "$TMP_ROOT/uninstall.log" || fail 'uninstall did not explain the missing CLI'
grep -Fq 'LaunchAgent was removed, but the Claude hook was not removed' "$TMP_ROOT/uninstall.log" || fail 'uninstall did not report partial completion'
if grep -Fq 'and the Claude SessionEnd hook' "$TMP_ROOT/uninstall.log"; then
  fail 'partial uninstall falsely reported complete hook removal'
fi

# A CLI hook-removal failure is also partial: the agent remains removed, the
# command returns non-zero, and the all-success message is withheld.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
printf 'installed agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  FAIL_UNINSTALL_HOOK=1 \
  "$SCRIPT" --uninstall > "$TMP_ROOT/uninstall-hook-failure.log" 2>&1
uninstall_hook_status=$?
set -e
[[ "$uninstall_hook_status" -eq 42 ]] || fail "expected hook failure status 42, got $uninstall_hook_status"
[[ ! -e "$installed_plist" ]] || fail 'hook failure left the LaunchAgent plist installed'
grep -Fq 'LaunchAgent was removed, but the Claude hook was not removed' "$TMP_ROOT/uninstall-hook-failure.log" || fail 'hook failure did not report partial completion'
if grep -Fq 'and the Claude SessionEnd hook' "$TMP_ROOT/uninstall-hook-failure.log"; then
  fail 'hook failure falsely reported a complete uninstall'
fi

# Only a successful hook removal reports complete uninstall success.
: > "$CLI_CALL_LOG"
printf 'installed agent\n' > "$installed_plist"
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  "$SCRIPT" --uninstall > "$TMP_ROOT/uninstall-success.log" 2>&1
grep -Fq 'Removed com.code-insights.maintenance and the Claude SessionEnd hook.' "$TMP_ROOT/uninstall-success.log" || fail 'successful uninstall did not report full completion'

# An unload failure is not a successful uninstall while launchctl still
# reports the job loaded. Keep the plist for recovery and return non-zero.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
printf 'installed agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" FAIL_BOOTOUT=1 \
  "$SCRIPT" --uninstall > "$TMP_ROOT/uninstall-bootout-failure.log" 2>&1
uninstall_bootout_status=$?
set -e
[[ "$uninstall_bootout_status" -ne 0 ]] || fail 'loaded-agent bootout failure unexpectedly reported success'
[[ -f "$installed_plist" ]] || fail 'uninstall deleted the plist after failing to unload a loaded job'
grep -Fq 'uninstall-hook' "$CLI_CALL_LOG" || fail 'unload failure skipped independent hook removal'
if grep -Fq 'and the Claude SessionEnd hook' "$TMP_ROOT/uninstall-bootout-failure.log"; then
  fail 'unload failure falsely reported a complete uninstall'
fi

# No action argument remains an alias for --install; action-specific input
# validation must happen after that default is resolved.
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/missing/code-insights" \
  CODE_INSIGHTS_MAINTENANCE_SCRIPT="$TMP_ROOT/missing/maintenance.sh" \
  CODE_INSIGHTS_LAUNCHD_TEMPLATE="$TMP_ROOT/missing/maintenance.plist.in" \
  "$SCRIPT" > "$TMP_ROOT/default-install.log" 2>&1
default_status=$?
set -e
[[ "$default_status" -eq 69 ]] || fail "expected default install to validate inputs (69), got $default_status"
if grep -Fq 'Usage:' "$TMP_ROOT/default-install.log"; then
  fail 'default install was rejected as an invalid action invocation'
fi

# Unknown actions report usage before probing action-irrelevant assets.
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/missing/code-insights" \
  CODE_INSIGHTS_MAINTENANCE_SCRIPT="$TMP_ROOT/missing/maintenance.sh" \
  CODE_INSIGHTS_LAUNCHD_TEMPLATE="$TMP_ROOT/missing/maintenance.plist.in" \
  "$SCRIPT" --unknown > "$TMP_ROOT/unknown-action.log" 2>&1
unknown_status=$?
set -e
[[ "$unknown_status" -eq 64 ]] || fail "expected unknown action exit 64, got $unknown_status"
grep -Fq 'Usage:' "$TMP_ROOT/unknown-action.log" || fail 'unknown action did not print usage'

# The final plist replacement must be a rename within LaunchAgents. Staging in
# the config directory can cross filesystems and lose atomic replacement.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
: > "$PLIST_MV_LOG"
rm -f "$installed_plist"
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  "$SCRIPT" --install > "$TMP_ROOT/install-same-directory-staging.log" 2>&1
IFS='|' read -r staged_plist staging_destination < "$PLIST_MV_LOG"
[[ -n "$staged_plist" && -n "$staging_destination" ]] || fail 'successful install did not replace the plist'
[[ "$(dirname "$staged_plist")" == "$(dirname "$staging_destination")" ]] || fail 'plist was not staged in the LaunchAgents directory'
rm -f "$installed_plist"

# User-managed LaunchAgent plist symlinks are rejected before any launchctl
# mutation rather than being silently replaced with regular files.
: > "$LAUNCHCTL_LOG"
managed_plist="$TMP_ROOT/managed-launch-agent.plist"
printf 'managed agent\n' > "$managed_plist"
rm -f "$installed_plist"
ln -s "$managed_plist" "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  "$SCRIPT" --install > "$TMP_ROOT/install-plist-symlink.log" 2>&1
plist_symlink_status=$?
set -e
[[ "$plist_symlink_status" -ne 0 ]] || fail 'LaunchAgent plist symlink installation unexpectedly succeeded'
[[ -L "$installed_plist" && "$(readlink "$installed_plist")" == "$managed_plist" ]] || fail 'LaunchAgent plist symlink shape was destroyed'
[[ "$(cat "$managed_plist")" == 'managed agent' ]] || fail 'LaunchAgent plist symlink target was modified'
[[ ! -s "$LAUNCHCTL_LOG" ]] || fail 'rejected LaunchAgent symlink changed launchctl state'
rm -f "$installed_plist"

# The settings backup must be a consistent snapshot. A source edit during the
# copy aborts before any launchctl state change and leaves the edit intact.
: > "$LAUNCHCTL_LOG"
snapshot_settings="$TMP_ROOT/home/.claude/settings.json"
mkdir -p "$(dirname "$snapshot_settings")"
printf '%s\n' '{"theme":"snapshot-source"}' > "$snapshot_settings"
printf 'previous agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" MUTATE_SETTINGS_AFTER_BACKUP_COPY=1 \
  SETTINGS_BACKUP_SOURCE="$snapshot_settings" \
  "$SCRIPT" --install > "$TMP_ROOT/settings-snapshot-race.log" 2>&1
settings_snapshot_status=$?
set -e
[[ "$settings_snapshot_status" -ne 0 ]] || fail 'inconsistent settings snapshot unexpectedly installed'
grep -Fq 'changedDuringBackup' "$snapshot_settings" || fail 'settings snapshot test edit was lost'
if grep -Eq '^(bootout|bootstrap) ' "$LAUNCHCTL_LOG"; then
  fail 'inconsistent settings snapshot changed launchctl state'
fi
rm -f "$snapshot_settings"

# Replacing the plist with a symlink after the initial safety check must be
# detected before bootout or replacement; preserve the concurrent link/target.
: > "$LAUNCHCTL_LOG"
mkdir -p "$(dirname "$snapshot_settings")"
printf '%s\n' '{"theme":"trigger-plist-backup-race"}' > "$snapshot_settings"
printf 'original agent\n' > "$installed_plist"
plist_race_target="$TMP_ROOT/concurrent-managed-agent.plist"
printf 'concurrent managed agent\n' > "$plist_race_target"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" REPLACE_PLIST_AFTER_SETTINGS_BACKUP=1 \
  PLIST_RACE_PATH="$installed_plist" PLIST_RACE_TARGET="$plist_race_target" \
  "$SCRIPT" --install > "$TMP_ROOT/plist-race.log" 2>&1
plist_race_status=$?
set -e
[[ "$plist_race_status" -ne 0 ]] || fail 'concurrent plist symlink replacement unexpectedly installed'
[[ -L "$installed_plist" && "$(readlink "$installed_plist")" == "$plist_race_target" ]] || fail 'plist race destroyed the concurrent symlink'
[[ "$(cat "$plist_race_target")" == 'concurrent managed agent' ]] || fail 'plist race modified the concurrent symlink target'
if grep -Eq '^(bootout|bootstrap) ' "$LAUNCHCTL_LOG"; then
  fail 'plist race changed loaded launchctl state'
fi
rm -f "$snapshot_settings" "$installed_plist"

# Fingerprinting also includes content, not only second-granularity timestamps:
# detect an in-place same-size edit made while settings are backed up.
: > "$LAUNCHCTL_LOG"
mkdir -p "$(dirname "$snapshot_settings")"
printf '%s\n' '{"theme":"trigger-same-size-plist-race"}' > "$snapshot_settings"
printf 'AAAA\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" EDIT_PLIST_SAME_SIZE_AFTER_SETTINGS_BACKUP=1 \
  PLIST_RACE_PATH="$installed_plist" \
  "$SCRIPT" --install > "$TMP_ROOT/plist-same-size-race.log" 2>&1
plist_same_size_status=$?
set -e
[[ "$plist_same_size_status" -ne 0 ]] || fail 'same-size concurrent plist edit unexpectedly installed'
[[ "$(cat "$installed_plist")" == 'BBBB' ]] || fail 'same-size concurrent plist edit was overwritten'
if grep -Eq '^(bootout|bootstrap) ' "$LAUNCHCTL_LOG"; then
  fail 'same-size plist race changed loaded launchctl state'
fi
rm -f "$snapshot_settings" "$installed_plist"

# A loaded job without a recoverable plist cannot participate in an atomic
# update. Fail before bootout instead of unloading an unrecoverable job.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" PRINT_LOADED_WITHOUT_PLIST=1 \
  "$SCRIPT" --install > "$TMP_ROOT/loaded-without-plist.log" 2>&1
loaded_without_plist_status=$?
set -e
[[ "$loaded_without_plist_status" -ne 0 ]] || fail 'loaded job without plist unexpectedly installed'
if grep -Eq '^(bootout|bootstrap) ' "$LAUNCHCTL_LOG"; then
  fail 'loaded job without plist was mutated'
fi
if [[ -f "$CLI_CALL_LOG" ]] && grep -Fq 'install-hook' "$CLI_CALL_LOG"; then
  fail 'loaded job without plist ran hook installation'
fi

# A failed bootstrap of an updated agent restores and reloads the previous
# plist instead of leaving maintenance uninstalled.
: > "$LAUNCHCTL_LOG"
export BOOTSTRAP_COUNT_FILE="$TMP_ROOT/bootstrap-count"
rm -f "$BOOTSTRAP_COUNT_FILE" "$CLI_CALL_LOG"
printf 'previous agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  FAIL_FIRST_BOOTSTRAP=1 \
  "$SCRIPT" --install > "$TMP_ROOT/install-rollback.log" 2>&1
install_status=$?
set -e
[[ "$install_status" -ne 0 ]] || fail 'expected failed new bootstrap to fail installation'
[[ "$(cat "$installed_plist")" == 'previous agent' ]] || fail 'failed bootstrap did not restore the previous plist'
[[ "$(grep -c '^bootstrap ' "$LAUNCHCTL_LOG")" -eq 2 ]] || fail 'expected bootstrap of new and restored agents'
[[ "$(grep -c '^bootout ' "$LAUNCHCTL_LOG")" -eq 2 ]] || fail 'expected cleanup bootout after a failed or partial new bootstrap'
if [[ -f "$CLI_CALL_LOG" ]] && grep -Fq 'install-hook' "$CLI_CALL_LOG"; then
  fail 'hook installation ran after the LaunchAgent bootstrap failed'
fi

# Once the old agent has been booted out, failures at bootout or plist move are
# transaction failures: the old plist is restored and bootstrapped again.
for failure_mode in bootout move; do
  : > "$LAUNCHCTL_LOG"
  : > "$CLI_CALL_LOG"
  printf 'previous agent\n' > "$installed_plist"
  set +e
  if [[ "$failure_mode" == 'bootout' ]]; then
    HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
      CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" FAIL_BOOTOUT=1 \
      "$SCRIPT" --install > "$TMP_ROOT/install-$failure_mode-failure.log" 2>&1
  else
    HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
      CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" FAIL_PLIST_MV=1 \
      FAIL_PLIST_MV_ONCE_FILE="$TMP_ROOT/plist-mv-failed-once" \
      "$SCRIPT" --install > "$TMP_ROOT/install-$failure_mode-failure.log" 2>&1
  fi
  transaction_status=$?
  set -e
  [[ "$transaction_status" -ne 0 ]] || fail "$failure_mode failure unexpectedly succeeded"
  [[ "$(cat "$installed_plist")" == 'previous agent' ]] || fail "$failure_mode failure did not restore the previous plist"
  grep -Fq "bootstrap gui/$(id -u) $installed_plist" "$LAUNCHCTL_LOG" || fail "$failure_mode failure did not re-bootstrap the previous agent"
  if grep -Fq 'install-hook' "$CLI_CALL_LOG"; then
    fail "$failure_mode failure ran hook installation"
  fi
done

# INT/TERM use the same rollback path. A signal delivered just after bootout
# must restore/reload the old agent and preserve the conventional exit code.
for signal in INT TERM; do
  : > "$LAUNCHCTL_LOG"
  : > "$CLI_CALL_LOG"
  printf 'previous agent\n' > "$installed_plist"
  expected_signal_status=130
  [[ "$signal" == 'INT' ]] || expected_signal_status=143
  set +e
  HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
    CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" SIGNAL_ON_BOOTOUT="$signal" \
    "$SCRIPT" --install > "$TMP_ROOT/install-$signal.log" 2>&1
  signal_status=$?
  set -e
  [[ "$signal_status" -eq "$expected_signal_status" ]] || fail "expected $signal status $expected_signal_status, got $signal_status"
  [[ "$(cat "$installed_plist")" == 'previous agent' ]] || fail "$signal did not restore the previous plist"
  grep -Fq "bootstrap gui/$(id -u) $installed_plist" "$LAUNCHCTL_LOG" || fail "$signal did not re-bootstrap the previous agent"
done

# Bash defers traps while waiting for an external mv. A signal delivered after
# mv has replaced the plist but before the next shell statement must still
# classify that file as generated and restore the previous agent.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
printf 'previous agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" SIGNAL_AFTER_PLIST_MV=TERM \
  "$SCRIPT" --install > "$TMP_ROOT/install-TERM-after-plist-mv.log" 2>&1
signal_after_mv_status=$?
set -e
[[ "$signal_after_mv_status" -eq 143 ]] || fail "expected post-mv TERM status 143, got $signal_after_mv_status"
[[ "$(cat "$installed_plist")" == 'previous agent' ]] || fail 'post-mv TERM did not restore the previous plist'
grep -Fq "bootstrap gui/$(id -u) $installed_plist" "$LAUNCHCTL_LOG" || fail 'post-mv TERM did not re-bootstrap the previous agent'

# If even recovery bootstrap fails, EXIT cleanup must retain the only staged
# backup instead of deleting the user's recovery copy.
: > "$LAUNCHCTL_LOG"
printf 'previous agent\n' > "$installed_plist"
rm -f "$TMP_ROOT/home/.code-insights"/*.previous.* 2>/dev/null || true
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" FAIL_ALL_BOOTSTRAP=1 \
  "$SCRIPT" --install > "$TMP_ROOT/install-recovery-failure.log" 2>&1
recovery_failure_status=$?
set -e
[[ "$recovery_failure_status" -ne 0 ]] || fail 'bootstrap and recovery failure unexpectedly succeeded'
[[ "$(cat "$installed_plist")" == 'previous agent' ]] || fail 'recovery failure lost the previous plist content'
recovery_backup=$(find "$TMP_ROOT/home/.code-insights" -maxdepth 1 -name 'com.code-insights.maintenance.plist.previous.*' -print -quit)
[[ -n "$recovery_backup" && -f "$recovery_backup" ]] || fail 'EXIT cleanup deleted the recovery plist backup'
[[ "$(cat "$recovery_backup")" == 'previous agent' ]] || fail 'retained recovery plist backup has wrong content'

# A hook-install failure also rolls the LaunchAgent back, so install cannot
# leave a new daily job paired with a missing or stale SessionEnd hook.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
printf 'previous agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  FAIL_INSTALL_HOOK=1 \
  "$SCRIPT" --install > "$TMP_ROOT/hook-rollback.log" 2>&1
hook_install_status=$?
set -e
[[ "$hook_install_status" -ne 0 ]] || fail 'expected hook failure to fail installation'
[[ "$(cat "$installed_plist")" == 'previous agent' ]] || fail 'hook failure did not restore the previous plist'
[[ "$(grep -c '^bootstrap ' "$LAUNCHCTL_LOG")" -eq 2 ]] || fail 'expected new and restored bootstrap after hook failure'
[[ "$(grep -c '^bootout ' "$LAUNCHCTL_LOG")" -eq 2 ]] || fail 'expected old and failed-new bootout after hook failure'
grep -Fq 'install-hook' "$CLI_CALL_LOG" || fail 'hook failure test did not run hook installation'

# If the new job cannot be unloaded during rollback, do not delete its plist or
# overwrite it with the old one. Retain the previous plist backup for recovery.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
bootout_count_file="$TMP_ROOT/bootout-count"
rm -f "$bootout_count_file"
printf 'previous agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" FAIL_INSTALL_HOOK=1 \
  FAIL_SECOND_BOOTOUT=1 BOOTOUT_COUNT_FILE="$bootout_count_file" \
  "$SCRIPT" --install > "$TMP_ROOT/hook-rollback-bootout-failure.log" 2>&1
rollback_bootout_status=$?
set -e
[[ "$rollback_bootout_status" -ne 0 ]] || fail 'rollback bootout failure unexpectedly succeeded'
grep -Fq '<string>com.code-insights.maintenance</string>' "$installed_plist" || fail 'rollback bootout failure overwrote the active new plist'
rollback_plist_backup=$(find "$TMP_ROOT/home/.code-insights" -maxdepth 1 -name 'com.code-insights.maintenance.plist.previous.*' -print -quit)
[[ -n "$rollback_plist_backup" && -f "$rollback_plist_backup" ]] || fail 'rollback bootout failure deleted the previous plist backup'
[[ "$(cat "$rollback_plist_backup")" == 'previous agent' ]] || fail 'retained previous plist backup has wrong content'
rm -f "$rollback_plist_backup"

# A stale plist that was not loaded before installation is restored on failure
# without starting a job that was previously stopped.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
printf 'stale stopped agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" FAIL_INSTALL_HOOK=1 PRINT_UNLOADED=1 \
  "$SCRIPT" --install > "$TMP_ROOT/stopped-agent-rollback.log" 2>&1
stopped_agent_status=$?
set -e
[[ "$stopped_agent_status" -ne 0 ]] || fail 'stopped-agent hook failure unexpectedly succeeded'
[[ "$(cat "$installed_plist")" == 'stale stopped agent' ]] || fail 'stopped-agent rollback did not restore its plist'
[[ "$(grep -c '^bootstrap ' "$LAUNCHCTL_LOG")" -eq 1 ]] || fail 'rollback started an old job that was previously stopped'

# Hook installation is part of the same transaction as the LaunchAgent. Even
# if a broken CLI mutates settings.json before returning non-zero, the exact
# previous settings content and permissions are restored with the prior plist.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
printf 'previous agent\n' > "$installed_plist"
settings_file="$TMP_ROOT/home/.claude/settings.json"
mkdir -p "$(dirname "$settings_file")"
printf '%s\n' '{"theme":"dark","hooks":{"SessionEnd":[]}}' > "$settings_file"
chmod 640 "$settings_file"
expected_settings_file="$TMP_ROOT/expected-settings.json"
cp -p "$settings_file" "$expected_settings_file"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  MUTATE_SETTINGS_THEN_FAIL=1 \
  "$SCRIPT" --install > "$TMP_ROOT/hook-settings-rollback.log" 2>&1
settings_rollback_status=$?
set -e
[[ "$settings_rollback_status" -ne 0 ]] || fail 'expected mutating hook failure to fail installation'
[[ "$(cat "$installed_plist")" == 'previous agent' ]] || fail 'mutating hook failure did not restore the previous plist'
cmp -s "$settings_file" "$expected_settings_file" || fail 'mutating hook failure did not restore previous settings content'
[[ "$(file_mode "$settings_file")" == '640' ]] || fail 'mutating hook failure did not restore settings permissions'
failed_regular_settings=$(find "$(dirname "$settings_file")" -maxdepth 1 -name '.settings.json.failed-current.*' -print -quit)
[[ -n "$failed_regular_settings" && -f "$failed_regular_settings" ]] || fail 'rollback discarded the failed hook settings state'
grep -Fq '"mutated":true' "$failed_regular_settings" || fail 'failed hook settings recovery copy has wrong content'

# A concurrent settings creation after the old bytes are staged for restore
# must win. Rollback fails closed and retains the original backup instead of
# overwriting the newly created file.
printf '%s\n' '{"theme":"before-race"}' > "$settings_file"
chmod 640 "$settings_file"
: > "$LAUNCHCTL_LOG"
printf 'previous agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" MUTATE_SETTINGS_THEN_FAIL=1 \
  CREATE_SETTINGS_RACE_AFTER_RESTORE_COPY=1 SETTINGS_RACE_DESTINATION="$settings_file" \
  "$SCRIPT" --install > "$TMP_ROOT/hook-settings-restore-race.log" 2>&1
settings_race_status=$?
set -e
[[ "$settings_race_status" -ne 0 ]] || fail 'settings restore race unexpectedly succeeded'
grep -Fq 'concurrentDuringRestore' "$settings_file" || fail 'rollback overwrote a settings file created during restore'
race_previous_backup=$(find "$(dirname "$settings_file")" -maxdepth 1 -name '.settings.json.previous.*' -print -quit)
[[ -n "$race_previous_backup" && -f "$race_previous_backup" ]] || fail 'restore race deleted the original settings backup'
grep -Fq 'before-race' "$race_previous_backup" || fail 'restore-race original backup has wrong content'
rm -f "$race_previous_backup"

# A directory created at the destination during restore must be treated as
# EEXIST, not as ln's "put the link inside this directory" shorthand.
rm -rf "$settings_file"
printf '%s\n' '{"theme":"before-directory-race"}' > "$settings_file"
chmod 640 "$settings_file"
: > "$LAUNCHCTL_LOG"
printf 'previous agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" MUTATE_SETTINGS_THEN_FAIL=1 \
  CREATE_SETTINGS_DIRECTORY_AFTER_RESTORE_COPY=1 SETTINGS_RACE_DESTINATION="$settings_file" \
  "$SCRIPT" --install > "$TMP_ROOT/hook-settings-directory-race.log" 2>&1
settings_directory_race_status=$?
set -e
[[ "$settings_directory_race_status" -ne 0 ]] || fail 'settings directory restore race unexpectedly succeeded'
[[ -d "$settings_file" && -f "$settings_file/user-file" ]] || fail 'restore damaged a concurrently created settings directory'
directory_race_backup=$(find "$(dirname "$settings_file")" -maxdepth 1 -name '.settings.json.previous.*' -print -quit)
[[ -n "$directory_race_backup" && -f "$directory_race_backup" ]] || fail 'directory restore race deleted the original settings backup'
grep -Fq 'before-directory-race' "$directory_race_backup" || fail 'directory-race original backup has wrong content'
rm -rf "$settings_file"
rm -f "$directory_race_backup"

# Absence is also backed up as state: if no settings.json existed before the
# transaction, a failed hook must not leave behind the file it created.
: > "$LAUNCHCTL_LOG"
: > "$CLI_CALL_LOG"
printf 'previous agent\n' > "$installed_plist"
rm -f "$settings_file"
failed_settings_count_before=$(find "$(dirname "$settings_file")" -maxdepth 1 -name '.settings.json.failed-current.*' | wc -l | tr -d ' ')
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  MUTATE_SETTINGS_THEN_FAIL=1 \
  "$SCRIPT" --install > "$TMP_ROOT/hook-settings-absent-rollback.log" 2>&1
absent_rollback_status=$?
set -e
[[ "$absent_rollback_status" -ne 0 ]] || fail 'expected hook failure from absent settings state'
[[ "$(cat "$installed_plist")" == 'previous agent' ]] || fail 'absent-settings hook failure did not restore the previous plist'
[[ ! -e "$settings_file" ]] || fail 'hook failure left settings.json that did not exist before installation'
failed_settings_count_after=$(find "$(dirname "$settings_file")" -maxdepth 1 -name '.settings.json.failed-current.*' | wc -l | tr -d ' ')
[[ "$failed_settings_count_after" -gt "$failed_settings_count_before" ]] || fail 'absent-state rollback discarded the file created by the failed hook'

# When settings.json is a symlink, rollback restores both the exact link shape
# and the target's prior bytes/permissions even if a faulty hook replaces the
# symlink itself before failing.
: > "$LAUNCHCTL_LOG"
printf 'previous agent\n' > "$installed_plist"
shared_settings_dir="$TMP_ROOT/home/shared-claude"
shared_settings="$shared_settings_dir/settings.json"
mkdir -p "$shared_settings_dir" "$(dirname "$settings_file")"
printf '%s\n' '{"theme":"linked"}' > "$shared_settings"
chmod 640 "$shared_settings"
rm -f "$settings_file"
ln -s '../shared-claude/settings.json' "$settings_file"
expected_link=$(readlink "$settings_file")
expected_linked_settings="$TMP_ROOT/expected-linked-settings.json"
cp -p "$shared_settings" "$expected_linked_settings"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" REPLACE_SYMLINK_THEN_FAIL=1 \
  "$SCRIPT" --install > "$TMP_ROOT/hook-symlink-rollback.log" 2>&1
symlink_rollback_status=$?
set -e
[[ "$symlink_rollback_status" -ne 0 ]] || fail 'symlink-replacing hook failure unexpectedly succeeded'
[[ -L "$settings_file" ]] || fail 'hook rollback did not restore settings.json as a symlink'
[[ "$(readlink "$settings_file")" == "$expected_link" ]] || fail 'hook rollback changed the settings.json symlink target text'
cmp -s "$shared_settings" "$expected_linked_settings" || fail 'hook rollback did not restore symlink target content'
[[ "$(file_mode "$shared_settings")" == '640' ]] || fail 'hook rollback did not restore symlink target permissions'
failed_link_entry=$(find "$(dirname "$settings_file")" -maxdepth 1 -name '.settings.json.failed-entry.*' -print -quit)
failed_link_target=$(find "$shared_settings_dir" -maxdepth 1 -name '.settings.json.failed-target.*' -print -quit)
[[ -n "$failed_link_entry" && -f "$failed_link_entry" ]] || fail 'symlink rollback discarded the failed hook replacement file'
[[ -n "$failed_link_target" && -f "$failed_link_target" ]] || fail 'symlink rollback discarded the mutated target state'
grep -Fq 'replacementFile' "$failed_link_entry" || fail 'failed symlink entry recovery copy has wrong content'
grep -Fq 'mutatedTarget' "$failed_link_target" || fail 'failed symlink target recovery copy has wrong content'

# If a faulty hook replaces the link with a non-empty directory, rollback must
# fail closed rather than delete/move user files. The original target backup is
# retained for manual recovery.
rm -rf "$settings_file"
printf '%s\n' '{"theme":"linked-directory-case"}' > "$shared_settings"
chmod 640 "$shared_settings"
ln -s '../shared-claude/settings.json' "$settings_file"
: > "$LAUNCHCTL_LOG"
printf 'previous agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" REPLACE_SYMLINK_WITH_DIR_THEN_FAIL=1 \
  "$SCRIPT" --install > "$TMP_ROOT/hook-unsafe-symlink-rollback.log" 2>&1
unsafe_symlink_status=$?
set -e
[[ "$unsafe_symlink_status" -ne 0 ]] || fail 'unsafe symlink rollback unexpectedly succeeded'
[[ -d "$settings_file" && -f "$settings_file/user-file" ]] || fail 'unsafe rollback destroyed the replacement directory'
unsafe_settings_backup=$(find "$shared_settings_dir" -maxdepth 1 -name '.settings.json.previous.*' -print -quit)
[[ -n "$unsafe_settings_backup" && -f "$unsafe_settings_backup" ]] || fail 'unsafe rollback deleted the original settings backup'
grep -Fq 'linked-directory-case' "$unsafe_settings_backup" || fail 'retained settings backup has wrong content'

# Dangling settings symlinks are unsafe to back up. Installation fails before
# launchctl is touched and leaves the dangling link unchanged.
: > "$LAUNCHCTL_LOG"
printf 'previous agent\n' > "$installed_plist"
rm -rf "$settings_file"
dangling_target='../../missing-claude/settings.json'
ln -s "$dangling_target" "$settings_file"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  "$SCRIPT" --install > "$TMP_ROOT/dangling-settings.log" 2>&1
dangling_status=$?
set -e
[[ "$dangling_status" -ne 0 ]] || fail 'dangling settings symlink installation unexpectedly succeeded'
[[ -L "$settings_file" && "$(readlink "$settings_file")" == "$dangling_target" ]] || fail 'dangling settings symlink was modified'
if grep -Eq '^(bootout|bootstrap) ' "$LAUNCHCTL_LOG"; then
  fail 'dangling settings symlink changed launchctl state'
fi

# The replacement plist is fully validated before the currently loaded agent
# is touched, and failed validation leaves no staging artifacts behind.
: > "$LAUNCHCTL_LOG"
: > "$PLUTIL_LOG"
rm -f "$CLI_CALL_LOG"
printf 'previous agent\n' > "$installed_plist"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights" \
  PLUTIL_STATUS=1 \
  "$SCRIPT" --install > "$TMP_ROOT/install-invalid.log" 2>&1
invalid_install_status=$?
set -e
[[ "$invalid_install_status" -ne 0 ]] || fail 'expected invalid rendered plist to fail installation'
[[ "$(cat "$installed_plist")" == 'previous agent' ]] || fail 'invalid rendered plist replaced the previous plist'
[[ ! -s "$LAUNCHCTL_LOG" ]] || fail 'invalid rendered plist caused launchctl state changes'
if find "$TMP_ROOT/home/.code-insights" -maxdepth 1 -name 'com.code-insights.maintenance.plist.tmp.*' -print -quit | grep -q .; then
  fail 'invalid rendered plist left a staging file behind'
fi

printf 'launchd installer render tests passed\n'
