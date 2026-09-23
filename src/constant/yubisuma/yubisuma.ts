export const PREFIX = 'ys';
export const CPU_ID = 'cpu';
export const TURN_TIMEOUT_MS = 120_000;
export const INVITE_TIMEOUT_MS = 300_000;
export const HISTORY_LIMIT = 50;
export const ACTIVE_GAME_LIMIT = 100;
export const MAINTENANCE_INTERVAL_MS = 30_000;
export const RULES = [
  '両者とも手を2本使ってスタートします。',
  '宣言役は交互に交代します。最初の宣言役はランダムです。',
  '宣言役は「上げる親指の本数」と「合計本数の予想」を一緒に選びます。相手は上げる本数を選びます。',
  '入力は両者が確定するまで相手に見えません。確定後の変更はできません。',
  '合計本数を当てた宣言役は手を1本抜き、先に残り0本になった人が勝ちです。',
  '各ラウンドの入力期限は2分です。期限切れは対戦終了（勝敗なし）。途中でやめると降参になります。',
  '2人プレイは、お互いを選ぶと成立します。対戦希望は5分で失効します。',
  'CPUもラウンド開始時に入力を確定します。賭け金・報酬はありません。',
].join('\n');
