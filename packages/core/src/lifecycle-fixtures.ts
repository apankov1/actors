/**
 * Shared Test Fixtures for Actor Lifecycle Tests
 *
 * Provides common utilities for testing Actor lifecycle across:
 * - lifecycle-comprehensive.test.ts (pairwise, barrier, model-based)
 * - lifecycle-property.spec.ts (property-based)
 * - alarm-lifecycle.test.ts (alarm-specific)
 *
 * @see lifecycle-comprehensive.test.ts for pairwise/barrier tests
 * @see lifecycle-property.spec.ts for property-based tests
 */

import { vi } from "vitest";

/**
 * Entry point types that can wake a Durable Object
 */
export type EntryPointType = "fetch" | "alarm" | "webSocketMessage" | "webSocketClose";

/**
 * Initialization state of the actor
 */
export type InitState = "uninitialized" | "initializing" | "ready" | "failed";

/**
 * Barrier for deterministic concurrency testing
 * Allows pausing execution at specific points to test race conditions
 */
export interface Barrier {
  wait: () => Promise<void>;
  release: () => void;
  released: boolean;
}

/**
 * Create a barrier for concurrency testing
 * @returns Barrier object with wait/release methods
 */
export function createBarrier(): Barrier {
  let resolve: () => void;
  let released = false;
  const promise = new Promise<void>((r) => {
    resolve = () => {
      released = true;
      r();
    };
  });
  return {
    wait: () => promise,
    release: () => resolve(),
    get released() {
      return released;
    },
  };
}

/**
 * Create a mock WebSocket with all required methods
 * @returns Mock WebSocket object suitable for testing
 */
export function createMockWebSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    readyState: 1,
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    url: "ws://test.example.com",
    protocol: "",
    extensions: "",
    binaryType: "blob",
    bufferedAmount: 0,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    dispatchEvent: vi.fn(() => true),
  } as unknown as WebSocket;
}

/**
 * Handler call record for invariant checking
 */
export interface HandlerCall {
  handler: string;
  identifierDefined: boolean;
  initState: InitState;
  timestamp: number;
}

/**
 * Create a call order tracker for lifecycle testing
 * @returns Object with callOrder array and push method
 */
export function createCallOrderTracker(): {
  callOrder: string[];
  push: (event: string) => void;
  clear: () => void;
} {
  const callOrder: string[] = [];
  return {
    callOrder,
    push: (event: string) => callOrder.push(event),
    clear: () => (callOrder.length = 0),
  };
}

/**
 * Actor test harness configuration
 */
export interface ActorTestHarnessConfig {
  /** Called when onInit starts */
  onInitStart?: () => void;
  /** Called when onInit ends */
  onInitEnd?: () => void;
  /** Barrier to pause onInit at */
  initBarrier?: Barrier;
  /** Error to throw from onInit */
  initError?: Error;
  /** Delay in ms for onInit */
  initDelay?: number;
}

/**
 * Pairwise test case for entry point x initialization state matrix
 */
export interface PairwiseTestCase {
  name: string;
  entryPoint: EntryPointType;
  setNameCalled: boolean;
  expectedBehavior: "proceed" | "wait" | "error";
  expectedCallOrder?: string[];
}

/**
 * Capitalize first letter of string
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Map entry point to handler name
 */
function entryPointToHandler(ep: EntryPointType): string {
  const map: Record<EntryPointType, string> = {
    fetch: "onRequest",
    alarm: "onAlarm",
    webSocketMessage: "onWebSocketMessage",
    webSocketClose: "onWebSocketDisconnect",
  };
  return map[ep];
}

/**
 * Generate pairwise test cases for entry point x init state matrix
 * All entry points now have guards, so all wait for initialization
 */
export function generatePairwiseMatrix(): PairwiseTestCase[] {
  const entryPoints: EntryPointType[] = ["fetch", "alarm", "webSocketMessage", "webSocketClose"];

  const testCases: PairwiseTestCase[] = [];

  for (const entryPoint of entryPoints) {
    // Case: setNameCalled=false -> wait for initialization
    testCases.push({
      name: `${entryPoint}() waits when setNameCalled=false`,
      entryPoint,
      setNameCalled: false,
      expectedBehavior: "wait",
    });

    // Case: setNameCalled=true -> proceed immediately
    testCases.push({
      name: `${entryPoint}() proceeds when setNameCalled=true`,
      entryPoint,
      setNameCalled: true,
      expectedBehavior: "proceed",
      expectedCallOrder: ["onInit", entryPointToHandler(entryPoint)],
    });
  }

  return testCases;
}

/**
 * Concurrent entry point test case
 */
export interface ConcurrentTestCase {
  name: string;
  entryPoints: EntryPointType[];
  expectedInitCount: number;
  description: string;
}

/**
 * Generate concurrent entry point test cases
 * Tests that multiple concurrent entry points share single onInit
 */
export function generateConcurrencyMatrix(): ConcurrentTestCase[] {
  return [
    {
      name: "fetch + alarm concurrent",
      entryPoints: ["fetch", "alarm"],
      expectedInitCount: 1,
      description: "Both wait for single onInit",
    },
    {
      name: "all four entry points concurrent",
      entryPoints: ["fetch", "alarm", "webSocketMessage", "webSocketClose"],
      expectedInitCount: 1,
      description: "All four share single onInit",
    },
    {
      name: "multiple webSocketMessage concurrent",
      entryPoints: ["webSocketMessage", "webSocketMessage", "webSocketMessage"],
      expectedInitCount: 1,
      description: "Multiple WS messages share single onInit",
    },
    {
      name: "webSocketMessage + webSocketClose concurrent",
      entryPoints: ["webSocketMessage", "webSocketClose"],
      expectedInitCount: 1,
      description: "WS message and close share single onInit",
    },
  ];
}

/**
 * Fault injection scenario for error handling tests
 */
export interface FaultScenario {
  name: string;
  fault: "initError" | "initTimeout" | "initHang";
  expectedBehavior: "propagate" | "timeout" | "hang";
  description: string;
}

/**
 * Generate fault injection scenarios
 */
export function generateFaultScenarios(): FaultScenario[] {
  return [
    {
      name: "onInit throws error",
      fault: "initError",
      expectedBehavior: "propagate",
      description: "Error propagates to setName caller",
    },
    {
      name: "onInit takes too long",
      fault: "initTimeout",
      expectedBehavior: "timeout",
      description: "Entry points timeout waiting for init",
    },
    {
      name: "onInit never resolves",
      fault: "initHang",
      expectedBehavior: "hang",
      description: "Entry points hang indefinitely (needs timeout)",
    },
  ];
}
