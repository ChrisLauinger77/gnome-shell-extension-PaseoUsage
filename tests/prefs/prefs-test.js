// Runs the real prefs.js in plain gjs with in-memory and read-only (locked) settings,
// in left-to-right and right-to-left GTK sessions. Run through tests/run.sh.
// Arguments: the installed extension directory (inside a gnome-shell/extensions/
// directory, which the gettext helpers of GNOME Shell require).
/* eslint-disable no-await-in-loop */

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";

for (const file of ["org.gnome.Shell.Extensions.src.gresource", "gnome-shell-dbus-interfaces.gresource"]) {
    Gio.resources_register(Gio.Resource.load(`/usr/share/gnome-shell/${file}`));
}
Adw.init();

const extensionDir = ARGV[0];
const { ExtensionPreferences } = await import("resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js");
const { default: Preferences } = await import(`file://${extensionDir}/prefs.js`);
const metadata = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${extensionDir}/metadata.json`)[1]));
const schema = Gio.SettingsSchemaSource.new_from_directory(`${extensionDir}/schemas`, null, false).lookup(
    metadata["settings-schema"],
    false
);

let failures = 0;
function check(label, ok) {
    print(`TEST ${ok ? "PASS" : "FAIL"} ${label}`);
    if (!ok) {
        failures++;
    }
}

async function openWindow(backend, direction) {
    Gtk.Widget.set_default_direction(direction);
    const prefs = new Preferences({ ...metadata, dir: Gio.File.new_for_path(extensionDir), path: extensionDir });
    ExtensionPreferences.lookupByUUID = () => prefs;
    const settings = new Gio.Settings({ settings_schema: schema, backend });
    prefs.getSettings = () => settings;
    const window = new Adw.PreferencesWindow();
    await prefs.fillPreferencesWindow(window);
    // By the ids in ui/prefs.ui: the titles are translated.
    const find = (id) => {
        const stack = [window];
        while (stack.length) {
            const widget = stack.pop();
            if (widget.get_buildable_id() === id) {
                return widget;
            }
            for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
                stack.push(child);
            }
        }
        return null;
    };
    return {
        settings,
        position: find("PaseoUsage_row_panelposition"),
        display: find("PaseoUsage_row_paneldisplay"),
        executable: find("PaseoUsage_row_executable"),
    };
}

// Locked keys.
{
    const { settings, position, display, executable } = await openWindow(
        Gio.null_settings_backend_new(),
        Gtk.TextDirection.LTR
    );
    check("locked: rows insensitive", !position.sensitive && !display.sensitive && !executable.sensitive);
    position.selected = 0;
    check(`locked: rejected position restored (selected ${position.selected})`, position.selected === 2);
    executable.text = "/tmp/elsewhere";
    executable.emit("apply");
    check(`locked: rejected executable restored (${executable.text})`, executable.text === "/usr/local/bin/paseo");
    check("locked: nothing stored", settings.get_string("panel-position") === "right");
}

// Never chosen position: shown as the side of GNOME Shell's default box, nothing written.
for (const [name, direction, unsetRow, otherRow, otherValue] of [
    ["ltr", Gtk.TextDirection.LTR, 2, 0, "left"],
    ["rtl", Gtk.TextDirection.RTL, 0, 2, "right"],
]) {
    const { settings, position } = await openWindow(Gio.memory_settings_backend_new(), direction);
    check(`${name}: row sensitive`, position.sensitive);
    check(`${name}: never chosen shows row ${unsetRow} (selected ${position.selected})`, position.selected === unsetRow);
    check(`${name}: opening the window writes nothing`, settings.get_user_value("panel-position") === null);
    position.selected = otherRow;
    check(
        `${name}: choosing row ${otherRow} stores ${settings.get_string("panel-position")}`,
        settings.get_string("panel-position") === otherValue && settings.get_user_value("panel-position") !== null
    );
    position.selected = 1;
    check(`${name}: Center stores center`, settings.get_string("panel-position") === "center");
    settings.reset("panel-position");
    check(`${name}: reset shows row ${unsetRow} again (selected ${position.selected})`, position.selected === unsetRow);
    check(`${name}: reset writes nothing`, settings.get_user_value("panel-position") === null);
}

print(failures ? `TEST RESULT ${failures} FAILED` : "TEST RESULT ALL PASSED");
