"use strict";

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import { displayLabel, formatPercent, remainingPct, resolveReport, toneClass } from "./format.js";
import { MessageItem, ProviderCard, ProviderIcon, UsageHeaderItem, createUsageBar } from "./usageView.js";

// Relative times ("5 minutes ago", "resets in 1h 17m") are refreshed this often while the popup is open.
const TICK_SECONDS = 60;

// The provider groups of the panel summary, laid out only as a whole: when the panel
// box gives the summary less than its preferred width, the groups that do not fit
// completely are hidden (zero width, clipped) instead of being cut, so a bar never
// shows without its percentage. The summary can shrink to nothing.
const PanelSummary = GObject.registerClass(
    // The matching class name is intentional for GObject registration.
    // eslint-disable-next-line no-shadow
    class PanelSummary extends St.BoxLayout {
        vfunc_get_preferred_width(forHeight) {
            const [, natWidth] = super.vfunc_get_preferred_width(forHeight);
            return [0, natWidth];
        }

        vfunc_allocate(box) {
            this.set_allocation(box);
            const content = this.get_theme_node().get_content_box(box);
            const height = content.get_height();
            const spacing = this.layout_manager.spacing;
            const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
            let offset = 0;
            let fits = true;
            for (const child of this.get_children()) {
                const [, width] = child.get_preferred_width(height);
                // Keep the order: after the first group that does not fit, hide the rest.
                fits &&= offset + width <= content.get_width() + 0.5;
                const childBox = new Clutter.ActorBox();
                if (fits) {
                    childBox.set_origin(rtl ? content.x2 - offset - width : content.x1 + offset, content.y1);
                    childBox.set_size(width, height);
                    offset += width + spacing;
                } else {
                    childBox.set_origin(rtl ? content.x2 : content.x1, content.y1);
                    childBox.set_size(0, height);
                }
                child.allocate(childBox);
            }
        }
    }
);

export const PaseoUsageIndicator = GObject.registerClass(
    // The matching class name is intentional for GObject registration.
    // eslint-disable-next-line no-shadow
    class PaseoUsageIndicator extends PanelMenu.Button {
        constructor(extension, settings) {
            super(0.5, _("Paseo Usage"));
            this._extension = extension;
            this._settings = settings;
            this._state = { entries: null, error: null, refreshing: false, lastSuccess: 0 };
            this._tickId = 0;
            this._fitCenterBox = false;

            // Clipped, in case the panel box cannot even fit the icon.
            const box = new St.BoxLayout({
                style_class: "panel-status-menu-box paseo-usage-panel-box",
                clip_to_allocation: true,
            });
            this._icon = new St.Icon({
                gicon: new Gio.FileIcon({
                    file: extension.dir.resolve_relative_path("icons/paseo-usage-symbolic.svg"),
                }),
                style_class: "system-status-icon paseo-usage-panel-icon",
            });
            box.add_child(this._icon);
            this._summary = new PanelSummary({ style_class: "paseo-usage-panel-summary", visible: false });
            box.add_child(this._summary);
            this.add_child(box);

            this.menu.box.add_style_class_name("paseo-usage-menu");
            this._header = new UsageHeaderItem({
                onRefresh: () => this._extension.refresh({ force: true }),
                onSettings: () => this._openPreferences(),
            });
            this.menu.addMenuItem(this._header);

            // The cards scroll below the fixed header when they do not fit the work area
            // (the menu height is capped by PanelMenu.Button).
            this._content = new PopupMenu.PopupMenuSection();
            this._scrollView = new St.ScrollView({
                style_class: "paseo-usage-scroll",
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                y_expand: true,
                child: this._content.actor,
            });
            const scrollSection = new PopupMenu.PopupMenuSection();
            scrollSection.actor.add_child(this._scrollView);
            this.menu.addMenuItem(scrollSection);
            // Must not be named _onOpenStateChanged: PanelMenu.Button uses that name for the
            // :active style and the max-height that makes the cards scrollable.
            this.menu.connect("open-state-changed", (_menu, open) => this._onMenuOpenStateChanged(open));

            this._setupClickGestures();
            this._render();
        }

        destroy() {
            this._stopTick();
            super.destroy();
        }

        // Call after adding the button to the center box of the panel. The panel gives the
        // center box its full preferred width and only the rest to the side boxes, where
        // Clutter still gives every child its minimum width: a wide button there could
        // push Quick Settings off the screen. So the button only asks for the space that
        // the side boxes and the other center items leave free.
        fitCenterBox() {
            this._fitCenterBox = true;
            // Clutter caches size requests: ask again whenever the free space can change.
            // The handlers are disconnected when the button is destroyed.
            const panelBoxes = this.container.get_parent().get_parent().get_children();
            for (const panelBox of panelBoxes) {
                panelBox.connectObject("queue-relayout", () => this.queue_relayout(), this);
            }
            Main.layoutManager.connectObject("monitors-changed", () => this.queue_relayout(), this);
            global.display.connectObject("workareas-changed", () => this.queue_relayout(), this);
            this.queue_relayout();
        }

        vfunc_get_preferred_width(forHeight) {
            const [minWidth, natWidth] = super.vfunc_get_preferred_width(forHeight);
            if (!this._fitCenterBox) {
                return [minWidth, natWidth];
            }
            // The minimum keeps the icon visible.
            return [minWidth, Math.max(minWidth, Math.min(natWidth, this._freeCenterWidth()))];
        }

        // Mirrors Panel.vfunc_allocate: each side box gets
        // (panel width - center box width + work area offset) / 2.
        _freeCenterWidth() {
            const centerBox = this.container.get_parent();
            const panel = centerBox?.get_parent();
            const monitor = Main.layoutManager.primaryMonitor;
            if (!panel || !monitor) {
                return Infinity;
            }
            const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            const centerOffset = 2 * (workArea.x - monitor.x) + workArea.width - monitor.width;

            let sideWidth = 0;
            for (const panelBox of panel.get_children()) {
                if (panelBox !== centerBox && panelBox.visible) {
                    sideWidth = Math.max(sideWidth, panelBox.get_preferred_width(-1)[1]);
                }
            }
            // Not the center box's own size request: that would ask this button again.
            let centerItems = centerBox.peek_theme_node()?.get_horizontal_padding() ?? 0;
            for (const child of centerBox.get_children()) {
                if (child !== this.container && child.visible) {
                    centerItems += child.get_preferred_width(-1)[1] + centerBox.layout_manager.spacing;
                }
            }
            return Math.floor(monitor.width + centerOffset - 2 * sideWidth - centerItems);
        }

        _setupClickGestures() {
            // GNOME 50+: the built-in gesture toggles the menu for every button, keep it on the primary one.
            if (this._clickGesture) {
                this._clickGesture.required_button = Clutter.BUTTON_PRIMARY;
            }

            const secondaryClickGesture = new Clutter.ClickGesture({
                required_button: Clutter.BUTTON_SECONDARY,
                recognize_on_press: true,
            });
            secondaryClickGesture.connect("recognize", () => {
                if (!this.menu.isOpen) {
                    this._extension.refreshIfStale();
                }
                this.menu.toggle();
            });
            this.add_action(secondaryClickGesture);

            const middleClickGesture = new Clutter.ClickGesture({ required_button: Clutter.BUTTON_MIDDLE });
            middleClickGesture.connect("recognize", () => this._openPreferences());
            this.add_action(middleClickGesture);
        }

        // GNOME 49 toggles the menu here for every mouse button; let only the primary one through.
        // GNOME 50+ has no event vfunc in the parent classes (chaining up would throw).
        vfunc_event(event) {
            if (this._clickGesture) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() !== Clutter.BUTTON_PRIMARY) {
                return Clutter.EVENT_PROPAGATE;
            }
            return super.vfunc_event(event);
        }

        _openPreferences() {
            this.menu.close();
            this._extension.openPreferences();
        }

        update(state) {
            this._state = state;
            this._render();
        }

        _render() {
            this.updatePanel();
            this._renderMenu();
        }

        updatePanel() {
            this._summary.destroy_all_children();
            const mode = this._settings.get_string("panel-display");
            if (mode !== "icon") {
                for (const entry of this._state.entries ?? []) {
                    const group = this._createSummaryGroup(entry, mode === "bars");
                    if (group) {
                        this._summary.add_child(group);
                    }
                }
            }
            this._summary.visible = this._summary.get_n_children() > 0;

            if (this._state.error) {
                this._icon.add_style_class_name("paseo-usage-panel-error");
            } else {
                this._icon.remove_style_class_name("paseo-usage-panel-error");
            }
        }

        _createSummaryGroup(entry, withBars) {
            const { report } = resolveReport(entry);
            const windows = (report?.windows ?? []).filter((window) => window.summary && remainingPct(window) !== null);
            if (windows.length === 0) {
                return null;
            }

            // Clipped: PanelSummary hides a group that does not fit by giving it zero width.
            const group = new St.BoxLayout({ style_class: "paseo-usage-panel-group", clip_to_allocation: true });
            group.add_child(
                new ProviderIcon(entry.icon, {
                    style_class: "paseo-usage-panel-provider-icon",
                    y_align: Clutter.ActorAlign.CENTER,
                })
            );
            for (const window of windows) {
                const pct = remainingPct(window);
                if (withBars) {
                    group.add_child(createUsageBar(pct, window.tone, "paseo-usage-panel-bar"));
                }
                group.add_child(
                    new St.Label({
                        text: `${formatPercent(pct)} ${window.shortLabel || displayLabel(window)}`,
                        style_class: `paseo-usage-panel-label ${toneClass(window.tone)}`,
                        y_align: Clutter.ActorAlign.CENTER,
                    })
                );
            }
            return group;
        }

        _renderMenu() {
            const now = Date.now();
            const { entries, error, refreshing } = this._state;
            this._header.update(this._state, now);
            this._content.removeAll();

            if (error) {
                const text = error.hint ? `${error.message}\n${error.hint}` : error.message;
                this._content.addMenuItem(new MessageItem(text, "danger"));
            }
            if (entries === null) {
                if (!error) {
                    this._content.addMenuItem(new MessageItem(refreshing ? _("Loading usage…") : _("No usage data")));
                }
                return;
            }
            if (entries.length === 0) {
                this._content.addMenuItem(new MessageItem(_("No usage data")));
                return;
            }
            for (const entry of entries) {
                this._content.addMenuItem(new ProviderCard(entry, now));
            }
        }

        _onMenuOpenStateChanged(open) {
            if (open) {
                this._renderMenu();
                this._scrollView.vadjustment.value = 0;
                this._startTick();
            } else {
                this._stopTick();
            }
        }

        _startTick() {
            this._stopTick();
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
                this._renderMenu();
                return GLib.SOURCE_CONTINUE;
            });
        }

        _stopTick() {
            if (this._tickId) {
                GLib.Source.remove(this._tickId);
                this._tickId = 0;
            }
        }
    }
);
