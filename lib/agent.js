/* sidecar — who is the agent running this command?

   One answer for the CLI, the wait, the presence ping and the server, because the name is what the
   human reads on a card and in "codex is here", and four copies of a default drift.

   SIDECAR_AGENT wins, always. Without it the name used to be 'claude' for everyone, so a review driven
   by Codex read "claude is here" and wore claude's name on every card. The harness is asked instead:

     Codex        sets CODEX_THREAD_ID and CODEX_SESSION_ID in every shell it runs (0.154.0, checked)
     Claude Code  sets CLAUDECODE=1

   Codex is asked FIRST, because a Codex launched from inside a Claude Code session inherits
   CLAUDECODE and is still Codex. A harness not listed here is 'claude', which is what it always was;
   add one only with the variable verified, never from memory. */
'use strict';

function agentName(env = process.env) {
  const named = String(env.SIDECAR_AGENT || '').trim();
  if (named) return named;
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  return 'claude';
}

// The name this agent went by BEFORE its harness was detected, or null. Until 1.13 every agent that
// set no SIDECAR_AGENT was 'claude', so a Codex that upgrades has a digest cursor, a doc baseline and
// a set of cards all filed under that name. lib/digest.js reads the old cursor when the new name has
// none, so the first wait after the upgrade reports what was unseen instead of snapshotting past it,
// and `drop` treats the old name's cards as this agent's own. Null when the name was set explicitly
// (that agent always had its name) and when the detected name is 'claude' (nothing changed).
function legacyName(env = process.env) {
  if (String(env.SIDECAR_AGENT || '').trim()) return null;
  return agentName(env) === 'claude' ? null : 'claude';
}

// Every name that is an agent's, as far as this process can know: its own, the ones agentName can
// produce, and whatever SIDECAR_AGENTS lists (comma-separated) for a harness that is neither. The
// server hands this to the page and to public/turn.js, because a review can have claude and codex
// both writing into it and the server was only started by one of them. A list of AGENTS rather than
// "everyone but the human": a document travels through git between people, and a second human's name
// must not turn yellow.
//
// The human's own name is never on it. SIDECAR_USER=claude is a person called Claude, and the default
// list would otherwise colour their replies as an agent's and count them as waiting on themselves.
const KNOWN = ['claude', 'codex'];
function agentNames(env = process.env) {
  const extra = String(env.SIDECAR_AGENTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const user = String(env.SIDECAR_USER || 'you');
  const own = agentName(env);
  return [...new Set([own, ...KNOWN, ...extra])].filter(n => n === own || n !== user);
}

module.exports = { agentName, agentNames, legacyName, KNOWN };
