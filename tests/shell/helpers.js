// Helpers for the GNOME Shell runtime tests (see tests/run.sh).
/* eslint-disable no-await-in-loop */

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as Scripting from "resource:///org/gnome/shell/ui/scripting.js";

export const UUID = "PaseoUsage@lauinger-clan.de";
const FAKE = GLib.getenv("PASEO_FAKE");
const FAKE_DIR = GLib.getenv("PASEO_FAKE_DIR");

let failures = 0;

export function log(text) {
    printerr(`TEST ${text}`);
}

export function check(label, ok) {
    log(`${ok ? "PASS" : "FAIL"} ${label}`);
    if (!ok) {
        failures++;
    }
    return ok;
}

export function finish() {
    log(failures ? `RESULT ${failures} FAILED` : "RESULT ALL PASSED");
}

export const sleep = (ms) => Scripting.sleep(ms);

export async function waitFor(condition, ms = 10000) {
    const end = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > end) {
            return false;
        }
        await Scripting.sleep(50);
    }
    return true;
}

export function writeFake(name, value) {
    GLib.file_set_contents(`${FAKE_DIR}/${name}`, String(value));
}

// The extension object and its live indicator.
export const extension = () => Main.extensionManager.lookup(UUID)?.stateObj;
export const indicator = () => extension()?._indicator;

export function panelBoxes() {
    const [left, center, right] = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
    return { left, center, right };
}

// Horizontal stage coordinates of an actor.
export function span(actor) {
    const [x] = actor.get_transformed_position();
    const [width] = actor.get_transformed_size();
    return { x1: Math.round(x), x2: Math.round(x + width) };
}

export function noWelcomeDialog() {
    new Gio.Settings({ schema_id: "org.gnome.shell" }).set_string("welcome-dialog-last-shown-version", "999");
}

// Hides the startup overview and enables the extension with the fake paseo. The
// settings use the in-memory backend of the test session.
export async function start() {
    Main.overview.hide();
    check("overview hidden, no modal grab", await waitFor(() => !Main.overview.visible && Main.modalCount === 0));
    const ext = Main.extensionManager.lookup(UUID);
    check("extension found", Boolean(ext));
    const source = Gio.SettingsSchemaSource.new_from_directory(
        ext.dir.get_child("schemas").get_path(),
        Gio.SettingsSchemaSource.get_default(),
        false
    );
    const settings = new Gio.Settings({
        settings_schema: source.lookup("org.gnome.shell.extensions.PaseoUsage", false),
    });
    settings.set_string("paseo-executable", FAKE);
    settings.set_int("refresh-interval", 0);
    Main.extensionManager.enableExtension(UUID);
    check("extension enabled", await waitFor(() => indicator()));
    check("initial refresh done", await waitFor(() => extension()._state?.entries && !extension()._activeRequest));
}

export async function stop() {
    Main.extensionManager.disableExtension(UUID);
    check("disabled: indicator removed", await waitFor(() => !Main.panel.statusArea[UUID] && !indicator()));
}

export async function showProviders(count, display = "bars") {
    writeFake("delay", 0);
    writeFake("providers", count);
    extension()._settings.set_string("panel-display", display);
    extension().refresh({ force: true });
    const ok = await waitFor(() => !extension()._activeRequest && extension()._state.entries?.length === count);
    await sleep(400);
    return ok;
}

// Plain status indicators like the ones other extensions add to the right box.
export function addDummyIndicators(prefix, count) {
    const buttons = [];
    for (let i = 0; i < count; i++) {
        const button = new PanelMenu.Button(0.5, `${prefix}${i}`, true);
        button.add_child(new St.Icon({ icon_name: "dialog-information-symbolic", style_class: "system-status-icon" }));
        Main.panel.addToStatusArea(`${prefix}${i}`, button);
        buttons.push(button);
    }
    return buttons;
}

function callDisplayConfig(method, params) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            "org.gnome.Mutter.DisplayConfig",
            "/org/gnome/Mutter/DisplayConfig",
            "org.gnome.Mutter.DisplayConfig",
            method,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

// Makes the monitor with the given width primary through Mutter's DisplayConfig
// D-Bus API (asynchronously: the service runs in this process).
export async function setPrimaryByWidth(width) {
    const [serial, monitors, logicalMonitors] = (await callDisplayConfig("GetCurrentState", null)).deep_unpack();
    const currentMode = new Map();
    const modeWidth = new Map();
    for (const [spec, modes] of monitors) {
        for (const [id, modeW, , , , , props] of modes) {
            if (props["is-current"]?.deep_unpack()) {
                currentMode.set(spec[0], id);
                modeWidth.set(spec[0], modeW);
            }
        }
    }
    const config = logicalMonitors.map(([x, y, scale, transform, , specs]) => {
        const connector = specs[0][0];
        return new GLib.Variant("(iiduba(ssa{sv}))", [
            x,
            y,
            scale,
            transform,
            modeWidth.get(connector) === width,
            [[connector, currentMode.get(connector), {}]],
        ]);
    });
    await callDisplayConfig(
        "ApplyMonitorsConfig",
        GLib.Variant.new_tuple([
            GLib.Variant.new_uint32(serial),
            GLib.Variant.new_uint32(1),
            GLib.Variant.new_array(new GLib.VariantType("(iiduba(ssa{sv}))"), config),
            new GLib.Variant("a{sv}", {}),
        ])
    );
    return waitFor(() => Main.layoutManager.primaryMonitor?.width === width);
}
