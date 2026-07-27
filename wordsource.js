/* WordSource — builds the puzzle vocabulary from the free Datamuse API
   (api.datamuse.com: no key required, CORS enabled).

   Datamuse caps a spelling query at 1000 results and returns them in alphabetical
   order, so a bare "?????" query yields only A-words. We therefore query each
   first letter separately (26 per length) and keep the entries that clear a
   corpus-frequency bar and carry a usable dictionary definition, which becomes
   the clue.

   The result is cached in localStorage for 30 days. Fetching happens in the
   background: play starts immediately on the cached or bundled bank and the
   larger bank swaps in when it arrives. */
(function (global) {
  'use strict';

  const CACHE_KEY = 'mini-wordbank-v3';
  const CACHE_DAYS = 30;
  const TIMEOUT_MS = 10000;
  const CONCURRENCY = 6;
  const MAX_CLUES_PER_WORD = 2;
  const MAX_CLUE_LEN = 60;
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

  // Keep curated clues where we have them: they are far punchier than dictionary
  // definitions. Fetched words supply new vocabulary, not replacement clues.
  // Set to false to make the API the sole source.
  const MERGE_BUILTIN = true;

  // Minimum corpus frequency (occurrences per million) — keeps answers fair.
  // Harvest floor. Difficulty tiers filter further, so this stays low enough to
  // leave the hard/extreme settings some genuinely obscure vocabulary.
  const MIN_FREQ = { 3: 1.5, 4: 0.8, 5: 0.4 };

  // Wiktionary definitions are formulaic, so these prefixes reliably identify
  // entries that make unfair crossword answers.
  const REJECT_DEF = new RegExp(
    '^(a |an |the )?(' +
    'initialism|acronym|abbrevia|alternative (spelling|form)|obsolete|archaic|' +
    'misspelling|eye dialect|plural of|past tense|present participle|' +
    'surname|given name|male given|female given|nickname|diminutive|' +
    'a city|a town|a village|a river|a county|a province|a state|a country|' +
    'a place|a book of the|a genus|taxonomic|symbol for|chemical symbol' +
    ')', 'i');

  // Proper nouns whose definitions don't start with a tell-tale prefix
  // ("An English surname...", "A woman converted by St. Paul").
  const REJECT_ANYWHERE = new RegExp(
    'surname|given name|forename|first name|male name|female name|' +
    'in the bible|biblical|\\bst\\.\\s|\\bsaint\\b|the capital|' +
    'a locality|a hamlet|a municipality|a suburb|a district|a borough|' +
    'a region of|a county of|a village in|a city in|a town in|a river in|' +
    'a lake in|an island in|a mountain in|a country in|a province|' +
    'a number of places|unincorporated|census-designated|\\bcounty\\b|' +
    'a community in|a neighborhood|a ghost town|a township|a parish|' +
    'a settlement|a placename|in the united states', 'i');

  // A dictionary-derived list of common English words (no proper nouns), used to
  // gate the API results. Datamuse frequency counts every sense of a spelling,
  // so without this gate place names and foreign words score high enough to pass.
  const COMMON_WORDS_URL =
    'https://raw.githubusercontent.com/dolph/dictionary/master/popular.txt';

  // Definitions that describe something other than a plain English sense.
  const REJECT_PHRASE = new RegExp(
    'aforementioned|synonym of|see also|used in|variant of|form of|refers to|:|' +
    'subjunctive|participle|conjugation|inflection|imperative mood|' +
    'indicative mood|singular of', 'i');

  const BLOCKED = new Set([
    'anal', 'anus', 'arse', 'bitch', 'boob', 'boobs', 'clit', 'cock', 'cocks',
    'crap', 'cum', 'cunt', 'dick', 'dildo', 'dyke', 'fag', 'fags', 'fuck',
    'gook', 'homo', 'jizz', 'kike', 'nigga', 'orgy', 'penis', 'piss', 'poop',
    'porn', 'prick', 'pube', 'pubes', 'pussy', 'queer', 'rape', 'raped',
    'shit', 'slut', 'sperm', 'spic', 'tits', 'turd', 'twat', 'vulva', 'wank',
    'whore'
  ]);

  /* ---------- definition -> clue ---------- */

  function stem(word) {
    return word.replace(/(ies|ing|ed|es|s)$/, '');
  }

  function cleanDefinition(raw, word) {
    if (typeof raw !== 'string') return null;

    let text = raw.replace(/^[a-z]+\t/, '').trim();   // drop the "n\t" part-of-speech tag
    const bracket = text.indexOf('[');                // Datamuse appends "[...]" cross-refs
    if (bracket !== -1) text = text.slice(0, bracket);
    if (REJECT_DEF.test(text) || REJECT_ANYWHERE.test(text)) return null;

    text = text.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (REJECT_DEF.test(text)) return null;

    // Keep only the first sense: "Unhappy; cheerless; miserable" -> "Unhappy".
    const semi = text.indexOf(';');
    if (semi >= 3) text = text.slice(0, semi);

    const lower = text.toLowerCase();
    const w = word.toLowerCase();
    if (lower.indexOf(w) !== -1) return null;          // never leak the answer
    const root = stem(w);
    if (root.length >= 4 && lower.indexOf(root) !== -1) return null;

    if (text.length > MAX_CLUE_LEN) {
      const comma = text.indexOf(',');
      if (comma > 14 && comma <= MAX_CLUE_LEN) text = text.slice(0, comma);
      else return null;
    }

    text = text.replace(/[.,;:\s]+$/, '').trim();
    if (text.length < 9 || text.split(/\s+/).length < 2) return null;
    if (REJECT_PHRASE.test(text)) return null;

    // A capitalised word after the first position means the sense is tied to a
    // proper noun ("...occurs in Yakutia", "the Hebrew Scriptures").
    const words = text.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const token = words[i].replace(/^[("']+/, '');
      if (/^[A-Z]/.test(token) && token !== 'I') return null;
    }

    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function frequencyOf(item) {
    const tags = item.tags || [];
    for (let i = 0; i < tags.length; i++) {
      if (tags[i].indexOf('f:') === 0) return parseFloat(tags[i].slice(2)) || 0;
    }
    return 0;
  }

  function harvest(items, len, out, common) {
    const exact = new RegExp('^[a-z]{' + len + '}$');
    (items || []).forEach(function (item) {
      const word = String(item.word || '').toLowerCase();
      if (!exact.test(word) || BLOCKED.has(word)) return;
      if (common && !common.has(word)) return;
      if (frequencyOf(item) < MIN_FREQ[len]) return;

      const clues = [];
      (item.defs || []).forEach(function (def) {
        if (clues.length >= MAX_CLUES_PER_WORD) return;
        const clue = cleanDefinition(def, word);
        if (clue && clues.indexOf(clue) === -1) clues.push(clue);
      });
      if (clues.length) out.push([word.toUpperCase(), clues, Math.round(frequencyOf(item) * 100) / 100]);
    });
  }

  /* ---------- fetching ---------- */

  function fetchJSON(url) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    return fetch(url, { signal: controller.signal })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) { clearTimeout(timer); return json; },
            function (err) { clearTimeout(timer); throw err; });
  }

  function runPool(tasks, limit) {
    let index = 0, failures = 0;
    function worker() {
      if (index >= tasks.length) return Promise.resolve();
      const task = tasks[index++];
      return task().catch(function () { failures++; }).then(worker);
    }
    const workers = [];
    for (let i = 0; i < Math.min(limit, tasks.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () { return failures; });
  }

  function fetchCommonWords() {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    return fetch(COMMON_WORDS_URL, { signal: controller.signal })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        clearTimeout(timer);
        const set = new Set();
        text.split('\n').forEach(function (line) {
          const w = line.trim().toLowerCase();
          if (w.length >= 3 && w.length <= 5) set.add(w);
        });
        return set.size > 1000 ? set : null;
      })
      .catch(function () { clearTimeout(timer); return null; });
  }

  function fetchAll() {
    const pairs = [];
    return fetchCommonWords().then(function (common) {
      const tasks = [];
      [3, 4, 5].forEach(function (len) {
        LETTERS.forEach(function (letter) {
          const pattern = letter + '?'.repeat(len - 1);
          tasks.push(function () {
            return fetchJSON('https://api.datamuse.com/words?sp=' + pattern + '&md=df&max=1000')
              .then(function (items) { harvest(items, len, pairs, common); });
          });
        });
      });
      return runPool(tasks, CONCURRENCY);
    }).then(function (failures) {
      const kept = dropInflections(pairs);
      if (kept.length < 400) throw new Error('only ' + kept.length + ' usable words (' + failures + ' requests failed)');
      return kept;
    });
  }

  /* Dictionary definitions are written for the lemma, so an inflected entry
     gets its base form's wording ("LEAPS" clued as "To jump"). When the base
     form is present in the same harvest, drop the inflection. */
  function dropInflections(pairs) {
    const have = Object.create(null);
    pairs.forEach(function (p) { have[p[0]] = true; });
    // The base form may live in the curated bank rather than this harvest.
    Object.keys(MiniGenerator.builtin.clues).forEach(function (w) { have[w] = true; });
    return pairs.filter(function (p) {
      const w = p[0];
      if (/S$/.test(w) && have[w.slice(0, -1)]) return false;                // TALES <- TALE
      if (/ES$/.test(w) && have[w.slice(0, -2)]) return false;               // BOXES <- BOX
      if (/IES$/.test(w) && have[w.slice(0, -3) + 'Y']) return false;        // CRIES <- CRY
      if (/ER$/.test(w) && have[w.slice(0, -1)]) return false;               // WIDER <- WIDE
      return true;
    });
  }

  /* ---------- cache ---------- */

  function readCache() {
    try {
      const data = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!data || !data.ts || !Array.isArray(data.words)) return null;
      if (Date.now() - data.ts > CACHE_DAYS * 864e5) return null;
      return data.words;
    } catch (e) { return null; }
  }

  function writeCache(pairs) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), words: pairs }));
    } catch (e) { /* quota or disabled — the cache is an optimization only */ }
  }

  /* ---------- assembly ---------- */

  let builtinText = null;
  function serializeBuiltin() {
    if (builtinText !== null) return builtinText;
    const src = MiniGenerator.builtin;
    builtinText = Object.keys(src.clues).map(function (word) {
      return word + '|' + src.clues[word].join('|');
    }).join('\n');
    return builtinText;
  }

  function bankFromPairs(pairs) {
    const bank = MERGE_BUILTIN
      ? MiniGenerator.ingest(MiniGenerator.makeBank(), serializeBuiltin())
      : MiniGenerator.makeBank();
    let added = 0;
    pairs.forEach(function (pair) {
      // A curated clue already exists for this word — don't dilute it.
      if (MERGE_BUILTIN && bank.clues[pair[0]]) return;
      if (MiniGenerator.addWord(bank, pair[0], pair[1], pair[2] || 0)) added++;
    });
    bank.fetchedCount = added;
    return bank;
  }

  global.WordSource = {
    /* Synchronous: cached bank, or null on a cold start. */
    cached: function () {
      const pairs = readCache();
      if (!pairs || !pairs.length) return null;
      return { bank: bankFromPairs(pairs), source: 'cache' };
    },

    /* Network refresh; resolves null when the cache is already fresh. */
    refresh: function (force) {
      if (!force && readCache()) return Promise.resolve(null);
      return fetchAll().then(function (pairs) {
        writeCache(pairs);
        return { bank: bankFromPairs(pairs), source: 'datamuse' };
      }).catch(function (err) {
        return { bank: null, source: 'builtin', error: String((err && err.message) || err) };
      });
    },

    clearCache: function () { try { localStorage.removeItem(CACHE_KEY); } catch (e) {} }
  };
})(window);
