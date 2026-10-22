package com.opencode.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.Charset;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Encrypted storage for provider API keys and the daemon token.
 *
 * - The AES-256 key is generated INSIDE the Android Keystore and is not extractable; this class never sees it.
 * - Values are encrypted with AES/GCM/NoPadding. The secret id is bound in as AAD, so a ciphertext copied
 *   under another id does not decrypt.
 * - SharedPreferences only ever contains base64(IV) + ":" + base64(ciphertext). There is NO plaintext fallback:
 *   if the Keystore is unusable every operation throws SecureStoreException instead of storing in the clear.
 * - get() is package-private on purpose: only Java code in this package (TermuxBackend, when it builds a provider
 *   request for the daemon) can read a secret. NativeBridge never returns a secret to JavaScript.
 *
 * Requires API 23+ (KeyGenParameterSpec). Uses only platform classes: no AndroidX, no Gradle dependency.
 */
public final class SecureStore {
    public static final class SecureStoreException extends Exception {
        public final String code;

        public SecureStoreException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "opencode_si_secrets_v1";
    private static final String PREFS = "opencode_si_secure";
    private static final String PREFIX = "s:";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int MAX_SECRET_CHARS = 8192;
    private static final Pattern ID_RE = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");
    private static final Charset UTF8 = Charset.forName("UTF-8");

    private final SharedPreferences prefs;
    private final SecureRandom random = new SecureRandom();

    public SecureStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String checkId(String id) throws SecureStoreException {
        if (id == null || !ID_RE.matcher(id).matches()) {
            throw new SecureStoreException("INVALID_ARGUMENT", "Invalid secret id.");
        }
        return id;
    }

    private SecretKey key(boolean create) throws SecureStoreException {
        try {
            KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
            ks.load(null);
            if (ks.containsAlias(KEY_ALIAS)) {
                return (SecretKey) ks.getKey(KEY_ALIAS, null);
            }
            if (!create) {
                return null;
            }
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
            kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .build());
            return kg.generateKey();
        } catch (Exception e) {
            throw new SecureStoreException("KEYSTORE_UNAVAILABLE", "The Android Keystore is not available on this device.");
        }
    }

    /** Stores (or replaces) a secret. Empty values are rejected: use delete(). */
    public synchronized void put(String id, String value) throws SecureStoreException {
        checkId(id);
        if (value == null || value.length() == 0) {
            throw new SecureStoreException("INVALID_ARGUMENT", "The secret is empty.");
        }
        if (value.length() > MAX_SECRET_CHARS) {
            throw new SecureStoreException("INVALID_ARGUMENT", "The secret is too long.");
        }
        try {
            SecretKey k = key(true);
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.ENCRYPT_MODE, k);            // Keystore generates a fresh random IV
            c.updateAAD(id.getBytes(UTF8));
            byte[] ct = c.doFinal(value.getBytes(UTF8));
            String stored = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
            if (!prefs.edit().putString(PREFIX + id, stored).commit()) {
                throw new SecureStoreException("STORAGE_FAILED", "Could not save the secret.");
            }
        } catch (SecureStoreException e) {
            throw e;
        } catch (GeneralSecurityException e) {
            throw new SecureStoreException("ENCRYPT_FAILED", "Could not encrypt the secret.");
        }
    }

    /** Returns the plaintext secret or null if absent. Package-private: never reachable from JavaScript. */
    synchronized String get(String id) throws SecureStoreException {
        checkId(id);
        String stored = prefs.getString(PREFIX + id, null);
        if (stored == null) {
            return null;
        }
        int sep = stored.indexOf(':');
        if (sep <= 0) {
            prefs.edit().remove(PREFIX + id).commit();
            throw new SecureStoreException("SECRET_CORRUPT", "The saved secret was damaged and has been removed. Enter it again.");
        }
        try {
            SecretKey k = key(false);
            if (k == null) {
                throw new KeyPermanentlyInvalidatedException();
            }
            byte[] iv = Base64.decode(stored.substring(0, sep), Base64.NO_WRAP);
            byte[] ct = Base64.decode(stored.substring(sep + 1), Base64.NO_WRAP);
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(GCM_TAG_BITS, iv));
            c.updateAAD(id.getBytes(UTF8));
            return new String(c.doFinal(ct), UTF8);
        } catch (SecureStoreException e) {
            throw e;
        } catch (Exception e) {
            // Key was wiped (new screen lock, restore from backup, ...) or the data is damaged: the value is
            // unrecoverable by design. Remove it so the UI asks for it again instead of failing forever.
            prefs.edit().remove(PREFIX + id).commit();
            throw new SecureStoreException("SECRET_UNREADABLE", "The saved secret can no longer be decrypted and was removed. Enter it again.");
        }
    }

    public synchronized boolean has(String id) throws SecureStoreException {
        checkId(id);
        return prefs.contains(PREFIX + id);
    }

    public synchronized void delete(String id) throws SecureStoreException {
        checkId(id);
        prefs.edit().remove(PREFIX + id).commit();
    }

    /** Returns the secret, creating a random 256-bit URL-safe one on first use (used for the daemon token). */
    synchronized String getOrCreateRandom(String id) throws SecureStoreException {
        String existing = get(id);
        if (existing != null) {
            return existing;
        }
        byte[] b = new byte[32];
        random.nextBytes(b);
        String token = Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        put(id, token);
        return token;
    }
}
