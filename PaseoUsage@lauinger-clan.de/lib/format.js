"use strict";

// Formatting helpers for the data returned by `paseo usage --json`.
// Wording follows the Paseo app ("82% left", "resets in 1h 17m · 16:10").

import * as DateUtils from "resource:///org/gnome/shell/misc/dateUtils.js";
import { gettext as _, ngettext } from "resource:///org/gnome/shell/extensions/extension.js";

import { PaseoErrorCode } from "./paseoClient.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TONES = ["default", "ok", "warning", "danger"];

export function parseTime(value) {
    if (typeof value !== "string" || !value) {
        return null;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

export function toneClass(tone) {
    return `paseo-usage-tone-${TONES.includes(tone) ? tone : "default"}`;
}

export function remainingPct(window) {
    let pct = null;
    if (Number.isFinite(window.remainingPct)) {
        pct = window.remainingPct;
    } else if (Number.isFinite(window.usedPct)) {
        pct = 100 - window.usedPct;
    }
    return pct === null ? null : Math.max(0, Math.min(100, pct));
}

export function formatPercent(pct) {
    return `${Math.round(pct)}%`;
}

export function formatPercentLeft(pct) {
    /* Translators: remaining share or amount of a usage limit, e.g. "82% left" */
    return _("%s left").format(formatPercent(pct));
}

export function formatDuration(ms) {
    const totalMinutes = Math.max(1, Math.floor(ms / MINUTE));
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    /* Translators: short duration in days, e.g. "4d" */
    const dayText = _("%dd").format(days);
    /* Translators: short duration in hours, e.g. "16h" */
    const hourText = _("%dh").format(hours);
    /* Translators: short duration in minutes, e.g. "17m" */
    const minuteText = _("%dm").format(minutes);

    if (days > 0) {
        return hours > 0 ? `${dayText} ${hourText}` : dayText;
    }
    if (hours > 0) {
        return minutes > 0 ? `${hourText} ${minuteText}` : hourText;
    }
    return minuteText;
}

export function formatResetLabel(resetsAt, now = Date.now()) {
    const time = parseTime(resetsAt);
    if (time === null) {
        return null;
    }
    if (time - now < MINUTE) {
        return _("resetting now");
    }
    /* Translators: %s is a short duration, e.g. "resets in 1h 17m" */
    return _("resets in %s").format(formatDuration(time - now));
}

export function formatRunsOutLabel(runsOutAt, now = Date.now()) {
    const time = parseTime(runsOutAt);
    if (time === null) {
        return null;
    }
    if (time - now < MINUTE) {
        return _("runs out now");
    }
    /* Translators: %s is a short duration, e.g. "runs out in 3h 5m" */
    return _("runs out in %s").format(formatDuration(time - now));
}

export function formatResetTime(resetsAt, now = Date.now()) {
    const time = parseTime(resetsAt);
    if (time === null || time <= now) {
        return null;
    }
    const date = new Date(time);
    const timeText = DateUtils.formatTime(date, { timeOnly: true }).trim();
    if (time - now < DAY) {
        return timeText;
    }
    if (time - now < 7 * DAY) {
        return `${DateUtils.formatDateWithCFormatString(date, "%a")} ${timeText}`;
    }
    /* Translators: strftime format of an abbreviated month and day, e.g. "Nov 30" */
    // xgettext:no-c-format
    const dateText = DateUtils.formatDateWithCFormatString(date, _("%b %-d"));
    return `${dateText}, ${timeText}`;
}

export function formatAgo(time, now = Date.now()) {
    const diff = now - time;
    if (diff < MINUTE) {
        return _("just now");
    }
    const minutes = Math.floor(diff / MINUTE);
    if (minutes < 60) {
        return ngettext("%d minute ago", "%d minutes ago", minutes).format(minutes);
    }
    const hours = Math.floor(diff / HOUR);
    if (hours < 24) {
        return ngettext("%d hour ago", "%d hours ago", hours).format(hours);
    }
    const days = Math.floor(diff / DAY);
    return ngettext("%d day ago", "%d days ago", days).format(days);
}

export function formatAmount(value, unit) {
    if (unit === "usd") {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
    }
    if (unit === "tokens") {
        return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
    }
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export function formatBalance(balance) {
    if (Number.isFinite(balance.remaining)) {
        return _("%s left").format(formatAmount(balance.remaining, balance.unit));
    }
    if (Number.isFinite(balance.used)) {
        if (Number.isFinite(balance.limit)) {
            /* Translators: used amount of a limit, e.g. "$3.20 of $10.00 used" */
            return _("%s of %s used").format(
                formatAmount(balance.used, balance.unit),
                formatAmount(balance.limit, balance.unit)
            );
        }
        /* Translators: used amount, e.g. "1.2K used" */
        return _("%s used").format(formatAmount(balance.used, balance.unit));
    }
    return "";
}

// Paseo only sends English labels; translate the well known ones by id.
export function displayLabel(item) {
    if (item.label === "Extra usage") {
        return _("Extra usage");
    }
    const known = {
        session: ["Session", _("Session")],
        five_hour: ["Session", _("Session")],
        weekly: ["Weekly", _("Weekly")],
        monthly: ["Monthly", _("Monthly")],
        code_review: ["Code review", _("Code review")],
        credits: ["Credits", _("Credits")],
        monthly_credits: ["Monthly credits", _("Monthly credits")],
    }[item.id];
    if (known && known[0] === item.label) {
        return known[1];
    }
    return item.label ?? "";
}

export function displayDetailValue(detail) {
    if (detail.label === "Extra usage") {
        if (detail.value === "Disabled") {
            return _("Disabled");
        }
        if (detail.value === "Enabled") {
            return _("Enabled");
        }
    }
    return detail.value ?? "";
}

export function formatProblem(problem, now = Date.now()) {
    if (problem?.kind === "no_quota") {
        return problem.detail || _("No quota available");
    }
    const remedy = problem?.refreshedBy
        ? /* Translators: %s is a command, e.g. "claude /login" */
          _("Run %s to refresh it.").format(problem.refreshedBy)
        : _("Sign in again.");
    if (problem?.kind === "rejected") {
        /* Translators: %s are an HTTP status code and a remedy sentence */
        return _("Login rejected (HTTP %s). %s").format(String(problem.status ?? "?"), remedy);
    }
    if (problem?.kind === "expired") {
        const expiresAt = parseTime(problem.expiresAt);
        if (expiresAt === null) {
            /* Translators: %s is a remedy sentence */
            return _("Login expired. %s").format(remedy);
        }
        /* Translators: %s are a relative time ("5 minutes ago") and a remedy sentence */
        return _("Login expired %s. %s").format(formatAgo(expiresAt, now), remedy);
    }
    return _("Usage is unavailable");
}

// Mirrors the Paseo app: show the last successful report when the current one failed.
export function resolveReport(entry, now = Date.now()) {
    const report = entry.report ?? {};
    if (report.status === "available") {
        return {
            report,
            retained: false,
            successfulAt: parseTime(entry.successfulAt) ?? parseTime(entry.fetchedAt),
            problem: null,
            tone: null,
        };
    }

    const isError = report.status === "error";
    const problem = isError ? report.error || _("Unknown error") : formatProblem(report.problem, now);
    const tone = isError ? "danger" : "warning";
    if (entry.lastSuccessful?.report) {
        return {
            report: entry.lastSuccessful.report,
            retained: true,
            successfulAt: parseTime(entry.lastSuccessful.fetchedAt),
            problem,
            tone,
        };
    }
    return { report: null, retained: false, successfulAt: null, problem, tone };
}

export function newestSuccess(entries) {
    let newest = 0;
    for (const entry of entries ?? []) {
        const time = parseTime(entry.successfulAt) ?? parseTime(entry.lastSuccessful?.fetchedAt);
        if (time !== null && time > newest) {
            newest = time;
        }
    }
    return newest;
}

export function formatClientError(error, executable) {
    if (error?.code === PaseoErrorCode.NOT_FOUND) {
        return _("Paseo executable not found or not executable: %s").format(executable);
    }
    if (error?.code === PaseoErrorCode.TIMEOUT) {
        return _("paseo did not respond within %d seconds").format(Number(error.detail));
    }
    if (error?.code === PaseoErrorCode.INVALID_OUTPUT) {
        return _("Unexpected output from paseo");
    }
    if (error?.code === PaseoErrorCode.FAILED) {
        return error.detail || _("paseo exited with status %d").format(error.exitStatus ?? -1);
    }
    return String(error?.message ?? error);
}
