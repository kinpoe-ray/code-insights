#!/usr/bin/env bash
# Render/install the macOS daily maintenance LaunchAgent and Claude SessionEnd hook.

set -euo pipefail
umask 077

LABEL='com.code-insights.maintenance'
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEMPLATE="${CODE_INSIGHTS_LAUNCHD_TEMPLATE:-$ROOT/automation/$LABEL.plist.in}"
MAINTENANCE_SCRIPT="${CODE_INSIGHTS_MAINTENANCE_SCRIPT:-$ROOT/automation/code-insights-maintenance.sh}"
CODE_INSIGHTS_BIN="${CODE_INSIGHTS_BIN:-$(command -v code-insights 2>/dev/null || true)}"
CONFIG_DIR="${CODE_INSIGHTS_CONFIG_DIR:-$HOME/.code-insights}"
LOG_DIR="$CONFIG_DIR/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

xml_sed_escape() {
  local value=$1
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  value=${value//\\/\\\\}
  value=${value//&/\\&}
  value=${value//|/\\|}
  printf '%s' "$value"
}

render_plist() {
  local destination=$1
  local bin_dir path_value
  bin_dir=$(dirname "$CODE_INSIGHTS_BIN")
  path_value="$bin_dir:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  mkdir -p "$(dirname "$destination")" "$LOG_DIR"
  sed \
    -e "s|@MAINTENANCE_SCRIPT@|$(xml_sed_escape "$MAINTENANCE_SCRIPT")|g" \
    -e "s|@WORKING_DIRECTORY@|$(xml_sed_escape "$ROOT")|g" \
    -e "s|@HOME@|$(xml_sed_escape "$HOME")|g" \
    -e "s|@PATH@|$(xml_sed_escape "$path_value")|g" \
    -e "s|@CODE_INSIGHTS_BIN@|$(xml_sed_escape "$CODE_INSIGHTS_BIN")|g" \
    -e "s|@CONFIG_DIR@|$(xml_sed_escape "$CONFIG_DIR")|g" \
    -e "s|@STDOUT_LOG@|$(xml_sed_escape "$LOG_DIR/launchd.stdout.log")|g" \
    -e "s|@STDERR_LOG@|$(xml_sed_escape "$LOG_DIR/launchd.stderr.log")|g" \
    "$TEMPLATE" > "$destination"
  chmod 600 "$destination"
}

validate_inputs() {
  [[ -x "$MAINTENANCE_SCRIPT" ]] || { printf 'Maintenance script is not executable: %s\n' "$MAINTENANCE_SCRIPT" >&2; exit 69; }
  [[ -n "$CODE_INSIGHTS_BIN" && -x "$CODE_INSIGHTS_BIN" ]] || { printf 'code-insights executable not found\n' >&2; exit 69; }
  [[ -f "$TEMPLATE" ]] || { printf 'LaunchAgent template not found: %s\n' "$TEMPLATE" >&2; exit 66; }
}

case "${1:---install}" in
  --render)
    [[ $# -eq 2 ]] || { printf 'Usage: %s --render DESTINATION\n' "$0" >&2; exit 64; }
    validate_inputs
    render_plist "$2"
    ;;
  --install)
    [[ $# -le 1 ]] || { printf 'Usage: %s --install\n' "$0" >&2; exit 64; }
    validate_inputs
    [[ "$(uname -s)" == 'Darwin' ]] || { printf 'LaunchAgent installation requires macOS.\n' >&2; exit 69; }
    NODE_BIN=$(command -v node 2>/dev/null || true)
    [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { printf 'node executable not found\n' >&2; exit 69; }
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
    temporary_plist=""
    backup_plist=""
    claude_settings="$HOME/.claude/settings.json"
    backup_claude_settings=""
    claude_settings_kind='absent'
    claude_settings_target=''
    claude_settings_link=''
    previous_agent_existed=0
    previous_agent_loaded=0
    previous_plist_state='absent'
    previous_plist_fingerprint=''
    previous_plist_content_signature=''
    new_plist_installed=0
    new_plist_replacement_started=0
    new_plist_fingerprint=''
    new_plist_content_signature=''
    install_transaction_started=0
    install_committed=0
    new_agent_bootstrapped=0
    hook_install_started=0
    agent_restore_complete=0
    settings_restore_complete=0

    cleanup_install_staging() {
      [[ -z "$temporary_plist" ]] || rm -f "$temporary_plist"
    }

    settings_file_mode() {
      if stat -c '%a' "$1" >/dev/null 2>&1; then
        stat -c '%a' "$1"
      else
        stat -f '%Lp' "$1"
      fi
    }

    file_fingerprint() {
      if stat -c '%d:%i:%f:%s:%Y:%Z' "$1" >/dev/null 2>&1; then
        stat -c '%d:%i:%f:%s:%Y:%Z' "$1"
      else
        stat -f '%d:%i:%p:%z:%m:%c' "$1"
      fi
    }

    file_content_signature() {
      printf '%s:' "$(settings_file_mode "$1")"
      cksum < "$1"
    }

    create_hard_link_if_absent() {
      "$NODE_BIN" -e 'const fs=require("node:fs");try{fs.linkSync(process.argv[1],process.argv[2])}catch{process.exit(1)}' "$1" "$2"
    }

    create_symlink_if_absent() {
      "$NODE_BIN" -e 'const fs=require("node:fs");try{fs.symlinkSync(process.argv[1],process.argv[2])}catch{process.exit(1)}' "$1" "$2"
    }

    plist_matches_snapshot() {
      local expected_fingerprint=$1 expected_content=$2
      [[ -f "$PLIST" && ! -L "$PLIST" ]] || return 1
      [[ "$(file_fingerprint "$PLIST")" == "$expected_fingerprint" ]] || return 1
      [[ "$(file_content_signature "$PLIST")" == "$expected_content" ]]
    }

    assert_previous_plist_unchanged() {
      if [[ "$previous_plist_state" == 'absent' ]]; then
        [[ ! -e "$PLIST" && ! -L "$PLIST" ]]
      else
        plist_matches_snapshot "$previous_plist_fingerprint" "$previous_plist_content_signature"
      fi
    }

    install_file_if_absent() {
      local source=$1 destination=$2 staged
      staged=$(mktemp "$(dirname "$destination")/.$LABEL.restore.XXXXXX") || return 1
      if ! cp -p "$source" "$staged" || ! create_hard_link_if_absent "$staged" "$destination"; then
        rm -f "$staged"
        return 1
      fi
      rm -f "$staged"
    }

    resolve_existing_settings_target() {
      if [[ -L "$claude_settings" ]]; then
        command -v realpath >/dev/null 2>&1 || {
          printf 'Cannot safely resolve the Claude settings symlink: realpath is unavailable.\n' >&2
          return 1
        }
        claude_settings_target=$(realpath "$claude_settings" 2>/dev/null) || {
          printf 'Claude settings.json is a dangling or unsafe symlink; refusing to modify it.\n' >&2
          return 1
        }
        [[ -f "$claude_settings_target" && ! -L "$claude_settings_target" ]] || {
          printf 'Claude settings.json symlink does not resolve to a regular file.\n' >&2
          return 1
        }
        claude_settings_kind='symlink'
        claude_settings_link=$(readlink "$claude_settings")
      elif [[ -e "$claude_settings" ]]; then
        [[ -f "$claude_settings" ]] || {
          printf 'Claude settings.json is not a regular file; refusing to modify it.\n' >&2
          return 1
        }
        claude_settings_kind='file'
        claude_settings_target="$claude_settings"
      else
        claude_settings_kind='absent'
        claude_settings_target="$claude_settings"
      fi
    }

    backup_hook_settings() {
      mkdir -p "$(dirname "$claude_settings")"
      resolve_existing_settings_target
      if [[ "$claude_settings_kind" != 'absent' ]]; then
        backup_claude_settings=$(mktemp "$(dirname "$claude_settings_target")/.settings.json.previous.XXXXXX")
        cp -p "$claude_settings_target" "$backup_claude_settings"
        case "$claude_settings_kind" in
          file)
            [[ -f "$claude_settings" && ! -L "$claude_settings" ]] || return 1
            ;;
          symlink)
            [[ -L "$claude_settings" ]] || return 1
            [[ "$(readlink "$claude_settings")" == "$claude_settings_link" ]] || return 1
            [[ "$(realpath "$claude_settings" 2>/dev/null)" == "$claude_settings_target" ]] || return 1
            [[ -f "$claude_settings_target" && ! -L "$claude_settings_target" ]] || return 1
            ;;
        esac
        cmp -s "$claude_settings_target" "$backup_claude_settings" || {
          printf 'Claude settings changed while they were being backed up; refusing to continue.\n' >&2
          return 1
        }
        [[ "$(settings_file_mode "$claude_settings_target")" == "$(settings_file_mode "$backup_claude_settings")" ]] || return 1
      fi
    }

    settings_state_matches_backup() {
      case "$claude_settings_kind" in
        absent)
          [[ ! -e "$claude_settings" && ! -L "$claude_settings" ]]
          ;;
        file)
          [[ -f "$claude_settings" && ! -L "$claude_settings" ]] || return 1
          cmp -s "$claude_settings" "$backup_claude_settings" || return 1
          [[ "$(settings_file_mode "$claude_settings")" == "$(settings_file_mode "$backup_claude_settings")" ]]
          ;;
        symlink)
          [[ -L "$claude_settings" ]] || return 1
          [[ "$(readlink "$claude_settings")" == "$claude_settings_link" ]] || return 1
          [[ -f "$claude_settings_target" && ! -L "$claude_settings_target" ]] || return 1
          cmp -s "$claude_settings_target" "$backup_claude_settings" || return 1
          [[ "$(settings_file_mode "$claude_settings_target")" == "$(settings_file_mode "$backup_claude_settings")" ]]
          ;;
      esac
    }

    reserve_settings_recovery_path() {
      local template=$1
      local recovery_path
      recovery_path=$(mktemp "$template") || return 1
      rm -f "$recovery_path" || return 1
      printf '%s' "$recovery_path"
    }

    preserve_failed_hook_settings() {
      local entry_backup='' target_backup=''
      case "$claude_settings_kind" in
        absent|file)
          if [[ -e "$claude_settings" || -L "$claude_settings" ]]; then
            [[ -f "$claude_settings" || -L "$claude_settings" ]] || return 1
            entry_backup=$(reserve_settings_recovery_path "$(dirname "$claude_settings")/.settings.json.failed-current.XXXXXX") || return 1
            mv "$claude_settings" "$entry_backup" || return 1
          fi
          ;;
        symlink)
          if [[ -e "$claude_settings" || -L "$claude_settings" ]]; then
            [[ -f "$claude_settings" || -L "$claude_settings" ]] || return 1
          fi
          if [[ -e "$claude_settings_target" || -L "$claude_settings_target" ]]; then
            [[ -f "$claude_settings_target" || -L "$claude_settings_target" ]] || return 1
          fi
          if [[ -e "$claude_settings" || -L "$claude_settings" ]]; then
            entry_backup=$(reserve_settings_recovery_path "$(dirname "$claude_settings")/.settings.json.failed-entry.XXXXXX") || return 1
            mv "$claude_settings" "$entry_backup" || return 1
          fi
          if [[ -e "$claude_settings_target" || -L "$claude_settings_target" ]]; then
            target_backup=$(reserve_settings_recovery_path "$(dirname "$claude_settings_target")/.settings.json.failed-target.XXXXXX") || return 1
            mv "$claude_settings_target" "$target_backup" || return 1
          fi
          ;;
      esac

      if [[ -n "$entry_backup" ]]; then
        printf 'Failed hook settings state retained at %s.\n' "$entry_backup" >&2
      fi
      if [[ -n "$target_backup" ]]; then
        printf 'Failed hook settings target retained at %s.\n' "$target_backup" >&2
      fi
    }

    restore_previous_hook_settings() {
      local restore_file
      if settings_state_matches_backup; then
        settings_restore_complete=1
        [[ -z "$backup_claude_settings" ]] || rm -f "$backup_claude_settings"
        backup_claude_settings=""
        return 0
      fi

      preserve_failed_hook_settings || return 1
      case "$claude_settings_kind" in
        absent)
          [[ ! -e "$claude_settings" && ! -L "$claude_settings" ]] || return 1
          ;;
        file|symlink)
          [[ -n "$backup_claude_settings" && -f "$backup_claude_settings" ]] || return 1
          [[ ! -e "$claude_settings_target" && ! -L "$claude_settings_target" ]] || return 1
          restore_file=$(mktemp "$(dirname "$claude_settings_target")/.settings.json.restore.XXXXXX") || return 1
          if ! cp -p "$backup_claude_settings" "$restore_file" || ! create_hard_link_if_absent "$restore_file" "$claude_settings_target"; then
            rm -f "$restore_file"
            return 1
          fi
          rm -f "$restore_file"
          if [[ "$claude_settings_kind" == 'symlink' ]]; then
            if ! create_symlink_if_absent "$claude_settings_link" "$claude_settings"; then
              return 1
            fi
          fi
          ;;
      esac
      settings_restore_complete=1
      [[ -z "$backup_claude_settings" ]] || rm -f "$backup_claude_settings"
      backup_claude_settings=""
    }

    restore_previous_agent() {
      local displaced_plist=''
      local displaced_is_generated=0
      if [[ "$new_agent_bootstrapped" -eq 1 ]]; then
        if ! launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1; then
          if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
            printf 'Failed to unload the new LaunchAgent; leaving its plist in place and retaining the old backup.\n' >&2
            return 1
          fi
        fi
      fi

      # Bash defers signal traps while waiting for an external command. If mv
      # completed just before INT/TERM was handled, the assignment following
      # mv did not run even though the generated plist is already canonical.
      if [[ "$new_plist_replacement_started" -eq 1 && "$new_plist_installed" -eq 0 &&
            -f "$PLIST" && ! -L "$PLIST" &&
            "$(file_content_signature "$PLIST")" == "$new_plist_content_signature" ]]; then
        new_plist_installed=1
      fi

      if [[ "$previous_agent_existed" -eq 1 ]]; then
        [[ -n "$backup_plist" && -f "$backup_plist" ]] || return 1
        if [[ "$new_plist_installed" -eq 1 ]]; then
          [[ -e "$PLIST" || -L "$PLIST" ]] || return 1
          [[ -f "$PLIST" || -L "$PLIST" ]] || return 1
          displaced_plist=$(mktemp "$(dirname "$PLIST")/.$LABEL.failed-new.XXXXXX") || return 1
          rm -f "$displaced_plist"
          mv "$PLIST" "$displaced_plist" || return 1
          if [[ -f "$displaced_plist" && ! -L "$displaced_plist" && "$(file_content_signature "$displaced_plist")" == "$new_plist_content_signature" ]]; then
            displaced_is_generated=1
          else
            printf 'Concurrent LaunchAgent plist retained at %s.\n' "$displaced_plist" >&2
          fi
          install_file_if_absent "$backup_plist" "$PLIST" || return 1
        elif ! assert_previous_plist_unchanged; then
          if [[ "$previous_agent_loaded" -eq 1 ]]; then
            launchctl bootstrap "gui/$(id -u)" "$backup_plist" || return 1
          fi
          printf 'LaunchAgent plist changed during rollback; current file preserved and old backup retained at %s.\n' "$backup_plist" >&2
          return 1
        fi
        if [[ "$previous_agent_loaded" -eq 1 ]]; then
          if ! launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
            printf 'Failed to reload the previous LaunchAgent; backup retained at %s.\n' "$backup_plist" >&2
            return 1
          fi
        fi
      else
        if [[ "$new_plist_installed" -eq 1 ]]; then
          [[ -e "$PLIST" || -L "$PLIST" ]] || return 1
          [[ -f "$PLIST" || -L "$PLIST" ]] || return 1
          displaced_plist=$(mktemp "$(dirname "$PLIST")/.$LABEL.failed-new.XXXXXX") || return 1
          rm -f "$displaced_plist"
          mv "$PLIST" "$displaced_plist" || return 1
          if [[ -f "$displaced_plist" && ! -L "$displaced_plist" && "$(file_content_signature "$displaced_plist")" == "$new_plist_content_signature" ]]; then
            displaced_is_generated=1
          else
            printf 'Concurrent LaunchAgent plist retained at %s.\n' "$displaced_plist" >&2
          fi
        else
          [[ ! -e "$PLIST" && ! -L "$PLIST" ]] || return 1
        fi
      fi

      agent_restore_complete=1
      if [[ "$displaced_is_generated" -eq 1 ]]; then
        rm -f "$displaced_plist"
      fi
      [[ -z "$backup_plist" ]] || rm -f "$backup_plist"
      backup_plist=""
    }

    finish_install_transaction() {
      local status=$?
      local rollback_failed=0
      trap - EXIT INT TERM
      set +e

      if [[ "$status" -ne 0 && "$install_transaction_started" -eq 1 && "$install_committed" -eq 0 ]]; then
        if [[ "$hook_install_started" -eq 1 ]]; then
          restore_previous_hook_settings || {
            rollback_failed=1
            printf 'Failed to restore the previous Claude settings after installation failed.\n' >&2
          }
        fi
        restore_previous_agent || {
          rollback_failed=1
          printf 'Failed to fully restore the previous LaunchAgent after installation failed.\n' >&2
        }
      fi

      cleanup_install_staging

      if [[ "$status" -eq 0 && "$install_committed" -eq 1 ]]; then
        [[ -z "$backup_plist" ]] || rm -f "$backup_plist"
        [[ -z "$backup_claude_settings" ]] || rm -f "$backup_claude_settings"
      elif [[ "$install_transaction_started" -eq 0 ]]; then
        # Nothing user-visible changed, so these are disposable staging copies.
        [[ -z "$backup_plist" ]] || rm -f "$backup_plist"
        [[ -z "$backup_claude_settings" ]] || rm -f "$backup_claude_settings"
      else
        if [[ -n "$backup_plist" && -f "$backup_plist" ]]; then
          printf 'Previous LaunchAgent backup retained at %s.\n' "$backup_plist" >&2
        fi
        if [[ -n "$backup_claude_settings" && -f "$backup_claude_settings" ]]; then
          printf 'Previous Claude settings backup retained at %s.\n' "$backup_claude_settings" >&2
        fi
      fi

      if [[ "$status" -eq 0 && "$rollback_failed" -ne 0 ]]; then
        status=1
      fi
      exit "$status"
    }

    stop_install_on_signal() {
      local status=$1
      trap - INT TERM
      exit "$status"
    }

    trap finish_install_transaction EXIT
    trap 'stop_install_on_signal 130' INT
    trap 'stop_install_on_signal 143' TERM

    # Keep the staging file beside the destination so the final mv is an
    # atomic rename even when the config directory is on another filesystem.
    temporary_plist=$(mktemp "$(dirname "$PLIST")/.$LABEL.plist.tmp.XXXXXX")
    render_plist "$temporary_plist"
    plutil -lint "$temporary_plist" >/dev/null
    new_plist_content_signature=$(file_content_signature "$temporary_plist")
    if [[ -L "$PLIST" ]]; then
      printf 'LaunchAgent plist is a symbolic link; refusing to replace it.\n' >&2
      exit 1
    fi
    if [[ -e "$PLIST" && ! -f "$PLIST" ]]; then
      printf 'LaunchAgent plist is not a regular file; refusing to replace it.\n' >&2
      exit 1
    fi
    if [[ -f "$PLIST" ]]; then
      previous_agent_existed=1
      previous_plist_state='file'
      previous_plist_fingerprint=$(file_fingerprint "$PLIST")
      previous_plist_content_signature=$(file_content_signature "$PLIST")
    fi
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      previous_agent_loaded=1
    fi
    if [[ "$previous_agent_loaded" -eq 1 && "$previous_agent_existed" -eq 0 ]]; then
      printf 'LaunchAgent is loaded but its plist is missing; refusing an update that cannot be rolled back.\n' >&2
      exit 1
    fi
    backup_hook_settings
    assert_previous_plist_unchanged || {
      printf 'LaunchAgent plist changed while installation was being prepared; refusing to continue.\n' >&2
      exit 1
    }
    if [[ "$previous_agent_existed" -eq 1 ]]; then
      backup_plist=$(mktemp "$CONFIG_DIR/$LABEL.plist.previous.XXXXXX")
      cp -p "$PLIST" "$backup_plist"
      assert_previous_plist_unchanged || exit 1
      cmp -s "$PLIST" "$backup_plist" || exit 1
      [[ "$(settings_file_mode "$PLIST")" == "$(settings_file_mode "$backup_plist")" ]] || exit 1
    fi
    assert_previous_plist_unchanged || exit 1
    install_transaction_started=1
    if [[ "$previous_agent_loaded" -eq 1 ]]; then
      launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1
    elif [[ "$previous_agent_existed" -eq 0 ]]; then
      launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
    fi
    assert_previous_plist_unchanged || exit 1
    new_plist_replacement_started=1
    mv "$temporary_plist" "$PLIST"
    temporary_plist=""
    new_plist_installed=1
    new_plist_fingerprint=$(file_fingerprint "$PLIST")
    # A bootstrap can partially load the job before returning non-zero. Mark it
    # first so rollback always issues a matching bootout.
    new_agent_bootstrapped=1
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    hook_install_started=1
    if "$CODE_INSIGHTS_BIN" install-hook; then
      :
    else
      hook_status=$?
      exit "$hook_status"
    fi
    install_committed=1
    printf 'Installed %s (daily at 03:15) and the Claude SessionEnd hook.\n' "$PLIST"
    ;;
  --uninstall)
    [[ $# -eq 1 ]] || { printf 'Usage: %s --uninstall\n' "$0" >&2; exit 64; }
    uninstall_status=0
    if [[ "$(uname -s)" == 'Darwin' ]]; then
      if launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1; then
        :
      else
        bootout_status=$?
        if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
          uninstall_status=$bootout_status
        fi
      fi
    fi
    if [[ "$uninstall_status" -eq 0 ]]; then
      rm -f "$PLIST" || uninstall_status=$?
    fi
    hook_uninstall_status=0
    if [[ -n "$CODE_INSIGHTS_BIN" && -x "$CODE_INSIGHTS_BIN" ]]; then
      if "$CODE_INSIGHTS_BIN" uninstall-hook; then
        :
      else
        hook_uninstall_status=$?
      fi
    else
      printf 'Skipping Claude hook removal: code-insights executable not found.\n' >&2
      hook_uninstall_status=69
    fi
    if [[ "$uninstall_status" -eq 0 && "$hook_uninstall_status" -eq 0 ]]; then
      printf 'Removed %s and the Claude SessionEnd hook.\n' "$LABEL"
    elif [[ "$uninstall_status" -eq 0 ]]; then
      printf 'LaunchAgent was removed, but the Claude hook was not removed.\n' >&2
      exit "$hook_uninstall_status"
    elif [[ "$hook_uninstall_status" -eq 0 ]]; then
      printf 'Claude hook removal completed, but the LaunchAgent plist could not be removed.\n' >&2
      exit "$uninstall_status"
    else
      printf 'Neither the LaunchAgent nor the Claude hook could be fully removed.\n' >&2
      exit "$uninstall_status"
    fi
    ;;
  *)
    printf 'Usage: %s [--install | --uninstall | --render DESTINATION]\n' "$0" >&2
    exit 64
    ;;
esac
