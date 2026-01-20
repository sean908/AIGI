(() => {
  'use strict';

  /**
   * Tag i18n helper for both browser usage (via <script>) and Node.js tests.
   *
   * Data lives in `AIGI/i18n/tags.json` and uses the schema:
   *   { "canonical-key": { "en": "English", "zh": "中文", "aliases": ["..."] } }
   *
   * Exports (browser globals + CommonJS):
   *   - translateTag(tag, lang)
   *   - normalizeTag(tag)
   *   - getAllTags(lang)
   *
   * Behavior:
   *   - If a tag is not in the table (directly or via alias), return the original string.
   *   - In the browser, the JSON table is fetched asynchronously; until it loads, functions fall back.
   */

  /** @typedef {{ en: string, zh: string, aliases?: string[] }} TagEntry */
  /** @typedef {{ [canonical: string]: TagEntry }} TagTable */

  /** @type {TagTable | null} */
  let tagTable = null;

  /** @type {Map<string, string> | null} */
  let aliasToCanonical = null;

  /** @type {Map<string, string> | null} */
  let foldedCanonicalToCanonical = null;

  /** @type {Promise<void> | null} */
  let browserLoadPromise = null;

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function foldTagKey(tag) {
    // Normalization used for alias matching. Keep it boring: trim + lowercase.
    return tag.trim().toLowerCase();
  }

  function buildIndexes(table) {
    const aliasMap = new Map();
    const canonicalMap = new Map();

    for (const canonical of Object.keys(table)) {
      canonicalMap.set(foldTagKey(canonical), canonical);

      const entry = table[canonical];
      const aliases = entry && Array.isArray(entry.aliases) ? entry.aliases : [];
      for (const alias of aliases) {
        if (typeof alias !== 'string') continue;
        const key = foldTagKey(alias);
        if (key.length === 0) continue;

        // Data mistakes happen. If aliases collide, keep the first mapping.
        if (!aliasMap.has(key)) aliasMap.set(key, canonical);
      }
    }

    aliasToCanonical = aliasMap;
    foldedCanonicalToCanonical = canonicalMap;
  }

  function setTagTable(table) {
    if (!isPlainObject(table)) return;

    // Basic shape check. We don't validate every entry strictly: keep it lightweight.
    const keys = Object.keys(table);
    if (keys.length === 0) return;
    for (const key of keys) {
      const entry = table[key];
      if (!isPlainObject(entry)) return;
      if (typeof entry.en !== 'string') return;
      if (typeof entry.zh !== 'string') return;
    }

    tagTable = /** @type {TagTable} */ (table);
    buildIndexes(tagTable);
  }

  function getBrowserTagsUrl() {
    // Default: infer from current script URL: `.../js/tag-i18n.js` -> `.../i18n/tags.json`.
    try {
      const script = typeof document !== 'undefined' ? document.currentScript : null;
      const src = script && typeof script.src === 'string' ? script.src : '';
      if (src) return new URL('../i18n/tags.json', src).toString();
    } catch {
      // Ignore and fall back.
    }
    return 'i18n/tags.json';
  }

  function maybeLoadTagTable() {
    if (tagTable) return;

    // Node / CommonJS: load synchronously so unit tests can be deterministic.
    if (typeof module === 'object' && module && module.exports) {
      try {
        // Path is relative to `AIGI/js/tag-i18n.js`.
        const table = require('../i18n/tags.json');
        setTagTable(table);
      } catch {
        // Intentionally ignore; functions will fall back to identity.
      }
      return;
    }

    // Browser: best-effort async fetch on first touch.
    if (browserLoadPromise) return;
    if (typeof fetch !== 'function') return;

    const url = getBrowserTagsUrl();
    browserLoadPromise = fetch(url)
      .then((resp) => (resp && resp.ok ? resp.json() : null))
      .then((data) => {
        if (data) setTagTable(data);
      })
      .catch(() => {
        // Intentionally ignore; functions will fall back to identity.
      });
  }

  /**
   * Map an arbitrary tag string (including aliases) to a canonical key.
   *
   * @param {string} tag
   * @returns {string} canonical key if found, otherwise the original string
   */
  function normalizeTag(tag) {
    if (typeof tag !== 'string' || tag.length === 0) return '';
    maybeLoadTagTable();

    if (!aliasToCanonical || !foldedCanonicalToCanonical) return tag;

    const folded = foldTagKey(tag);
    if (folded.length === 0) return '';

    return (
      aliasToCanonical.get(folded) ||
      foldedCanonicalToCanonical.get(folded) ||
      tag
    );
  }

  /**
   * Translate a tag to the requested language.
   *
   * Unknown tags (including before the browser table loads) return the original string.
   *
   * @param {string} tag
   * @param {'en'|'zh'} lang
   * @returns {string}
   */
  function translateTag(tag, lang = 'en') {
    if (typeof tag !== 'string' || tag.length === 0) return '';
    maybeLoadTagTable();

    if (!tagTable) return tag;

    const canonical = normalizeTag(tag);
    const entry = canonical && tagTable[canonical];
    if (!entry) return tag;

    const normalizedLang = lang === 'zh' ? 'zh' : 'en';
    const translated = entry[normalizedLang];
    return typeof translated === 'string' && translated.length > 0 ? translated : tag;
  }

  /**
   * Get all canonical tags and their translated display labels.
   *
   * @param {'en'|'zh'} lang
   * @returns {Array<{ key: string, label: string }>}
   */
  function getAllTags(lang = 'en') {
    maybeLoadTagTable();
    if (!tagTable) return [];

    const normalizedLang = lang === 'zh' ? 'zh' : 'en';
    return Object.keys(tagTable).map((key) => ({
      key,
      label: tagTable[key][normalizedLang],
    }));
  }

  // Browser globals (kept minimal for existing inline-script usage).
  if (typeof globalThis === 'object' && globalThis) {
    globalThis.translateTag = translateTag;
    globalThis.normalizeTag = normalizeTag;
    globalThis.getAllTags = getAllTags;
  }

  // CommonJS export for unit tests (task-4).
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { translateTag, normalizeTag, getAllTags };
  }

  // Kick off browser loading early (best-effort).
  maybeLoadTagTable();
})();
