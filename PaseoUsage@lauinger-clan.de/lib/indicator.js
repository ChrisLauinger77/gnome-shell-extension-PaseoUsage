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

export const PaseoUsageIndicator = GObject.registerClass(
    // The matching class name is intentional for GObject registration.
    // eslint-disable-next-line no-shadow
    class PaseoUsageIndicator extends PanelMenu.Button {
        // maxWidthFraction: largest part of the panel width the button may ask for, 0 for no limit.
        constructor(extension, settings, { maxWidthFraction = 0 } = {}) {
            super(0.5, _("Paseo Usage"));
            this._extension = extension;
            this._settings = settings;
            this._maxWidthFraction = maxWidthFraction;
            this._state = { entries: null, error: null, refreshing: false, lastSuccess: 0 };
            this._tickId = 0;
            if (maxWidthFraction) {
                // The limit depends on the primary monitor, which Clutter's cached size
                // request does not know about. Disconnected when the button is destroyed.
                Main.layoutManager.connectObject("monitors-changed", () => this.queue_relayout(), this);
            }

            // Clipped: when the button gets less than its preferred width, the labels
            // ellipsize and bars or icons that still do not fit are cut off (the
            // summary has min-width: 0 in the stylesheet).
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
            this._summary = new St.BoxLayout({ style_class: "paseo-usage-panel-summary", visible: false });
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

        vfunc_get_preferred_width(forHeight) {
            const [minWidth, natWidth] = super.vfunc_get_preferred_width(forHeight);
            const panelWidth = Main.layoutManager.primaryMonitor?.width ?? 0;
            if (!this._maxWidthFraction || panelWidth <= 0) {
                return [minWidth, natWidth];
            }
            const maxWidth = Math.floor(panelWidth * this._maxWidthFraction);
            return [Math.min(minWidth, maxWidth), Math.min(natWidth, maxWidth)];
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

            const group = new St.BoxLayout({ style_class: "paseo-usage-panel-group" });
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
