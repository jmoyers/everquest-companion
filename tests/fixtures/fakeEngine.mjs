// A FAKE `engined.exe`, in Node, honouring the JOS-467 spawn contract verbatim.
//
// WHY THIS EXISTS AND WHY IT IS NOT A MOCK. The supervisor's in-process unit tests
// (tests/dataServerSupervisor.test.mts, section "the state machine") drive every failure path with
// fakes and a fake clock, which is the right instrument for a state machine. What they cannot see
// is the half that lives in the operating system: whether a real pipe delivers the token before a
// real child reads it, whether a real ephemeral port announced on a real stdout is the port a real
// `net.connect` reaches, whether closing a real stdin actually ends a real process. Those are the
// three things that make this a CONTRACT rather than a diagram, and this script is what lets them
// be asserted with no Rust in the tree.
//
// It is deliberately NOT the engine. It has no parser, no fold and no views — it answers `hello`
// and `session.health` and nothing else, which is exactly the surface phase 0's supervisor uses.
// The real binary is JOS-466; the real-binary end-to-end is JOS-470.
//
// THE CONTRACT, as implemented here:
//   1. The FIRST LINE on stdin is the token. Nothing is read from argv or the environment.
//   2. Bind 127.0.0.1 port 0, then print EXACTLY ONE line to stdout:
//      `EQC-ENGINE PORT=<port> PROTOCOL=<v>`. Diagnostics go to stderr.
//   3. EOF on stdin ⇒ exit 0, promptly.
//   4. Every connection opens with a valid `hello` or is closed.
//
// MODES (argv[2]) are the misbehaviours a supervisor has to survive. Each one is a real binary
// somebody will ship one day: `garbage` is a Rust panic on stdout, `silent` is a process that hangs
// before it binds, `crash` is a missing DLL, `deaf` is a wedged shutdown, `mute` is a live socket
// behind a stuck fold, `mismatch` is a build-version skew, `refuse` is the token check working.

import { createServer } from 'node:net'
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'ok'
const PROTOCOL = Number(process.env.FAKE_ENGINE_PROTOCOL ?? '1')

if (mode === 'crash') {
  process.stderr.write('fake engine: the CRT could not be loaded (STATUS_DLL_NOT_FOUND)\n')
  process.exit(3)
}

let token = null
let server = null

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  // Rule 1: the FIRST line is the token, and there is no second line in this protocol.
  if (token !== null) return
  token = line
  start()
})
rl.on('close', () => {
  // Rule 3: EOF on stdin is the shutdown signal. `deaf` is the binary that ignores it, which is
  // what makes the supervisor's kill escalation observable.
  if (mode === 'deaf') {
    process.stderr.write('fake engine: ignoring stdin EOF on purpose\n')
    return
  }
  server?.close()
  process.exit(0)
})

function start() {
  if (mode === 'silent') return
  if (mode === 'garbage') {
    process.stdout.write("thread 'main' panicked at engine/src/main.rs:12:5\n")
    return
  }
  server = createServer(onConnection)
  server.on('error', (err) => {
    process.stderr.write(`fake engine: listen failed: ${err.message}\n`)
    process.exit(4)
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    process.stdout.write(`EQC-ENGINE PORT=${port} PROTOCOL=${PROTOCOL}\n`)
    // The one line, then nothing — except in `chatty`, the build that put a diagnostic on the wrong
    // stream. A supervisor must say so and keep the engine, not kill a process that is answering.
    if (mode === 'chatty') process.stdout.write('note: this line does not belong on stdout\n')
  })
}

function onConnection(socket) {
  socket.setEncoding('utf8')
  let buffer = ''
  let greeted = false
  socket.on('error', () => {
    // A client that vanished mid-probe. Not this script's problem, and not a reason to die.
  })
  socket.on('data', (chunk) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at !== -1) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim() !== '') greeted = handle(socket, line, greeted)
      at = buffer.indexOf('\n')
    }
  })
}

/** One frame. Returns the connection's new "has said hello" state. */
function handle(socket, line, greeted) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    socket.destroy()
    return greeted
  }
  if (!greeted) {
    // Rule 4, and the token check it exists for. `refuse` is the same code path with the answer
    // forced, so a test can drive "the engine rejected us" without inventing a wrong token.
    if (message.op !== 'hello' || message.token !== token || mode === 'refuse') {
      socket.destroy()
      return greeted
    }
    const version = mode === 'mismatch' ? PROTOCOL + 1 : PROTOCOL
    send(socket, { kind: 'hello', ok: true, engineVersion: '0.0.0-fake', protocolVersion: version })
    return true
  }
  if (message.op === 'session.health') {
    // `mute`: the socket is up, the fold is wedged, nothing answers. Only a round-trip can see it.
    if (mode === 'mute') return greeted
    send(socket, {
      kind: 'reply',
      id: message.id,
      ok: true,
      result: { status: 'idle', epoch: 1, uptimeMs: Math.round(process.uptime() * 1000) }
    })
    return greeted
  }
  send(socket, {
    kind: 'error',
    id: message.id ?? 0,
    ok: false,
    error: { code: 'unknownOp', message: `the fake engine does not implement ${String(message.op)}` }
  })
  return greeted
}

function send(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`)
}
