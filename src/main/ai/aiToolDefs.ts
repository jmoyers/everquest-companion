export interface AITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const queryParam = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Name or search text' }
  },
  required: ['query']
}

export const AI_TOOLS: AITool[] = [
  {
    type: 'function',
    function: {
      name: 'search_items',
      description: 'Search the local EverQuest Legends item database (stats, drops, quests). Offline. Not Live EQ or P99.',
      parameters: queryParam
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_spells',
      description:
        'Search the local spell database. Supports the same tokens as in-app search (name text, class:clr, 27-28, type:buff).',
      parameters: queryParam
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_mobs',
      description: 'Search the local mob catalog (level, zones, known loot). Offline.',
      parameters: queryParam
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_output',
      description:
        'Read a /outputfile dump (inventory, spellbook, factions, guild, raid, achievements). Returns empty, updatedAt, stale, and a note. If empty, tell them to type the command in game. If stale, say the list may be out of date. Do not invent bags. Do not ask them to paste.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['inventory', 'spellbook', 'factions', 'guild', 'raid', 'achievements']
          }
        },
        required: ['kind']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_loadout',
      description: "This character's current class trio from the companion's combo model. Label inferred vs /who.",
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_aa',
      description: 'This character AA ledger from the log: earned, unspent, allocated, recent purchases. No community AA prices.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_fight',
      description:
        'This pull: live vs last fight, current target, your damage and DPS, pet total. Hydrating means the log is still being read - do not treat that as live.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_zone',
      description:
        'The zone you are in: catalog mobs and watched respawn clocks for that zone. A due clock is not a spawn. Zone unknown if no enter line yet.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_buffs',
      description:
        'Buffs and debuffs the log has landed for this character. Inferred targets are labeled. No duration means the overlay counts elapsed time, not a countdown.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_loot',
      description:
        'Recent loot this character picked up, joined to the local item DB (quest/lore/summary) when the name is known.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'draft_alert',
      description:
        'Propose an in-app alert. Does NOT save it. Prefer `spell` for a named spell (typed trigger). Use triggerRegex only for a custom log line. Tell the user to confirm the card in chat.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short alert name' },
          spell: { type: 'string', description: 'Spell name for a buffApply where.spell trigger' },
          eventKind: { type: 'string', description: 'Log event kind when no spell (buffWearOff, death, zone, ...)' },
          triggerRegex: { type: 'string', description: 'Raw log regex only if the user asked for a custom line' },
          speechText: { type: 'string', description: 'Optional TTS phrase' },
          note: { type: 'string', description: 'What the alert is for' }
        },
        required: ['name']
      }
    }
  }
]

export const RETIRED_TOOL_NAMES = [
  'query_local_items',
  'fetch_eql_wiki_quest',
  'fetch_eql_aa_paths',
  'fetch_patch_notes',
  'create_alert'
] as const
