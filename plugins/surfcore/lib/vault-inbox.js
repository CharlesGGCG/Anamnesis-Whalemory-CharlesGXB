// 记忆库自动收录：把桥接/桌宠写下的候选句抽词入库（插件进程，每分钟一次）。
//
// 候选来自 `vault-inbox.jsonl`（bridge / pet-chat 在主人说「记住/答应/生日…」时追加一行），
// 这里逐个判断是否值得收、用 LLM 抽关键词，然后写进 vault.json。
import {
  takeVaultCandidates, commitVaultCandidates, rollbackVaultCandidates, addFromText, isRememberText,
} from '../../../src/memory-vault.js';

export function createVaultInboxDrain({ pluginLog = () => {}, intervalMs = 60_000, inbox = '', vaultFile = '' } = {}) {
  let timer = null;
  let busy = false;
  let lastError = '';
  let lastIngestedAt = 0;

  async function drainOnce() {
    if (busy) return { ok: true, skipped: true };
    busy = true;
    try {
      const taken = takeVaultCandidates(inbox ? { file: inbox } : {});
      if (!taken.ok) throw new Error(taken.reason || '读取候选队列失败');
      if (!taken.items.length) {
        if (taken.moved) commitVaultCandidates(taken.moved);
        return { ok: true, ingested: 0 };
      }
      let added = 0;
      try {
        for (const item of taken.items) {
          const text = String(item?.text ?? '').trim();
          if (!text || !isRememberText(text)) continue;
          const r = await addFromText(text, {
            source: String(item?.source || 'auto').slice(0, 40),
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
      if (added) {
        lastIngestedAt = Date.now();
        pluginLog(`[记忆库] 自动收下 ${added} 条（候选 ${taken.items.length} 条）`);
      }
      return { ok: true, ingested: added };
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
