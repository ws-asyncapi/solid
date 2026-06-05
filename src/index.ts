/**
 * Typed SolidJS primitives for ws-asyncapi — a thin binding over the
 * framework-agnostic `@ws-asyncapi/query-core`, the same core that backs
 * `@ws-asyncapi/react`. RPCs map to TanStack Solid Query `createQuery` /
 * `createMutation`; presence/stream/event/connection are bridged from the core's
 * subscribable stores into Solid signals (accessors).
 *
 * ```tsx
 * import { createSolidClient } from "@ws-asyncapi/solid";
 * import type { chat } from "./server";
 *
 * export const ws = createSolidClient<typeof chat>("ws://localhost:3000", "/chat/1");
 * // inside a component (under a QueryClientProvider):
 * const room = ws.createRequest("getRoom", { id: "42" }); // room.data is reactive
 * const presence = ws.createPresence();                   // presence.members()
 * const price = ws.createStream("prices", { symbol: "ACME" }); // price.data()
 * ```
 */
import {
    type CreateMutationResult,
    type CreateQueryResult,
    createMutation,
    createQuery,
    useQueryClient,
} from "@tanstack/solid-query";
import {
    createClient,
    type HistoryEntry,
    type RpcError,
    type TypedRpcError,
    type WebsocketAsyncAPIOptions,
} from "@ws-asyncapi/client";
import {
    connectionStore,
    historyQueryOptions,
    lastEventStore,
    mutationOptions,
    presenceStore,
    type QueryCoreClient,
    requestQueryOptions,
    type StreamReduce,
    type Subscribable,
    streamStore,
    subscribeHistoryLive,
} from "@ws-asyncapi/query-core";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { AnyChannel, InferClient } from "ws-asyncapi";

export { streamFold, type StreamReduce } from "@ws-asyncapi/query-core";

/** Bridge a core {@link Subscribable} into a Solid accessor (signal). */
function fromStore<T>(store: Subscribable<T>): Accessor<T> {
    const [value, setValue] = createSignal(store.getSnapshot());
    const unsub = store.subscribe(() => setValue(() => store.getSnapshot()));
    onCleanup(unsub);
    return value;
}

type Shape = InferClient<AnyChannel>;

/** Reactive result of {@link SolidClient.createStream}. */
export interface StreamAccessors<Data> {
    data: Accessor<Data>;
    isDone: Accessor<boolean>;
    error: Accessor<RpcError | null>;
}

/** Reactive presence surface from {@link SolidClient.createPresence}. */
export interface PresenceAccessors<State> {
    members: Accessor<Map<string, State>>;
    self: Accessor<string | null>;
    set: (state: State) => Promise<void>;
    clear: () => Promise<void>;
}

export interface SolidClient<T extends Shape> {
    /** the underlying client (escape hatch: `opened`, raw `request`, …) */
    client: ReturnType<typeof createClient<AnyChannel>>;

    createRequest<C extends keyof T["rpcMap"]>(
        command: C,
        input: T["rpcMap"][C]["input"] | Accessor<T["rpcMap"][C]["input"]>,
    ): CreateQueryResult<
        T["rpcMap"][C]["output"],
        TypedRpcError<T["rpcMap"][C]["errors"]>
    >;

    createMutate<C extends keyof T["rpcMap"]>(
        command: C,
    ): CreateMutationResult<
        T["rpcMap"][C]["output"],
        TypedRpcError<T["rpcMap"][C]["errors"]>,
        T["rpcMap"][C]["input"]
    >;

    createPresence(): PresenceAccessors<T["presenceState"]>;

    createHistory(
        room: string,
        options?: { liveEvent?: keyof T["eventMap"] & string; limit?: number },
    ): CreateQueryResult<HistoryEntry<T["eventMap"]>[], RpcError>;

    createStream<N extends keyof T["streamMap"]>(
        name: N,
        input: T["streamMap"][N]["input"],
    ): StreamAccessors<T["streamMap"][N]["output"] | undefined>;
    createStream<N extends keyof T["streamMap"]>(
        name: N,
        input: T["streamMap"][N]["input"],
        options: { reduce: "append"; max?: number },
    ): StreamAccessors<T["streamMap"][N]["output"][]>;
    createStream<N extends keyof T["streamMap"], Acc>(
        name: N,
        input: T["streamMap"][N]["input"],
        options: {
            reduce: (acc: Acc, item: T["streamMap"][N]["output"]) => Acc;
            initial: Acc;
        },
    ): StreamAccessors<Acc>;

    createLastEvent<E extends keyof T["eventMap"]>(
        event: E,
    ): Accessor<T["eventMap"][E] | undefined>;

    createEvent<E extends keyof T["eventMap"]>(
        event: E,
        handler: (
            data: T["eventMap"][E],
            // biome-ignore lint/suspicious/noExplicitAny: solid-query QueryClient
            queryClient: any,
        ) => void,
    ): void;

    createConnection(): {
        connected: Accessor<boolean>;
        recovered: Accessor<boolean>;
    };
}

export function createSolidClient<C extends AnyChannel>(
    url: string,
    path: InferClient<C>["address"],
    options?: WebsocketAsyncAPIOptions<
        // biome-ignore lint/suspicious/noExplicitAny: query/headers loosened here
        any,
        // biome-ignore lint/suspicious/noExplicitAny: query/headers loosened here
        any
    >,
): SolidClient<InferClient<C>> {
    const client = createClient<C>(url, path, options);
    const keyPrefix = `wsaa:${path as string}`;
    const core = client as unknown as QueryCoreClient;

    const presence = presenceStore(core);
    const connection = connectionStore(core);

    function createRequest(
        command: string,
        input: unknown | (() => unknown),
    ) {
        const inputAcc =
            typeof input === "function" ? (input as () => unknown) : () => input;
        return createQuery(() =>
            requestQueryOptions(core, keyPrefix, command, inputAcc()),
        );
    }

    function createMutate(command: string) {
        return createMutation(() => mutationOptions(core, command));
    }

    function createPresence() {
        const snap = fromStore(presence);
        return {
            members: () => snap().members,
            self: () => snap().self,
            set: presence.set,
            clear: presence.clear,
        };
    }

    function createHistory(
        room: string,
        opts?: { liveEvent?: string; limit?: number },
    ) {
        const qc = useQueryClient();
        const query = createQuery(() =>
            historyQueryOptions(core, keyPrefix, room, opts?.limit),
        );
        if (opts?.liveEvent) {
            const off = subscribeHistoryLive(core, qc, keyPrefix, room, {
                liveEvent: opts.liveEvent,
                limit: opts.limit,
            });
            onCleanup(off);
        }
        return query;
    }

    function createStream(
        name: string,
        input: unknown,
        opts?: StreamReduce<unknown, unknown>,
    ): StreamAccessors<unknown> {
        // Solid setup runs once → the store is created once (no memo needed)
        const snap = fromStore(streamStore(core, name, input, opts));
        return {
            data: () => snap().data,
            isDone: () => snap().isDone,
            error: () => snap().error,
        };
    }

    function createLastEvent(event: string) {
        return fromStore(lastEventStore(core, event));
    }

    function createEvent(
        event: string,
        handler: (data: unknown, qc: unknown) => void,
    ) {
        const qc = useQueryClient();
        const off = core.onEvent(event, (data: unknown) => handler(data, qc));
        onCleanup(off);
    }

    function createConnection() {
        const snap = fromStore(connection);
        return {
            connected: () => snap().connected,
            recovered: () => snap().recovered,
        };
    }

    return {
        client,
        createRequest,
        createMutate,
        createPresence,
        createHistory,
        createStream,
        createLastEvent,
        createEvent,
        createConnection,
        // biome-ignore lint/suspicious/noExplicitAny: runtime typed via SolidClient
    } as any;
}
