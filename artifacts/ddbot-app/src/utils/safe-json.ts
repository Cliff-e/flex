/**
 * Safely parses JSON that originates from a source the app does not fully
 * control (localStorage, sessionStorage, cookies, URL params, etc). Returns
 * `fallback` instead of throwing when the value is missing, not valid JSON,
 * or (for the literal-string case) the corrupted string "undefined"/"null"
 * that browser storage APIs sometimes coerce values into.
 *
 * Do NOT use this for parsing application-controlled data (already-validated
 * API responses, build-time config, internal serialization) — an unexpected
 * shape there usually indicates a real bug that should surface, not be
 * silently swallowed.
 */
export function safeJsonParse<T = unknown>(raw: string | null | undefined, fallback: T): T {
    if (typeof raw !== 'string' || raw.length === 0 || raw === 'undefined' || raw === 'null') {
        return fallback;
    }

    try {
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : (parsed as T);
    } catch {
        return fallback;
    }
}
