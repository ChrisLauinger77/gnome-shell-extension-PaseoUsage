#!/bin/bash
# Runtime tests for the extension: GNOME Shell suites in headless nested sessions and
# the preferences in plain gjs.
#
# Isolation: the extension is packed into a temporary directory and installed there
# (XDG_DATA_HOME), GSettings use the in-memory backend and every shell runs on its own
# D-Bus session bus. The user's settings, extensions and session are never touched.
# paseo is replaced by tests/fake-paseo.sh, which returns synthetic data.
#
# Requires GNOME Shell 49 or newer (--headless, --virtual-monitor, --automation-script,
# gnome-shell-perf-helper), gjs, libadwaita, glib-compile-schemas, unzip and
# dbus-run-session. The preferences test also needs a Wayland or X11 display.
# Set PASEO_TEST_KEEP=1 to keep the temporary directory with the logs.

tests_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(dirname -- "$tests_dir")
extension="PaseoUsage@lauinger-clan.de"

tmp=$(mktemp -d)
if [[ "${PASEO_TEST_KEEP:-}" == "1" ]]; then
  echo "Logs: $tmp"
else
  trap 'rm -rf -- "$tmp"' EXIT
fi

# Pack like ./paseousage.sh zip, but into the temporary directory.
if ! (cd "$repo_dir/$extension" && gnome-extensions pack --podir=../po/ --out-dir="$tmp" \
  --extra-source=./lib/ --extra-source=./ui/ --extra-source=./icons/ --extra-source=../LICENSE --force) >/dev/null; then
  echo "ERROR: gnome-extensions pack failed" >&2
  exit 1
fi
installed="$tmp/data/gnome-shell/extensions/$extension"
mkdir -p "$installed" "$tmp/config" "$tmp/cache" "$tmp/state" "$tmp/fake"
unzip -q "$tmp/$extension.shell-extension.zip" -d "$installed"
glib-compile-schemas "$installed/schemas"

status=0

# report <name> <log>: passes when every check passed and the log has no JS errors.
report() {
  local name=$1 log=$2 passed failed errors
  passed=$(grep -c "TEST PASS" "$log")
  failed=$(grep -c "TEST FAIL" "$log")
  errors=$(grep -c -E "JS ERROR|JS WARNING|Spurious clutter_actor_allocate" "$log")
  if [[ $failed -eq 0 && $errors -eq 0 ]] && grep -q "TEST RESULT ALL PASSED" "$log"; then
    echo "PASS $name ($passed checks)"
  else
    echo "FAIL $name ($passed passed, $failed failed, $errors JS errors or warnings)"
    grep -E "TEST FAIL|JS ERROR|JS WARNING|Spurious clutter_actor_allocate" "$log" | sed 's/^/    /'
    status=1
  fi
}

# run_shell <suite> <extra environment or -> <gnome-shell arguments...>
run_shell() {
  local suite=$1 extra_env=$2 log="$tmp/shell-$1.log"
  shift 2
  echo 0 >"$tmp/fake/delay"
  echo 2 >"$tmp/fake/providers"
  env -u WAYLAND_DISPLAY -u DISPLAY \
    XDG_DATA_HOME="$tmp/data" XDG_CONFIG_HOME="$tmp/config" XDG_CACHE_HOME="$tmp/cache" XDG_STATE_HOME="$tmp/state" \
    GSETTINGS_BACKEND=memory PASEO_FAKE="$tests_dir/fake-paseo.sh" PASEO_FAKE_DIR="$tmp/fake" TEST_SUITE="$suite" \
    ${extra_env/#-/} \
    dbus-run-session -- timeout 180 gnome-shell --headless --no-x11 --wayland-display="paseo-test-$$" \
    --automation-script="$tests_dir/shell/runtime-test.js" "$@" >"$log" 2>&1
  report "shell/$suite" "$log"
}

run_shell main - --virtual-monitor 1024x768
run_shell narrow - --virtual-monitor 800x600
run_shell monitors - --virtual-monitor 1600x900 --virtual-monitor 800x600
run_shell rtl CLUTTER_TEXT_DIRECTION=rtl --virtual-monitor 1024x768

if [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]]; then
  # The preferences import GNOME Shell's private Shew library.
  shew=$(find /usr/lib /usr/lib64 -name "Shew-0.typelib" -path "*gnome-shell*" 2>/dev/null | head -n 1)
  GSETTINGS_BACKEND=memory GI_TYPELIB_PATH="$(dirname -- "$shew")" LD_LIBRARY_PATH="$(dirname -- "$(dirname -- "$shew")")" \
    timeout 60 gjs -m "$tests_dir/prefs/prefs-test.js" "$installed" >"$tmp/prefs.log" 2>&1
  report "prefs" "$tmp/prefs.log"
else
  echo "SKIP prefs (no display)"
fi

exit $status
