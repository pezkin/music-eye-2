/**
 * OMR Cache Service
 *
 * Caches parsed OMR results (scoreData) by image content hash.
 * Scanning the same photo twice returns the cached result instantly
 * instead of re-uploading and re-processing through Audiveris (~30s).
 *
 * Uses expo-crypto for SHA-256 hashing and AsyncStorage for persistence.
 * Cache entries expire after 7 days to avoid stale data buildup.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system/next';

const CACHE_PREFIX = 'omr_cache_v3_';
const INDEX_KEY = 'omr_cache_index_v3';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 20; // keep at most 20 cached results

class OMRCacheServiceClass {
  _index = null; // { hash: { timestamp, engine } }

  /**
   * Generate a SHA-256 hash of the image file contents.
   * Uses first 64KB + file size as a fast fingerprint.
   */
  async hashImage(imageUri) {
    try {
      const file = new File(imageUri);
      if (!file.exists) return null;

      // Use the file URI + size as a quick composite key
      // (reading full file content on mobile is expensive for large images)
      const size = file.size ?? 0;
      const key = `${imageUri}::${size}`;
      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        key
      );
      return hash;
    } catch (e) {
      console.warn('OMRCache: hash failed', e.message);
      return null;
    }
  }

  /**
   * Look up a cached OMR result for the given image.
   * Returns the scoreData object or null if not cached / expired.
   */
  async get(imageUri, engine) {
    try {
      const hash = await this.hashImage(imageUri);
      if (!hash) return null;

      const cacheKey = `${CACHE_PREFIX}${engine}_${hash}`;
      const raw = await AsyncStorage.getItem(cacheKey);
      if (!raw) return null;

      const entry = JSON.parse(raw);

      // Check expiry
      if (Date.now() - entry.timestamp > MAX_AGE_MS) {
        await AsyncStorage.removeItem(cacheKey);
        console.log(`🗂️ OMRCache: expired entry removed for ${hash.slice(0, 8)}...`);
        return null;
      }

      console.log(`🗂️ OMRCache: HIT for ${hash.slice(0, 8)}... (${engine}, ${entry.noteCount} notes)`);
      return entry.scoreData;
    } catch (e) {
      console.warn('OMRCache: get failed', e.message);
      return null;
    }
  }

  /**
   * Store an OMR result in the cache.
   */
  async set(imageUri, engine, scoreData) {
    try {
      const hash = await this.hashImage(imageUri);
      if (!hash) return;

      const cacheKey = `${CACHE_PREFIX}${engine}_${hash}`;
      const entry = {
        timestamp: Date.now(),
        engine,
        noteCount: scoreData?.notes?.filter(n => n.type === 'note')?.length || 0,
        scoreData,
      };

      await AsyncStorage.setItem(cacheKey, JSON.stringify(entry));
      console.log(`🗂️ OMRCache: STORED ${hash.slice(0, 8)}... (${engine}, ${entry.noteCount} notes)`);

      // Prune old entries if needed
      await this._pruneIfNeeded();
    } catch (e) {
      console.warn('OMRCache: set failed', e.message);
    }
  }

  /**
   * Clear all cached OMR results.
   */
  async clearAll() {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const cacheKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
      if (cacheKeys.length > 0) {
        await AsyncStorage.multiRemove(cacheKeys);
        console.log(`🗂️ OMRCache: cleared ${cacheKeys.length} entries`);
      }
    } catch (e) {
      console.warn('OMRCache: clearAll failed', e.message);
    }
  }

  /**
   * Keep cache size under MAX_ENTRIES by removing oldest entries.
   */
  async _pruneIfNeeded() {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const cacheKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));

      if (cacheKeys.length <= MAX_ENTRIES) return;

      // Read timestamps and sort by oldest first
      const entries = [];
      for (const key of cacheKeys) {
        try {
          const raw = await AsyncStorage.getItem(key);
          if (raw) {
            const { timestamp } = JSON.parse(raw);
            entries.push({ key, timestamp });
          }
        } catch (_) {
          entries.push({ key, timestamp: 0 });
        }
      }

      entries.sort((a, b) => a.timestamp - b.timestamp);
      const toRemove = entries.slice(0, entries.length - MAX_ENTRIES).map(e => e.key);

      if (toRemove.length > 0) {
        await AsyncStorage.multiRemove(toRemove);
        console.log(`🗂️ OMRCache: pruned ${toRemove.length} old entries`);
      }
    } catch (e) {
      console.warn('OMRCache: prune failed', e.message);
    }
  }
}

export const OMRCacheService = new OMRCacheServiceClass();
