/**
 * UUID v4 generator.
 *
 * Used by XmlProposalAdapter and other adapters that need unique
 * identifiers without importing from the bot-skeleton (avoiding
 * circular dependencies between the TypeScript virtualHook module
 * and the JavaScript bot-skeleton).
 */
export function getUUID(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback — random hex string for environments without crypto.randomUUID.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}