import { describe, expect, it } from "vitest";
import { __test, unwrapProxy, IS_PROXIED } from "./persist";

const { createDeepProxy } = __test;

// No-op trigger for testing (we don't need persistence in these tests)
const noopTrigger = () => {};

/**
 * Helper to create a proxy using the real createDeepProxy function.
 * Uses minimal mock instance and property key for testing purposes.
 */
function createTestProxy<T extends object>(value: T): T {
  return createDeepProxy(value, {}, "testProp", noopTrigger);
}

describe("persist proxy - null auto-vivification bug", () => {
  it("should NOT mutate null properties to {} when reading them", () => {
    // This is the bug: reading a null property through the proxy
    // should return null, not auto-vivify it to {}
    const original = {
      ownerId: null as string | null,
      name: "test",
    };

    const proxied = createTestProxy(original);

    // Read the null property
    const ownerId = proxied.ownerId;

    // Should return null as-is without mutation
    expect(ownerId).toBe(null);
    expect(original.ownerId).toBe(null);
  });

  it("should preserve null values in object spread", () => {
    const original = {
      id: "match_123",
      ownerId: null as string | null,
      firstMoveMadeAt: null as number | null,
      completedAt: null as number | null,
    };

    const proxied = createTestProxy(original);

    // Spread the proxied object (this is what our code does)
    const copy = { ...proxied };

    // Spread should preserve null values
    expect(copy.ownerId).toBe(null);
    expect(copy.firstMoveMadeAt).toBe(null);
    expect(copy.completedAt).toBe(null);

    // The original should NOT be mutated by a read operation
    expect(original.ownerId).toBe(null);
  });

  it("should NOT mutate the underlying object on property read", () => {
    const original = { nullProp: null as null };
    const proxied = createTestProxy(original);

    // Just reading should not mutate
    void proxied.nullProp;

    // The underlying object should remain unchanged
    expect(original.nullProp).toBe(null);
  });

  it("real-world: D1 journaling with nullable fields", () => {
    // Real-world scenario: match state with nullable fields
    // When serialized to D1, null values must be preserved
    interface MatchState {
      id: string;
      ownerId: string | null;
      firstMoveMadeAt: number | null;
      completedAt: number | null;
    }

    const matchState: MatchState = {
      id: "match_123",
      ownerId: null,
      firstMoveMadeAt: null,
      completedAt: null,
    };

    const proxied = createTestProxy(matchState);

    // When we journal to D1, null values should be preserved
    expect(proxied.ownerId).toBe(null);
    expect(proxied.firstMoveMadeAt).toBe(null);
    expect(proxied.completedAt).toBe(null);

    // Verify the original wasn't corrupted
    expect(matchState.ownerId).toBe(null);
    expect(matchState.firstMoveMadeAt).toBe(null);
    expect(matchState.completedAt).toBe(null);
  });

  it("should preserve undefined values without mutation", () => {
    const original = {
      definedProp: undefined as string | undefined,
      anotherProp: "value",
    };

    const proxied = createTestProxy(original);

    // Read the undefined property
    const value = proxied.definedProp;

    // Should return undefined as-is without mutation
    expect(value).toBe(undefined);
    expect(original.definedProp).toBe(undefined);
  });

  it("should preserve falsy but valid values (0, false, empty string)", () => {
    const original = {
      zero: 0,
      falseValue: false,
      emptyString: "",
    };

    const proxied = createTestProxy(original);

    // All falsy values should pass through unchanged
    expect(proxied.zero).toBe(0);
    expect(proxied.falseValue).toBe(false);
    expect(proxied.emptyString).toBe("");

    // Original should remain unchanged
    expect(original.zero).toBe(0);
    expect(original.falseValue).toBe(false);
    expect(original.emptyString).toBe("");
  });
});

describe("persist proxy - error handler heap overflow bug", () => {
  it("should return undefined on error instead of creating infinite proxy chain", () => {
    // Create an object with a throwing getter
    const throwingObj = {
      get badProp(): never {
        throw new Error("This getter throws");
      },
      normalProp: "hello",
    };

    const proxied = createTestProxy(throwingObj);

    // Accessing the throwing getter should return undefined, not create {} and recurse
    // Before the fix, this would cause a heap overflow from infinite proxy recursion
    const result = proxied.badProp;

    expect(result).toBe(undefined);
    // The normal prop should still work
    expect(proxied.normalProp).toBe("hello");
  });

  it("should not corrupt the original object on error", () => {
    const original: Record<string, unknown> = {
      get explosive(): never {
        throw new Error("boom");
      },
    };

    const proxied = createTestProxy(original);

    // Access the throwing getter
    void proxied.explosive;

    // The original should not be mutated with {}
    // Check that 'explosive' is still a getter, not {}
    const descriptor = Object.getOwnPropertyDescriptor(original, "explosive");
    expect(descriptor?.get).toBeDefined();
  });
});

describe("unwrapProxy", () => {
  describe("prototype pollution prevention", () => {
    it("ignores __proto__ key in proxied objects", () => {
      const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
      malicious[IS_PROXIED] = true;
      const result = unwrapProxy(malicious);

      expect(result.safe).toBe(1);
      // Malicious __proto__ value not copied as own property
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
      // Global Object.prototype not polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("ignores constructor key in proxied objects", () => {
      const malicious = { constructor: { prototype: { polluted: true } }, safe: 1, [IS_PROXIED]: true };
      const result = unwrapProxy(malicious);

      expect(result.safe).toBe(1);
      // Malicious constructor value not copied as own property
      expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
      // Inherited constructor is standard Object constructor
      expect(result.constructor).toBe(Object);
    });

    it("ignores prototype key in proxied objects", () => {
      const malicious = { prototype: { polluted: true }, safe: 1, [IS_PROXIED]: true };
      const result = unwrapProxy(malicious);

      expect(result.safe).toBe(1);
      expect(result.prototype).toBeUndefined();
    });

    it("filters dangerous keys in nested proxied objects", () => {
      const nested = JSON.parse('{"__proto__": {"polluted": true}, "valid": 2}');
      nested[IS_PROXIED] = true;
      const malicious = {
        nested,
        safe: 1,
      };
      const result = unwrapProxy(malicious);

      expect(result.safe).toBe(1);
      expect(result.nested.valid).toBe(2);
      // Malicious __proto__ value not copied as own property
      expect(Object.prototype.hasOwnProperty.call(result.nested, '__proto__')).toBe(false);
    });

    it("proxied object result has standard prototype", () => {
      const input = { a: 1, [IS_PROXIED]: true };
      const result = unwrapProxy(input);

      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    });

    it("non-proxied objects returned unchanged (fast path)", () => {
      const input = { a: 1 };
      const result = unwrapProxy(input);

      expect(result).toBe(input);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    });

    it("nested proxy triggers full unwrap", () => {
      const input = { outer: { inner: { [IS_PROXIED]: true, val: 1 } } };
      const result = unwrapProxy(input);

      expect(result).not.toBe(input);
      expect(result.outer.inner.val).toBe(1);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    });

    it("non-proxied array returned unchanged", () => {
      const input = [1, 2, { a: 3 }];
      const result = unwrapProxy(input);

      expect(result).toBe(input);
    });

    it("array containing proxy triggers unwrap", () => {
      const input = [1, { [IS_PROXIED]: true, val: 2 }];
      const result = unwrapProxy(input);

      expect(result).not.toBe(input);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("basic functionality", () => {
    it("handles primitives", () => {
      expect(unwrapProxy(null)).toBeNull();
      expect(unwrapProxy(undefined)).toBeUndefined();
      expect(unwrapProxy(42)).toBe(42);
      expect(unwrapProxy("str")).toBe("str");
      expect(unwrapProxy(true)).toBe(true);
    });

    it("handles arrays", () => {
      const input = [1, { a: 2 }, [3]];
      const result = unwrapProxy(input);

      expect(result).toEqual([1, { a: 2 }, [3]]);
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles nested objects", () => {
      const input = { a: { b: { c: 1 } } };
      const result = unwrapProxy(input);

      expect(result.a.b.c).toBe(1);
    });

    it("handles circular references", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;

      const result = unwrapProxy(obj);

      expect(result.a).toBe(1);
      expect(result.self).toBe(result);
    });

    it("handles Map", () => {
      const input = new Map([["key", { value: 1 }]]);
      const result = unwrapProxy(input);

      expect(result instanceof Map).toBe(true);
      expect(result.get("key")).toEqual({ value: 1 });
    });

    it("handles Set", () => {
      const input = new Set([1, 2, { a: 3 }]);
      const result = unwrapProxy(input);

      expect(result instanceof Set).toBe(true);
      expect(result.size).toBe(3);
    });

    it("preserves Date instances", () => {
      const date = new Date("2024-01-01");
      const result = unwrapProxy(date);

      expect(result).toBe(date);
    });

    it("preserves RegExp instances", () => {
      const regex = /test/gi;
      const result = unwrapProxy(regex);

      expect(result).toBe(regex);
    });

    it("preserves Error instances", () => {
      const error = new Error("test");
      const result = unwrapProxy(error);

      expect(result).toBe(error);
    });
  });
});
