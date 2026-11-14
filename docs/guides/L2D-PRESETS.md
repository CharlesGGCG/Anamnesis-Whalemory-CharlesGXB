# Live2D 动作快捷预设（快照 + 恢复）

> 预设真实存放在 AgentL2D 的 `.local/presets.json`（`C:\dsh\jingyu\Jingyu 1.5 Integrated\.local\`），
> **不随仓库走**；重装整合包会丢。这里存一份快照与恢复办法。

## 当前预设（2026-11-14，共 11 个）

| 名字 | 时长 | 来源 |
|---|---|---|
| 伸懒腰 | 8.5s | 2026-11-12 初始 |
| 持草 | 6.0s | 初始 |
| 竖食指 | 6.1s | 初始 |
| 抚胸 | 5.6s | 初始 |
| 眨眼 | 4.9s | 初始 |
| 歪头 | 4.4s | 初始 |
| 点头 | 3.3s | 2026-11-14 新增 |
| 摇头 | 5.7s | 新增 |
| 微笑 | 5.0s | 新增 |
| 挑眉 | 6.1s | 新增 |
| 鼓腮 | 9.1s | 新增 |

快照（含完整 plan）：[`docs/assets/l2d-presets.json`](../assets/l2d-presets.json)

## 怎么用

- whaleweb / QQ 的 `[动作:xxx]` 标记会**动态拉** `GET /api/presets`，按名字模糊匹配（`点个头` → `点头`），命中直接重播；
  没命中才走 DSH 现编排。所以新增预设**不用改代码**。
- 模型能力边界：头/视线、基础表情、情绪表情、抚胸/竖指/持草、身体小幅。
  **做不了**：走路/跑步/转身/挥手/双手交叠抱胸（没有完整骨骼动画）。

## 恢复（重装后）

```bash
# 读 docs/assets/l2d-presets.json，逐个 POST 回去
node -e "
const fs=require('fs');
const {presets}=JSON.parse(fs.readFileSync('docs/assets/l2d-presets.json','utf8'));
(async()=>{
  for(const p of presets){
    const r=await fetch('http://127.0.0.1:61945/api/presets/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:p.name,plan:p.plan})});
    console.log(p.name, r.status);
  }
})();
"
```

## 新增预设的做法

```bash
# 1) 发起编排
curl -X POST http://127.0.0.1:61945/api/planner/run -H "content-type: application/json" -d "{\"prompt\":\"轻轻点一下头\"}"
# 2) 轮询到 status=validated，拿 task.plan
curl http://127.0.0.1:61945/api/planner/state
# 3) 存成预设
curl -X POST http://127.0.0.1:61945/api/presets/save -H "content-type: application/json" -d "{\"name\":\"点头\",\"plan\":{...}}"
```

单个约 8~16 秒（DSH 编排）。同一时间只能跑一个编排任务。
