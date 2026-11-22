"use strict";

import GLib from "gi://GLib";
import Gio from "gi://Gio";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension, gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import { formatClientError, newestSuccess } from "./lib/format.js";
import { PaseoUsageIndicator } from "./lib/indicator.js";
import { fetchUsage, isCancelledError, PaseoErrorCode } from "./lib/paseoClient.js";

// A right click only refreshes when the last successful refresh is older than this.
const STALE_AFTER_MS = 60 * 1000;

// Panel box and index for each `panel-position` value: after the Activities
// button in the left box, before the clock in the center box, before the system
// menu in the right box (an index of -1 appends to the box). The values are the
// panel box names: GNOME Shell shows the left box on the right in right-to-left
// languages, and the preferences label the choices by the side they appear on.
//
// The panel gives the center box its full preferred width and only the rest to the
// side boxes, so in the center the button is limited to a third of the panel width
// to keep Activities and Quick Settings visible. The side boxes are limited anyway.
const PANEL_POSITIONS = {
    left: { box: "left", index: -1 },
    center: { box: "center", index: 0, maxWidthFraction: 1 / 3 },
    right: { box: "right", index: 0 },
};

export default class PaseoUsage extends Extension {
    _logOutput(text) {
        if (this._useLogging) {
            this.getLogger().log(text);
        }
    }

    _isCancelled(cancellable) {
        return cancellable !== this._cancellable || cancellable.is_cancelled();
    }

    _setState(changes) {
        Object.assign(this._state, changes);
        // Rendering works on data from an external tool. A rendering problem must never
        // stop the refresh cycle, otherwise even valid output could not recover the UI.
        try {
            this._indicator.update(this._state);
        } catch (error) {
            this.getLogger().error(`Rendering usage failed: ${error}`);
        }
    }

    refresh({ force = false } = {}) {
        if (this._activeRequest) {
            // The running request cannot satisfy this one: run again once it finished.
            const executable = this._settings.get_string("paseo-executable");
            if ((force && !this._activeRequest.force) || executable !== this._activeRequest.executable) {
                this._queuedRefresh = { force: force || Boolean(this._queuedRefresh?.force) };
            }
            return;
        }

        const cancellable = this._cancellable;
        const request = { force, executable: this._settings.get_string("paseo-executable") };
        this._activeRequest = request;
        this._doRefresh(request, cancellable)
            .catch((error) => this.getLogger().error(`Refreshing usage failed: ${error}`))
            .finally(() => {
                if (this._isCancelled(cancellable)) {
                    return;
                }
                this._activeRequest = null;
                const queued = this._queuedRefresh;
                this._queuedRefresh = null;
                if (queued) {
                    this.refresh(queued);
                } else if (this._state.refreshing) {
                    this._setState({ refreshing: false });
                }
            });
    }

    refreshIfStale() {
        if (Date.now() - this._state.lastSuccess > STALE_AFTER_MS) {
            this.refresh({ force: true });
        }
    }

    _isOutdated(request, cancellable) {
        return (
            this._isCancelled(cancellable) || request.executable !== this._settings.get_string("paseo-executable")
        );
    }

    async _doRefresh(request, cancellable) {
        const { force, executable } = request;
        this._setState({ refreshing: true });
        this._logOutput(`Running ${executable} usage --json${force ? " --refresh" : ""}`);

        let entries;
        try {
            entries = await fetchUsage(executable, cancellable, {
                refresh: force,
                subprocesses: this._subprocesses,
            });
        } catch (error) {
            // Results for a changed executable are dropped, a queued refresh follows.
            if (isCancelledError(error) || this._isOutdated(request, cancellable)) {
                return;
            }
            const message = formatClientError(error, executable);
            // Avoid flooding the journal when the same problem repeats on every timer tick.
            if (message !== this._state.error?.message) {
                this.getLogger().warn(`paseo usage failed: ${message}`);
            }
            const hint = error?.code === PaseoErrorCode.NOT_FOUND ? _("Check the paseo executable in the preferences.") : null;
            this._setState({ error: { message, hint }, refreshing: false });
            return;
        }

        if (this._isOutdated(request, cancellable)) {
            return;
        }
        this._logOutput(`Received ${entries.length} usage report(s)`);
        this._setState({
            entries,
            error: null,
            refreshing: false,
            // Only real provider successes count; an empty list is a successful call with nothing to show.
            lastSuccess: entries.length === 0 ? Date.now() : newestSuccess(entries),
        });
    }

    _addIndicator() {
        const { box, index, maxWidthFraction } =
            PANEL_POSITIONS[this._settings.get_string("panel-position")] ?? PANEL_POSITIONS.right;
        this._indicator = new PaseoUsageIndicator(this, this._settings, { maxWidthFraction });
        Main.panel.addToStatusArea(this.uuid, this._indicator, index, box);
    }

    // Destroying the indicator also removes it from Main.panel.statusArea, so it can
    // be added again right away in the new panel box.
    _moveIndicator() {
        this._indicator.destroy();
        this._addIndicator();
        this._setState({});
    }

    _startRefreshTimer() {
        this._stopRefreshTimer();
        const minutes = this._settings.get_int("refresh-interval");
        if (minutes <= 0) {
            this._logOutput("Automatic refresh is off");
            return;
        }
        this._refreshTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this.refresh({ force: true });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopRefreshTimer() {
        if (this._refreshTimerId) {
            GLib.Source.remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
    }

    enable() {
        this._settings = this.getSettings();
        this._useLogging = this._settings.get_boolean("use-logging");
        this._cancellable = new Gio.Cancellable();
        this._subprocesses = new Set();
        this._activeRequest = null;
        this._queuedRefresh = null;
        this._refreshTimerId = 0;
        this._state = { entries: null, error: null, refreshing: false, lastSuccess: 0 };

        this._addIndicator();

        const settingsToMonitor = [
            { key: "paseo-executable", callback: () => this.refresh({ force: false }) },
            { key: "refresh-interval", callback: () => this._startRefreshTimer() },
            { key: "panel-display", callback: () => this._indicator.updatePanel() },
            { key: "panel-position", callback: () => this._moveIndicator() },
            {
                key: "use-logging",
                callback: () => {
                    this._useLogging = this._settings.get_boolean("use-logging");
                },
            },
        ];
        this._settingSignals = settingsToMonitor.map(({ key, callback }) =>
            this._settings.connect(`changed::${key}`, callback)
        );

        // Start with the daemon cache so logging in does not hit every provider at once.
        this.refresh({ force: false });
        this._startRefreshTimer();
    }

    disable() {
        this._cancellable.cancel();
        for (const proc of this._subprocesses) {
            proc.force_exit();
        }
        this._subprocesses.clear();
        this._stopRefreshTimer();
        for (const id of this._settingSignals) {
            this._settings.disconnect(id);
        }
        this._indicator.destroy();

        this._indicator = null;
        this._settingSignals = null;
        this._settings = null;
        this._cancellable = null;
        this._subprocesses = null;
        this._activeRequest = null;
        this._queuedRefresh = null;
        this._state = null;
    }
}
