/**
 * Intent Calibration & Alignment Layer
 *
 * Lightweight 3-hour check-in system with:
 *   – Retrospective / prospective free-text inputs
 *   – Alignment scoring (sentence-embedding cosine similarity, text-overlap fallback)
 *   – Gentle drift feedback
 *   – Collapse early-warning heuristic
 *
 * Depends on window.panasDB  (sql.js Database)
 *         and window.panasPersist (function to flush DB to localStorage)
 *
 * Fires a 'panas-db-ready' CustomEvent when those are available.
 */
(function () {
    'use strict';

    /* ===================================================================
       Configuration (all user-tuneable knobs in one place)
       =================================================================== */
    const CFG = {
        intervalHours:     3,
        windowStart:       8,      // earliest hour for check-in prompts
        windowEnd:         20,     // latest  hour for check-in prompts
        alignThreshold:    0.35,   // below this → drift flag
        driftWindowBlocks: 5,      // look-back for alignment trend
        pollMs:            5 * 60 * 1000,  // how often to check if check-in is due
        lsLastNotify:      'intent_last_notify',
    };

    let db, persist;
    let embedModel      = null;
    let embeddingsReady  = false;
    let embeddingsLoading = false;

    /* ===================================================================
       DB helpers
       =================================================================== */
    function initSchema() {
        db.exec(`CREATE TABLE IF NOT EXISTS intent_checkins (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            ts                  TEXT NOT NULL,
            retrospective       TEXT DEFAULT '',
            prospective         TEXT DEFAULT '',
            target_words        TEXT DEFAULT '',
            hours_slept         REAL,
            alignment_retro     REAL,
            alignment_prospect  REAL,
            drift_flag          INTEGER DEFAULT 0,
            retro_embedding     TEXT,
            prospect_embedding  TEXT,
            target_embedding    TEXT
        )`);
        persist();
    }

    function rowToObj(cols, row) {
        var o = {};
        cols.forEach(function (c, i) { o[c] = row[i]; });
        return o;
    }

    function getLastCheckin() {
        var res = db.exec('SELECT * FROM intent_checkins ORDER BY id DESC LIMIT 1');
        if (!res.length || !res[0].values.length) return null;
        return rowToObj(res[0].columns, res[0].values[0]);
    }

    function getRecentCheckins(n) {
        n = n || 10;
        var res = db.exec('SELECT * FROM intent_checkins ORDER BY id DESC LIMIT ' + n);
        if (!res.length) return [];
        var cols = res[0].columns;
        return res[0].values.map(function (r) { return rowToObj(cols, r); });
    }

    /* ===================================================================
       Embeddings  (Transformers.js via dynamic import → text-overlap fallback)
       =================================================================== */
    async function initEmbeddings() {
        if (embeddingsLoading) return;
        embeddingsLoading = true;
        try {
            /* Dynamic import works from http(s):// served pages.
               From file:// it will throw — that's fine, we fall back. */
            var mod = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
            embedModel = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                progress_callback: function (p) {
                    if (p.status === 'progress') {
                        setStatus('Loading model… ' + (p.progress || 0).toFixed(0) + '%');
                    }
                }
            });
            embeddingsReady = true;
            updateEmbedBadge(true);
            setStatus('');
            console.log('Intent: Embedding model loaded (semantic similarity active)');
        } catch (e) {
            embeddingsReady = false;
            updateEmbedBadge(false);
            console.warn('Intent: Embedding model unavailable – using text-overlap fallback.', e.message);
        }
        embeddingsLoading = false;
    }

    function updateEmbedBadge(ok) {
        var el = document.getElementById('embed-status');
        if (!el) return;
        el.textContent = ok
            ? '✓ semantic similarity'
            : '○ text overlap (serve via http for semantic)';
        el.style.color = ok ? '#2a7' : '#999';
    }

    async function getEmbedding(text) {
        if (!text || !text.trim() || !embeddingsReady || !embedModel) return null;
        try {
            var out = await embedModel(text, { pooling: 'mean', normalize: true });
            return Array.from(out.data);
        } catch (e) { return null; }
    }

    /* ---- vector math ------------------------------------------------- */
    function cosineSim(a, b) {
        if (!a || !b || a.length !== b.length) return null;
        var dot = 0, nA = 0, nB = 0;
        for (var i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            nA  += a[i] * a[i];
            nB  += b[i] * b[i];
        }
        var denom = Math.sqrt(nA) * Math.sqrt(nB);
        return denom === 0 ? 0 : dot / denom;
    }

    /* ---- bag-of-words fallback --------------------------------------- */
    var STOPS = new Set(
        'the a an is it to in on for of and or i my me was did do be this that with have has had not but at by from so'.split(' ')
    );
    function tokenize(s) {
        return s.toLowerCase().split(/\W+/).filter(function (w) { return w.length > 1 && !STOPS.has(w); });
    }
    function textOverlapSim(a, b) {
        if (!a || !b || !a.trim() || !b.trim()) return null;
        var tokA = tokenize(a), tokB = tokenize(b);
        if (!tokA.length || !tokB.length) return null;
        var vocabArr = Array.from(new Set(tokA.concat(tokB)));
        var vecA = vocabArr.map(function (w) { return tokA.filter(function (t) { return t === w; }).length; });
        var vecB = vocabArr.map(function (w) { return tokB.filter(function (t) { return t === w; }).length; });
        return cosineSim(vecA, vecB);
    }

    /* ===================================================================
       Alignment scoring
       =================================================================== */
    async function computeAlignment(retro, prospect, target) {
        var prev = getLastCheckin();
        var alignRetro = null, alignProspect = null;
        var retroEmbed = null, prospectEmbed = null, targetEmbed = null;

        if (embeddingsReady) {
            retroEmbed    = await getEmbedding(retro);
            prospectEmbed = await getEmbedding(prospect);
            targetEmbed   = await getEmbedding(target);

            if (prev && prev.prospect_embedding) {
                try {
                    var prevEmbed = JSON.parse(prev.prospect_embedding);
                    alignRetro = cosineSim(prevEmbed, retroEmbed);
                } catch (_) { /* corrupt embedding */ }
            }
            if (targetEmbed && prospectEmbed) {
                alignProspect = cosineSim(targetEmbed, prospectEmbed);
            }
        } else {
            if (prev && prev.prospective && retro) {
                alignRetro = textOverlapSim(prev.prospective, retro);
            }
            if (target && prospect) {
                alignProspect = textOverlapSim(target, prospect);
            }
        }

        return {
            alignRetro:    alignRetro,
            alignProspect: alignProspect,
            retroEmbed:    retroEmbed,
            prospectEmbed: prospectEmbed,
            targetEmbed:   targetEmbed
        };
    }

    /* ===================================================================
       Collapse early-warning heuristic
       =================================================================== */
    function computeCollapseWarning() {
        var flags = [];

        /* 1. Rolling 7-day sleep average */
        try {
            var sr = db.exec(
                "SELECT hours_slept FROM intent_checkins " +
                "WHERE hours_slept IS NOT NULL AND ts >= datetime('now','-7 days') " +
                "ORDER BY ts DESC"
            );
            if (sr.length && sr[0].values.length >= 3) {
                var vals = sr[0].values.map(function (r) { return r[0]; });
                var avg  = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
                if (avg < 6.5) {
                    flags.push({
                        type: 'sleep',
                        msg: '7-day sleep avg: ' + avg.toFixed(1) + 'h',
                        severity: avg < 5.5 ? 'high' : 'medium'
                    });
                }
            }
        } catch (_) { /* no entries */ }

        /* 2. Strain: increase in negative PANAS signals */
        try {
            var nr = db.exec(
                "SELECT negative_score FROM entries " +
                "WHERE ts >= datetime('now','-7 days') ORDER BY ts ASC"
            );
            if (nr.length && nr[0].values.length >= 4) {
                var nv  = nr[0].values.map(function (r) { return r[0]; });
                var mid = Math.floor(nv.length / 2);
                var earlier = nv.slice(0, mid);
                var recent  = nv.slice(mid);
                var avgE = earlier.reduce(function (a, b) { return a + b; }, 0) / earlier.length;
                var avgR = recent.reduce(function (a, b)  { return a + b; }, 0) / recent.length;
                if (avgR > avgE * 1.2) {
                    flags.push({
                        type: 'strain',
                        msg: 'Strain trending up (' + avgE.toFixed(0) + ' → ' + avgR.toFixed(0) + ')',
                        severity: 'medium'
                    });
                }
            }
        } catch (_) { }

        /* 3. Alignment decline over recent blocks */
        try {
            var ar = db.exec(
                'SELECT alignment_retro FROM intent_checkins ' +
                'WHERE alignment_retro IS NOT NULL ORDER BY id DESC LIMIT ' + CFG.driftWindowBlocks
            );
            if (ar.length && ar[0].values.length >= 3) {
                var av   = ar[0].values.map(function (r) { return r[0]; }).reverse();
                var mid2 = Math.floor(av.length / 2);
                var first  = av.slice(0, mid2);
                var second = av.slice(mid2);
                var avgF = first.reduce(function (a, b)  { return a + b; }, 0) / first.length;
                var avgS = second.reduce(function (a, b) { return a + b; }, 0) / second.length;
                if (avgS < avgF * 0.8) {
                    flags.push({
                        type: 'alignment',
                        msg: 'Alignment declining (' + (avgF * 100).toFixed(0) + '% → ' + (avgS * 100).toFixed(0) + '%)',
                        severity: 'medium'
                    });
                }
            }
        } catch (_) { }

        return { downshift: flags.length >= 2, flags: flags };
    }

    /* ===================================================================
       Notifications
       =================================================================== */
    function isInWindow() {
        var h = new Date().getHours();
        return h >= CFG.windowStart && h < CFG.windowEnd;
    }

    function shouldCheckIn() {
        if (!isInWindow()) return false;
        var last = getLastCheckin();
        if (!last) return true;
        var elapsed = (Date.now() - new Date(last.ts).getTime()) / 3600000;
        return elapsed >= CFG.intervalHours;
    }

    function requestNotifyPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    function fireNotification() {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Intent Check-In', {
                body: "Time for a 3-hour check-in. What did you do? What's next?",
                tag: 'intent-checkin'
            });
        }
        highlightSection();
    }

    function highlightSection() {
        var note = document.getElementById('intent-notification');
        if (note) {
            note.style.display = 'block';
            note.innerHTML =
                '<strong>Check-in due</strong> — What did you do? What\'s your intent for the next block?';
        }
        /* gentle pulse on section border */
        var sec = document.getElementById('intent-section');
        if (sec) { sec.classList.add('intent-highlight'); }
    }

    function startNotifyLoop() {
        requestNotifyPermission();
        if (shouldCheckIn()) highlightSection();
        setInterval(function () {
            if (!shouldCheckIn()) return;
            var last = localStorage.getItem(CFG.lsLastNotify);
            var now  = Date.now();
            if (!last || (now - parseInt(last, 10)) > CFG.intervalHours * 3600000 / 2) {
                fireNotification();
                localStorage.setItem(CFG.lsLastNotify, now.toString());
            }
        }, CFG.pollMs);
    }

    /* ===================================================================
       UI helpers
       =================================================================== */
    function esc(s) { return s ? s.replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }

    function setStatus(msg) {
        var el = document.getElementById('intent-status');
        if (el) el.textContent = msg;
    }

    function fmt(d) {
        return d.toLocaleDateString() + ' ' +
            d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    /* ===================================================================
       Build DOM — injected into #intent-anchor (inside #right column)
       =================================================================== */
    function buildUI() {
        var anchor = document.getElementById('intent-anchor');
        if (!anchor) {
            console.error('Intent module: #intent-anchor not found');
            return;
        }

        var section = document.createElement('div');
        section.id = 'intent-section';
        section.innerHTML = [
            '<h2>Intent Check-In</h2>',

            '<div id="intent-notification" class="intent-note" style="display:none"></div>',
            '<div id="collapse-warning" class="intent-collapse" style="display:none"></div>',
            '<div id="drift-feedback" class="intent-drift" style="display:none"></div>',

            '<div class="intent-form">',
            '  <div class="intent-field">',
            '    <label for="intent-retro">What did I actually do since the last check-in?</label>',
            '    <textarea id="intent-retro" rows="2" placeholder="Retrospective…"></textarea>',
            '  </div>',
            '  <div class="intent-field">',
            '    <label for="intent-prospect">What\'s my intent / direction for the next block?</label>',
            '    <textarea id="intent-prospect" rows="2" placeholder="e.g. Ship parsing module, Recover &amp; rest…"></textarea>',
            '  </div>',
            '  <div class="intent-actions">',
            '    <button id="intent-save">Check In</button>',
            '    <span id="intent-status" class="intent-status"></span>',
            '    <span id="embed-status" class="intent-status" style="margin-left:auto"></span>',
            '  </div>',
            '</div>',

            '<details class="intent-history" id="intent-history-box">',
            '  <summary><strong>Recent Check-ins</strong></summary>',
            '  <div id="intent-list"></div>',
            '</details>'
        ].join('\n');

        anchor.appendChild(section);
        document.getElementById('intent-save').addEventListener('click', handleCheckin);
    }

    /* ===================================================================
       Check-in handler
       =================================================================== */
    async function handleCheckin() {
        var retro    = document.getElementById('intent-retro').value.trim();
        var prospect = document.getElementById('intent-prospect').value.trim();
        /* Sleep comes from the PANAS-side input */
        var sleep    = window.panasGetSleep ? window.panasGetSleep() : null;

        if (!retro && !prospect) {
            setStatus('Please fill in at least one field.');
            return;
        }

        setStatus('Computing alignment…');

        /* For alignment, we treat prospect as both intent and target direction */
        var result = await computeAlignment(retro, prospect, prospect);
        var driftFlag = (result.alignRetro !== null && result.alignRetro < CFG.alignThreshold) ? 1 : 0;
        var ts = new Date().toISOString();

        var stmt = db.prepare(
            'INSERT INTO intent_checkins ' +
            '(ts, retrospective, prospective, target_words, hours_slept, ' +
            ' alignment_retro, alignment_prospect, drift_flag, ' +
            ' retro_embedding, prospect_embedding, target_embedding) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?)'
        );
        stmt.run([
            ts, retro, prospect, '', sleep,
            result.alignRetro, result.alignProspect, driftFlag,
            result.retroEmbed    ? JSON.stringify(result.retroEmbed)    : null,
            result.prospectEmbed ? JSON.stringify(result.prospectEmbed) : null,
            result.targetEmbed   ? JSON.stringify(result.targetEmbed)   : null
        ]);
        stmt.free();
        persist();

        /* clear form */
        document.getElementById('intent-retro').value   = '';
        document.getElementById('intent-prospect').value = '';

        /* hide due-banner */
        document.getElementById('intent-notification').style.display = 'none';
        var sec = document.getElementById('intent-section');
        if (sec) sec.classList.remove('intent-highlight');

        /* drift feedback */
        if (driftFlag) {
            showDriftFeedback(result.alignRetro);
        } else {
            document.getElementById('drift-feedback').style.display = 'none';
        }

        renderCollapseWarning();
        renderHistory();

        /* status line */
        var msg = 'Checked in.';
        if (result.alignRetro !== null) msg += ' Alignment: ' + (result.alignRetro * 100).toFixed(0) + '%';
        setStatus(msg);
    }

    /* ===================================================================
       Drift feedback
       =================================================================== */
    function showDriftFeedback(score) {
        var el = document.getElementById('drift-feedback');
        el.style.display = 'block';
        el.innerHTML =
            '<strong>Intent drift detected</strong> (alignment: ' + (score * 100).toFixed(0) + '%)<br>' +
            '<span style="color:#666">Was this shift intentional or reactive? ' +
            'Neither answer is wrong — just notice.</span>';
    }

    /* ===================================================================
       Collapse warning banner
       =================================================================== */
    function renderCollapseWarning() {
        var collapse = computeCollapseWarning();
        var el = document.getElementById('collapse-warning');

        if (collapse.downshift) {
            el.style.display   = 'block';
            el.style.background = '#fff0f0';
            el.style.borderColor = '#d9534f';
            el.innerHTML =
                '<strong>⚡ Consider a 10 % downshift</strong><br>' +
                collapse.flags.map(function (f) { return '<span>• ' + esc(f.msg) + '</span>'; }).join('<br>');
        } else if (collapse.flags.length === 1) {
            el.style.display   = 'block';
            el.style.background = '#fffbe6';
            el.style.borderColor = '#e6c300';
            el.innerHTML =
                '<strong>📍 Note</strong><br>' +
                collapse.flags.map(function (f) { return '<span>• ' + esc(f.msg) + '</span>'; }).join('<br>');
        } else {
            el.style.display = 'none';
        }
    }

    /* ===================================================================
       History list
       =================================================================== */
    function renderHistory() {
        var list = document.getElementById('intent-list');
        if (!list) return;
        var checkins = getRecentCheckins(10);
        if (!checkins.length) {
            list.innerHTML = '<p style="color:#999;font-size:13px">No check-ins yet.</p>';
            return;
        }

        list.innerHTML = checkins.map(function (c) {
            var ts   = new Date(c.ts);
            var time = fmt(ts);
            var aStr = c.alignment_retro !== null ? (c.alignment_retro * 100).toFixed(0) + '%' : '—';
            var drift = c.drift_flag
                ? ' style="border-left:3px solid #d9534f;padding-left:8px"'
                : '';
            var parts = [];
            parts.push('<div class="intent-entry"' + drift + '>');
            parts.push('  <div class="intent-entry-head">');
            parts.push('    <span class="ie-time">' + time + '</span>');
            parts.push('    <span class="ie-align" title="Alignment with previous intent">↔ ' + aStr + '</span>');
            if (c.drift_flag) parts.push('    <span class="ie-badge ie-badge--drift">drift</span>');
            parts.push('  </div>');
            if (c.retrospective) parts.push('  <div class="ie-text"><b>Did:</b> ' + esc(c.retrospective) + '</div>');
            if (c.prospective)   parts.push('  <div class="ie-text"><b>Next:</b> ' + esc(c.prospective) + '</div>');
            if (c.hours_slept)   parts.push('  <div class="ie-sleep">💤 ' + c.hours_slept + 'h</div>');
            parts.push('</div>');
            return parts.join('\n');
        }).join('');
    }

    /* ===================================================================
       Initialization
       =================================================================== */
    function boot() {
        db      = window.panasDB;
        persist = window.panasPersist;
        if (!db || !persist) {
            console.error('Intent module: PANAS DB not available');
            return;
        }
        initSchema();
        buildUI();
        renderCollapseWarning();
        renderHistory();
        startNotifyLoop();
        /* load embedding model async — non-blocking */
        initEmbeddings();
    }

    if (window.panasDB) {
        boot();
    } else {
        window.addEventListener('panas-db-ready', boot);
    }
})();