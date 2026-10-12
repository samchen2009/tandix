# 从长操作历史推断“我做了什么”

这是 Skill 提炼之前的实验入口。用户无需预先定义任务、设置开始结束标记或限定网站。Agent 从已有记录里提出候选任务，寻找不连续的支持片段，检查反例，然后回答“你做了什么”。目前提供只读 CLI 与 Agent 调查提示词；没有接入侧栏、自动调用模型或修改录制器的保留策略。

## 如何调查

输入记录 → 全量可分页索引 → 候选业务活动 → 跨历史检索与事件回查 → 关联、反例和结果报告。

索引分页只是存储窗口。时间间隔、网站切换、tabId 相同均不能单独确定任务边界。候选任务可以跨天，由多个不连续片段组成。关联时比较项目、周期、来源上下文、内容结构、错误与修正的对应关系，并检查其他可能来源。推断缺少直接数据流证据时，必须保留替代解释。

报告分别记录 `segments`（观察）、`links`（推断）、`counterEvidenceIds`（反例）、`outcome`（可见结果）和未归属事件。例如点击保存后出现错误属于失败尝试；出现草稿已保存只能证明草稿；点击发送后的埋点 HTTP 200 不能证明邮件发送成功。

`likely`、`possible`、`insufficient` 是 Agent 对证据的定性判断，不是计算出的概率。没有预设业务分类器或按关键词自动划分任务；关键词搜索只帮助定位证据。即使结构校验通过，语义判断仍可能错误。

## 使用

在仓库根目录执行：

```sh
pnpm activity prompt --history scripts/fixtures/activity-long-history.json
pnpm activity index --history scripts/fixtures/activity-long-history.json --offset 0 --limit 20
pnpm activity index --history scripts/fixtures/activity-long-history.json --offset 20 --limit 20
pnpm activity search --history scripts/fixtures/activity-long-history.json --query 'report.csv'
pnpm activity events --history scripts/fixtures/activity-long-history.json --ids e09,e13,e22,e23,e25
pnpm activity validate --history scripts/fixtures/activity-long-history.json --report scripts/fixtures/activity-long-history.inference.json
pnpm test:activity
```

把 `prompt` 输出交给能执行本地命令的 Agent。提示词包含工具位置、历史文件路径和首个索引页。Agent 按 `nextOffset` 翻页、搜索并回查关键事件，最后返回 `tandix.activity-inference/v1` JSON。`validate` 只检查引用、结构和声明的覆盖范围；它无法核实 Agent 是否真的阅读了所声明的事件，也无法验证语义正确性。CLI 自身不会生成推断答案。

CLI 接受浏览器录制的 JSON / JSONL、`tandix.skill-extraction-evidence/v1` 的 `timeline`，以及包含 `events` 的实验记录。检索结果是元数据投影而非无损原文：保留 ID、时间、页面上下文、控件标签、下载状态等；输入值和选项原值被隐藏，其他未投影字段不可用。`observation` 是调用方提供的已审阅、脱敏的页面观察文本，CLI 不会自动生成或自动脱敏这段自由文本。页面标题、标签和文件名也应在发送给 Agent 前审阅。

事件按时间排序，但不以时间空隙切段；已有 ID 保留，缺失 ID 在排序前分配。索引摘要有长度限制并标注 `summaryTruncated`，完整投影可通过 `events` 回查。超过 32 MiB 或 100,000 条事件会明确拒绝；不会悄悄截取最后一段。部分检索结果可分页取得。

## 本次试验的推理

输入为明确标注 `synthetic: true` 的 40 条合成事件，跨度 5 天，混有新闻、通知、报销、同名文件、失败重试和隔天修正。输入没有预设任务归属。当前 Agent 阅读索引、检索同名文件、回查关键事件后，写下示例报告 `scripts/fixtures/activity-long-history.inference.json`：

| 候选活动 | 关联依据 | 可确认结果与缺口 |
| --- | --- | --- |
| 北区上一周经营周报 | 项目、周期、表格结构一致；日期错误与隔天修正相对应 | 草稿已保存；下载→预览→输入只有间接证据 |
| 同主题邮件沟通 | 邮件主题与周报一致 | 点击过发送；内容关联与发送成功未知 |
| 差旅报销 | 同业务、同 tabId 的草稿与后来提交 | 有报销进入审批中；不能证明跨天是同一单据 |
| 南区昨天数据导出 | 项目、周期不同，且在北区输入之后才下载 | 下载完成并出现相关预览；不能因同名文件和同结构归入北区周报 |

新闻与搬迁通知未强行归入这些候选任务。报告共享部分事件作为其他候选的支持或反例，不强制每条事件仅属于一个任务。

这份数据和答案由同一开发过程构造，只是可审查的方法示例，不能作为准确率证明。页面观察摘要比现有录制器的数据丰富；现有十分钟/200 条近期记录也无法恢复已经丢失的跨天历史。要验证真实能力，需要完整实际导出，并衡量错误合并、错误拆分、数据来源误判以及结果误报，而非只看 JSON 是否通过校验。

后续长历史输入需要持久记录与观察采集支持。大量事件不能全部塞进上下文时，应保留原始 ID 和检索能力，明确报告已审阅范围；本原型尚未实现自动分层归纳或大型历史的模型调度。任务片段推断达到可用程度后，再将选定候选交给现有 Skill 提炼流程。
