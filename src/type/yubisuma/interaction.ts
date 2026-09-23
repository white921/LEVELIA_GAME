import type { Pool } from 'mysql2/promise';
import type { Scope } from './yubisuma.js';
import type { YubisumaStore } from '../../service/yubisuma/yubisumaStore.js';
import type { YubisumaMessageService } from '../../service/yubisuma/yubisumaMessageService.js';

export interface YubisumaDependencies {
  store: YubisumaStore;
  messages: Pick<YubisumaMessageService, 'sync'>;
  scope: Scope;
  database: Pool;
  balanceMode: 'lia' | 'unavailable';
}
