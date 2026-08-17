/**
 * linear.mts — the board is in Linear; this is how the integrator moves it.
 *
 *   npx tsx scripts/linear.mts list [--state "In Progress"]
 *   npx tsx scripts/linear.mts create "Title" --state Backlog [--desc "..."]
 *   npx tsx scripts/linear.mts move JOS-18 "In Progress"
 *   npx tsx scripts/linear.mts comment JOS-18 "E1 doer dispatched (worktree agent)"
 *   npx tsx scripts/linear.mts comment JOS-18 --file brief.md   (multi-line bodies MUST use
 *       --file / --desc-file: on Windows the npx cmd shim mangles argv at the first blank
 *       line, silently truncating anything passed inline — proven 2026-08-14)
 *
 * CANONICAL PROJECT MANAGEMENT (owner decision, 2026-08-05): the kanban in the owner's
 * personal Linear workspace (Josh's Maker Space, team JOS — NEVER the work workspace) is the
 * source of truth for what is being built, by which agent, and where it stands. The
 * integrator moves issues when dispatching (→ In Progress, with a comment naming the wave)
 * and when merging (→ Done, with the commit hash). Flat organization, no projects/cycles.
 *
 * AUTH: personal API key in .triage/linear.env (gitignored; created 2026-08-05, key name
 * eq-companion-claude-agent). No secret lives in this file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const env = readFileSync(join(import.meta.dirname, '..', '.triage', 'linear.env'), 'utf8')
const KEY = /LINEAR_API_KEY=(\S+)/.exec(env)?.[1] ?? ''
if (!KEY) throw new Error('LINEAR_API_KEY missing from .triage/linear.env')

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: KEY },
    body: JSON.stringify({ query, variables })
  })
  const body = (await res.json()) as { data?: T; errors?: unknown }
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data as T
}

interface StateNode { id: string; name: string; type: string }
interface TeamData { teams: { nodes: { id: string; key: string; name: string; states: { nodes: StateNode[] } }[] } }

const teamData = await gql<TeamData>('query { teams { nodes { id key name states { nodes { id name type } } } } }')
const team = teamData.teams.nodes[0]
if (!team) throw new Error('no team visible to this key')

const stateId = (name: string): string => {
  const s = team.states.nodes.find((x) => x.name.toLowerCase() === name.toLowerCase())
  if (!s) throw new Error(`no state '${name}' — have: ${team.states.nodes.map((x) => x.name).join(', ')}`)
  return s.id
}

async function issueByIdentifier(ident: string): Promise<{ id: string; identifier: string; title: string }> {
  const num = Number(ident.split('-')[1])
  const d = await gql<{ issues: { nodes: { id: string; identifier: string; title: string }[] } }>(
    'query($n: Float!) { issues(filter: { number: { eq: $n } }, first: 1) { nodes { id identifier title } } }',
    { n: num }
  )
  const node = d.issues.nodes[0]
  if (!node) throw new Error(`no issue ${ident}`)
  return node
}

const [cmd, a, b] = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

if (cmd === 'list') {
  // THE SYNC READ: the owner steers by reordering the board and cancelling tickets. Output is
  // sorted by the kanban's own manual order (sortOrder within a column) with the priority
  // field shown — this listing IS the dispatch queue, never a cached plan of it.
  const want = flag('state')
  const d = await gql<{ issues: { nodes: { identifier: string; title: string; sortOrder: number; priority: number; state: { name: string; position: number } }[] } }>(
    'query($id: ID!) { issues(filter: { team: { id: { eq: $id } } }, first: 250) { nodes { identifier title sortOrder priority state { name position } } } }',
    { id: team.id }
  )
  const PRIO = ['—', 'URGENT', 'High', 'Med', 'Low']
  const rows = d.issues.nodes
    .filter((n) => !want || n.state.name.toLowerCase() === want.toLowerCase())
    .sort((a, b) => a.state.position - b.state.position || a.sortOrder - b.sortOrder)
  for (const n of rows) {
    console.log(`${n.identifier}  [${n.state.name}]  (${PRIO[n.priority] ?? n.priority})  ${n.title}`)
  }
} else if (cmd === 'show' && a) {
  const issue = await issueByIdentifier(a)
  const d = await gql<{ issue: { title: string; description: string; state: { name: string }; priority: number; comments: { nodes: { body: string; createdAt: string }[] } } }>(
    'query($id: String!) { issue(id: $id) { title description priority state { name } comments { nodes { body createdAt } } } }',
    { id: issue.id }
  )
  console.log(`# ${issue.identifier}: ${d.issue.title}\nState: ${d.issue.state.name} · priority ${String(d.issue.priority)}\n\n${d.issue.description}\n`)
  for (const c of d.issue.comments.nodes) console.log(`--- comment (${c.createdAt}):\n${c.body}\n`)
} else if (cmd === 'create' && a) {
  // --priority: 1 urgent, 2 high, 3 medium, 4 low (Linear's own scale; 0/absent = none)
  const prio = flag('priority')
  const descFile = flag('desc-file')
  const input: Record<string, unknown> = {
    teamId: team.id, title: a,
    description: descFile !== undefined ? readFileSync(descFile, 'utf8') : (flag('desc') ?? ''),
    stateId: stateId(flag('state') ?? 'Todo')
  }
  if (prio !== undefined) input.priority = Number(prio)
  const d = await gql<{ issueCreate: { issue: { identifier: string } } }>(
    'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier } } }',
    { input }
  )
  console.log(`created ${d.issueCreate.issue.identifier}`)
} else if (cmd === 'move' && a && b) {
  const issue = await issueByIdentifier(a)
  await gql('mutation($id: String!, $sid: String!) { issueUpdate(id: $id, input: { stateId: $sid }) { success } }', {
    id: issue.id, sid: stateId(b)
  })
  console.log(`${issue.identifier} -> ${b}`)
} else if (cmd === 'edit' && a && (flag('title') !== undefined || flag('desc-file') !== undefined)) {
  // Rewrite an existing ticket's title and/or body in place (a ticket that graduates from GATED
  // to a build brief keeps its identifier and its comment history).
  const issue = await issueByIdentifier(a)
  const input: Record<string, unknown> = {}
  const title = flag('title')
  const descFile = flag('desc-file')
  if (title !== undefined) input.title = title
  if (descFile !== undefined) input.description = readFileSync(descFile, 'utf8')
  await gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', {
    id: issue.id, input
  })
  console.log(`${issue.identifier} edited`)
} else if (cmd === 'comment' && a && (b || flag('file'))) {
  const issue = await issueByIdentifier(a)
  const file = flag('file')
  const body = file !== undefined ? readFileSync(file, 'utf8') : b
  await gql('mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }', {
    id: issue.id, body
  })
  console.log(`${issue.identifier} commented`)
} else {
  console.log('usage: linear.mts list [--state S] | create "Title" [--state S] [--desc D|--desc-file F] | edit JOS-N [--title T] [--desc-file F] | move JOS-N "State" | comment JOS-N "text"|--file F')
}
