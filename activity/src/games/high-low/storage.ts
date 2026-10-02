const BEST_STREAK_KEY = 'levelia-high-low-best';

export function readBestStreak(storage: Storage = localStorage): number {
  try {
    const value = Number.parseInt(storage.getItem(BEST_STREAK_KEY) ?? '0', 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function saveBestStreak(best: number, storage: Storage = localStorage): void {
  try {
    storage.setItem(BEST_STREAK_KEY, String(best));
  } catch {
    // The game remains playable when storage is blocked.
  }
}
