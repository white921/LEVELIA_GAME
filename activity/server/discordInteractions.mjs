import nacl from 'tweetnacl';
import { ApiError, sendJson, sendMethodNotAllowed } from './http.mjs';
import { canManageHighLow, executeAdminAction, parseAdminAction } from './highLowAdmin.mjs';
import { errorMetadata } from './safeLog.mjs';

const ephemeral = content => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });

export function createDiscordInteractions({ env, store, fetchImpl = fetch, now = Date.now }) {
  const keyHex = env.DISCORD_PUBLIC_KEY?.trim();
  if (keyHex && !/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('DISCORD_PUBLIC_KEY must be a 32-byte hex key');
  const publicKey = keyHex ? Buffer.from(keyHex, 'hex') : null;
  const jobs = new Set();

  async function complete(interaction, action) {
    let content;
    try { content = await executeAdminAction(store, action, interaction); }
    catch (error) {
      console.error('High-low admin command failed', errorMetadata(error));
      content = '設定の結果を確認できませんでした。時間を置いて /ハイロー還元率 確認 で現在の設定を確認してください。';
    }
    try {
      const result = await fetchImpl(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${encodeURIComponent(interaction.token)}/messages/@original`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000),
      });
      if (!result.ok) console.error('High-low admin reply failed', { status: result.status });
    } catch { console.error('High-low admin reply unavailable'); }
  }

  return {
    async handle(request, response) {
      if (request.method !== 'POST') { sendMethodNotAllowed(response, ['POST']); return; }
      if (!publicKey) throw new ApiError(503, 'interactions_not_configured', 'Discord interactions are not configured');
      const timestamp = request.headers['x-signature-timestamp'];
      const signature = request.headers['x-signature-ed25519'];
      if (typeof timestamp !== 'string' || !/^\d{10,12}$/.test(timestamp)
        || Math.abs(now() / 1000 - Number(timestamp)) > 300
        || typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) {
        throw new ApiError(401, 'invalid_signature', 'Invalid interaction signature');
      }
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 65_536) throw new ApiError(413, 'payload_too_large', 'Interaction body is too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!nacl.sign.detached.verify(
        Buffer.concat([Buffer.from(timestamp), body]),
        Buffer.from(signature, 'hex'),
        publicKey,
      )) {
        throw new ApiError(401, 'invalid_signature', 'Invalid interaction signature');
      }
      let interaction;
      try { interaction = JSON.parse(body.toString('utf8')); }
      catch { throw new ApiError(400, 'invalid_json', 'Invalid interaction body'); }
      if (interaction?.type === 1) { sendJson(response, 200, { type: 1 }); return; }
      if (!interaction || interaction.application_id !== env.DISCORD_CLIENT_ID?.trim()
        || !canManageHighLow(interaction, env.GUILD_ID?.trim())) {
        sendJson(response, 200, ephemeral('このコマンドは指定サーバーの管理3ロール（英傑・皇帝・システム支配人）専用です。'));
        return;
      }
      let action;
      try { action = parseAdminAction(interaction); }
      catch (error) { sendJson(response, 200, ephemeral(error.message)); return; }
      if (!/^[1-9]\d{16,19}$/.test(interaction.id) || !/^[1-9]\d{16,19}$/.test(interaction.member?.user?.id)
        || typeof interaction.token !== 'string' || !interaction.token.length) {
        throw new ApiError(400, 'invalid_interaction', 'Invalid interaction metadata');
      }
      // Acknowledge before database I/O so slow transactions cannot exceed Discord's deadline.
      sendJson(response, 200, { type: 5, data: { flags: 64 } });
      const job = complete(interaction, action);
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    },
    async close() { await Promise.allSettled([...jobs]); },
  };
}
