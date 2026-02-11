import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { serializeMessages, getTraces, ReplTool } from "../../src/tool/repl"
import type { MessageV2 } from "../../src/session/message-v2"

const ctx = {
  sessionID: "test-repl",
  messageID: "",
  callID: "",
  agent: "rlm",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("serializeMessages", () => {
  test("serializes text messages", () => {
    const messages: MessageV2.WithParts[] = [
      {
        info: { role: "user" } as any,
        parts: [{ type: "text", text: "hello" } as any],
      },
      {
        info: { role: "assistant", agent: "build" } as any,
        parts: [{ type: "text", text: "hi there" } as any],
      },
    ]
    const result = serializeMessages(messages)
    expect(result.turns).toHaveLength(2)
    expect(result.turns[0].role).toBe("user")
    expect(result.turns[0].text).toBe("hello")
    expect(result.turns[1].role).toBe("assistant")
    expect(result.turns[1].agent).toBe("build")
    expect(result.turns[1].text).toBe("hi there")
    expect(result.text).toContain("[user] hello")
    expect(result.text).toContain("[assistant/build] hi there")
  })

  test("serializes tool parts with completed status", () => {
    const messages: MessageV2.WithParts[] = [
      {
        info: { role: "assistant", agent: "build" } as any,
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { filePath: "/foo" }, output: "file content" },
          } as any,
        ],
      },
    ]
    const result = serializeMessages(messages)
    expect(result.turns[0].tools).toHaveLength(1)
    expect(result.turns[0].tools[0].tool).toBe("read")
    expect(result.turns[0].tools[0].output).toBe("file content")
  })

  test("skips pending tool parts", () => {
    const messages: MessageV2.WithParts[] = [
      {
        info: { role: "assistant", agent: "build" } as any,
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { status: "pending" },
          } as any,
        ],
      },
    ]
    const result = serializeMessages(messages)
    expect(result.turns[0].tools).toHaveLength(0)
  })

  test("handles empty messages", () => {
    const result = serializeMessages([])
    expect(result.turns).toHaveLength(0)
    expect(result.text).toBe("")
  })
})

describe("ReplTool execution", () => {
  test("executes simple code and returns output", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        const result = await repl.execute({ code: 'print("hello world")' }, ctx)
        expect(result.output).toBe("hello world")
      },
    })
  })

  test("returns value when nothing is printed", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        const result = await repl.execute({ code: "return 42" }, ctx)
        expect(result.output).toBe("42")
      },
    })
  })

  test("persistent store $ survives across calls", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        await repl.execute({ code: "$.foo = 123" }, ctx)
        const result = await repl.execute({ code: "print($.foo)" }, ctx)
        expect(result.output).toBe("123")
      },
    })
  })

  test("handles errors gracefully", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        const result = await repl.execute({ code: "throw new Error('boom')" }, ctx)
        expect(result.output).toContain("Error: boom")
      },
    })
  })

  test("supports top-level await", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        const result = await repl.execute({ code: "const x = await Promise.resolve(99)\nprint(x)" }, ctx)
        expect(result.output).toBe("99")
      },
    })
  })

  test("directory is available", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        const result = await repl.execute({ code: "print(directory)" }, ctx)
        expect(result.output).toBe(tmp.path)
      },
    })
  })

  test("returns (no output) when code produces nothing", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        const result = await repl.execute({ code: "const x = 1" }, ctx)
        expect(result.output).toBe("(no output)")
      },
    })
  })

  test("console.log is captured", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        const result = await repl.execute({ code: 'console.log("a"); console.log("b")' }, ctx)
        expect(result.output).toBe("a\nb")
      },
    })
  })

  test("objects are pretty-printed", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        const result = await repl.execute({ code: "print({ a: 1 })" }, ctx)
        expect(result.output).toContain('"a": 1')
      },
    })
  })
})

describe("trace logging", () => {
  test("trace entries are recorded per session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "test-trace-recording"
        const traceCtx = { ...ctx, sessionID: sid }
        const repl = await ReplTool.init()
        await repl.execute({ code: 'print("step1")' }, traceCtx)
        await repl.execute({ code: 'print("step2")' }, traceCtx)
        const traces = getTraces(sid)
        expect(traces).toHaveLength(2)
        expect(traces[0].step).toBe(1)
        expect(traces[0].output).toBe("step1")
        expect(traces[1].step).toBe(2)
        expect(traces[1].output).toBe("step2")
      },
    })
  })

  test("error trace entries include error message", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "test-error-trace"
        const errCtx = { ...ctx, sessionID: sid }
        const repl = await ReplTool.init()
        await repl.execute({ code: "throw new Error('test error')" }, errCtx)
        const traces = getTraces(sid)
        expect(traces).toHaveLength(1)
        expect(traces[0].error).toBe("test error")
      },
    })
  })

  test("trace entries record duration", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "test-duration-trace"
        const durCtx = { ...ctx, sessionID: sid }
        const repl = await ReplTool.init()
        await repl.execute({ code: 'print("fast")' }, durCtx)
        const traces = getTraces(sid)
        expect(traces[0].durationMs).toBeGreaterThanOrEqual(0)
      },
    })
  })
})

describe("loadFiles", () => {
  test("loads files matching glob pattern", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "const a = 1")
        await Bun.write(path.join(dir, "b.ts"), "const b = 2")
        await Bun.write(path.join(dir, "c.js"), "const c = 3")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const repl = await ReplTool.init()
        const result = await repl.execute(
          { code: '$.files = await loadFiles("*.ts")\nprint(Object.keys($.files).length)' },
          ctx,
        )
        expect(result.output).toBe("2")
      },
    })
  })
})

describe("budget injection", () => {
  test("$.budget is injected with total, used, remaining", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = "test-budget"
        const budgetCtx = { ...ctx, sessionID: sid }
        const repl = await ReplTool.init()
        const result = await repl.execute({ code: "print(JSON.stringify($.budget))" }, budgetCtx)
        const budget = JSON.parse(result.output)
        expect(budget).toHaveProperty("total")
        expect(budget).toHaveProperty("used")
        expect(budget).toHaveProperty("remaining")
        expect(budget.used).toBe(1)
      },
    })
  })
})
