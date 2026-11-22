"use strict";

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";
import { ExtensionPreferences, gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { fetchVersion, isCancelledError, PaseoErrorCode } from "./lib/paseoClient.js";

const PANEL_DISPLAY_MODES = ["icon", "percent", "bars"];
// Physical sides: the extension maps them to the panel boxes, which GNOME Shell
// mirrors in right-to-left sessions.
const PANEL_POSITIONS = ["left", "center", "right"];

export default class AdwPrefs extends ExtensionPreferences {
    _setupExecutable(window, builder, settings, cancellable) {
        const entryRow = builder.get_object("PaseoUsage_row_executable");
        const selectButton = builder.get_object("PaseoUsage_button_executableselect");
        const statusRow = builder.get_object("PaseoUsage_row_status");
        let checkSerial = 0;

        const checkExecutable = async () => {
            const serial = ++checkSerial;
            const executable = settings.get_string("paseo-executable");
            statusRow.subtitle = _("Checking…");
            let status;
            try {
                const version = await fetchVersion(executable, cancellable, { timeoutSeconds: 10 });
                /* Translators: %s is the version of the paseo command line tool */
                status = _("paseo %s found").format(version);
            } catch (error) {
                if (isCancelledError(error)) {
                    return;
                }
                status =
                    error?.code === PaseoErrorCode.NOT_FOUND
                        ? _("Not found or not executable")
                        : error?.detail || _("The paseo command failed");
            }
            if (serial === checkSerial && !cancellable.is_cancelled()) {
                statusRow.subtitle = status;
            }
        };

        const syncEntry = () => {
            entryRow.text = settings.get_string("paseo-executable");
            checkExecutable().catch((error) => console.error(error));
        };

        // Also covers the file chooser button inside the row.
        settings.bind_writable("paseo-executable", entryRow, "sensitive", false);
        entryRow.connect("apply", () => {
            const path = entryRow.text.trim();
            if (!path || !settings.set_string("paseo-executable", path)) {
                syncEntry();
            }
        });

        selectButton.connect("clicked", () => {
            const dialog = new Gtk.FileDialog({ title: _("Select the paseo executable"), modal: true });
            const current = Gio.File.new_for_path(settings.get_string("paseo-executable"));
            const folder = current.get_parent();
            if (folder?.query_exists(null)) {
                dialog.set_initial_folder(folder);
            }
            dialog.open(window, cancellable, (fileDialog, result) => {
                try {
                    const path = fileDialog.open_finish(result)?.get_path();
                    if (path) {
                        settings.set_string("paseo-executable", path);
                    }
                } catch (error) {
                    if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) && !isCancelledError(error)) {
                        console.error(error);
                    }
                }
            });
        });

        syncEntry();
        return settings.connect("changed::paseo-executable", syncEntry);
    }

    // Syncs a combo row with a string key whose schema choices are `values`, in the
    // same order as the row items. `unsetValue` is shown while the key has no user
    // value. A locked key makes the row insensitive.
    _bindComboRow(builder, settings, rowId, key, values, unsetValue = null) {
        const comboRow = builder.get_object(rowId);
        let syncing = false;
        const syncCombo = () => {
            const unset = unsetValue !== null && settings.get_user_value(key) === null;
            syncing = true;
            comboRow.selected = Math.max(values.indexOf(unset ? unsetValue : settings.get_string(key)), 0);
            syncing = false;
        };
        settings.bind_writable(key, comboRow, "sensitive", false);
        // Only a selection by the user is written, also when it matches the stored value.
        comboRow.connect("notify::selected", () => {
            const value = values[comboRow.selected];
            if (!syncing && value && !settings.set_string(key, value)) {
                syncCombo();
            }
        });
        syncCombo();
        return settings.connect(`changed::${key}`, syncCombo);
    }

    fillPreferencesWindow(window) {
        window.search_enabled = true;
        window._settings = this.getSettings();
        const settings = window._settings;
        const cancellable = new Gio.Cancellable();

        const builder = Gtk.Builder.new();
        builder.add_from_file(GLib.build_filenamev([this.path, "ui", "prefs.ui"]));
        window.add(builder.get_object("PaseoUsage_page_general"));
        window.set_default_size(640, 700);

        const settingSignals = [
            this._setupExecutable(window, builder, settings, cancellable),
            this._bindComboRow(builder, settings, "PaseoUsage_row_paneldisplay", "panel-display", PANEL_DISPLAY_MODES),
            // Until a position is chosen, the extension keeps GNOME Shell's default box,
            // which is on the left in right-to-left sessions.
            this._bindComboRow(
                builder,
                settings,
                "PaseoUsage_row_panelposition",
                "panel-position",
                PANEL_POSITIONS,
                Gtk.Widget.get_default_direction() === Gtk.TextDirection.RTL ? "left" : "right"
            ),
        ];
        settings.bind(
            "refresh-interval",
            builder.get_object("PaseoUsage_row_refreshinterval"),
            "value",
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind("use-logging", builder.get_object("PaseoUsage_row_logging"), "active", Gio.SettingsBindFlags.DEFAULT);

        window.connect("close-request", () => {
            cancellable.cancel();
            for (const id of settingSignals) {
                settings.disconnect(id);
            }
            return false;
        });
    }
}
