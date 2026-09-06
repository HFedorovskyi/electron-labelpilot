/**
 * Content-derived key for a label template. Computed ONCE when a station loads the
 * template (not per print) and sent alongside print requests: the main process ships
 * the parsed doc into the generation worker only on the first print of a template —
 * repeats send this key alone, skipping the per-print structured clone, and the worker
 * reuses one doc object so its structural cache hits across prints.
 *
 * Self-invalidating: a re-synced template has different structure text → different key.
 * FNV-1a over the raw structure string (fast: ~0.05ms for a 20KB template) + length.
 */
export function computeDocKey(structure: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < structure.length; i++) {
        h = Math.imul(h ^ structure.charCodeAt(i), 0x01000193) >>> 0;
    }
    return `${structure.length.toString(36)}:${h.toString(36)}`;
}
