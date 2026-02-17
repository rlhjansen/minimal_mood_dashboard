/**
 * PanasCrypto — Client-side AES-256-GCM encryption
 *
 * All mood data is encrypted/decrypted in the browser.
 * The encryption key never leaves the device unless exported
 * as a recovery code by the user.
 *
 * Key is 256-bit random, encoded as Base32 groups for portability.
 */
window.PanasCrypto = (function () {
    'use strict';

    var ALGO     = 'AES-GCM';
    var KEY_BITS = 256;
    var IV_BYTES = 12;          // 96-bit nonce for GCM
    var LS_KEY   = 'panas_enc_key';
    var B32      = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /* ================================================================
       Base32 (RFC 4648) — encodes 256-bit key as 52 chars
       ================================================================ */
    function bytesToBase32(bytes) {
        var bits = '';
        for (var i = 0; i < bytes.length; i++) bits += bytes[i].toString(2).padStart(8, '0');
        var out = '';
        for (var j = 0; j < bits.length; j += 5) {
            var chunk = bits.substr(j, 5);
            if (chunk.length < 5) chunk += '00000'.substr(0, 5 - chunk.length);
            out += B32[parseInt(chunk, 2)];
        }
        return out;
    }

    function base32ToBytes(str) {
        str = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
        var bits = '';
        for (var i = 0; i < str.length; i++) {
            var idx = B32.indexOf(str[i]);
            if (idx >= 0) bits += idx.toString(2).padStart(5, '0');
        }
        var bytes = new Uint8Array(Math.floor(bits.length / 8));
        for (var j = 0; j < bytes.length; j++) bytes[j] = parseInt(bits.substr(j * 8, 8), 2);
        return bytes;
    }

    /* ================================================================
       Base64 helpers
       ================================================================ */
    function u8ToB64(u8) {
        var s = '';
        for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return btoa(s);
    }

    function b64ToU8(b64) {
        var s = atob(b64);
        var u8 = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
        return u8;
    }

    /* ================================================================
       Key management
       ================================================================ */
    function generateKey() {
        return crypto.subtle.generateKey(
            { name: ALGO, length: KEY_BITS },
            true,               // extractable — needed for export
            ['encrypt', 'decrypt']
        );
    }

    function exportKeyRaw(key) {
        return crypto.subtle.exportKey('raw', key).then(function (buf) {
            return new Uint8Array(buf);
        });
    }

    function importKeyRaw(rawBytes) {
        return crypto.subtle.importKey(
            'raw', rawBytes,
            { name: ALGO, length: KEY_BITS },
            true,
            ['encrypt', 'decrypt']
        );
    }

    /* Recovery code: 52 base32 chars grouped as XXXX-XXXX-… (13 groups) */
    function keyToRecoveryCode(key) {
        return exportKeyRaw(key).then(function (raw) {
            var b32 = bytesToBase32(raw);
            return b32.match(/.{1,4}/g).join('-');
        });
    }

    function recoveryCodeToKey(code) {
        var clean = code.replace(/[-\s]/g, '').toUpperCase();
        var raw   = base32ToBytes(clean);
        if (raw.length !== 32) return Promise.reject(new Error('Invalid recovery code (expected 32 bytes, got ' + raw.length + ')'));
        return importKeyRaw(raw);
    }

    /* ================================================================
       Encrypt / Decrypt
       ================================================================ */
    function encrypt(key, data) {
        var iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        return crypto.subtle.encrypt({ name: ALGO, iv: iv }, key, data).then(function (cipher) {
            var combined = new Uint8Array(IV_BYTES + cipher.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(cipher), IV_BYTES);
            return u8ToB64(combined);
        });
    }

    function decrypt(key, b64) {
        var combined = b64ToU8(b64);
        var iv       = combined.slice(0, IV_BYTES);
        var cipher   = combined.slice(IV_BYTES);
        return crypto.subtle.decrypt({ name: ALGO, iv: iv }, key, cipher).then(function (plain) {
            return new Uint8Array(plain);
        });
    }

    /* ================================================================
       Local key storage  (key material in localStorage per device)
       ================================================================ */
    function saveKeyLocally(key) {
        return exportKeyRaw(key).then(function (raw) {
            localStorage.setItem(LS_KEY, u8ToB64(raw));
        });
    }

    function loadLocalKey() {
        var b64 = localStorage.getItem(LS_KEY);
        if (!b64) return Promise.resolve(null);
        try {
            return importKeyRaw(b64ToU8(b64));
        } catch (e) {
            console.error('PanasCrypto: failed to load local key', e);
            return Promise.resolve(null);
        }
    }

    function hasLocalKey() { return !!localStorage.getItem(LS_KEY); }
    function clearLocalKey() { localStorage.removeItem(LS_KEY); }

    /* ================================================================
       Download key as file
       ================================================================ */
    function downloadKeyFile(key) {
        return keyToRecoveryCode(key).then(function (code) {
            var text = 'PANAS Mood Dashboard — Encryption Recovery Code\n'
                     + '================================================\n\n'
                     + code + '\n\n'
                     + 'Keep this file safe. Anyone with this code can decrypt your mood data.\n'
                     + 'Generated: ' + new Date().toISOString() + '\n';
            var blob = new Blob([text], { type: 'text/plain' });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href = url; a.download = 'panas-recovery-key.txt'; a.click();
            URL.revokeObjectURL(url);
        });
    }

    /* ================================================================
       Public API
       ================================================================ */
    return {
        generateKey:        generateKey,
        exportKeyRaw:       exportKeyRaw,
        importKeyRaw:       importKeyRaw,
        keyToRecoveryCode:  keyToRecoveryCode,
        recoveryCodeToKey:  recoveryCodeToKey,
        encrypt:            encrypt,
        decrypt:            decrypt,
        saveKeyLocally:     saveKeyLocally,
        loadLocalKey:       loadLocalKey,
        hasLocalKey:        hasLocalKey,
        clearLocalKey:      clearLocalKey,
        downloadKeyFile:    downloadKeyFile
    };
})();
