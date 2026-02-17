/**
 * PanasSync — Supabase authentication + cloud sync (no encryption)
 *
 * Depends on:
 *   window.supabase.createClient (@supabase/supabase-js v2 CDN)
 *   window.panasDB               (sql.js Database)
 *   window.panasPersist           (function — flush DB to localStorage)
 *   window.panasSQL              (sql.js SQL module — for opening cloud blobs)
 *   window.panasRefreshFromDb    (function — refresh UI after merge)
 *
 * ── Supabase project setup (run once in SQL Editor) ─────────────
 *
 *   CREATE TABLE user_data (
 *     id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id         uuid REFERENCES auth.users(id) NOT NULL UNIQUE,
 *     encrypted_blob  text NOT NULL,
 *     updated_at      timestamptz DEFAULT now()
 *   );
 *
 *   ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;
 *
 *   CREATE POLICY "Users access own data"
 *     ON user_data FOR ALL
 *     USING (auth.uid() = user_id);
 *
 * Also configure in Supabase → Authentication → URL Configuration:
 *   Site URL:      https://yourusername.github.io/your-repo/
 *   Redirect URLs: https://yourusername.github.io/your-repo/
 * ─────────────────────────────────────────────────────────────────
 */
window.PanasSync = (function () {
    'use strict';

    var LS_SETTINGS = 'panas_supabase_config';
    var client = null;
    var currentUser = null;

    /* ================================================================
       Settings (Supabase project URL + anon key)
       ================================================================ */
    function getSettings() {
        var s = localStorage.getItem(LS_SETTINGS);
        return s ? JSON.parse(s) : { url: '', anonKey: '' };
    }

    function saveSettings(url, anonKey) {
        localStorage.setItem(LS_SETTINGS, JSON.stringify({ url: url, anonKey: anonKey }));
    }

    function isConfigured() {
        var s = getSettings();
        return !!(s.url && s.anonKey);
    }

    /* ================================================================
       Supabase init
       ================================================================ */
    function initClient() {
        if (!window.supabase) return false;
        if (!isConfigured()) return false;
        var s = getSettings();
        try {
            client = window.supabase.createClient(s.url, s.anonKey);
            client.auth.onAuthStateChange(function (_event, session) {
                currentUser = session ? session.user : null;
                refreshUI();
            });
            return true;
        } catch (e) {
            console.error('PanasSync: init failed', e);
            return false;
        }
    }

    /* ================================================================
       Auth
       ================================================================ */
    function signIn(email) {
        if (!client) return Promise.resolve({ error: 'Supabase not configured' });
        return client.auth.signInWithOtp({
            email: email,
            options: { emailRedirectTo: window.location.href.split('#')[0].split('?')[0] }
        }).then(function (res) {
            return { error: res.error ? res.error.message : null };
        });
    }

    function signOut() {
        if (!client) return Promise.resolve();
        return client.auth.signOut().then(function () {
            currentUser = null;
            refreshUI();
        });
    }

    function checkSession() {
        if (!client) return Promise.resolve(null);
        return client.auth.getUser().then(function (res) {
            currentUser = res.data ? res.data.user : null;
            return currentUser;
        });
    }

    /* ================================================================
       Base64 helpers
       ================================================================ */
    function u8ToB64(u8) {
        var s = '';
        u8.forEach(function (b) { s += String.fromCharCode(b); });
        return btoa(s);
    }

    function b64ToU8(b64) {
        var s = atob(b64);
        var u = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        return u;
    }

    /* ================================================================
       Cloud push / pull (plain base64, protected by RLS)
       ================================================================ */
    function pushToCloud(dbExportFn) {
        if (!client || !currentUser) return Promise.resolve(false);
        var dbBytes = typeof dbExportFn === 'function' ? dbExportFn() : dbExportFn;
        var blob = u8ToB64(dbBytes);
        return client.from('user_data').upsert({
            user_id: currentUser.id,
            encrypted_blob: blob,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' }).then(function (res) {
            if (res.error) throw res.error;
            setSyncMsg('✓ Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), false);
            return true;
        }).catch(function (e) {
            console.error('PanasSync: push failed', e);
            setSyncMsg('Push failed: ' + (e.message || e), true);
            return false;
        });
    }

    function pullRaw() {
        if (!client || !currentUser) return Promise.resolve(null);
        return client.from('user_data')
            .select('encrypted_blob, updated_at')
            .eq('user_id', currentUser.id)
            .single()
            .then(function (res) {
                if (res.error || !res.data) return null;
                return b64ToU8(res.data.encrypted_blob);
            });
    }

    /* ================================================================
       Merge cloud DB into local DB
       ================================================================ */
    function mergeFromCloud() {
        return pullRaw().then(function (bytes) {
            if (!bytes) return false;
            var SQL = window.panasSQL;
            var db = window.panasDB;
            if (!SQL || !db) return false;

            var cloudDB;
            try { cloudDB = new SQL.Database(bytes); } catch (e) {
                console.error('PanasSync: cloud DB corrupt', e);
                setSyncMsg('Cloud data corrupted', true);
                return false;
            }

            var imported = 0;
            imported += mergeTable(cloudDB, db, 'entries');
            imported += mergeTable(cloudDB, db, 'intent_checkins');
            imported += mergeTable(cloudDB, db, 'sleep_log');
            cloudDB.close();

            if (imported > 0) {
                window.panasPersist();
                if (window.panasRefreshFromDb) window.panasRefreshFromDb();
                setSyncMsg('✓ Merged ' + imported + ' new row(s) from cloud', false);
            } else {
                setSyncMsg('✓ Up to date', false);
            }
            return imported > 0;
        }).catch(function (e) {
            console.error('PanasSync: pull/merge failed', e);
            setSyncMsg('Pull failed: ' + (e.message || e), true);
            return false;
        });
    }

    function mergeTable(srcDB, dstDB, table) {
        var imported = 0;
        try {
            var srcRes = srcDB.exec('SELECT * FROM ' + table);
            if (!srcRes.length) return 0;
            var cols = srcRes[0].columns;
            var rows = srcRes[0].values;

            var tsIdx = cols.indexOf('ts');
            if (tsIdx < 0) return 0;

            var existing = new Set();
            try {
                var dstRes = dstDB.exec('SELECT ts FROM ' + table);
                if (dstRes.length) dstRes[0].values.forEach(function (r) { existing.add(r[0]); });
            } catch (_) { return 0; }

            var insertCols = cols.filter(function (c) { return c !== 'id'; });
            var placeholders = insertCols.map(function () { return '?'; }).join(',');
            var colList = insertCols.map(function (c) { return '"' + c + '"'; }).join(',');
            var insertQ = 'INSERT INTO ' + table + ' (' + colList + ') VALUES (' + placeholders + ')';

            rows.forEach(function (row) {
                var ts = row[tsIdx];
                if (existing.has(ts)) return;
                existing.add(ts);
                var vals = [];
                cols.forEach(function (c, i) { if (c !== 'id') vals.push(row[i]); });
                try {
                    var stmt = dstDB.prepare(insertQ);
                    stmt.run(vals);
                    stmt.free();
                    imported++;
                } catch (e) {
                    console.warn('PanasSync: merge row failed for ' + table, e.message);
                }
            });
        } catch (e) { /* table doesn't exist in source */ }
        return imported;
    }

    /* ================================================================
       Inject styles
       ================================================================ */
    function injectStyles() {
        if (document.getElementById('panas-sync-css')) return;
        var style = document.createElement('style');
        style.id = 'panas-sync-css';
        style.textContent = [
            '#sync-bar{grid-column:1/-1;display:flex;align-items:center;gap:.5rem;padding:.5rem .8rem;background:#f8f9fa;border:1px solid #eee;border-radius:8px;font-size:13px;flex-wrap:wrap;min-height:32px;}',
            '#sync-bar .sb-icon{font-size:15px;}',
            '#sync-bar input[type="email"]{padding:.3rem .5rem;border:1px solid #ddd;border-radius:4px;font-size:13px;font-family:inherit;width:220px;}',
            '#sync-bar button{padding:.25rem .6rem;font-size:12px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;}',
            '#sync-bar button:hover{background:#f0f0f0;}',
            '#sync-bar .sb-msg{font-size:12px;color:#888;}',
            '#sync-bar .sb-msg.err{color:#d9534f;}',
            '#sync-bar .sb-msg.ok{color:#2a7;}',
            '#sync-bar .sb-user{font-weight:600;color:#333;}',
            '#sync-bar .sb-right{margin-left:auto;display:flex;gap:.4rem;align-items:center;}',
            '.sb-config-section{margin-top:1rem;padding-top:1rem;border-top:1px solid #ddd;}',
            '.sb-config-section strong{display:block;margin-bottom:.3rem;}',
            '.sb-config-section p{font-size:12px;color:#888;margin:.2rem 0 .5rem;}',
            '.sb-config-section label{display:block;margin-top:.6rem;font-weight:600;font-size:13px;}',
            '.sb-config-section input{width:100%;padding:.4rem;margin-top:.2rem;border:1px solid #ddd;border-radius:4px;font-family:monospace;font-size:12px;box-sizing:border-box;}',
            '.sb-config-section button{margin-top:.6rem;}',
            '.sb-config-section .sb-sql{font-size:11px;color:#999;background:#f5f5f5;padding:.5rem;border-radius:4px;margin-top:.5rem;white-space:pre-wrap;font-family:monospace;max-height:120px;overflow-y:auto;}'
        ].join('\n');
        document.head.appendChild(style);
    }

    /* ================================================================
       UI rendering
       ================================================================ */
    var syncBar = null;

    function ensureDOMElements() {
        if (!syncBar) {
            syncBar = document.createElement('div');
            syncBar.id = 'sync-bar';
            document.body.insertBefore(syncBar, document.body.firstChild);
        }
    }

    function setSyncMsg(msg, isError) {
        var el = syncBar ? syncBar.querySelector('.sb-msg') : null;
        if (!el) return;
        el.textContent = msg;
        el.className = 'sb-msg ' + (isError ? 'err' : 'ok');
    }

    /* ---- State: not configured ---- */
    function renderNotConfigured() {
        syncBar.innerHTML =
            '<span class="sb-icon">☁️</span>' +
            '<span style="color:#666">Cloud sync not configured — open ⚙️ Settings → Cloud Sync</span>';
    }

    /* ---- State: signed out ---- */
    function renderSignedOut() {
        syncBar.innerHTML =
            '<span class="sb-icon">🔒</span>' +
            '<input type="email" id="sb-email" placeholder="you@example.com">' +
            '<button id="sb-signin">Send magic link</button>' +
            '<span class="sb-msg"></span>' +
            '<span class="sb-right"><span style="color:#999;font-size:11px">or use locally without sync</span></span>';

        document.getElementById('sb-signin').addEventListener('click', function () {
            var email = document.getElementById('sb-email').value.trim();
            if (!email) { setSyncMsg('Enter your email', true); return; }
            setSyncMsg('Sending magic link…', false);
            signIn(email).then(function (res) {
                if (res.error) {
                    setSyncMsg(res.error, true);
                } else {
                    renderMagicLinkSent(email);
                }
            });
        });

        document.getElementById('sb-email').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') document.getElementById('sb-signin').click();
        });
    }

    /* ---- State: magic link sent ---- */
    function renderMagicLinkSent(email) {
        syncBar.innerHTML =
            '<span class="sb-icon">✉️</span>' +
            '<span>Check <b>' + esc(email) + '</b> for the sign-in link — click it to continue</span>' +
            '<span class="sb-msg"></span>';
    }

    /* ---- State: signed in ---- */
    function renderReady() {
        syncBar.innerHTML =
            '<span class="sb-icon">☁️</span>' +
            '<span>Synced as <span class="sb-user">' + esc(currentUser.email) + '</span></span>' +
            '<span class="sb-msg ok"></span>' +
            '<span class="sb-right">' +
            '  <button id="sb-sync" title="Sync now">↻ Sync</button>' +
            '  <button id="sb-signout">Sign out</button>' +
            '</span>';

        document.getElementById('sb-sync').addEventListener('click', function () {
            setSyncMsg('Syncing…', false);
            mergeFromCloud().then(function () {
                return pushToCloud(function () { return window.panasDB.export(); });
            });
        });

        document.getElementById('sb-signout').addEventListener('click', function () {
            signOut();
        });
    }

    /* ---- State router ---- */
    function refreshUI() {
        if (!syncBar) return;

        if (!isConfigured() || !client) {
            renderNotConfigured();
            return;
        }

        if (!currentUser) {
            renderSignedOut();
            return;
        }

        renderReady();
    }

    /* ================================================================
       Supabase config panel (injected into settings box)
       ================================================================ */
    function injectConfigUI() {
        var settingsBox = document.getElementById('settingsBox');
        if (!settingsBox || document.getElementById('sb-config-section')) return;

        var section = document.createElement('div');
        section.id = 'sb-config-section';
        section.className = 'sb-config-section';

        var s = getSettings();
        section.innerHTML =
            '<strong>☁️ Cloud Sync (Supabase)</strong>' +
            '<p>Enable multi-device sync via your own Supabase project. Data is protected by row-level security (only you can access your data).</p>' +
            '<label>Supabase Project URL:</label>' +
            '<input id="sbUrl" type="text" placeholder="https://xxxxx.supabase.co" value="' + esc(s.url) + '">' +
            '<label>Supabase Publishable Key:</label>' +
            '<input id="sbAnonKey" type="text" placeholder="eyJ..." value="' + esc(s.anonKey) + '">' +
            '<button id="saveSbSettings">Save Cloud Settings</button>' +
            '<div id="sbConfigStatus" style="font-size:12px;color:#666;margin-top:.4rem"></div>' +
            '<details style="margin-top:.6rem">' +
            '  <summary style="cursor:pointer;font-size:12px;color:#999">Supabase SQL setup instructions</summary>' +
            '  <div class="sb-sql">' +
            'CREATE TABLE user_data (\n' +
            '  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n' +
            '  user_id         uuid REFERENCES auth.users(id) NOT NULL UNIQUE,\n' +
            '  encrypted_blob  text NOT NULL,\n' +
            '  updated_at      timestamptz DEFAULT now()\n' +
            ');\n\n' +
            'ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;\n\n' +
            'CREATE POLICY "Users access own data"\n' +
            '  ON user_data FOR ALL\n' +
            '  USING (auth.uid() = user_id);' +
            '  </div>' +
            '</details>';

        settingsBox.appendChild(section);

        document.getElementById('saveSbSettings').addEventListener('click', function () {
            var url = document.getElementById('sbUrl').value.trim();
            var key = document.getElementById('sbAnonKey').value.trim();
            saveSettings(url, key);
            var status = document.getElementById('sbConfigStatus');
            if (url && key) {
                status.textContent = '✓ Saved. Reload the page to activate cloud sync.';
                status.style.color = '#2a7';
            } else {
                status.textContent = 'Cleared cloud sync settings.';
                status.style.color = '#666';
            }
        });
    }

    /* ================================================================
       Utility
       ================================================================ */
    function esc(s) { return s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; }

    /* ================================================================
       Boot
       ================================================================ */
    function boot() {
        injectStyles();
        ensureDOMElements();
        injectConfigUI();

        if (initClient()) {
            checkSession().then(function () {
                refreshUI();
                /* Pull cloud data once on page load */
                if (currentUser) mergeFromCloud();
            });
        } else {
            refreshUI();
        }
    }

    /* ================================================================
       Public API
       ================================================================ */
    var api = {
        pushToCloud: pushToCloud,
        isReady: function () { return !!(client && currentUser); }
    };

    if (window.panasDB) {
        boot();
    } else {
        window.addEventListener('panas-db-ready', boot);
    }

    return api;
})();
