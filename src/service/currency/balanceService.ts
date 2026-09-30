import type { Pool, RowDataPacket } from 'mysql2/promise';

export async function balanceMessage(database: Pool, userId: string): Promise<string> {
  const [rows] = await database.execute<RowDataPacket[]>('SELECT wallet FROM accounts WHERE user_id = ?', [userId]);
  const wallet = rows[0]?.wallet;
  if (wallet === undefined) return 'LEVELIAの口座が見つかりません。銀行パネルで口座を確認してください。';
  return `あなたの残高：**${BigInt(String(wallet)).toLocaleString('ja-JP')} LIA**\n指スマによる残高の増減はありません。`;
}
