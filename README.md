# dsh-token-usage

给 DeepSeek Harness（DSH）Web GUI 用的 **Token 用量面板**：逐请求账本、四桶计量、全年热力图、实时并发，以及一份**在保留窗口内只增不减的落盘账本**。

> A token-usage panel for the DeepSeek Harness Web GUI: a per-request ledger with
> four-bucket accounting, a year heat map, a live concurrency gauge, and a durable
> append-only ledger on disk, within its 730-day retention window.
> [English summary ↓](#english)

---

## 为什么会有这个插件

DSH 本身已经在 durable session log 里记下了每次调用的 provider 计费用量（`tokenUsage` 投影），但**没有一个地方能看**：没有一个页面把「用了多少、花在哪、什么时候用的」摊开。

这个插件把那份权威数据折成一张**请求日志**，并且额外落一份盘 —— 因为会话投影只保留每个会话最近 600 行，会话一长、或者会话被删，早期用量就从界面上消失了。

## 功能

**概览**
- 4 张主指标卡（请求 / 合计 tokens / 缓存命中率 / 输出速度）+「更多指标」展开四桶、平均耗时、平均首字
- 趋势图：按桶堆叠的柱状 + **同一 x 轴上的缓存命中率折线**（一眼看出哪次改动把缓存打掉了）
- 全年热力图：53 周 × 7 天，铺满卡片宽度，月/周标签齐全
- 渠道排行：占比、四色构成条、请求数、命中率、合计
- 标题下的 **今日** 与 **实时并发**（见下）

**请求日志**
- 12 列逐请求明细：时间 / 会话 / 渠道 / 模型 / 提示 / 缓存读 / 补全 / 合计 / 耗时 / 首字 / 速度 / 流式
- 按天分组的粘性日期条（当天条数 + 合计），表头与日期条都随滚动钉住
- 点任意一行展开该条的四桶明细（含缓存写、推理子集、轮次/步骤）
- **点会话名直接跳到那个对话**
- 筛选：时间范围 / 渠道 / 模型 / 全文搜索，一键清除；**暂停**冻结表格（顶部数字照常更新）
- 列头点击排序、CSV 导出、页码直达

**模型 / 渠道 / 日期**
- 同一张表的三个维度：占比（带条）、请求、提示、缓存读、补全、合计（带四色构成条）、命中率、平均耗时、速度

**实时并发**
- 标题下的活体指示：`● 运行中 N`，数据来自会话列表自带的 `running` 标志（Host 推送，非轮询）
- 一个会话里同时有多个调用在飞时，追加 `· M 步在飞`（Host 侧按 `step/start` → 结算计数，`turn/end` 清空）

**落盘账本**
- 每次请求结算时 append 一行 JSONL 到 `$DSH_HOME/token-usage/requests.jsonl`
- 按 `session|turn|step|attempt` 做键，**读时后写覆盖**：崩溃、重放、重复扫描都不会重复计数
- 启动后回扫磁盘上的**全部**会话日志，把投影窗口早就丢掉的历史补回来
- 保留 730 天；**启动时**若文件 ≤ 32 MB 且（总行数 ≥ 2000 且 总行数 > 唯一键数 × 1.25，即重复行占比 > 20%；或存在超 730 天的记录）则压实（写临时文件再 rename）；超过 32 MB 的文件只读、不再压实

## 安装

插件是一个普通的 DSH bundle（纯 JS，**无构建步骤**）。

```bash
git clone https://github.com/menglian001/dsh-token-usage.git ~/dsh-token-usage

# 1) 装插件自己的依赖（**必做**，见下方说明）
cd ~/dsh-token-usage && npm install

# 2) 在 profile 里登记：dependencies 加一条 link:，bundles 加一个名字
cd ~/.dsh/profiles/web
pnpm install
```

profile 的 `package.json` 需要这两处（以 `~/.dsh/profiles/web` 为例）：

```jsonc
{
  "dependencies": {
    "dsh-token-usage": "link:~/dsh-token-usage"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-token-usage"]
    }
  }
}
```

然后重启 dsh。

> **为什么第 1 步必做**：`link:` 包按**真实目录**解析依赖，不经过 profile 的
> `node_modules`。插件目录里没有 `node_modules/zod` 时，Host 半会以
> `Cannot find package 'zod'` 加载失败 —— 而 Host 半失败会连带 Client 半不注入，
> 表现是侧边栏根本没有这个图标。`npm install`（或 `pnpm install`）只装一个
> `zod`，几秒钟。
>
> **Host 半改动必须重启**才生效；Client 半是热更新的，刷新页面即可。

打开 GUI → 侧边栏出现「Token 用量」图标，设置页里也有一节。

## 数据从哪来，准不准

| 数字 | 来源 |
|---|---|
| 四桶（未命中输入 / 缓存读 / 缓存写 / 补全）+ 推理 | **provider 回包上报**，非估算 |
| 提示 / 补全 / 合计 / 缓存命中率 | 四桶的算术 |
| 耗时 / 首字 / 生成时间 | **本地时钟**（含网络往返，不是上游服务端延迟） |
| 输出速度 | 补全 ÷ 生成时间，池化；仅计入补全 ≥ 100 且生成 ≥ 100 ms 的请求 |

链路：provider 响应 → `llm-*/src/stream.ts` 的 `usage` 事件 → `assembler` → `assistant/message.data.usage`。

**如果你走中转**：所谓"真实"= 忠实反映中转报的数。中转少报，面板就跟着少报。

## 已知边界（诚实版）

- **缓存写 / 推理恒为 0**：如果你的上游是 OpenAI 口径（prompt 里含缓存命中），它不会单独报 `cache_creation` / `reasoning` —— 这两格显示 0 不是插件漏读。
- **速度显示 `—`**：中转把首字和落盘报在同一瞬间时，生成时间≈0，除出来的速度是假的，所以按门槛显示 `—`。`—` 的意思是"没测到"，不是 0。
- **保留窗口**：会话投影每会话只留最近 600 行。**账本落盘后总量不受影响**，但"请求日志"明细仍受这个窗口约束（它读投影）；分组视图与趋势在无筛选时读账本聚合，所以不会缩水。
- **热力图空格 = 那天没有记录**，不是"那天没用"。
- **账本从启用那天开始记**：更早、且日志已被清理的会话，只有总数可能补回来，明细补不回来。

## 架构

```
index.js    Host 半
            ├─ requestLog 会话投影（一次计费尝试一行）
            ├─ Ledger：JSONL 落盘 + 内存聚合（天/模型/渠道/会话）
            ├─ 磁盘回扫：sessionPersistence.list() → 逐会话 read() → 补写
            ├─ LiveSteps：在飞步骤计数
            └─ GET /token-usage/ledger（浏览器 cookie 鉴权，失败关闭）

client.js   Client 半（纯 JS，React.createElement，无构建）
            ├─ 侧边栏 / 主面板 / 设置页三个槽位
            ├─ 投影补拉 pump（游标轮转，避免老会话饿死）
            └─ 视图：概览 / 请求日志 / 模型 / 渠道 / 日期
```

数据有两条来源，面板自己会说当前用的是哪条（页脚）：

- **账本**：保留窗口内只增不减（730 天），但只有聚合（天/模型/渠道）与最近若干行明细（服务端留 2000 行，面板按需取 400 行）
- **保留记录**：浏览器手里的投影行，能按任意条件切片，但受 600 行窗口约束

规则：账本行数 ≥ 保留行数且**无筛选**时读账本，否则读保留记录。

## 开发与校验

插件是纯 JS，没有构建。校验脚本在 `test/`（Node 直接跑，不依赖 dsh，但需要先装唯一的运行时依赖 `zod`）：

```bash
npm install       # 装 zod（仅测试/开发需要）
npm test          # 跑全部 11 套
node test/render-check.mjs   # 跑单个
```

覆盖：投影折叠语义、账本写入/覆盖/压实/回扫幂等、聚合视图切换、pump 覆盖率、面板渲染（含空数据与缺 seat 的降级）。

## English

A token-usage panel for the DeepSeek Harness (DSH) Web GUI. It folds the Harness's
own provider-reported usage into a per-request ledger and keeps a durable copy on
disk, because a session projection only retains the newest 600 rows per session.

**What you get**

- **Overview** — four headline cards (requests / tokens / cache hit rate / output
  speed), a stacked-by-bucket trend with the cache-hit line on the same x axis, a
  53-week heat map, and a channel ranking.
- **Request log** — one row per billed attempt (12 columns), grouped under sticky
  day rules, expandable into the four-bucket breakdown, sortable, filterable by
  range / channel / model / text, pausable, exportable to CSV. Clicking a session
  name opens that conversation.
- **Model / channel / day tables** — share, requests, prompt, cache read,
  completion, total with a four-colour composition bar, hit rate, latency, speed.
- **Live concurrency** — a gauge fed by the session list's `running` flag, plus a
  Host-side count of open steps, so several calls in flight inside one
  conversation are visible.
- **Durable ledger** — every settled request is appended to
  `$DSH_HOME/token-usage/requests.jsonl`, keyed by `session|turn|step|attempt`
  (last write wins), swept from every stored session log at startup, retained for
  730 days and compacted at startup.

**Install** — a plain DSH bundle with no build step: clone it, run `npm install`
**inside the clone** (a `link:` package resolves its dependencies from its real
directory, so without it the Host half fails with `Cannot find package 'zod'`),
add `"dsh-token-usage": "link:~/dsh-token-usage"` to your profile dependencies and
`dsh-token-usage` to `dsh.profile.bundles`, run `pnpm install`, restart dsh.

**Where the numbers come from** — the four buckets and reasoning tokens are what
the provider reported; prompt/completion/total/hit-rate are arithmetic on them;
latency and first-token are local clock measurements; speed is completion over
generation time, pooled. Behind a relay, "accurate" means "faithfully reflects
what the relay reported".

**Honest limits** — cache-write and reasoning read zero when the upstream never
reports them (OpenAI-style relays do not); a request whose generation time is
under 100 ms shows `—` instead of a fabricated speed; the request log's detail
view is still bounded by the projection's 600-row window, while the grouped views
read the ledger's aggregates and therefore never shrink.

**Tests** — `npm install` then `npm test` runs the offline harnesses in `test/`
(no dsh required; `zod` is the only dependency and only the tests need it installed).

## License

[MIT](LICENSE)