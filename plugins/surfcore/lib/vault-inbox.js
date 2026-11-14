// 记忆库自动收录：把桥接/桌宠写下的候选句抽词入库（插件进程，每分钟一次）。
//
// 候选来自各角色的 `characters/<id>/memory/vault-inbox.jsonl`：
// bridge（QQ，当前角色）、pet-chat（网页/桌宠，带 characterId）在主人说「记住/答应/生日…」时追加一行。
// 这里按角色分别 drain，收进该角色自己的 vault。
import {
  takeVaultCandidates, commitVaultCandidates, rollbackVaultCandidates, addFromText, isRememberText,
} from '../../../src/memory-vault.js';
import { listCharacters } from '../../../src/character-persona.js';

export function createVaultInboxDrain({ pluginLog = () => {}, intervalMs = 60_000, inbox = '', vaultFile = '' } = {}) {
  let timer = null;
  let busy = false;
  let lastError = '';
  let lastIngestedAt = 0;

  async function drainOne(characterId) {
    const opts = { ...(characterId ? { characterId } : {}) };
    if (inbox) opts.file = inbox;
    const taken = takeVaultCandidates(opts);
    if (!taken.ok) throw new Error(taken.reason || '读取候选队列失败');
    if (!taken.items.length) {
      if (taken.moved) commitVaultCandidates(taken.moved);
      return 0;
    }
    let added = 0;
    try {
      for (const item of taken.items) {
        const text = String(item?.text ?? '').trim();
        if (!text || !isRememberText(text)) continue;
        const r = await addFromText(text, {
          source: String(item?.source || 'auto').slice(0, 40),
          ...(characterId ? { characterId } : {}),
          ...(vaultFile ? { file: vaultFile } : {}),
        });
        if (r.ok) added += 1;
      }
    } catch (error) {
      // 一条失败不吞整批：还回队列，下次重试（重复的由 addVaultEntry 按正文去重）
      rollbackVaultCandidates(taken.moved, inbox ? { file: inbox } : {});
      throw error;
    }
    commitVaultCandidates(taken.moved);
    if (added) pluginLog(`[记忆库] ${characterId ? characterId + ' ' : ''}自动收下 ${added} 条（候选 ${taken.items.length} 条）`);
    return added;
  }

  async function drainOnce() {
    if (busy) return { ok: true, skipped: true };
    busy = true;
    try {
      const chars = listCharacters();
      const targets = chars.length ? chars.map((c) => c.id) : [''];
      let ingested = 0;
      for (const id of targets) {
        try { ingested += await drainOne(id); }
        catch (error) { pluginLog(`[记忆库] ${id || '当前角色'} 自动收录失败：`, String(error?.message ?? error).slice(0, 160)); }
      }
      if (ingested) lastIngestedAt = Date.now();
      lastError = '';
      return { ok: true, ingested };
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 180);
      pluginLog('[记忆库] 自动收录失败：', lastError);
      return { ok: false, error: lastError };
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    void drainOnce();
    timer = setInterval(() => { void drainOnce(); }, Math.max(10_000, Number(intervalMs) || 60_000));
    try { timer.unref?.(); } catch {}
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, drainOnce, status: () => ({ running: Boolean(timer), busy, lastError, lastIngestedAt }) };
}
