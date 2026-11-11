/**
 * `SessionController.releaseAgent` disposes an idle Agent the controller
 * resumed, releases the Session's writer lock, keeps the Session listed for
 * Clients, and lets the next request resume it from the unchanged log.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-workspace'
import type SessionController from '../src/index.ts'
import type { SessionSummary } from '../src/types.ts'
import { createSessionTestController } from './test-remote.ts'

const ownedContexts = new Set<Context>()
const ownedRoots = new Set<string>()
afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
  await Promise.all([...ownedRoots].map(root => rm(root, { recursive: true, force: true })))
  ownedRoots.clear()
})

interface Fixture {
  readonly ctx: Context
  readonly controller: SessionController
  readonly cwd: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-agent-'))
  ownedRoots.add(root)
  const ctx = new Context()
  ownedContexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
  const controller = await createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: root,
  })
  await mountAgentLoopTestHarness(ctx)
  return { ctx, controller, cwd: root }
}

/** A completed conversation: one turn with one human prompt. */
function conversation(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 800, data: { turn: 1 } },
    {
      type: 'user/message', seq: SessionSeq(1), time: 1200,
      data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: SessionSeq(2), time: 1300, data: { turn: 1, reason: 'completed' } },
  ] as SessionEvent[]
}

async function storeSession(ctx: Context, id: SessionId, cwd: string): Promise<void> {
  const prepared = ctx.sessions.prepare(id, { meta: { cwd } })
  const handle = await ctx.sessionPersistence.create(prepared.header)
  await handle.append(conversation())
  await handle.close()
}

async function resumed(f: Fixture, id: string): Promise<SessionId> {
  const sessionId = SessionId(id)
  await storeSession(f.ctx, sessionId, f.cwd)
  const result = await f.controller.resolveAgent(sessionId)
  if (!('agent' in result)) throw new Error(`resume failed: ${result.error.message}`)
  return sessionId
}

describe('SessionController.releaseAgent', () => {
  it('disposes an idle resumed Agent, frees the writer lock, keeps the row listed, and resumes again', async () => {
    const f = await fixture()
    const sessionId = await resumed(f, 'release-idle')
    const added: SessionSummary[] = []
    const removed: SessionId[] = []
    f.ctx.on('api-session/added', (summary) => { added.push(summary) })
    f.ctx.on('api-session/removed', (id) => { removed.push(id) })

    await expect(f.controller.releaseAgent(sessionId)).resolves.toEqual({ released: true })

    expect(f.ctx.agents.get(sessionId)).toBeUndefined()
    expect(f.ctx.sessions.get(sessionId)).toBeUndefined()
    expect(removed).toEqual([])
    expect(added).toEqual([expect.objectContaining({ sessionId, agentAvailable: false, running: false })])
    const writer = await f.ctx.sessionPersistence.open(sessionId, 'write')
    await writer.close()

    const again = await f.controller.resolveAgent(sessionId)
    expect(again).toMatchObject({ agent: { id: sessionId } })
    if (!('agent' in again)) throw new Error('resume after release failed')
    expect(again.agent.session.eventAt(SessionSeq(2))?.type).toBe('turn/end')
    await expect(f.controller.releaseAgent(sessionId)).resolves.toEqual({ released: true })
  })

  it('still reports a disposal it did not request as a removal', async () => {
    const f = await fixture()
    const sessionId = SessionId('foreign-disposal')
    const removed: SessionId[] = []
    f.ctx.on('api-session/removed', (id) => { removed.push(id) })
    const handle = await f.ctx.agents.create({ sessionId, meta: { cwd: f.cwd } })
    await expect(f.controller.releaseAgent(sessionId)).resolves.toEqual({ released: false, reason: 'not-owned' })
    expect(f.ctx.agents.get(sessionId)).toBe(handle.agent)
    await handle.dispose()
    expect(removed).toEqual([sessionId])
  })

  it('reports a Session without a live Agent as not loaded', async () => {
    const f = await fixture()
    await expect(f.controller.releaseAgent(SessionId('never-loaded')))
      .resolves.toEqual({ released: false, reason: 'not-loaded' })
  })

  it('keeps an Agent whose Session reports work', async () => {
    const f = await fixture()
    const sessionId = await resumed(f, 'release-busy')
    const activity = [{ kind: 'turn' as const }]
    f.ctx.on('workspace/session-activity', async (request, next) => request.sessionId === sessionId
      ? [...activity, ...await next()]
      : next())

    await expect(f.controller.releaseAgent(sessionId))
      .resolves.toEqual({ released: false, reason: 'active', activity })
    expect(f.ctx.agents.get(sessionId)).toMatchObject({ id: sessionId })
  })
})
