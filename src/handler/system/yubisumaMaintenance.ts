import { MAINTENANCE_INTERVAL_MS } from '../../constant/yubisuma/yubisuma.js';
import { gameBoard } from '../../panel/yubisuma/yubisumaPanelService.js';
import type { YubisumaDependencies } from '../../type/yubisuma/interaction.js';
import { errorCode } from '../../util/system/error.js';

export function startYubisumaMaintenance(deps: YubisumaDependencies): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const ids = await deps.store.transact(deps.scope, room => room.games
        .filter(game => !game.messageId || game.publishedVersion !== JSON.stringify(gameBoard(game)))
        .map(game => game.id));
      for (const id of ids) {
        if (stopped) break;
        try { await deps.messages.sync(id); }
        catch (error) { console.error('Game board maintenance failed', { gameId: id, code: errorCode(error) }); }
      }
    } catch (error) { console.error('Game maintenance failed', { code: errorCode(error) }); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), MAINTENANCE_INTERVAL_MS);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
