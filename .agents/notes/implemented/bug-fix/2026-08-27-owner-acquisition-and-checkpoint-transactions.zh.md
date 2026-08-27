# Agent Note: 保证 owner 初始化与 checkpoint 事务的生命周期安全

Status: implemented

[English](2026-08-27-owner-acquisition-and-checkpoint-transactions.md) | 中文

## Problem

兼容的 `BrowserRuntime.acquire()` 调用会共享 owner environment，但如果 Provider 初始化绑定到第一个调用方的信号，该调用方就能取消全部并发等待方。工具 Consumer 也把 Agent 范围的 lease 初始化耦合到第一个工具调用信号。Checkpoint 创建会先生成 Provider payload，再提交 Runtime 元数据；元数据写入失败时没有删除新 payload，而且旧 payload 的清理会在 checkpoint 操作返回后继续运行。Provider 可以在声明支持 checkpoint 的同时省略 `restore()`、`destroyCheckpoint()` 或 environment 的 `checkpoint()`，导致无法回滚，或直到 shutdown 才暴露错误配置。

Provider 选择可能在读取 registration 后等待异步 `available()`，但此时尚未把 owner slot 与该 Provider 关联。因此，卸载可能遗漏正在初始化的 slot，调用 Provider 级 `dispose()`，然后 acquire 继续在已 dispose 的 Provider 上调用 `open()`。不同 owner 对象发起的 checkpoint 事务也可能共用同一 session id。如果 Runtime 没有自己持有的按 session 顺序，即使存储 domain 已串行后端写入，较早元数据失败的回滚仍可以恢复或删除较晚事务写入的内存索引。两个 Provider 还可以在首个 checkpoint 出现前打开同一 session，随后依次替换该 session 索引，使第一个 Provider 的私有 payload 无法再访问。

## Decision

owner slot 持有 Provider 初始化及其取消信号。每个 acquire 使用自己的信号等待共享初始化；调用方取消只拒绝自己的等待。所有待处理调用方离开且没有 lease 时，slot shutdown 会中止初始化。移除 Provider 和销毁 Runtime 仍会中止 owner slot 并等待回滚完成。

Provider 选择会在等待 `available()` 前，先把每个候选 registration 与 owner slot 关联。卸载会把 Provider 从注册表移除，中止并等待候选选择或 environment 初始化，关闭已公布的 environment，最后才调用 Provider 级 `dispose()`。精确选择会在 availability 返回后重新核对 registration identity；异步检查期间注册表成员变化时，自动选择会重试，并且只提交稳定快照。

Agent 工具 binding 持有 lease 初始化。工具调用分别等待 binding promise，Agent 销毁则中止初始化。因此，一个工具超时不能让等待同一 Agent lease 的另一个并发工具调用失败。操作执行期间发生取消时，binding 会让该 lease 失效并释放它，因为 Playwright Provider 会关闭 BrowserContext 以停止工作；下一次工具调用会等待清理完成并取得新环境。

Checkpoint 创建把 Provider payload 和 Runtime 索引作为一个有序事务。Payload 创建、元数据提交或回滚以及旧 payload 清理会按 session id 跨 owner environment 串行执行。调用方在等待时取消，只会在前一个事务结束后释放自己的排队位置，因此后续工作无法越过正在执行的 checkpoint 状态。每个事务会在创建 payload 前读取当前索引，并以 `BROWSER_CHECKPOINT_PROVIDER_MISMATCH` 拒绝不同 Provider。元数据提交失败时会恢复原内存索引并等待删除新 payload；两个步骤都失败时返回 `AggregateError`。替换成功后会等待旧 payload 的尽力删除完成，再返回结果。显式删除会先提交元数据和内存索引移除，再删除 Provider payload，避免索引引用已经从 Provider 删除的状态。

声明支持 checkpoint 会使 Provider 注册时必须提供 `restore()` 和 `destroyCheckpoint()`。该 Provider 返回的每个 environment 都必须暴露 `checkpoint()`；如果缺少，Runtime 会关闭并拒绝新打开的 environment。这些检查保证 checkpoint 事务开始前，payload 回滚和替换清理已经可用。

## Alternatives considered

**由第一个调用方持有共享 Provider 初始化。** 不采用，因为兼容 acquire 承诺相互独立的调用方取消与 lease；调用顺序不能让一个调用方成为另一个调用方的生命周期 owner。

**初始化完成后才响应调用方取消。** 不采用，因为这种做法虽然保留共享初始化，但在浏览器启动缓慢时会让 acquire 取消失效。

**只在 `available()` 返回后重新检查 Provider registration。** 不采用，因为这能阻止后续 `open()`，却仍允许 Provider 级资源释放与正在执行的 availability 调用竞争。把候选 Provider 公布到 owner slot，卸载流程才能等待整个选择区间结束。

**依赖存储 domain 的写入链保证 checkpoint 顺序。** 不采用，因为该链只串行持久写入，不会串行 Runtime 在此之前的内存替换或失败后回滚。完整的 payload/索引事务需要相同的按 session 顺序。

**通过不同 Provider 替换 checkpoint，并让旧 Provider 删除其 payload。** 不采用，因为 v0.1 没有定义跨 Provider checkpoint 转换或替换语义。切换 Provider 前要求显式删除 checkpoint，可以避免隐式状态丢失与跨 registration 清理竞争。

**元数据失败后保留新 payload。** 不采用，因为重启后没有 Runtime 索引能够定位或删除该 payload。

**先删除 checkpoint payload，再删除元数据。** 不采用，因为元数据写入失败会保留持久索引，而对应的 Provider 状态已经缺失。

**允许 checkpoint Provider 不提供 payload 删除。** 不采用，因为删除操作可选会让元数据回滚和显式 checkpoint 删除无法达到确定的最终状态。

## Verification

Runtime 测试在延迟 Provider 初始化期间取消两个并发 acquire 之一，并要求另一个 acquire 获得唯一打开的 environment；最后一个等待方取消的用例要求初始化回滚且不产生清理警告。Provider 移除竞争覆盖配置选择和自动选择，在 `available()` 未完成时发起卸载，并要求卸载等待完成且不会在资源释放后调用 `open()`。Runtime 测试还会在注册时拒绝缺失生命周期方法的 checkpoint Provider，要求缺少 `checkpoint()` 的新 environment 在 acquire 失败前关闭，在 `AggregateError` 中保留 validation 和 close 两个失败，证明取消已排队的同 session checkpoint 不会让第三个事务越过正在执行的事务，并且在第二个 Provider 创建 payload 前拒绝并发的跨 Provider 替换。工具集成测试通过 `ctx.tools.execute` 覆盖同一初始化竞争，然后取消已经接收的操作，并要求下一次工具调用成功打开第二个环境。Playwright 集成测试会中断真实的慢速导航、释放已经关闭的 context，并打开新环境。存储集成测试会拒绝两个同 session 元数据提交中的第一个，并要求后续提交在 Runtime 与持久索引中保持一致，失败 payload 只删除一次。

## Consequences

并发调用方不再共享取消，但所有调用方离开时，owner 生命周期仍会完全停稳。一个调用方停止后，只要其他调用方或 Agent binding 仍持有初始化，共享初始化就可以继续。Provider 卸载可能会等待异步 availability 检查或部分完成的 open 结束，但 Provider 级资源释放后不会再开始任何 environment。操作超时会丢弃该 Agent 当前的浏览器环境，因此 ephemeral 页面状态会丢失；这样可以避免缓存 Playwright 已经关闭的环境。同 session checkpoint 工作放弃了跨 owner 并行，换取单一一致的 payload/索引历史；取消可能会留下空排队位置，直到前一个事务结束。切换 checkpoint Provider 需要先释放实时 environment，显式删除旧 checkpoint，再使用新 Provider acquire。Checkpoint 失败路径会在返回前执行更多清理，等待 Provider 清理的代价换来了没有未索引 payload 和后台删除任务的状态。Checkpoint Provider 的错误配置会在注册或 environment 打开时失败，而不是在浏览器使用后才失败；被拒绝的 environment 会执行并等待 close。
