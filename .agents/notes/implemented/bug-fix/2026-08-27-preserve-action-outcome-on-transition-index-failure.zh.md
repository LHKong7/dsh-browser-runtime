# Agent Note: transition 索引失败时保留 action 结果

Status: implemented

[English](2026-08-27-preserve-action-outcome-on-transition-index-failure.md) | 中文

## Problem

已经接收的浏览器 action 可能在 Runtime 记录紧凑 transition 之前改变外部状态。如果把紧凑索引写入拒绝处理成 `BROWSER_EVIDENCE_WRITE_FAILED`，存储错误就会覆盖 action 成功、Provider 失败或调用方取消。工具 Consumer 随后会报告错误，可能导致模型重复执行已经产生副作用的 click、fill 或 navigation。只要存在任意持久记录，`listTransitions()` 还会选择持久数据而不是内存，因此一条较旧的持久记录就能隐藏只保留在内存中的当前 transition。

## Decision

紧凑 `transitions` 表是辅助运维查询索引，而不是浏览器 action 的提交点。Runtime 会先把每个 transition 追加到有界内存记录，再尝试持久写入。写入被拒绝时会发出警告，但不会覆盖 action 成功、Provider 失败或调用方的取消原因。

`listTransitions()` 按 transition id 合并持久记录与有界内存记录。id 重复时采用内存值；即使紧凑索引拒绝写入，当前记录在本进程中仍可查询。

Checkpoint 元数据的语义不同，因为它是跨进程恢复的必要数据。Checkpoint 元数据提交失败仍是致命错误，会回滚新创建的 Provider payload，并使用明确的 `BROWSER_CHECKPOINT_METADATA_FAILED` 错误代码。DSH 现有 `tool/call` 和 `tool/result` Session event 仍是模型可见交互的持久记录；辅助 transition 索引不会取代它们。

## Alternatives considered

**传播 action 与索引的组合错误。** 不采用，因为调用方需要真实的 action 结果来判断重试是否安全；存储包装错误仍会掩盖真正重要的区别。

**把 action 标为 unknown 并使 environment 失效。** 不采用，因为关闭浏览器状态无法撤销外部 click 或提交，而且 unknown 工具错误仍会诱发重试。

**以原子方式提交浏览器副作用和 transition 记录。** 不采用，因为远程 Web action 与本地存储 backend 不共享事务协调器。

**为 transition 写入建立持久重试队列。** 不采用，因为重试所有权、shutdown 排空和持久队列状态会为可选运维索引增加生命周期机制；Session event log 已经持有模型可见历史的持久记录。

## Verification

存储集成测试注入一个允许读取但拒绝所有修改的 backend。测试要求成功 action 保持成功，Provider 失败保留 `BROWSER_ACTION_FAILED` 及其 cause，调用方取消保留精确原因，而且 `listTransitions()` 同时返回较旧的持久记录和当前内存记录。真实 `ToolRuntime` 集成要求 `browser_open` 在相同索引失败下返回成功工具结果。独立的 checkpoint 回滚测试要求返回 `BROWSER_CHECKPOINT_METADATA_FAILED`，并删除没有索引的 Provider payload。

## Consequences

辅助存储故障无法把已知的浏览器结果变成误导性工具失败，从而减少外部副作用发生后的不安全模型重试。运维人员会收到警告，当前进程的检查会保留记录，直到有界内存将其逐出。被拒绝的紧凑记录在重启后的 transition 查询中可能缺失；模型可见的持久历史仍保存在 Session log。Checkpoint 元数据继续采用严格失败与回滚语义，因为丢失该数据会使恢复状态无法访问。
