// GNOME Shell --automation-script with runtime checks for the panel button: placement,
// moves while the popup is open, the width in crowded panels, monitor changes and
// right-to-left sessions. Run through tests/run.sh, which selects the suite with
// TEST_SUITE and starts the matching virtual monitors.
/* eslint-disable no-await-in-loop */

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { PopupAnimation } from "resource:///org/gnome/shell/ui/boxpointer.js";

import * as T from "./helpers.js";

// Required by the automation script runner.
export const METRICS = {};

export function init() {
    T.noWelcomeDialog();
}

export async function run() {
    const suites = { main, narrow, monitors, rtl };
    const suite = suites[GLib.getenv("TEST_SUITE")];
    try {
        T.check(`suite ${GLib.getenv("TEST_SUITE")} exists`, Boolean(suite));
        await T.start();
        await suite();
        await T.stop();
    } catch (error) {
        T.check(`no exception: ${error}\n${error.stack}`, false);
    }
    T.finish();
}

const settings = () => T.extension()._settings;

function countIndicators() {
    const Indicator = T.indicator().constructor;
    return Object.values(T.panelBoxes())
        .flatMap((box) => box.get_children())
        .filter((container) => container.child instanceof Indicator).length;
}

function where() {
    const container = T.indicator().container;
    const parent = container.get_parent();
    const boxes = T.panelBoxes();
    const name = Object.keys(boxes).find((key) => boxes[key] === parent) ?? "none";
    const index = parent ? parent.get_children().indexOf(container) : -1;
    const last = parent ? parent.get_n_children() - 1 : -1;
    return { name, index, last, text: `box=${name} index=${index}/${last}` };
}

function physicalSide() {
    const s = T.span(T.indicator());
    const middle = (s.x1 + s.x2) / 2;
    const width = Main.panel.width;
    if (middle < width / 3) {
        return "left";
    }
    return middle > (2 * width) / 3 ? "right" : "center";
}

function checkNaturalWidth(name) {
    const container = Main.panel.statusArea[name].container;
    const natural = container.get_preferred_width(-1)[1];
    T.check(`${name} keeps its natural width (${container.width} of ${natural})`, container.width >= natural - 1);
}

function checkOnScreen(name) {
    const s = T.span(Main.panel.statusArea[name].container);
    const panel = T.span(Main.panel);
    T.check(`${name} fully on screen (${s.x1}-${s.x2} in ${panel.x1}-${panel.x2})`, s.x1 >= panel.x1 - 1 && s.x2 <= panel.x2 + 1);
}

function checkBoxesApart(label) {
    const { left, center, right } = T.panelBoxes();
    const [l, c, r] = [T.span(left), T.span(center), T.span(right)];
    const rtlPanel = Main.panel.get_text_direction() === Clutter.TextDirection.RTL;
    const [first, last] = rtlPanel ? [r, l] : [l, r];
    T.log(`INFO ${label}: boxes ${first.x1}-${first.x2} | ${c.x1}-${c.x2} | ${last.x1}-${last.x2}`);
    T.check(`${label}: panel boxes do not overlap`, first.x2 <= c.x1 + 1 && c.x2 <= last.x1 + 1);
}

// Every provider group is shown completely (inside the summary) or not at all.
function checkWholeGroups(label, { atLeast = 0 } = {}) {
    const summary = T.indicator()._summary;
    const bounds = T.span(summary);
    let shown = 0;
    let whole = true;
    for (const group of summary.get_children()) {
        const natural = group.get_preferred_width(-1)[1];
        if (group.width < 0.5) {
            continue;
        }
        shown++;
        const s = T.span(group);
        whole &&= group.width >= natural - 0.5 && s.x1 >= bounds.x1 - 1 && s.x2 <= bounds.x2 + 1;
    }
    const total = summary.get_n_children();
    T.check(`${label}: provider groups shown whole or hidden (${shown}/${total} shown)`, whole && shown >= atLeast);
}

function checkIconVisible(label) {
    const icon = T.span(T.indicator()._icon);
    T.check(`${label}: panel icon visible (${icon.x2 - icon.x1}px)`, icon.x2 - icon.x1 >= 14);
}

const naturalWidth = () => T.indicator().get_preferred_width(-1)[1];

async function main() {
    const formatUri = Gio.File.new_for_path(`${T.extension().path}/lib/format.js`).get_uri();
    const { displayLabel, displayDetailValue } = await import(formatUri);
    const extraUsage = { id: "extra_usage", label: "Extra usage", value: "Disabled" };
    T.check("extra usage label uses gettext", displayLabel(extraUsage) === T.extension().gettext("Extra usage"));
    for (const value of ["Disabled", "Enabled"]) {
        T.check(`${value} extra usage uses gettext`,
            displayDetailValue({ ...extraUsage, value }) === T.extension().gettext(value));
    }
    T.check("unknown extra usage value preserved", displayDetailValue({ ...extraUsage, value: "$5" }) === "$5");
    T.check("other detail values preserved", displayDetailValue({ label: "Custom", value: "Disabled" }) === "Disabled");

    let w = where();
    T.check("never chosen: no user value", settings().get_user_value("panel-position") === null);
    T.check(`never chosen: right box, index 0 (${w.text})`, w.name === "right" && w.index === 0);

    const indexOk = { center: (x) => x.index === 0, left: (x) => x.index === x.last, right: (x) => x.index === 0 };
    for (const position of ["center", "left", "right"]) {
        settings().set_string("panel-position", position);
        w = where();
        T.check(`${position}: ${w.text}`, w.name === position && indexOk[position](w));
        T.check(`${position}: exactly one indicator (${countIndicators()})`, countIndicators() === 1);
        T.check(`${position}: statusArea is the live indicator`, Main.panel.statusArea[T.UUID] === T.indicator());
    }

    // Moves while the popup is open and a refresh is in flight.
    T.writeFake("delay", 2);
    T.writeFake("providers", 3);
    T.extension().refresh({ force: true });
    T.check("refresh in flight before the moves", Boolean(T.extension()._activeRequest));
    const replaced = [];
    for (const position of ["center", "left", "right", "center", "left", "center"]) {
        const button = T.indicator();
        button.menu.open(PopupAnimation.NONE);
        await T.sleep(100); // a user can only move the button after the popup was shown
        const entry = { button, menu: button.menu, wasOpen: button.menu.isOpen, destroyed: false };
        button.connect("destroy", () => (entry.destroyed = true));
        replaced.push(entry);
        settings().set_string("panel-position", position);
    }
    T.check("popup was open on every replaced button", replaced.every((e) => e.wasOpen));
    T.check("every replaced button destroyed", replaced.every((e) => e.destroyed));
    T.check("every old popup closed", replaced.every((e) => !e.menu.isOpen));
    const managed = Main.panel.menuManager._menus;
    T.check("old popups removed from the panel menu manager", replaced.every((e) => !managed.includes(e.menu)));
    T.check(`no modal grab left (modalCount=${Main.modalCount})`, Main.modalCount === 0);
    T.check(`exactly one indicator after the moves (${countIndicators()})`, countIndicators() === 1);
    T.check("replacement popup closed", !T.indicator().menu.isOpen);
    T.check("refresh still in flight after the moves", Boolean(T.extension()._activeRequest));
    T.check("refresh finishes", await T.waitFor(() => !T.extension()._activeRequest));
    T.check(
        `refresh result reaches the replacement (${T.indicator()._summary.get_n_children()} providers)`,
        T.extension()._state.entries?.length === 3 &&
            T.indicator()._summary.get_n_children() === 3 &&
            T.indicator()._state === T.extension()._state
    );

    // Several moves within one frame.
    for (const position of ["left", "right", "center", "left", "right", "center"]) {
        settings().set_string("panel-position", position);
    }
    w = where();
    T.check(`burst: one indicator, in the center (${countIndicators()}, ${w.text})`, countIndicators() === 1 && w.name === "center");

    // A wide summary (12 providers with bars) in every position.
    T.check("12 providers shown", await T.showProviders(12));
    for (const position of ["center", "left", "right"]) {
        settings().set_string("panel-position", position);
        await T.sleep(400);
        checkNaturalWidth("activities");
        checkNaturalWidth("quickSettings");
        checkOnScreen("quickSettings");
        checkBoxesApart(position);
        checkIconVisible(position);
        checkWholeGroups(position, { atLeast: 1 });
        if (position !== "center") {
            const s = T.span(T.indicator());
            const box = T.span(T.panelBoxes()[position]);
            T.check(`${position}: button inside its box`, s.x1 >= box.x1 - 1 && s.x2 <= box.x2 + 1);
        }
    }

    // Idle in the center: the free space handlers must not cause a relayout loop.
    let relayouts = 0;
    const id = Main.panel.connect("queue-relayout", () => relayouts++);
    await T.sleep(2000);
    Main.panel.disconnect(id);
    T.check(`idle: no relayout loop (${relayouts} panel relayouts in 2 s)`, relayouts <= 2);

    // The right box keeps the unlimited natural width.
    settings().set_string("panel-position", "right");
    for (const [count, display] of [
        [2, "bars"],
        [1, "percent"],
    ]) {
        T.check(`${count} provider(s) shown (${display})`, await T.showProviders(count, display));
        const content = T.indicator().get_first_child().get_preferred_width(-1)[1];
        T.check(`right/${display}: no width limit (${naturalWidth()} >= ${content})`, naturalWidth() >= content);
        checkWholeGroups(`right/${display}`);
    }
    T.check(
        `right/percent, 1 provider: fits unclipped (${T.indicator().width} of ${naturalWidth()})`,
        T.indicator().width >= naturalWidth() - 1
    );
}

// Narrow panel with a wide clock and other status indicators: only the space they
// leave free is available to the button in the center.
async function narrow() {
    const iface = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" });
    for (const key of ["clock-show-weekday", "clock-show-date", "clock-show-seconds"]) {
        iface.set_boolean(key, true);
    }
    const dummy = T.addDummyIndicators("paseo-test-a", 1);
    settings().set_string("panel-position", "center");
    const widths = () =>
        ["activities", "dateMenu", "quickSettings", "paseo-test-a0"]
            .map((name) => `${name} ${Main.panel.statusArea[name].container.get_preferred_width(-1)[1]}`)
            .join(", ");
    const checkPanel = (label) => {
        checkNaturalWidth("activities");
        checkNaturalWidth("quickSettings");
        checkOnScreen("quickSettings");
        checkBoxesApart(label);
        checkIconVisible(label);
        checkWholeGroups(label);
    };

    // Precondition: the panel fits when the button shows only its icon.
    T.check("icon only", await T.showProviders(12, "icon"));
    T.log(`INFO panel ${Main.panel.width}px: ${widths()}`);
    checkPanel("icon only");

    T.check("12 providers with bars", await T.showProviders(12));
    checkPanel("bars");
    const before = naturalWidth();

    const more = T.addDummyIndicators("paseo-test-b", 1);
    await T.sleep(400);
    checkPanel("one more indicator");
    T.check(`button gives way to a new indicator (${before} -> ${naturalWidth()})`, naturalWidth() < before);

    more.forEach((button) => button.destroy());
    await T.sleep(400);
    T.check(`button grows again when it is gone (${naturalWidth()} == ${before})`, Math.abs(naturalWidth() - before) <= 1);

    iface.set_boolean("clock-show-seconds", false);
    iface.set_boolean("clock-show-date", false);
    await T.sleep(1200);
    T.check(`button grows when the clock gets narrower (${before} -> ${naturalWidth()})`, naturalWidth() > before);
    checkPanel("narrower clock");

    dummy.forEach((button) => button.destroy());
}

async function monitors() {
    T.log(`INFO monitors: ${Main.layoutManager.monitors.map((m) => `${m.width}x${m.height}+${m.x}`).join(", ")}`);
    T.check("primary is the 1600 px monitor", await T.setPrimaryByWidth(1600));
    settings().set_string("panel-position", "center");
    T.check("12 providers shown", await T.showProviders(12));
    const wide = naturalWidth();
    checkBoxesApart("1600 px");

    T.check("primary switched to the 800 px monitor", await T.setPrimaryByWidth(800));
    await T.sleep(800);
    T.check(`800 px: button follows the new primary (${wide} -> ${naturalWidth()})`, naturalWidth() < wide);
    checkNaturalWidth("activities");
    checkNaturalWidth("quickSettings");
    checkOnScreen("quickSettings");
    checkBoxesApart("800 px");

    T.check("primary switched back to 1600 px", await T.setPrimaryByWidth(1600));
    await T.sleep(800);
    T.check(`back on 1600 px: button grows again (${naturalWidth()} == ${wide})`, Math.abs(naturalWidth() - wide) <= 1);
}

async function rtl() {
    const isRtl = Main.panel.get_text_direction() === Clutter.TextDirection.RTL;
    T.check(`shell runs right-to-left (CLUTTER_TEXT_DIRECTION=${GLib.getenv("CLUTTER_TEXT_DIRECTION")})`, isRtl);
    await T.sleep(300);

    // An upgrade without a chosen position keeps GNOME Shell's default box.
    let w = where();
    T.check("never chosen: no user value", settings().get_user_value("panel-position") === null);
    T.check(`never chosen: GNOME default box, physical ${physicalSide()} (${w.text})`, w.name === "right" && w.index === 0 && physicalSide() === "left");

    const expected = { left: ["right", (x) => x.index === 0], right: ["left", (x) => x.index === x.last] };
    for (const position of ["left", "center", "right"]) {
        settings().set_string("panel-position", position);
        await T.sleep(300);
        w = where();
        T.check(`${position}: physical side ${physicalSide()} (${w.text})`, physicalSide() === position);
        if (expected[position]) {
            const [box, indexOk] = expected[position];
            T.check(`${position}: at the inner edge of the ${box} box`, w.name === box && indexOk(w));
        }
    }

    settings().reset("panel-position");
    await T.sleep(300);
    w = where();
    T.check(`reset: back in the GNOME default box (${w.text})`, w.name === "right" && physicalSide() === "left");

    // Whole groups also in right-to-left order, next to the icon.
    settings().set_string("panel-position", "left");
    T.check("12 providers shown", await T.showProviders(12));
    checkWholeGroups("rtl left", { atLeast: 1 });
    const icon = T.span(T.indicator()._icon);
    const first = T.indicator()._summary.get_first_child();
    T.check("rtl: first provider group next to the icon, on its left", T.span(first).x2 <= icon.x1 + 1 && first.width > 0);
    checkBoxesApart("rtl");
    checkNaturalWidth("activities");
    checkNaturalWidth("quickSettings");
}
