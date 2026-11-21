"use strict";

// Runs the paseo command line tool asynchronously. Only GLib/Gio are used here so
// the module works in GNOME Shell, in the preferences process and in plain gjs.

import GLib from "gi://GLib";
import Gio from "gi://Gio";

export const PaseoErrorCode = Object.freeze({
    NOT_FOUND: "not-found",
    FAILED: "failed",
    TIMEOUT: "timeout",
    INVALID_OUTPUT: "invalid-output",
});

export class PaseoError extends Error {
    constructor(code, detail = "", exitStatus = null) {
        super(`${code}: ${detail}`);
        this.name = "PaseoError";
        this.code = code;
        this.detail = detail;
        this.exitStatus = exitStatus;
    }
}

export function isCancelledError(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function _communicate(proc, cancellable) {
    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, cancellable, (subprocess, res) => {
            try {
                const [, stdout, stderr] = subprocess.communicate_utf8_finish(res);
                resolve([stdout ?? "", stderr ?? ""]);
            } catch (error) {
                reject(error);
            }
        });
    });
}

export async function runPaseo(executable, args, { cancellable = null, timeoutSeconds = 30, subprocesses = null } = {}) {
    let proc;
    try {
        proc = new Gio.Subprocess({
            argv: [executable, ...args],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(cancellable);
    } catch (error) {
        if (isCancelledError(error)) {
            throw error;
        }
        throw new PaseoError(PaseoErrorCode.NOT_FOUND, error.message);
    }

    subprocesses?.add(proc);
    // Stop waiting on timeout or outer cancellation even if a grandchild still
    // holds the output pipes open.
    const callCancellable = new Gio.Cancellable();
    const outerHandlerId = cancellable ? cancellable.connect(() => callCancellable.cancel()) : 0;
    let timedOut = false;
    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
        timedOut = true;
        timeoutId = 0;
        callCancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });

    try {
        const [stdout, stderr] = await _communicate(proc, callCancellable);
        const exitStatus = proc.get_if_exited() ? proc.get_exit_status() : -1;
        return { exitStatus, stdout, stderr };
    } catch (error) {
        if (isCancelledError(error)) {
            proc.force_exit();
            if (timedOut) {
                throw new PaseoError(PaseoErrorCode.TIMEOUT, String(timeoutSeconds));
            }
        }
        throw error;
    } finally {
        if (timeoutId) {
            GLib.Source.remove(timeoutId);
        }
        if (outerHandlerId) {
            cancellable.disconnect(outerHandlerId);
        }
        subprocesses?.delete(proc);
    }
}

// paseo prints failures as {"error": {"code", "message", "details"}} on stderr.
function _errorMessage(stderr, stdout) {
    for (const text of [stderr, stdout]) {
        const trimmed = text.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const message = JSON.parse(trimmed)?.error?.message;
            if (typeof message === "string" && message) {
                return message;
            }
        } catch {
            // not JSON, use the raw text
        }
        return trimmed;
    }
    return "";
}

// The JSON comes from an external tool: keep only known fields with the expected
// types so the UI never has to deal with malformed data.
function _isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _string(value) {
    return typeof value === "string" ? value : null;
}

function _number(value) {
    return Number.isFinite(value) ? value : null;
}

function _list(value, normalize) {
    return Array.isArray(value) ? value.filter(_isObject).map(normalize) : [];
}

function _normalizeWindow(window) {
    return {
        id: _string(window.id) ?? "",
        label: _string(window.label) ?? "",
        shortLabel: _string(window.shortLabel),
        summary: window.summary === true,
        usedPct: _number(window.usedPct),
        remainingPct: _number(window.remainingPct),
        resetsAt: _string(window.resetsAt),
        runsOutAt: _string(window.runsOutAt),
        tone: _string(window.tone),
    };
}

function _normalizeBalance(balance) {
    return {
        id: _string(balance.id) ?? "",
        label: _string(balance.label) ?? "",
        used: _number(balance.used),
        remaining: _number(balance.remaining),
        limit: _number(balance.limit),
        unit: _string(balance.unit),
        tone: _string(balance.tone),
    };
}

function _normalizeDetail(detail) {
    let value = _string(detail.value);
    if (value === null && Number.isFinite(detail.value)) {
        value = String(detail.value);
    }
    return {
        id: _string(detail.id) ?? "",
        label: _string(detail.label) ?? "",
        value: value ?? "",
        tone: _string(detail.tone),
    };
}

function _normalizeProblem(problem) {
    if (!_isObject(problem)) {
        return null;
    }
    return {
        kind: _string(problem.kind),
        detail: _string(problem.detail),
        status: _number(problem.status),
        expiresAt: _string(problem.expiresAt),
        refreshedBy: _string(problem.refreshedBy),
    };
}

function _normalizeReport(report) {
    if (!_isObject(report)) {
        return null;
    }
    return {
        status: _string(report.status) ?? "error",
        planLabel: _string(report.planLabel),
        windows: _list(report.windows, _normalizeWindow),
        balances: _list(report.balances, _normalizeBalance),
        details: _list(report.details, _normalizeDetail),
        problem: _normalizeProblem(report.problem),
        error: _string(report.error),
    };
}

export function normalizeEntry(entry) {
    if (!_isObject(entry)) {
        return null;
    }
    const report = _normalizeReport(entry.report);
    if (!report) {
        return null;
    }
    const lastReport = _isObject(entry.lastSuccessful) ? _normalizeReport(entry.lastSuccessful.report) : null;
    return {
        id: _string(entry.id) ?? "",
        sourceId: _string(entry.sourceId) ?? "",
        sourceLabel: _string(entry.sourceLabel),
        icon: _string(entry.icon),
        account: { label: _isObject(entry.account) ? _string(entry.account.label) : null },
        fetchedAt: _string(entry.fetchedAt),
        successfulAt: _string(entry.successfulAt),
        report,
        lastSuccessful: lastReport ? { fetchedAt: _string(entry.lastSuccessful.fetchedAt), report: lastReport } : null,
    };
}

export async function fetchUsage(executable, { refresh = false, ...options } = {}) {
    const args = ["usage", "--json"];
    if (refresh) {
        args.push("--refresh");
    }
    const { exitStatus, stdout, stderr } = await runPaseo(executable, args, options);
    if (exitStatus !== 0) {
        throw new PaseoError(PaseoErrorCode.FAILED, _errorMessage(stderr, stdout), exitStatus);
    }

    let data;
    try {
        data = JSON.parse(stdout);
    } catch {
        throw new PaseoError(PaseoErrorCode.INVALID_OUTPUT, stdout.trim().slice(0, 200));
    }
    if (!Array.isArray(data)) {
        throw new PaseoError(PaseoErrorCode.INVALID_OUTPUT, stdout.trim().slice(0, 200));
    }
    return data.map(normalizeEntry).filter((entry) => entry !== null);
}

export async function fetchVersion(executable, options = {}) {
    const { exitStatus, stdout, stderr } = await runPaseo(executable, ["--version"], options);
    if (exitStatus !== 0) {
        throw new PaseoError(PaseoErrorCode.FAILED, _errorMessage(stderr, stdout), exitStatus);
    }
    return stdout.trim();
}
