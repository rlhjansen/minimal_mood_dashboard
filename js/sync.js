/**
 * PanasSync — Supabase authentication + encrypted cloud sync
 *
 * Depends on:
 *   window.PanasCrypto           (js/crypto.js)
 *   window.supabase.createClient (@supabase/supabase-js v2 CDN)
 *   window.panasDB               (sql.js Database — exposed by panas.html)
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
 * Also set your Site URL in Supabase → Authentication → URL Configuration
 * to the URL where you host the dashboard (for magic-link redirects).
 * ─────────────────────────────────────────────────────────────────
 */
window.PanasSync = (function () {
    'use strict';

    var LS_SETTINGS  = 'panas_supabase_config';
    var client       = null;   // Supabase client
    var currentUser  = null;
    var encKey       = null;   // CryptoKey

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
            encKey = null;
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
       Cloud push / pull
       ================================================================ */
    function pushToCloud(dbExportFn) {
        if (!client || !currentUser || !encKey) return Promise.resolve(false);
        var dbBytes = typeof dbExportFn === 'function' ? dbExportFn() : dbExportFn;
        return PanasCrypto.encrypt(encKey, dbBytes).then(function (blob) {
            return client.from('user_data').upsert({
                user_id: currentUser.id,
                encrypted_blob: blob,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });
        }).then(function (res) {
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
        if (!client || !currentUser || !encKey) return Promise.resolve(null);
        return client.from('user_data')
            .select('encrypted_blob, updated_at')
            .eq('user_id', currentUser.id)
            .single()
            .then(function (res) {
                if (res.error || !res.data) return null;
                return PanasCrypto.decrypt(encKey, res.data.encrypted_blob);
            });
    }

    function hasCloudData() {
        if (!client || !currentUser) return Promise.resolve(false);
        return client.from('user_data')
            .select('updated_at')
            .eq('user_id', currentUser.id)
            .single()
            .then(function (res) { return !res.error && !!res.data; })
            .catch(function () { return false; });
    }

    /* ================================================================
       Merge cloud DB into local DB
       ================================================================ */
    function mergeFromCloud() {
        return pullRaw().then(function (bytes) {
            if (!bytes) return false;
            var SQL = window.panasSQL;
            var db  = window.panasDB;
            if (!SQL || !db) return false;

            var cloudDB;
            try { cloudDB = new SQL.Database(bytes); } catch (e) {
                console.error('PanasSync: cloud DB corrupt', e);
                setSyncMsg('Cloud data corrupted — decrypt error', true);
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
            setSyncMsg('Pull failed: ' + (e.message || 'decryption error?'), true);
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

            /* Build set of existing timestamps for dedup */
            var tsIdx = cols.indexOf('ts');
            if (tsIdx < 0) return 0;

            var existing = new Set();
            try {
                var dstRes = dstDB.exec('SELECT ts FROM ' + table);
                if (dstRes.length) dstRes[0].values.forEach(function (r) { existing.add(r[0]); });
            } catch (_) { /* table may not exist locally yet */ return 0; }

            var insertCols = cols.filter(function (c) { return c !== 'id'; });
            var placeholders = insertCols.map(function () { return '?'; }).join(',');
            var colList = insertCols.map(function (c) { return '"' + c + '"'; }).join(',');
            var insertQ = 'INSERT INTO ' + table + ' (' + colList + ') VALUES (' + placeholders + ')';

            rows.forEach(function (row) {
                var ts = row[tsIdx];
                if (existing.has(ts)) return; // already exists
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
        } catch (e) {
            /* table doesn't exist in source — fine */
        }
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
            '#sync-bar input[type="email"],#sync-bar input[type="text"]{padding:.3rem .5rem;border:1px solid #ddd;border-radius:4px;font-size:13px;font-family:inherit;}',
            '#sync-bar input[type="email"]{width:220px;}',
            '#sync-bar button{padding:.25rem .6rem;font-size:12px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;}',
            '#sync-bar button:hover{background:#f0f0f0;}',
            '#sync-bar .sb-msg{font-size:12px;color:#888;}',
            '#sync-bar .sb-msg.err{color:#d9534f;}',
            '#sync-bar .sb-msg.ok{color:#2a7;}',
            '#sync-bar .sb-user{font-weight:600;color:#333;}',
            '#sync-bar .sb-right{margin-left:auto;display:flex;gap:.4rem;align-items:center;}',
            '#key-panel{grid-column:1/-1;background:#fffef5;border:2px solid #ffc107;border-radius:8px;padding:1rem;font-size:13px;display:none;}',
            '#key-panel.visible{display:block;}',
            '#key-panel .rcode{font-family:monospace;font-size:14px;background:#fff;border:1px solid #ddd;border-radius:4px;padding:.6rem;word-break:break-all;letter-spacing:1.5px;margin:.5rem 0;user-select:all;line-height:1.6;}',
            '#key-panel textarea{width:100%;height:56px;font-family:monospace;font-size:13px;letter-spacing:1px;padding:.4rem;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;}',
            '#key-panel .kp-actions{display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap;}',
            '#key-panel button{padding:.35rem .7rem;font-size:12px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;}',
            '#key-panel button.primary{background:#333;color:#fff;border-color:#333;}',
            '#key-panel button.primary:hover{background:#555;}',

            /* Supabase config in settings */
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
       UI rendering — state machine
       ================================================================ */
    var syncBar   = null;
    var keyPanel  = null;

    function ensureDOMElements() {
        if (!syncBar) {
            syncBar = document.createElement('div');
            syncBar.id = 'sync-bar';
            document.body.insertBefore(syncBar, document.body.firstChild);
        }
        if (!keyPanel) {
            keyPanel = document.createElement('div');
            keyPanel.id = 'key-panel';
            syncBar.insertAdjacentElement('afterend', keyPanel);
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
        keyPanel.className = '';
        keyPanel.innerHTML = '';
    }

    /* ---- State: signed out ---- */
    function renderSignedOut() {
        syncBar.innerHTML =
            '<span class="sb-icon">🔒</span>' +
            '<input type="email" id="sb-email" placeholder="you@example.com">' +
            '<button id="sb-signin">Send magic link</button>' +
            '<span class="sb-msg"></span>' +
            '<span class="sb-right"><span style="color:#999;font-size:11px">or use locally without sync</span></span>';
        keyPanel.className = '';
        keyPanel.innerHTML = '';

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
        keyPanel.className = '';
        keyPanel.innerHTML = '';
    }

    /* ---- State: logged in, need to generate key ---- */
    function renderGenerateKey() {
        syncBar.innerHTML =
            '<span class="sb-icon">🔑</span>' +
            '<span>Logged in as <span class="sb-user">' + esc(currentUser.email) + '</span></span>' +
            '<span class="sb-msg"></span>' +
            '<span class="sb-right"><button id="sb-signout">Sign out</button></span>';

        keyPanel.className = 'visible';
        keyPanel.innerHTML =
            '<strong>🔐 Set up encryption</strong>' +
            '<p>Your data will be encrypted before leaving this browser. ' +
            'No one (including the server) can read your mood data.</p>' +
            '<div class="kp-actions">' +
            '  <button class="primary" id="kp-generate">Generate encryption key</button>' +
            '  <button id="kp-import-toggle">I have a recovery code</button>' +
            '</div>' +
            '<div id="kp-import-area" style="display:none;margin-top:.6rem">' +
            '  <label style="font-weight:600;font-size:13px">Paste your recovery code:</label>' +
            '  <textarea id="kp-import-code" placeholder="XXXX-XXXX-XXXX-…"></textarea>' +
            '  <div class="kp-actions"><button class="primary" id="kp-import-go">Unlock</button></div>' +
            '</div>';

        document.getElementById('sb-signout').addEventListener('click', function () { signOut(); });

        document.getElementById('kp-generate').addEventListener('click', function () {
            PanasCrypto.generateKey().then(function (key) {
                encKey = key;
                return PanasCrypto.saveKeyLocally(key).then(function () {
                    return PanasCrypto.keyToRecoveryCode(key);
                });
            }).then(function (code) {
                renderShowRecoveryCode(code, true);
            });
        });

        document.getElementById('kp-import-toggle').addEventListener('click', function () {
            var area = document.getElementById('kp-import-area');
            area.style.display = area.style.display === 'none' ? 'block' : 'none';
        });

        document.getElementById('kp-import-go').addEventListener('click', function () {
            var code = document.getElementById('kp-import-code').value.trim();
            if (!code) return;
            PanasCrypto.recoveryCodeToKey(code).then(function (key) {
                encKey = key;
                return PanasCrypto.saveKeyLocally(key);
            }).then(function () {
                keyPanel.className = '';
                setSyncMsg('Key imported — syncing…', false);
                return mergeFromCloud();
            }).then(function () {
                renderReady();
            }).catch(function (e) {
                setSyncMsg('Invalid recovery code: ' + e.message, true);
            });
        });
    }

    /* ---- State: show recovery code (after generation) ---- */
    function renderShowRecoveryCode(code, isNew) {
        keyPanel.className = 'visible';
        keyPanel.innerHTML =
            '<strong>🔐 Your Recovery Code</strong>' +
            '<p>' + (isNew
                ? 'Save this code securely (password manager, etc.). You\'ll need it to access your data on another device. <b>It cannot be recovered if lost.</b>'
                : 'This is your existing recovery code:') + '</p>' +
            '<div class="rcode">' + esc(code) + '</div>' +
            '<div class="kp-actions">' +
            '  <button id="kp-copy">📋 Copy</button>' +
            '  <button id="kp-download">💾 Download .txt</button>' +
            '  <button class="primary" id="kp-done">I\'ve saved it — continue</button>' +
            '</div>';

        document.getElementById('kp-copy').addEventListener('click', function () {
            navigator.clipboard.writeText(code).then(function () {
                document.getElementById('kp-copy').textContent = '✓ Copied';
            }).catch(function () {
                /* fallback */
                var ta = document.createElement('textarea');
                ta.value = code; document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); document.body.removeChild(ta);
                document.getElementById('kp-copy').textContent = '✓ Copied';
            });
        });

        document.getElementById('kp-download').addEventListener('click', function () {
            PanasCrypto.downloadKeyFile(encKey);
        });

        document.getElementById('kp-done').addEventListener('click', function () {
            keyPanel.className = '';
            keyPanel.innerHTML = '';
            /* If new key — push existing local data to cloud */
            if (isNew) {
                setSyncMsg('Encrypting & uploading…', false);
                pushToCloud(function () { return window.panasDB.export(); }).then(function () {
                    renderReady();
                });
            } else {
                renderReady();
            }
        });
    }

    /* ---- State: ready (logged in + key) ---- */
    function renderReady() {
        syncBar.innerHTML =
            '<span class="sb-icon">☁️</span>' +
            '<span>Synced as <span class="sb-user">' + esc(currentUser.email) + '</span></span>' +
            '<span class="sb-msg ok"></span>' +
            '<span class="sb-right">' +
            '  <button id="sb-sync" title="Sync now">↻ Sync</button>' +
            '  <button id="sb-key" title="Show recovery code">🔑</button>' +
            '  <button id="sb-signout">Sign out</button>' +
            '</span>';
        keyPanel.className = '';
        keyPanel.innerHTML = '';

        document.getElementById('sb-sync').addEventListener('click', function () {
            setSyncMsg('Syncing…', false);
            mergeFromCloud().then(function () {
                return pushToCloud(function () { return window.panasDB.export(); });
            });
        });

        document.getElementById('sb-key').addEventListener('click', function () {
            PanasCrypto.keyToRecoveryCode(encKey).then(function (code) {
                renderShowRecoveryCode(code, false);
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

        if (!encKey) {
            /* Check if we have a local key */
            if (PanasCrypto.hasLocalKey()) {
                PanasCrypto.loadLocalKey().then(function (key) {
                    if (key) {
                        encKey = key;
                        renderReady();
                        /* Auto-pull on first ready */
                        mergeFromCloud();
                    } else {
                        renderGenerateKey();
                    }
                });
            } else {
                /* Check if cloud has data (existing user, new device) */
                hasCloudData().then(function (has) {
                    if (has) {
                        renderNeedImport();
                    } else {
                        renderGenerateKey();
                    }
                });
            }
            return;
        }

        renderReady();
    }

    /* ---- State: cloud has data, user needs to import key ---- */
    function renderNeedImport() {
        syncBar.innerHTML =
            '<span class="sb-icon">🔑</span>' +
            '<span>Logged in as <span class="sb-user">' + esc(currentUser.email) + '</span></span>' +
            '<span class="sb-msg"></span>' +
            '<span class="sb-right"><button id="sb-signout">Sign out</button></span>';

        keyPanel.className = 'visible';
        keyPanel.innerHTML =
            '<strong>🔐 Unlock your data</strong>' +
            '<p>Your encrypted data is in the cloud. Enter your recovery code to decrypt it.</p>' +
            '<textarea id="kp-import-code" placeholder="XXXX-XXXX-XXXX-…"></textarea>' +
            '<div class="kp-actions">' +
            '  <button class="primary" id="kp-import-go">Unlock</button>' +
            '  <button id="kp-new-key">Start fresh (new key)</button>' +
            '</div>';

        document.getElementById('sb-signout').addEventListener('click', function () { signOut(); });

        document.getElementById('kp-import-go').addEventListener('click', function () {
            var code = document.getElementById('kp-import-code').value.trim();
            if (!code) { setSyncMsg('Enter recovery code', true); return; }
            setSyncMsg('Decrypting…', false);
            PanasCrypto.recoveryCodeToKey(code).then(function (key) {
                encKey = key;
                return PanasCrypto.saveKeyLocally(key);
            }).then(function () {
                return mergeFromCloud();
            }).then(function () {
                renderReady();
            }).catch(function (e) {
                setSyncMsg('Invalid code or decryption failed — wrong code?', true);
                console.error('PanasSync: import failed', e);
            });
        });

        document.getElementById('kp-new-key').addEventListener('click', function () {
            if (!confirm('This will generate a new key. Your cloud data (encrypted with the old key) will be replaced. Continue?')) return;
            PanasCrypto.generateKey().then(function (key) {
                encKey = key;
                return PanasCrypto.saveKeyLocally(key).then(function () {
                    return PanasCrypto.keyToRecoveryCode(key);
                });
            }).then(function (code) {
                renderShowRecoveryCode(code, true);
            });
        });
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
            '<p>Enable encrypted multi-device sync. Your data is encrypted before it leaves this browser.</p>' +
            '<label>Supabase Project URL:</label>' +
            '<input id="sbUrl" type="text" placeholder="https://xxxxx.supabase.co" value="' + esc(s.url) + '">' +
            '<label>Supabase Anon Key:</label>' +
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
        if (!window.PanasCrypto) {
            console.warn('PanasSync: PanasCrypto not available');
            return;
        }

        injectStyles();
        ensureDOMElements();
        injectConfigUI();

        if (initClient()) {
            checkSession().then(function () {
                refreshUI();
            });
        } else {
            refreshUI();
        }
    }

    /* ================================================================
       Public API
       ================================================================ */
    var api = {
        /* For external callers (e.g. persist hook) */
        pushToCloud: pushToCloud,
        isReady: function () { return !!(client && currentUser && encKey); }
    };

    /* Auto-boot when DB is ready (same pattern as intent.js) */
    if (window.panasDB) {
        boot();
    } else {
        window.addEventListener('panas-db-ready', boot);
    }

    return api;
})();
