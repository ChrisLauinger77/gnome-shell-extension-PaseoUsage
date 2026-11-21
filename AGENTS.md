# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

This repository contains the GNOME Shell extension `PaseoUsage@lauinger-clan.de`.
It visualizes the plan usage of coding agents (session and weekly limits,
credits) by calling the [Paseo](https://github.com/getpaseo/paseo) command-line
tool with `paseo usage --json`.

The `shell-version` entries in `PaseoUsage@lauinger-clan.de/metadata.json`,
which holds the public extension metadata, declare the GNOME Shell versions
supported by the current extension release only (currently 49, 50 and 51).

The GNOME Shell compatibility badge in `README.md` is broader: it shows every
GNOME Shell major version supported across all PaseoUsage releases. When
updating the badge, include GNOME versions supported by older extension
releases, even if they are no longer in the current release's `shell-version`
list.

## Important Files

- `PaseoUsage@lauinger-clan.de/extension.js`: extension entry point. Owns the
  settings, the refresh state, the deduplicated async refresh, the refresh
  timer, and enable/disable cleanup.
- `PaseoUsage@lauinger-clan.de/lib/paseoClient.js`: runs `paseo` asynchronously
  with `Gio.Subprocess`, handles timeouts and cancellation, and parses the JSON
  output. It only imports GLib/Gio so it can be used by `prefs.js` and tested
  with plain `gjs`.
- `PaseoUsage@lauinger-clan.de/lib/format.js`: translated formatting helpers
  (percentages, durations, reset times, problems, retained reports).
- `PaseoUsage@lauinger-clan.de/lib/indicator.js`: the `PanelMenu.Button`, its
  panel summary, the click gestures, and popup rendering.
- `PaseoUsage@lauinger-clan.de/lib/usageView.js`: popup widgets (header,
  provider cards, messages, provider icons).
- `PaseoUsage@lauinger-clan.de/prefs.js`: preferences window logic using
  Gtk/Adwaita APIs and `Gtk.Builder`.
- `PaseoUsage@lauinger-clan.de/ui/prefs.ui`: preferences UI definition.
- `PaseoUsage@lauinger-clan.de/schemas/org.gnome.shell.extensions.PaseoUsage.gschema.xml`:
  GSettings schema and defaults.
- `PaseoUsage@lauinger-clan.de/stylesheet.css`: popup and panel styling,
  including all `-barlevel-*` properties used by the usage bars.
- `PaseoUsage@lauinger-clan.de/icons/paseo-usage-symbolic.svg`: panel icon. It
  must only use fills, because GNOME Shell does not recolor strokes in symbolic
  icons.
- `po/*.po` and `po/PaseoUsage.pot`: gettext translation files.
- `paseousage.sh`: helper script for packaging, installing, uploading,
  refreshing translations, and keeping versions in sync.
- `.githooks/`: optional Git hooks that check or sync the `package.json`
  version against `metadata.json`.
- `eslint.config.js`: ESLint flat config for GJS/GNOME Shell globals.
- `.github/workflows/eslint.yml`: CI version consistency check, ESLint scan,
  and Shexli scan.
- `.github/workflows/release.yml`: release packaging and EGO upload workflow.

## Useful Commands

Run from the repository root unless noted otherwise.

```bash
./paseousage.sh install-dependencies
npm run lint
./paseousage.sh zip
./paseousage.sh install
./paseousage.sh translate
./paseousage.sh check-version
./paseousage.sh update-version
./paseousage.sh setup-hooks
./paseousage.sh cleanup
```

Run `./paseousage.sh install-dependencies` after pulling or rebasing remote
changes that modify `package-lock.json`, particularly Renovate updates.

Notes:

- `npm run lint` is the main automated local check.
- `./paseousage.sh zip` calls `gnome-extensions pack` and writes
  `PaseoUsage@lauinger-clan.de.shell-extension.zip` in the repository root. It
  includes `lib/`, `ui/`, `icons/` and `LICENSE` as extra sources.
- `./paseousage.sh install` builds the zip if needed, installs it with
  `gnome-extensions install --force`, and enables the extension.
- `./paseousage.sh translate` updates `po/PaseoUsage.pot` (including
  `Translators:` comments) and merges existing `po/*.po` files. Run it after
  changing translatable strings.
- `./paseousage.sh check-version` verifies that the `package.json` version
  matches `version-name` in `metadata.json` (normalized to `x.y.z`).
  `update-version` updates `package.json` and `package-lock.json` to match.
  CI runs `check-version`, and the pre-commit hook enabled by `setup-hooks`
  blocks commits with mismatched staged versions. Requires `jq`.
- `./paseousage.sh cleanup` removes the generated extension zip.
- `./paseousage.sh upload` uploads to extensions.gnome.org with the
  maintainer's local credentials. Do not run it from an agent.
- There is currently no real test suite. `npm test` intentionally exits with an
  error.

## Code Style

- Use ES modules and modern GJS imports, matching the existing files.
- Keep JavaScript indentation at 4 spaces. Other files default to 2 spaces via
  `.editorconfig`. Use double quotes.
- Use `const` by default and `let` only when reassignment is needed.
- Keep user-visible strings wrapped in `_()` / `ngettext()` so gettext can
  extract them. Do not call `_()` at module level: the translation domain is
  only bound when the extension object is created.
- Prefer the extension logger (`this.getLogger()`) or `console.*` over GNOME's
  old `log()` / `logError()` globals. ESLint forbids the old globals.
- Avoid adding dependencies unless there is a clear repository-level reason.

## Runtime Architecture Notes

- `paseo` is only ever run asynchronously through `lib/paseoClient.js`
  (`Gio.Subprocess` + `communicate_utf8_async`) with a timeout. Never use
  synchronous spawning in the shell process.
- `enable()` initializes settings, a `Gio.Cancellable`, the subprocess set and
  the indicator, starts an initial refresh from the Paseo daemon cache (no
  `--refresh`), and starts the refresh timer (`refresh-interval` minutes, 0 is
  off). Timer refreshes use `--refresh`.
- `disable()` must cancel the cancellable, force-exit running subprocesses,
  remove GLib sources, disconnect settings signals, destroy the indicator, and
  clear references. It must stay synchronous (GNOME 51 rejects async disable).
- Only one paseo request runs at a time. A refresh requested while one runs is
  queued when the running request cannot satisfy it (it is a cache read but a
  forced refresh was requested, or the executable setting changed). Results of
  a request whose executable changed meanwhile are discarded. After every
  `await`, `_isCancelled(cancellable)` guards against a disable/enable cycle.
- `lib/paseoClient.js` normalizes the JSON (known fields only, checked types,
  arrays filtered to objects). Rendering never sees raw paseo output, and a
  rendering exception is logged in `_setState()` so it can not stop the
  refresh cycle.
- `lastSuccess` is the newest provider `successfulAt` (or retained
  `lastSuccessful.fetchedAt`). A response where every provider failed does not
  count as a successful refresh, so right click retries immediately.
- Clicks on the panel button:
  - left click toggles the popup only;
  - right click toggles the popup and, when opening, refreshes with
    `--refresh` if the last successful refresh is older than 60 seconds;
  - middle click closes the popup and opens the preferences.
  - GNOME 50+ uses the private `PanelMenu.Button._clickGesture` (restricted to
    the primary button). GNOME 49 has no such gesture and toggles the menu in
    `vfunc_event`, which the indicator filters. Do not chain up to
    `vfunc_event` on GNOME 50+, it is not implemented there and throws.
- On a failed refresh the previous data is kept and an error banner is shown.
  Reports with `status` `unavailable`/`error` fall back to `lastSuccessful`,
  like the Paseo app.
- Provider icons arrive as inline SVG with `fill="currentColor"`; the
  `ProviderIcon` widget substitutes the theme foreground color and uses a
  `Gio.BytesIcon`.
- While the popup is open, a 60 second tick re-renders the relative times.
- The provider cards live in an `St.ScrollView` below the fixed header.
  `PanelMenu.Button._onOpenStateChanged` caps the menu with `max-height`,
  which makes the cards scroll. Never define a method with that name (or other
  private `PanelMenu.Button`/`PopupMenu` names) in the indicator: it would
  silently replace the parent logic.

## Settings And UI Changes

When adding or changing a setting, update all relevant places:

1. Add or modify the key in
   `PaseoUsage@lauinger-clan.de/schemas/org.gnome.shell.extensions.PaseoUsage.gschema.xml`.
2. Wire the setting in `extension.js` (and `lib/indicator.js`) if it affects
   runtime behavior.
3. Wire the setting in `prefs.js` and `ui/prefs.ui` if it should be configurable.
4. Include any user-visible labels/descriptions in gettext extraction by running
   `./paseousage.sh translate`.

Be careful that GSettings key names in the JavaScript files and the schema
match exactly.

## Validation Checklist

Before finishing changes, run the validations that match the edit:

- JavaScript changes: `npm run lint`.
- Subprocess or parsing changes: exercise `lib/paseoClient.js` with plain
  `gjs -m` against the real `paseo` binary and simulated failures (missing
  executable, daemon not running via `--home /nonexistent`, timeout, invalid
  output).
- Schema, metadata, packaging, icon, UI, or translation changes:
  `./paseousage.sh zip`.
- User-visible strings: `./paseousage.sh translate`.
- Runtime behavior: load the extension in GNOME Shell and check the panel
  label in all display modes, left/right/middle clicks, the popup, and the
  preferences window.
- Submission-oriented changes: use `$review-gnome-shell-extension` to check
  lifecycle cleanup, process boundaries, metadata, schemas, subprocesses,
  privacy, maintainability, and packaging requirements.

If a required GNOME, Paseo, or gettext command is unavailable in the
environment, state that clearly in the final response.

## Packaging And Release

- Release builds are produced by `./paseousage.sh zip`.
- Bump `version-name` in `metadata.json` and run
  `./paseousage.sh update-version` so `package.json` stays in sync.
- GitHub releases run on `v*` tags, build the extension zip, create a GitHub
  release, and upload to extensions.gnome.org using repository secrets. A
  manual `workflow_dispatch` run builds the zip as an artifact and uploads to
  EGO only when requested.
- Do not commit generated `.zip`, `.mo`, `*.po~`, or
  `schemas/gschemas.compiled` files. They are ignored.

## Manual Testing Tips

- After installing, restart GNOME Shell as appropriate for the session type
  (log out and in on Wayland), or test in a nested session with
  `dbus-run-session -- gnome-shell --devkit`.
- Enable logging in the extension preferences, then watch logs with:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

- The Paseo daemon must be running for `paseo usage --json` to succeed;
  otherwise the popup shows the `DAEMON_NOT_RUNNING` message from paseo.
- The default executable path is `/usr/local/bin/paseo`, configurable in
  preferences.
- `paseo usage --json` output contains account e-mail addresses. Do not commit
  screenshots or fixtures containing real account data.

## Agent-Specific Cautions

- Do not assume a Paseo daemon or GNOME Shell session is available in the
  coding environment. Prefer linting and packaging checks when runtime testing
  is not possible.
- Use `$review-gnome-shell-extension` when changing runtime, preferences,
  metadata, schema, packaging, or user-data behavior that may affect
  extensions.gnome.org review.
- Preserve translation files unless a string/schema/UI change requires updating
  them.
- Keep generated release artifacts out of commits.
- This repo may have user changes in progress. Check `git status --short` before
  editing and do not revert unrelated work.
