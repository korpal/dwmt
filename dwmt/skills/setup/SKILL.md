---
name: setup
description: Generates dwmt agents (.claude/agents/dwmt-*.md) from .claude/dwmt.json; creates a default config if missing. A session restart is recommended afterwards.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
# dwmt: setup

Talk to the user in their language.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dwmt.mjs" setup` from the repo root. Never write the agents with edit tools.
   - `node` not found: dwmt needs Node.js >= 22. Tell the user to install the LTS (Windows `winget install OpenJS.NodeJS.LTS`, macOS `brew install node`, Linux/WSL nvm or the distro package), open a new terminal and run setup again; stop. `ok: false`: show `error` and `hint`; stop.
2. Report in 3–5 lines: config path, whether it was created (`wroteConfig`), target branch (`target`), agents written (`written`) and removed (`removed`, e.g. the old `dwmt-planner` replaced by `dwmt-architect`), `warnings` (e.g. `roles.planner` read as `architect`), hash.
3. `targetQuestion` present: ask with AskUserQuestion which branch finished sprints land in (why: dwmt squashes every sprint into it). Options: `candidates`, `recommended` first; no candidates → ask for the name. Then run `setup --target <branch>` and report it. `reason: missing` = the configured branch does not exist.
4. `wroteConfig: true`: show `.claude/dwmt.json` and ask the user to fill it in per the plugin README:
   - `language`;
   - `verify.full`: the full suite;
   - `review.lensGlobs`: globs for the risk lenses.

   The driver (`drive.mjs`, a script instead of the model session) runs sprints by default; `"drive": {"enabled": false}` in `.claude/dwmt.json` brings back the model session. Inline mode is always a model session.

   After a config change, run setup again.
5. Non-empty `written` or `removed`, or `wroteTarget: true`:
   - give the commit command for the config and agents (commit only with the user's consent; the quoted pathspec also stages removed agents):
     ```text
     git add -A -- .claude/dwmt.json ".claude/agents/dwmt-*.md"
     git commit -m "dwmt: config and agents"
     ```
   - recommend a new session (`claude --effort high`): new agents are reliably visible only after a restart.
