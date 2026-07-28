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

  // Bumped so every existing install re-harvests through REJECT_EXPLICIT
  // instead of keeping whatever it cached before that filter existed.
  // Bumped for the vocabulary/clue-variety expansion below: MAX_CLUES_PER_WORD,
  // the frequency gate, the common-word backfill pass, and cleanDefinition's
  // truncation/proper-noun rules all changed, so any earlier cached bank needs
  // replacing rather than kept around.
  const CACHE_KEY = 'mini-wordbank-v10';
  const CACHE_DAYS = 30;
  const TIMEOUT_MS = 10000;
  const CONCURRENCY = 6;
  // Datamuse averages ~3 senses per word and some carry 20+ (checked live: a
  // sample 1000-word batch averaged 3.3 defs/word, max 36). Capping at 2 threw
  // almost all of that away, which is the direct cause of "you learn the one
  // clue for a word after a few plays" — cluesFor()/generate() already pick
  // randomly among whatever's stored, so more stored senses is what actually
  // buys variety, no new selection logic needed for that part.
  const MAX_CLUES_PER_WORD = 8;
  // Raised from 60: the clue bar wraps (height:auto, word-break:break-word in
  // styles.css) rather than clipping, and 60 was discarding otherwise-clean
  // one-clause definitions with no internal comma to cut at — e.g. silk's
  // racing-silks sense ("the garments worn by a jockey displaying the colors
  // of the horse's owner", 74 chars). A truncate-at-word-boundary fallback was
  // tried first; it kept producing clues that read as cut off mid-thought
  // even once forced to not end on an article/preposition, so this raises the
  // ceiling instead of truncating harder — the full sentence or nothing.
  const MAX_CLUE_LEN = 90;
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

  // Keep curated clues where we have them: they are far punchier than dictionary
  // definitions. Fetched words supply new vocabulary, not replacement clues.
  // Set to false to make the API the sole source.
  const MERGE_BUILTIN = true;

  // Only matters when the common-word list (below) fails to load — the normal
  // path gates on list membership instead (see harvest()) and ignores this,
  // since e.g. "amble" sits at 0.14 f/M and is a perfectly fair answer; a
  // frequency floor keeps admitting the SAME few thousand highest-frequency
  // spellings no matter how low it goes, which is the opposite of what "more
  // than 5,000 words" needs. This is just the degraded-offline-fallback floor.
  const MIN_FREQ = { 3: 0.5, 4: 0.3, 5: 0.15 };

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

  // Wiktionary/dictionary sources carry every sense a spelling has, including
  // crude slang senses of otherwise everyday words (e.g. one definition of
  // "roger" is a vulgar verb). BLOCKED below only screens words that are
  // themselves unfit as answers; this screens definition TEXT so an innocuous
  // word doesn't surface an explicit secondary sense as a puzzle clue. Checked
  // before the parenthetical-content strip, since dictionaries often tag these
  // senses as "(vulgar)" / "(offensive)" rather than stating it plainly.
  const REJECT_EXPLICIT = new RegExp(
    'sexual intercourse|have sex\\b|to have sex|an act of sex|make love|' +
    'masturbat|ejaculat|orgasm|copulat|fellatio|cunnilingus|erection|aroused|' +
    '\\bpenis\\b|\\bvagina\\b|genitalia|testicle|scrotum|foreskin|' +
    'a prostitute|act of oral sex|oral sex|anal sex|porn(?:ography)?\\b|' +
    '\\(vulgar\\)|\\(coarse slang\\)|\\(offensive\\)|\\(derogatory\\)|\\(ethnic slur\\)|' +
    'vulgar slang|derogatory term|offensive term|ethnic slur|racial slur|' +
    'excrement|\\bfeces\\b|urinat|defecat|flatulen|orgy\\b|' +
    // Generic insult/slur definitions ("a promiscuous woman", "term of abuse
    // for...") — these don't name a body part or act, but they're the same
    // category of thing: not fit to hand a player as a puzzle clue.
    'term of (abuse|contempt|disparagement)|insulting term|slang insult|' +
    'a promiscuous|loose morals|\\bslapper\\b|disparaging term|' +
    // Found live in generated puzzles: COLOR, BROWN, and MUTT all had a sense
    // that defines the word by classifying PEOPLE via race/ethnicity/skin
    // pigmentation ("an indicator of race or ethnicity", "ethnic groups having
    // dark pigmentation of the skin", "a person of mixed racial or ethnic
    // ancestry"). Not slur-level, but a bad, insensitive pick for a casual
    // word game, especially when — checked live — COLOR alone has 24 other
    // fine senses (hue, a flag, gold in a prospector's pan...). Deliberately
    // narrow: "race" meaning a competition (DERBY, RELAY, LEG) or a fantasy
    // folk (ELF, GNOME) is common and fine and must not be caught here — only
    // phrasing that classifies real people by race/ethnicity is targeted.
    '(indicator|marker) of[^.]{0,15}(race|ethnicity)|' +
    'pigmentation of the skin|' +
    '(racial|ethnic) (ancestry|origin|background|identity)|' +
    'mixed (racial|ethnic)',
    'i');

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
    if (REJECT_DEF.test(text) || REJECT_ANYWHERE.test(text) || REJECT_EXPLICIT.test(text)) return null;

    text = text.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (REJECT_DEF.test(text) || REJECT_EXPLICIT.test(text)) return null;

    // Keep only the first sense: "Unhappy; cheerless; miserable" -> "Unhappy".
    const semi = text.indexOf(';');
    if (semi >= 3) text = text.slice(0, semi);

    // Same idea for a multi-sentence definition ("A flat bread roll topped
    // with onion flakes. Instead of a hole like a bagel, it has..." — bialy).
    // Without this, the first sentence's own clean, complete definition gets
    // discarded because sentence two pushes the whole blob over MAX_CLUE_LEN
    // with no comma in range to cut at. "Mr./U.S./etc." abbreviations are the
    // one real false-split risk; requiring 2+ letters right before the period
    // avoids splitting on those single-letter-per-period patterns.
    const sentenceSplit = /\.\s+[A-Z]/.exec(text);
    if (sentenceSplit) {
      const wordBefore = (text.slice(0, sentenceSplit.index).match(/[a-zA-Z]+$/) || [''])[0];
      if (wordBefore.length >= 2) text = text.slice(0, sentenceSplit.index + 1);
    }

    const lower = text.toLowerCase();
    const w = word.toLowerCase();
    if (lower.indexOf(w) !== -1) return null;          // never leak the answer
    const root = stem(w);
    if (root.length >= 4 && lower.indexOf(root) !== -1) return null;

    if (text.length > MAX_CLUE_LEN) {
      // Only cut at a comma (a real clause boundary) — a first pass also
      // tried cutting at the nearest word boundary under the limit, which
      // technically avoided leaking a stopword at the end but still produced
      // clues that read as cut off mid-thought ("...displaying the colors" —
      // of what?). A definition either fits as a complete clause or it isn't
      // used; there's no good way to force-shorten English prose by regex.
      const comma = text.indexOf(',');
      if (comma > 14 && comma <= MAX_CLUE_LEN) text = text.slice(0, comma);
      else return null;
    }

    text = text.replace(/[.,;:\s]+$/, '').trim();
    if (text.length < 9 || text.split(/\s+/).length < 2) return null;
    if (REJECT_PHRASE.test(text)) return null;

    // A capitalised word means the sense is tied to a proper noun ("...occurs
    // in Yakutia", "the Hebrew Scriptures") — EXCEPT that dictionary defs for
    // ordinary animal/plant words routinely cite a capitalized Latin family or
    // genus name as supporting detail ("...family Fringillidae, seed-eating
    // birds..."), which isn't the same kind of proper-noun leak and was
    // getting rejected anyway. Genuine proper-noun definitions name the noun
    // up front ("A city in France", "An English surname"); taxonomic mentions
    // tend to trail later in the sentence. Only checking the first clause
    // catches the former without the latter.
    const leadClause = text.split(/[,;]/)[0];
    const words = leadClause.split(/\s+/);
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
      // The common-word list IS the quality gate in the normal case (it's
      // already curated down to ordinary English words), so it replaces the
      // frequency floor rather than stacking with it — stacking meant a
      // perfectly common word like "amble" (0.14 f/M) got dropped anyway.
      // The frequency floor only fires when that list failed to load.
      if (common) {
        if (!common.has(word)) return;
      } else if (frequencyOf(item) < MIN_FREQ[len]) {
        return;
      }

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

  function fetchJSON(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || TIMEOUT_MS);
    return fetch(url, { signal: controller.signal })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) { clearTimeout(timer); return json; },
            function (err) { clearTimeout(timer); throw err; });
  }

  /* ---------- single-word alternate definitions (for the in-game hint) ----------
     The bundled bank gives most answers exactly one clue (see clues.js for why
     hand-curating past a few hundred words doesn't scale), so "give me a
     different clue" needs a live source for the other ~80%. Datamuse's plain
     word lookup returns every sense it has on file — reusing cleanDefinition
     means an on-demand definition is filtered by the same rules (no proper
     nouns, no leaking the answer, etc.) as the bulk harvest at boot. */
  const HINT_TIMEOUT_MS = 4000;                 // a hint should feel instant or fail fast

  function fetchAltClues(word) {
    const w = String(word || '').toLowerCase();
    if (!/^[a-z]{3,5}$/.test(w)) return Promise.resolve([]);
    return fetchJSON('https://api.datamuse.com/words?sp=' + w + '&md=d&max=1', HINT_TIMEOUT_MS)
      .then(function (items) {
        const hit = items && items[0];
        if (!hit || hit.word !== w) return [];
        const out = [];
        (hit.defs || []).forEach(function (def) {
          const clue = cleanDefinition(def, w);
          if (clue && out.indexOf(clue) === -1) out.push(clue);
        });
        return out;
      })
      .catch(function () { return []; });
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

  // Datamuse caps sp= at 1000 results and ranks them by its own relevance
  // score, not alphabetically (checked live) — so a wildcard query like
  // "s????" simply never surfaces a meaningful share of real common words no
  // matter how the query is split, because they don't rank in its top 1000
  // for that broad a pattern. Checked directly: "sacks", "safes", "scans",
  // "seeds"... all missing from the bulk s???? query, all found instantly
  // (with real definitions) by looking each one up by its exact spelling.
  // Phase 2 does exactly that: after the cheap bulk pass, look up whichever
  // common words it didn't turn up, one request each. This is the only
  // approach that reliably reaches close to the full common-word list rather
  // than whatever a broad pattern query happens to rank highly.
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
      return runPool(tasks, CONCURRENCY).then(function (failures1) {
        if (!common) return failures1;             // no list to backfill against

        const have = new Set(pairs.map(function (p) { return p[0].toLowerCase(); }));
        const missing = [];
        common.forEach(function (w) { if (!have.has(w)) missing.push(w); });

        const backfill = [];
        missing.forEach(function (w) {
          const len = w.length;
          backfill.push(function () {
            return fetchJSON('https://api.datamuse.com/words?sp=' + w + '&md=d&max=1')
              .then(function (items) {
                const hit = items && items[0];
                if (hit && hit.word === w) harvest([hit], len, pairs, common);
              });
          });
        });
        return runPool(backfill, CONCURRENCY).then(function (failures2) {
          return failures1 + failures2;
        });
      });
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
    let added = 0, enriched = 0;
    pairs.forEach(function (pair) {
      // Used to skip entirely whenever the bundled bank already had the word,
      // on the theory that a fetched definition would "dilute" it. That
      // theory doesn't hold: clues.js's hand-curated overrides already win at
      // clue-pick time regardless of what's stored here (see cluesFor() in
      // generator.js), so nothing curated was ever actually at risk — the
      // words being skipped were just the plain, single-definition bundled
      // entries, which are exactly the ones that most need more variety
      // (they're the common answers a puzzle reaches for most often).
      // addWord() already unions clue lists for a word that exists, so this
      // now enriches the bundled entry instead of discarding the harvest.
      const hadWord = !!bank.clues[pair[0]];
      if (MiniGenerator.addWord(bank, pair[0], pair[1], pair[2] || 0)) {
        if (hadWord) enriched++; else added++;
      }
    });
    bank.fetchedCount = added;
    bank.enrichedCount = enriched;
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

    clearCache: function () { try { localStorage.removeItem(CACHE_KEY); } catch (e) {} },

    /* Best-effort list of alternate definitions for one answer, straight from
       Datamuse. Resolves to [] (never rejects) on timeout, offline, or no hit —
       callers decide what "no alternate available" means for them. */
    fetchAltClues: fetchAltClues
  };
})(window);
