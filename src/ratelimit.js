'use strict';

/** Token bucket keyed by an arbitrary string (socket id, player id, IP address). */
class RateLimiter {
  constructor({ capacity, perSeconds }) {
    this.capacity = capacity;
    this.refillPerMs = capacity / (perSeconds * 1000);
    this.buckets = new Map();
  }

  take(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.refillPerMs);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  forget(key) {
    this.buckets.delete(key);
  }

  /** Drop full buckets so the map does not grow forever. */
  sweep() {
    const now = Date.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.at) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
  }
}

module.exports = { RateLimiter };
