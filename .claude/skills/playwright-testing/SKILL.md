---
name: playwright-testing
description: "Use when driving the gaido web UI via Playwright MCP, asserting graph state from the browser, or verifying UI behavior end-to-end. Covers the window.__gaido debug bridge (trigger methods, waitFor helpers, events ring buffer) and the stable data-testid attributes on every clickable thing. Apply to any task that involves clicking, typing, or asserting in a real browser session against http://127.0.0.1:4288."
user-invocable: true
---

# Playwright testing in gaido

Two complementary primitives, both already wired up. Use them together.

## `window.__gaido`

Installed by `apps/web/src/lib/debug.tsx` (`<DebugBridge />` mounted in `App.tsx`). API surface:

```ts
window.__gaido = {
  nodes(): NodeRow[]                      // current cached nodes.list result
  selectedNodeId(): string | null         // zustand store

  events: PersistedEvent[]                // 500-item ring buffer from a global ws subscription

  trigger: {
    createRoot(instruction, opts?): Promise   // seeds instruction root → config → coder (single branch); opts: { skeletonName?, coderName?, autoRun? }; resolves { node (the branch coder), run }
    createBatch(instruction, combinations): Promise  // one instruction root, N config→coder branches; combinations: { coderName, skeletonName? }[]; resolves { node (the instruction root), coderIds, runs }
    fork(coderNodeId, instruction): Promise   // waits for coder→done, lands new coder under its critique child
    runCritique(critiqueNodeId): Promise      // start an idle critique's first run (thin wrapper over retry)
    select(nodeId | null): void
    retry(nodeId): Promise
    rerunRender(nodeId): Promise           // re-run only the render phase of a coder whose render failed
    cancel(nodeId): Promise
    delete(nodeId): Promise
  }

  critiqueChildOf(coderNodeId): NodeRow | null

  waitFor(predicate, { timeoutMs?, pollMs? }): Promise<void>
  waitForNodeStatus(nodeId, status | status[], timeoutMs?): Promise<void>
  refetch(): Promise<void>
}
```

## Stable `data-testid` attributes

Names by component:

| Component | Testid(s) |
|---|---|
| `EmptyState` | `empty-create-root`, `empty-batch`, `create-root-form`, `create-root-skeleton` (only when presets are available), `create-root-input`, `create-root-submit`, `create-root-cancel` |
| `BatchModal` | `batch-form`, `batch-input`, `batch-coders`, `batch-coder-<name>`, `batch-skeletons`, `batch-skeleton-<name>`, `batch-combos`, `batch-combo`, `batch-combo-remove`, `batch-submit`, `batch-cancel` |
| `CoderCard` / `CritiqueCard` / `ConfigCard` / `InstructionCard` | `node-card` (with `data-node-id`, `data-node-kind` = `coder`\|`critique`\|`config`\|`instruction`; `data-status`/`data-favorite` on coder & critique only). Coder cards show their instruction only for a legacy root (`data-node-kind="coder"` with no parent); new coders don't. Also `node-favorite-toggle`, `critique-run` (idle critique's "Run critic" button), `config-child-link` (config sidebar) |
| `StatusBadge` | `status-badge` (with `data-status`) |
| `Sidebar` | `sidebar`, `sidebar-fork` (coder only), `sidebar-retry`, `sidebar-rerender` (coder only, when the current run failed during rendering), `sidebar-delete`, `fork-form`, `fork-input`, `fork-submit`, `critique-panel` (critique sidebar only), `error-panel`, `rerender-error` |
| `Toolbar` | `toolbar`, `toolbar-seed-root`, `toolbar-batch` |
| `EventStream` | `event-stream`, `event-row` (with `data-event-kind`) |

## Patterns that work well with Playwright MCP

- **Drive via UI clicks** — `getByTestId('empty-create-root').click()`, then type into `create-root-input`, click `create-root-submit`. Exercises the full stack.
- **Assert state via `__gaido`** — `await page.evaluate(() => window.__gaido.nodes())`. Less brittle than DOM scraping, types via `inferRouterOutputs<AppRouter>`.
- **Set up state quickly via `__gaido.trigger.*`** — bypass the UI when you just need a node to exist before testing something else.
- **`__gaido.events`** captures every server event so you can assert subscriptions are firing without inspecting the EventStream DOM.

## Console hygiene

Console should stay clean — verify with `mcp__playwright__browser_console_messages` at `level: "warning"`.
