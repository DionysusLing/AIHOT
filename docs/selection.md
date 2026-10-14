# 精选与校准

## 一条资料怎么变成精选

1. **收进来**：同一网址、同一内容只留一份。只有标题或订阅摘要的，先抓原文页面再判断。
2. **预筛**（`prefilter.md`）：这是不是本行业的事。宽进，只拦明显无关的：`BLOCK` 的资料不出现在任何公开页面；`PASS` 和拿不准的 `UNKNOWN` 继续往下走。
3. **评分**（`selection-score.md`）：同一份评分标准独立打两次分（0–100）。**两次之和 ≥ 2 × 门槛**就入选，门槛按信源分级不同。页面上显示的分数是两次的平均（向下取整）。
4. **写标题摘要**：入选的和差一点入选的（平均分高于 `understandFloor`），按 `content-understanding.md` 写中文标题、答案先行的摘要、推荐理由和标签；其余的按 `summarize-*.md` 写简短的标题摘要，进“全部动态”。
5. **结构化**（`structure.md`）：分类、标签、主体公司、事实（谁、做了什么、对什么），和评分同时进行。主题页和事件归组靠它。
6. **归组**（`group-*.md`）：不同来源报道的同一件事归成一个事件，事件页有综述（`story-digest.md`），“热门”按事件排。入选的资料要等归组完成（最多 3 分钟）才出现在精选里，避免同一件事先冒出好几条。
7. **日报、周报、月报**（`report-*.md`）：每天 08:00 出日报（前一天 08:00 到当天 08:00 的精选候选），每周一 10:00 出上周周报，每月 1 日 10:30 出上月月报。资料进入站点后若跨过刊期边界才确定精选公开时间，便归入下一期候选池；截止前已确定公开时间、但仍在提交的发布事务，取稿会等它提交后再读取，避免漏过前后两期。最终刊载仍受同一事实去重和版面容量限制。

每一步的提示词都在 `industry/prompts/`，改提示词不用改代码。提示词的版本就是它内容的哈希：改了提示词，之后的新资料按新版判断，已经判过的不会重算。

## 门槛：`industry/selection.ts`

```ts
export const SELECTION = {
  thresholds: { T1: 60, T1_5: 65, T2: 76 },   // 两次评分的平均至少要到这个数
  understandFloor: 50,                        // 平均分高于它的未入选资料，也按入选的写法写
};
```

官方一手信源（T1）门槛低一些，媒体和个人（T2）门槛高一些：同样一件事，官方原文更值得先看。没有门槛的分级（`EXCLUDE_MP`）不参与精选。

这组数是 AIHOT 在 AI 领域一直在用的门槛，偏严：宁可少选几条，也不让噪声进精选。换了行业、改了评分标准，一定要按下面的办法重新校准。

## 校准

### 1. 准备样本集

从你自己的信源里挑 100–200 条资料，一条一条标“该选 / 不该选”，存成 `.data/gold.jsonl`（`.data/` 不进 Git）。每行一条：

```json
{"caseId":"law-001","material":{"title":"原文标题","originalTitle":null,"publishedAt":"2026-10-01T09:00:00+08:00","sourceName":"信源名称","bodyZh":null,"bodyOriginal":"正文……"},"sourceFacts":{"sourceKind":"rss","sourceTier":"T1","firstParty":true,"language":"zh"},"samplingContext":{"benchmarkSplit":"development","samplingStratum":"regulation"},"gold":{"decision":"select"}}
```

| 字段 | 说明 |
|---|---|
| `caseId` | 唯一编号 |
| `material` | 标题、原标题、发布时间、信源名、正文（中文正文放 `bodyZh`，原文放 `bodyOriginal`，有一个就行） |
| `sourceFacts` | 信源类型、分级、是否一手、语言。分级决定用哪个门槛 |
| `samplingContext` | 可选。`benchmarkSplit` 分开发集和留出集，`samplingStratum` 是你自己的分组（比如“新规”“判决”“营销”），看错在哪一类 |
| `gold.decision` | `select` 该选，`reject` 不该选，`either` 两可（不计入准确率） |

`industry/gold.example.jsonl` 有两条示例。

几条建议：

- 多放**难例**：差一点就该选、差一点就不该选的。一眼就能判断的放太多，准确率会虚高。
- 分出一部分做**留出集**（`benchmarkSplit: "holdout"`），调提示词只看开发集，最后再用留出集检查一遍，免得把提示词调成只会做这几道题。
- 标注的人最好就是以后读这个站的人，或者和他们口味一致的人。

### 2. 跑评测

```bash
node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl --split development --label "第一版评分标准"
```

对每条样本跑一遍预筛和两次评分，输出：

- 准确率、查准率（选出来的有多少是对的）、查全率（该选的有多少选上了）；
- 门槛从 40 到 90 每隔 2 分，各自会得到什么结果；
- 判错的条目，完整报告写到 `.data/eval/`，同时导入后台 SelectBench。

常用参数：`--models default,deepseek-flash` 同批比较几个模型，`--n 200` 最多抽多少条，`--split holdout` 只跑留出集。同样的输入和提示词再跑不会重复调用模型（有回执复用），只有改过的部分才会产生新调用。

### 3. 看错例，改标准，再跑

在后台 SelectBench 里逐条看判错的资料和模型给的理由：

上传多模型报告时，同一 `caseId` 在各模型下须使用相同的 `gold`（`select`、`reject` 或 `either`），模型的 `decision` 可以不同。每个模型内的 `caseId` 必须是非空字符串且不能重复。非法或冲突的逐例数据返回 HTTP 400，在任何写入前拒绝整份报告。允许不同模型覆盖部分样本，也保留无 `cases` 或 `cases: []` 的仅汇总报告，以及旧版按模型名组织的报告格式。

- 该选没选上，多半是评分标准里没说清它为什么重要：在 `selection-score.md` 里把这类价值写进“必须正常评价”的部分，给出例子。
- 不该选却选上了，多半是噪声没压住：写进“必须压住”的部分。
- 整体偏松或偏紧，而判错的条目分数都贴着门槛，再调 `industry/selection.ts` 的门槛。

先改标准，再动门槛：门槛只能整体移动，解决不了“哪一类判错了”。每改一次跑一遍，SelectBench 里能看到每一版的对比。

### 历史报告的只读检查

新校验只影响之后的导入，不会修复已有记录。确认目标部署使用此表结构后，优先在数据库快照或只读副本上执行下列 SQL；线上检查应使用只读账号。按同一运行、同一 case 比较金标，不能跨运行比较（不同评测轮次可以重新标注）。

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';

-- 同一 case 在不同模型下的金标冲突；保留每个模型的原值供人工核对。
SELECT run_id, case_id, count(DISTINCT gold) AS gold_count,
       jsonb_object_agg(model, gold ORDER BY model) AS gold_by_model
FROM selectbench_results
GROUP BY run_id, case_id
HAVING count(DISTINCT gold) > 1
ORDER BY run_id, case_id;

-- 旧版导入可能接受的非法金标。
SELECT run_id, model, case_id, gold
FROM selectbench_results
WHERE gold IS NULL OR gold NOT IN ('select', 'reject', 'either')
ORDER BY run_id, model, case_id;

ROLLBACK;
```

超时只表示本次检查未完成，不表示没有冲突；大库可在两个查询中按 `run_id` 限定检查范围。结果为零也无法发现旧版 `ON CONFLICT DO NOTHING` 已忽略的同模型重复记录，这类问题需要核对原始报告。发现异常后保留原始报告并人工确认正确标注，不使用 `min(gold)` 自动修正，也不直接删除或覆盖历史记录。

## 换模型

后台“模型与评测”页能看到每一步当前用哪个模型、近期的成功率、耗时和 token 用量，也能直接切换（只影响之后的新任务）。换评分模型之前，先用 `--models` 在同一批样本上比一比。
