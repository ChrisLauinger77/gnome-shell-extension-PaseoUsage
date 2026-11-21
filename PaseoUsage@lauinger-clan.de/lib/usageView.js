"use strict";

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import Pango from "gi://Pango";
import St from "gi://St";

import * as BarLevel from "resource:///org/gnome/shell/ui/barLevel.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import {
    displayLabel,
    formatAgo,
    formatBalance,
    formatPercentLeft,
    formatResetLabel,
    formatResetTime,
    formatRunsOutLabel,
    remainingPct,
    resolveReport,
    toneClass,
} from "./format.js";

const FALLBACK_PROVIDER_ICON = "application-x-addon-symbolic";

// Provider icons arrive as inline SVG with fill="currentColor". St does not resolve
// currentColor for in-memory icons, so the theme foreground color is substituted.
export const ProviderIcon = GObject.registerClass(
    // The matching class name is intentional for GObject registration.
    // eslint-disable-next-line no-shadow
    class ProviderIcon extends St.Icon {
        constructor(svg, params = {}) {
            super(params);
            this._svg = typeof svg === "string" && svg.includes("<svg") ? svg : null;
            this._color = null;
            if (!this._svg) {
                this.icon_name = FALLBACK_PROVIDER_ICON;
            }
        }

        vfunc_style_changed() {
            super.vfunc_style_changed();
            if (!this._svg) {
                return;
            }
            const color = this.get_theme_node().get_foreground_color().to_string().substring(0, 7);
            if (color === this._color) {
                return;
            }
            this._color = color;
            const svg = this._svg.replaceAll("currentColor", color);
            this.gicon = new Gio.BytesIcon({ bytes: new GLib.Bytes(new TextEncoder().encode(svg)) });
        }
    }
);

export function createUsageBar(pct, tone, styleClass) {
    return new BarLevel.BarLevel({
        value: pct / 100,
        style_class: `${styleClass} ${toneClass(tone)}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function _wrappingLabel(text, styleClass) {
    const label = new St.Label({ text, style_class: styleClass, x_expand: true });
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function _valueRow(labelText, valueText, labelStyle, valueStyle) {
    const row = new St.BoxLayout({ style_class: "paseo-usage-row", x_expand: true });
    row.add_child(
        new St.Label({
            text: labelText,
            style_class: labelStyle,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        })
    );
    row.add_child(
        new St.Label({
            text: valueText,
            style_class: valueStyle,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        })
    );
    return row;
}

function _windowBlock(window, now) {
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "paseo-usage-window",
        x_expand: true,
    });
    const pct = remainingPct(window);
    box.add_child(
        _valueRow(
            displayLabel(window),
            pct === null ? "" : formatPercentLeft(pct),
            "paseo-usage-window-label",
            "paseo-usage-window-value"
        )
    );
    if (pct !== null) {
        const bar = createUsageBar(pct, window.tone, "paseo-usage-bar");
        bar.x_expand = true;
        box.add_child(bar);
    }
    const caption = [
        formatResetLabel(window.resetsAt, now),
        formatResetTime(window.resetsAt, now),
        formatRunsOutLabel(window.runsOutAt, now),
    ]
        .filter(Boolean)
        .join(" · ");
    if (caption) {
        box.add_child(new St.Label({ text: caption, style_class: "paseo-usage-caption" }));
    }
    return box;
}

export const UsageHeaderItem = GObject.registerClass(
    // The matching class name is intentional for GObject registration.
    // eslint-disable-next-line no-shadow
    class UsageHeaderItem extends PopupMenu.PopupBaseMenuItem {
        constructor({ onRefresh, onSettings }) {
            super({ reactive: false, can_focus: false, style_class: "paseo-usage-header" });

            const titleBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            titleBox.add_child(new St.Label({ text: _("Usage"), style_class: "paseo-usage-title" }));
            this._subtitle = new St.Label({ text: "", style_class: "paseo-usage-subtitle" });
            titleBox.add_child(this._subtitle);
            this.add_child(titleBox);

            this._refreshButton = new St.Button({
                style_class: "icon-button paseo-usage-header-button",
                icon_name: "view-refresh-symbolic",
                accessible_name: _("Refresh"),
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._refreshButton.connect("clicked", () => onRefresh());
            this.add_child(this._refreshButton);

            const settingsButton = new St.Button({
                style_class: "icon-button paseo-usage-header-button",
                icon_name: "emblem-system-symbolic",
                accessible_name: _("Settings"),
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            settingsButton.connect("clicked", () => onSettings());
            this.add_child(settingsButton);
        }

        update({ refreshing, lastSuccess }, now) {
            this._refreshButton.reactive = !refreshing;
            if (refreshing) {
                this._subtitle.text = _("Refreshing…");
            } else if (lastSuccess > 0) {
                /* Translators: %s is a relative time, e.g. "5 minutes ago" */
                this._subtitle.text = _("Last refresh: %s").format(formatAgo(lastSuccess, now));
            } else {
                this._subtitle.text = _("No successful refresh");
            }
        }
    }
);

export const MessageItem = GObject.registerClass(
    // The matching class name is intentional for GObject registration.
    // eslint-disable-next-line no-shadow
    class MessageItem extends PopupMenu.PopupBaseMenuItem {
        constructor(text, tone = null) {
            super({ reactive: false, can_focus: false, style_class: "paseo-usage-message-item" });
            const styleClass = tone ? `paseo-usage-message ${toneClass(tone)}` : "paseo-usage-message";
            this.add_child(_wrappingLabel(text, styleClass));
        }
    }
);

export const ProviderCard = GObject.registerClass(
    // The matching class name is intentional for GObject registration.
    // eslint-disable-next-line no-shadow
    class ProviderCard extends PopupMenu.PopupBaseMenuItem {
        constructor(entry, now) {
            super({ reactive: false, can_focus: false, style_class: "paseo-usage-card-item" });
            const { report, retained, successfulAt, problem, tone } = resolveReport(entry, now);

            const card = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: "paseo-usage-card",
                x_expand: true,
            });

            const title = new St.BoxLayout({ style_class: "paseo-usage-card-title", x_expand: true });
            title.add_child(
                new ProviderIcon(entry.icon, {
                    style_class: "paseo-usage-provider-icon",
                    y_align: Clutter.ActorAlign.CENTER,
                })
            );
            title.add_child(
                new St.Label({
                    text: entry.sourceLabel ?? entry.sourceId ?? "",
                    style_class: "paseo-usage-provider-name",
                    y_align: Clutter.ActorAlign.CENTER,
                })
            );
            if (report?.planLabel) {
                title.add_child(
                    new St.Label({
                        text: report.planLabel,
                        style_class: "paseo-usage-plan",
                        y_align: Clutter.ActorAlign.CENTER,
                    })
                );
            }
            card.add_child(title);

            if (problem) {
                let text = problem;
                if (retained && successfulAt !== null) {
                    /* Translators: %s is a relative time, e.g. "2 hours ago" */
                    text = `${problem} · ${_("Updated %s").format(formatAgo(successfulAt, now))}`;
                }
                card.add_child(_wrappingLabel(text, `paseo-usage-problem ${toneClass(tone)}`));
            }

            for (const window of report?.windows ?? []) {
                card.add_child(_windowBlock(window, now));
            }
            for (const balance of report?.balances ?? []) {
                card.add_child(
                    _valueRow(
                        displayLabel(balance),
                        formatBalance(balance),
                        "paseo-usage-balance-label",
                        `paseo-usage-balance-value ${toneClass(balance.tone)}`
                    )
                );
            }
            for (const detail of report?.details ?? []) {
                card.add_child(
                    _valueRow(
                        displayLabel(detail),
                        detail.value ?? "",
                        "paseo-usage-detail-label",
                        `paseo-usage-detail-value ${toneClass(detail.tone)}`
                    )
                );
            }

            if (entry.account?.label) {
                card.add_child(new St.Label({ text: entry.account.label, style_class: "paseo-usage-account" }));
            }

            this.add_child(card);
        }
    }
);
