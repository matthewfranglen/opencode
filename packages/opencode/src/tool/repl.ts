import z from "zod"
import { Tool } from "./tool"
import { Log } from "../util/log"
import { Provider } from "../provider/provider"
import { generateText } from "ai"
import { Instance } from "../project/instance"
import { Session } from "../session"
import type { MessageV2 } from "../session/message-v2"
import DESCRIPTION from "./repl.txt"

const log = Log.create({ service: "repl-tool" })

// Persistent store per session. The `$` object inside the REPL persists
// across calls. `$.foo = 123` in one call is accessible as `$.foo` in the next.
const stores = new Map<string, Record<string, unknown>>()

function getStore(sessionID: string): Record<string, unknown> {
  if (stores.has(sessionID)) return stores.get(sessionID)!
  const store: Record<string, unknown> = {}
  stores.set(sessionID, store)
  return store
}

// Serialize session messages into a structured format suitable for
// programmatic exploration in the REPL.
export function serializeMessages(messages: MessageV2.WithParts[]): {
  turns: Array<{
    role: string
    agent?: string
    text: string
    tools: Array<{ tool: string; input: string; output: string }>
  }>
  text: string
} {
  const turns: Array<{
    role: string
    agent?: string
    text: string
    tools: Array<{ tool: string; input: string; output: string }>
  }> = []

  for (const msg of messages) {
    const role = msg.info.role
    const agent = msg.info.role === "assistant" ? msg.info.agent : undefined
    const texts: string[] = []
    const tools: Array<{ tool: string; input: string; output: string }> = []

    for (const part of msg.parts) {
      if (part.type === "text" && !("synthetic" in part && part.synthetic)) {
        texts.push(part.text)
      }
      if (part.type === "tool" && part.state.status === "completed") {
        tools.push({
          tool: part.tool,
          input: JSON.stringify(part.state.input ?? {}),
          output: part.state.output ?? "",
        })
      }
    }

    turns.push({
      role,
      agent,
      text: texts.join("\n"),
      tools,
    })
  }

  // Build a plain-text representation for simple queries
  const lines: string[] = []
  for (const turn of turns) {
    const prefix = turn.agent ? `[${turn.role}/${turn.agent}]` : `[${turn.role}]`
    if (turn.text) lines.push(`${prefix} ${turn.text}`)
    for (const t of turn.tools) {
      lines.push(`${prefix} [tool:${t.tool}] ${t.output.slice(0, 500)}`)
    }
  }

  return { turns, text: lines.join("\n\n") }
}

async function makeLoadSession(sessionID: string) {
  return async function loadSession(targetSessionID?: string): Promise<{
    turns: Array<{
      role: string
      agent?: string
      text: string
      tools: Array<{ tool: string; input: string; output: string }>
    }>
    text: string
    messageCount: number
  }> {
    const id = targetSessionID ?? sessionID
    const messages = await Session.messages({ sessionID: id })
    const result = serializeMessages(messages)
    return { ...result, messageCount: messages.length }
  }
}

async function makeLlmQuery(providerID: string) {
  return async function llm_query(
    prompt: string,
    context: string,
    options?: { model?: string },
  ): Promise<string> {
    let model
    if (options?.model) {
      const parsed = Provider.parseModel(options.model)
      model = await Provider.getModel(parsed.providerID, parsed.modelID)
    } else {
      model = await Provider.getSmallModel(providerID)
      if (!model) {
        const fallback = await Provider.defaultModel()
        model = await Provider.getModel(fallback.providerID, fallback.modelID)
      }
    }
    const language = await Provider.getLanguage(model)
    const result = await generateText({
      model: language,
      messages: [
        { role: "system", content: "You are a helpful assistant. Answer concisely based on the provided context." },
        { role: "user", content: `${prompt}\n\n<context>\n${context}\n</context>` },
      ],
    })
    return result.text
  }
}

export const ReplTool = Tool.define("repl", async () => {
  const defaultModel = await Provider.defaultModel()
  const query = await makeLlmQuery(defaultModel.providerID)

  return {
    description: DESCRIPTION,
    parameters: z.object({
      code: z.string().describe("JavaScript code to execute in the persistent REPL"),
    }),
    async execute(params, ctx) {
      const $ = getStore(ctx.sessionID)

      // Capture console.log output
      const output: string[] = []
      const capture = (...args: unknown[]) => {
        output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" "))
      }

      const loader = await makeLoadSession(ctx.sessionID)

      // Build the execution environment. The `$` object is the persistent store.
      // Everything else is convenience — llm_query, print, console, etc.
      const env: Record<string, unknown> = {
        $,
        llm_query: query,
        loadSession: loader,
        print: capture,
        console: { ...console, log: capture, info: capture, warn: capture, error: capture },
        directory: Instance.directory,
      }

      // Wrap in async IIFE for top-level await support
      const wrapped = `return (async () => {\n${params.code}\n})()`

      const keys = Object.keys(env)
      const values = keys.map((k) => env[k])

      try {
        const fn = new Function(...keys, wrapped)
        const result = await fn(...values)

        // If code returned a value but nothing was printed, show the return value
        if (result !== undefined && output.length === 0) {
          capture(result)
        }

        const text = output.join("\n")
        log.info("repl executed", { sessionID: ctx.sessionID, outputLength: text.length })

        ctx.metadata({
          metadata: {
            output: text.length > 30_000 ? text.slice(0, 30_000) + "\n\n..." : text,
          },
        })

        return {
          title: "repl",
          metadata: {},
          output: text || "(no output)",
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.info("repl error", { sessionID: ctx.sessionID, error: msg })
        return {
          title: "repl",
          metadata: {},
          output: `Error: ${msg}`,
        }
      }
    },
  }
})
