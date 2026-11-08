// End-to-end simulation of the LAN multi-device join: one hub and two nodes, each a real
// process on 127.0.0.1 with its own temporary HOME and data folder, so nothing here can
// touch the user's own team (~/.dsh, ~/.ds-bot).
//
//   node dev/multi-node-sim.mjs            # run the whole flow, one PASS/FAIL line per step
//   node dev/multi-node-sim.mjs --keep     # leave the three processes running for a look
//   node dev/multi-node-sim.mjs --json     # also print the step results as JSON
//
// What it proves, in order: a node finds the hub over the discovery probe, asks to join,
// the hub allows it, the node backs up its own team, takes over the hub's Bots, memory and
// settings, keeps its own credentials and machine settings, follows the hub's conversation
// and sends a message back, and a second join of the same hub writes nothing twice.
//
// The Session is a scripted stand-in: the hub answers a pull with the message it holds and
// appends a reply when a node sends one. That is the role `dev/mock-llm.mjs` plays for a
// run with a real DSH; this simulation needs neither a model nor a key.
import { spawn } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHub } from '../src/host/multi-device/hub.js'
import { createTeamSource } from '../src/host/multi-device/team-sync.js'
import { replicaFile } from '../src/host/multi-device/session-client.js'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, '..')

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}
const flag = name => process.argv.includes(`--${name}`)

const say = (ok, scope, detail) => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${scope}: ${detail}\n`)
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function step(scope, run) {
  try {
    const detail = await run()
    say(true, scope, detail ?? 'ok')
    return true
  } catch (error) {
    say(false, scope, error?.message ?? String(error))
    return false
  }
}

async function until(check, { timeout = 20_000, interval = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await wait(interval)
  }
  throw new Error(`${what} did not happen within ${timeout} ms`)
}

async function freeTcpPort() {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function freeUdpPort() {
  const socket = createSocket('udp4')
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}

const teamOf = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Main', instructions: 'Run the team.', sessionId: 'chief', createdAt: 1 },
    writer: { id: 'writer', name: 'Writer', role: 'Writes', instructions: 'Write it down.', sessionId: 'writer', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  privateArchives: [],
  capabilities: { items: {} },
  prefs: { theme: 'dark', defaultBotModel: { provider: 'deepseek', model: 'chat' } },
  revision: 1,
})

function seed(home, state, memory = {}) {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  for (const [key, text] of Object.entries(memory)) {
    const path = join(home, ...key.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
}

// The hub role: the real hub with a scripted Session and its team read from state.json.
async function runHub({ root, port, discoveryPort }) {
  const home = join(root, 'hub', 'bot')
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const items = [{ kind: 'user', text: 'hello from the hub' }]
  const waiting = new Set()
  let revision = 1
  const wake = () => {
    for (const done of waiting) done()
    waiting.clear()
  }
  const session = {
    async bots() {
      return { bots: [{ id: 'chief', name: 'Chief', role: 'Main', main: true }] }
    },
    async snapshot(botId, { since, waitMs } = {}) {
      if (since === revision && (waitMs ?? 0) > 0) {
        await new Promise(done => {
          const timer = setTimeout(done, Math.min(waitMs, 500))
          waiting.add(() => { clearTimeout(timer); done() })
        })
      }
      return { epoch: 'sim-1', revision, botId: 'chief', botName: 'Chief', sessionId: 'sim-session', items: [...items], hidden: 0 }
    },
    async send({ text }) {
      items.push({ kind: 'user', text })
      items.push({ kind: 'bot', text: `the scripted Bot answers: ${text}` })
      revision += 1
      wake()
      say(true, 'hub', `a node sent "${text}" and the scripted Bot answered`)
      return { ok: true, revision }
    },
  }
  const hub = createHub({
    dataDir: join(root, 'hub', 'multi-device'),
    host: '127.0.0.1',
    port,
    discoveryPort,
    name: 'sim-hub',
    sessionSync: session,
    teamSync: createTeamSource({ state: () => state, home: () => home, name: 'sim-hub' }),
    log: () => {},
  })
  await hub.start()
  process.stdout.write(`HUB-READY ${JSON.stringify({ url: hub.url, port: hub.port })}\n`)
  // The person at the hub pressing Allow, and the scripted reply, on a timer so the two
  // nodes can join in any order.
  const timer = setInterval(() => {
    for (const request of hub.joinRequests().filter(entry => entry.status === 'pending')) {
      if (hub.approveJoin(request.id)) say(true, 'hub', `allowed ${request.name}`)
    }
  }, 200)
  const stop = async () => {
    clearInterval(timer)
    await hub.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
}

// A node role: the plugin runtime, so the join is the same code the Devices page drives.
async function runNode({ root, name, hubUrl, discoveryPort }) {
  // The plugin runtime imports @deepseek-ai packages; the child was started with the same
  // resolver the unit tests use.
  const { createRuntime } = await import('../index.js')
  const { fakeContext } = await import('../test/fake-ctx.js')
  const home = join(root, name, 'bot')
  const dataDir = join(root, name, 'multi-device')
  const ctx = fakeContext()
  const rt = createRuntime(ctx, {
    home,
    multiDevice: { host: '127.0.0.1', port: 0, dataDir, name, discoveryPort, discovery: false },
  })
  await rt.multiDeviceReady

  let failed = false
  const results = {}
  const check = async (scope, run) => {
    const ok = await step(`${name} ${scope}`, run)
    results[scope] = ok
    if (!ok) failed = true
    return ok
  }

  let url
  await check('discovery', async () => {
    const found = await rt.multiDeviceScan({ timeoutMs: 2000 })
    const hub = found.hubs.find(entry => entry.name === 'sim-hub')
    if (hub === undefined) throw new Error(`no sim-hub among ${found.hubs.map(entry => entry.name).join(', ') || 'none'}`)
    url = hubUrl === undefined ? hub.url : hubUrl
    return `found ${hub.name} at ${hub.url}`
  })
  if (failed) return finish()

  await check('join', async () => {
    const status = await rt.multiDeviceJoin(url)
    if (status.node.joining === undefined) throw new Error('the page is not waiting for an answer')
    return 'asked to join, waiting for the hub to allow it'
  })

  await check('allow', async () => {
    await until(() => {
      const value = rt.multiDeviceStatus()
      return value.node.paired && value.node.online ? value : undefined
    }, { what: 'the hub to allow this machine' })
    return 'allowed and online'
  })

  await check('backup', async () => {
    const status = rt.multiDeviceStatus()
    const dir = status.node.backup
    if (typeof dir !== 'string' || !existsSync(dir)) throw new Error('the Devices status names no backup folder')
    const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    if (saved.bots.localonly === undefined) throw new Error('the backup does not hold this machine\'s own Bot')
    return dir
  })

  let after
  await check('team', async () => {
    after = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    const names = Object.values(after.bots).map(bot => bot.name).sort()
    if (JSON.stringify(names) !== JSON.stringify(['Chief', 'Writer'])) throw new Error(`the Bots are ${names.join(', ') || 'none'}`)
    if (after.bots.localonly !== undefined) throw new Error('this machine still has its own Bot')
    if (after.prefs.theme !== 'dark') throw new Error(`the theme is ${after.prefs.theme}`)
    return `${names.join(', ')} and the hub's settings`
  })

  await check('memory', async () => {
    const text = readFileSync(join(home, 'memory', 'team', 'MEMORY.md'), 'utf8')
    if (!text.includes('office')) throw new Error('the team memory is not the hub\'s')
    return 'the hub\'s team memory'
  })

  await check('local kept', async () => {
    const secrets = readFileSync(join(home, 'secrets.json'), 'utf8')
    if (!secrets.includes('NODE_KEY')) throw new Error('this machine\'s own secret is gone')
    if (secrets.includes('hub-only-value')) throw new Error('the hub\'s secret was copied here')
    if (after.multiDevice?.node?.hubUrl === undefined) throw new Error('the join record is gone')
    if (after.bots.chief?.workDir !== undefined) throw new Error('a hub path leaked into the local team')
    return 'credentials stay local, the hub\'s key did not travel, machine paths stay local'
  })

  let replica
  await check('conversation from hub', async () => {
    const worker = rt.multiDeviceNodeWorker()
    if (worker === undefined) throw new Error('this node runs no worker')
    replica = await until(() => {
      try {
        const parsed = JSON.parse(readFileSync(replicaFile(dataDir, 'chief'), 'utf8'))
        return parsed.items.some(item => item.text === 'hello from the hub') ? parsed : undefined
      } catch {
        return undefined
      }
    }, { what: 'the hub conversation' })
    return `revision ${replica.revision}, ${replica.items.length} items`
  })

  await check('conversation to hub', async () => {
    const worker = rt.multiDeviceNodeWorker()
    const text = `from ${name}`
    await worker.session().send(text)
    await until(() => {
      try {
        return JSON.parse(readFileSync(replicaFile(dataDir, 'chief'), 'utf8')).items.some(item => item.text === `the scripted Bot answers: ${text}`)
      } catch {
        return false
      }
    }, { what: 'the answer to come back' })
    return `sent "${text}" and read the scripted answer back`
  })

  await check('reconnect idempotent', async () => {
    const again = await rt.multiDeviceRefreshTeam()
    if (again.applied !== false) throw new Error('a second sync applied the team again')
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    if (Object.keys(state.bots).length !== 2) throw new Error(`the Bots are ${Object.keys(state.bots).length}`)
    return 'a second sync wrote nothing'
  })

  return finish()

  async function finish() {
    await rt.multiDeviceHub?.stop()
    await ctx.dispose()
    process.stdout.write(`DONE ${JSON.stringify({ name, failed, results })}\n`)
    process.exit(failed ? 1 : 0)
  }
}

// The parent: three processes, three folder trees, one summary.
async function runAll() {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-multi-node-'))
  const port = await freeTcpPort()
  const discoveryPort = await freeUdpPort()
  const hubHome = join(root, 'hub', 'bot')
  seed(hubHome, teamOf(), {
    'memory/team/MEMORY.md': '# Memory\n\n## Index\n\n- The office team keeps its notes here. [[office]]\n',
    'memory/team/office.md': '# Office\n\nWe work from the office on weekdays.\n',
  })
  // A key the hub keeps. It must not travel with the team; the value is a marker, not a key.
  writeFileSync(join(hubHome, 'secrets.json'), `${JSON.stringify({
    secrets: [{ name: 'DEMO_KEY', value: 'hub-only-value', purpose: 'simulation' }],
  }, null, 2)}\n`)
  for (const name of ['node-1', 'node-2']) {
    const home = join(root, name, 'bot')
    seed(home, {
      version: 1,
      mainBotIds: ['localonly'],
      bots: { localonly: { id: 'localonly', name: 'LocalOnly', role: 'Here', sessionId: 'localonly', createdAt: 1 } },
      rooms: {},
      agents: {},
      privateArchives: [],
      capabilities: { items: {} },
      prefs: { theme: 'light' },
      revision: 1,
    }, { 'memory/team/MEMORY.md': '# Memory\n\nOnly this machine.\n' })
    writeFileSync(join(home, 'secrets.json'), `${JSON.stringify({
      secrets: [{ name: 'NODE_KEY', value: `local-only-${name}`, purpose: 'simulation' }],
    }, null, 2)}\n`)
  }

  const children = []
  const lines = []
  const start = (role, extra) => {
    const child = spawn(process.execPath, [
      // `--import` takes a URL: a Windows path would read as a `d:` scheme.
      '--import', pathToFileURL(resolve(plugin, 'test', 'harness-resolve.mjs')).href,
      resolve(plugin, 'dev', 'multi-node-sim.mjs'),
      '--role', role,
      '--root', root,
      ...extra,
    ], { cwd: plugin, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      const done = buffer.split('\n')
      buffer = done.pop()
      for (const line of done) {
        lines.push({ role, line })
        if (/^(PASS|FAIL|DONE) /.test(line)) process.stdout.write(`${line}\n`)
        if (line.startsWith('HUB-READY ')) child.emit('hub-ready', JSON.parse(line.slice('HUB-READY '.length)))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => process.stderr.write(`[${role}] ${chunk}`))
    children.push(child)
    return child
  }

  const hub = start('hub', ['--port', String(port), '--discovery', String(discoveryPort)])
  const hubUrl = await new Promise((resolvePromise, reject) => {
    hub.once('hub-ready', value => resolvePromise(value.url))
    hub.once('exit', code => reject(new Error(`the hub exited with ${code}`)))
    setTimeout(() => reject(new Error('the hub did not start within 15 s')), 15_000)
  })
  const nodes = ['node-1', 'node-2'].map(name => start('node', [
    '--name', name,
    '--hub', hubUrl,
    '--discovery', String(discoveryPort),
  ]))
  const done = nodes.map(node => new Promise(resolvePromise => node.once('exit', code => resolvePromise(code))))

  const timeout = setTimeout(() => {
    process.stderr.write('the simulation ran longer than 120 s; stopping it\n')
    for (const child of children) child.kill()
  }, 120_000)
  const codes = await Promise.all(done)
  clearTimeout(timeout)

  const passes = lines.filter(entry => entry.line.startsWith('PASS ')).length
  const failures = lines.filter(entry => entry.line.startsWith('FAIL '))
  process.stdout.write(`\n${passes} passed, ${failures.length} failed\n`)
  if (failures.length > 0) for (const failure of failures) process.stdout.write(`${failure.line}\n`)

  if (flag('json')) {
    const results = Object.fromEntries(lines
      .filter(entry => /^(PASS|FAIL) /.test(entry.line))
      .map(entry => [entry.line.slice(5), entry.line.startsWith('PASS')]))
    process.stdout.write(`${JSON.stringify({ root, hubUrl, results }, null, 2)}\n`)
  }

  if (flag('keep')) {
    process.stdout.write(`left running: hub ${hubUrl}, nodes under ${root}; Ctrl-C stops them\n`)
    return
  }
  hub.kill()
  await wait(200)
  rmSync(root, { recursive: true, force: true })
  process.exit(failures.length === 0 && codes.every(code => code === 0) ? 0 : 1)
}

const role = argOf('role')
if (role === 'hub') {
  await runHub({
    root: argOf('root'),
    port: Number(argOf('port')),
    discoveryPort: Number(argOf('discovery')),
  })
} else if (role === 'node') {
  await runNode({
    root: argOf('root'),
    name: argOf('name'),
    hubUrl: argOf('hub'),
    discoveryPort: Number(argOf('discovery')),
  })
} else {
  await runAll()
}
