# @ws-asyncapi/solid

Typed **SolidJS** primitives for [ws-asyncapi](https://github.com/ws-asyncapi),
inferred from your server `Channel` — no codegen. A thin binding over the
framework-agnostic [`@ws-asyncapi/query-core`](../query-core) (the same core that
backs `@ws-asyncapi/react`): RPCs map to TanStack Solid Query
`createQuery`/`createMutation`; presence/stream/event/connection bridge into
Solid signals.

## Installation

```bash
npm install @ws-asyncapi/solid
# peers: solid-js, @tanstack/solid-query, @ws-asyncapi/client, @ws-asyncapi/query-core, ws-asyncapi
```

## Setup

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createSolidClient } from "@ws-asyncapi/solid";
import type { chat } from "./server";

export const ws = createSolidClient<typeof chat>("ws://localhost:3000", "/chat/1");
const qc = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <Room />
    </QueryClientProvider>
  );
}
```

## Primitives

```tsx
// RPC as a query (read) — room.data is reactive
const room = ws.createRequest("getRoom", { id: "42" });
// reactive input: pass an accessor
const room2 = ws.createRequest("getRoom", () => ({ id: id() }));

// RPC as a mutation (write)
const send = ws.createMutate("sendMessage");
send.mutate({ text: "hi" });

// room history + live (appends incoming events into the same cache)
const history = ws.createHistory("room:42", { liveEvent: "message", limit: 50 });

// presence — accessors
const presence = ws.createPresence();
presence.members();   // Accessor<Map<id, state>>
presence.self();      // Accessor<string | null>
presence.set({ name: "Alice", typing: false });

// stream — LATEST value by default (O(1)); opt into append / custom fold
const price = ws.createStream("prices", { symbol: "ACME" });   // price.data()
const ticks = ws.createStream("prices", { symbol: "ACME" }, { reduce: "append", max: 100 });

// newest event value / side effect
const status = ws.createLastEvent("status");          // Accessor
ws.createEvent("message", (msg, queryClient) => { /* patch cache */ });

// connection liveness
const conn = ws.createConnection();   // conn.connected(), conn.recovered()
```

Everything is typed from the channel — primitive names, payloads, results,
presence state, and stream outputs are inferred, with wrong names/payloads as
compile errors.

## License

MIT
