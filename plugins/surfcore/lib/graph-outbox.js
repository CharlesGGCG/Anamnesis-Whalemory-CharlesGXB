// lib/graph-outbox.js —— 插件进程侧：把 B站 工具写下的出站事件喂进记忆图谱。
//
// 工具进程（debrief / bili-watch / comment）只负责往 graph-outbox.jsonl 追加一行；
// 这里每分钟取一次，统一 enqueue + flush。这样「看视频/发评论」不用等抽取，也不会丢记忆。
import { takeGraphEvents, commitGraphEvents, rollbackGraphEvents, turnForGraphEvent } from '../tools/lib/graph-outbox.mjs';
import { getMemoryGraph } from '../../../src/memory-graph.js';

export function createGraphOutboxDrain({ pluginLog = () => {}, intervalMs = 60_000, getGraph = getMemoryGraph, file = '' } = {}) {
  let timer = null;
  let busy = false;
  let lastError = '';
  let lastIngestedAt = 0;

  async function drainOnce() {
    if (busy) return { ok: true, skipped: true };
    busy = true;
    try {
      const taken = takeGraphEvents(file ? { file } : {});
      if (!taken.ok) return taken;
      if (!taken.events.length) {
        if (taken.moved) commitGraphEvents(taken);
        return { ok: true, ingested: 0 };
      }
      const turns = taken.events.map(turnForGraphEvent).filter(Boolean);
      if (!turns.length) {
        commitGraphEvents(taken);
        return { ok: true, ingested: 0, dropped: taken.events.length };
      }
      let mg;
      try {
        mg = await getGraph();
      } catch (error) {
        // 引擎起不来（缺 key / 目录坏了）：把队列还回去，下次再试，别把记忆吃掉。
        rollbackGraphEvents(taken);
        throw error;
      }
      for (const turn of turns) mg.enqueue(turn);
      try {
        await mg.flush();
      } catch (error) {
        // 已经交给引擎了：重试会重复入图，所以提交队列、只记日志。
        commitGraphEvents(taken);
        throw error;
      }
      commitGraphEvents(taken);
      lastIngestedAt = Date.now();
      pluginLog(`[记忆图谱] B站 捕获 ${turns.length} 条（队列 ${taken.events.length} 条）`);
      return { ok: true, ingested: turns.length };
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 180);
      pluginLog('[记忆图谱] B站 捕获失败：', lastError);
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

  return {
    start,
    stop,
    drainOnce,
    status: () => ({ running: Boolean(timer), busy, lastError, lastIngestedAt }),
  };
}
