# Agent Note: 为 browser observation 排序与分页

Status: implemented

[English](2026-08-27-observation-ranking-and-paging.md) | 中文

## Problem

在 arXiv 列表页上，一次 `browser_open` 耗时约三秒，返回 18,902 个字符，并触达 100 个元素引用的上限。导航本身没问题，observation 有问题。上限被作者链接、每篇论文的 Abstract/PDF/HTML/Other 链接以及重复的格式链接占满，因此模型真正需要的页面控件——搜索框、日期切换，以及 `51-100`、`101-150`、`more`、`all` 这些分页入口——部分或全部落在返回集合之外。这些边界对自身也保持沉默：observation 只为文本报告一个布尔 `truncated`，对元素则什么都不报，因此模型无法判断它想要的分页链接是存在但被丢弃，还是根本不存在。

排序方式是文档顺序，唯一的边界是一个计数。对列表页来说这两者形态都不对：当一个页面把某种记录重复数百次时，文档顺序会把最没用的链接排在最前；而一个数字无法表达"保留所有控件、丢掉作者"。

## Decision

Provider 在元素跨越 Playwright 协议之前把它们分成五个层级：表单控件、按钮和分页；站点导航与页面级操作；重复记录的标题链接；普通正文链接；作者、脚注、下载格式等重复的记录内链接。返回的元素先按层级、再按文档顺序排序，因此元素预算裁剪的是尾部，而不是文档的某个任意后缀。成组出现的数字或 next/previous/more/all 链接会被整体标记为分页；孤立的同类链接仍算普通内容，因为正文里单独一个 `2` 不是分页器。

排序在 Chromium 内进行，位于 `src/provider/page-snapshot.ts`。这个判断需要 DOM，而在页面内决定也能让协议载荷保持有界：否则 Runtime 必须先收到全部候选元素才能排序。

同一条重复记录内的元素携带共享的 `groupKey`，Runtime 生成 `g1` 这样的 observation 局部 group ref。记录是最近的、在至少三个同类兄弟中重复出现的祖先，且 `dt`/`dd` 一对算作同一条记录——这正是让 arXiv 条目的操作链接折叠到其标题之下的原因。Element fingerprint 刻意不包含层级、section 和 group：记录在列表中移动不应使模型已经持有的引用失效。

`browser_observe` 接受一个 mode。`summary`（默认）返回第 1-3 层加一段引导文本，`interactive` 返回全部层级且不含页面文本，`document` 返回页面文本加继续阅读所需的控件。每种模式有自己的文本与元素预算；显式的 `max_text_chars` 和 `max_elements` 可以覆盖它们，插件配置对两者再设上限。

`browser_observe_next` 读取最新 observation 的下一页。它重新投影已保存的 observation，而不是重新观察，因此模型在翻阅文本或元素尾部时元素引用保持有效。continuation 只属于最新的 observation：任何产生 observation 的工具都会替换游标，旧 token 会以 `BROWSER_OBSERVATION_SUPERSEDED` 失败，而不是悄悄读取模型早已越过的一页。

Observation 会在两个截断标志旁报告页面总文本长度和可见元素总数，因此"没有显示"始终是一个数字，而不是一次推断。

## Alternatives considered

**调高 `maxElements`。** 已否决，因为它只是把故障放大而不是改好：在那个页面上 300 个引用仍然大多是作者，token 成本随噪声一起增长。

**在 Runtime 中排序。** 已否决，因为排序需要 landmark 祖先、兄弟结构和计算后的可见性。把这些全部送到 Node 再排序，正是这个边界要避免的传输成本。

**让模型传入 CSS selector 来收窄 observation。** 已否决，因为模型提供的 selector 恰恰是这个插件不授予的能力；selector 是对页面的通用读取原语。

**把层级和 group 放进 element fingerprint。** 已否决，因为那会让列表在引用周围重排时引用立即过期，把一次普通页面更新变成一个虚假的 stale-reference 错误。

**让 `browser_observe_next` 用更大预算重新观察。** 已否决，因为新的 observation 会使模型持有的每个引用失效，这与"继续往下读同一页"的诉求正好相反。

## Verification

一个真实 Chromium 套件提供了与触发本次改动的页面同形的列表页——一个搜索表单、四个分页链接，以及十二个 `dt`/`dd` 论文条目，每条含四个操作链接和三个作者链接。它断言控件和每个分页入口都排在第一个记录内链接之前、成组分页会被标记而孤立链接不会、12 个元素的预算保留全部四个分页入口并丢弃作者，以及每个 `dt`/`dd` 对折叠成一条带标签的记录。工具层测试覆盖每种模式的层级选择、continuation 的推进与耗尽、被替换的游标，以及来自已翻页 observation 的引用仍可执行。

## Consequences

对大型列表页的第一次 observation 能装进较小预算，同时保留全部页面控件，截断也以模型可据以行动的数字报告。调用方现在选择模式而不是调高上限，继续往下读同一页也不再以牺牲已持有的引用为代价。

排序是基于结构的启发式，而不是对页面的语义理解。如果站点构造记录时不重复兄弟元素，就不会产生 group；样式上表现为孤立链接的分页控件也不会被标记。层级固定在 Provider 内而不可配置，因此优先级与常见情况不同的页面无法重排它们；退路是 `interactive` 模式加分页，它会返回全部内容。
