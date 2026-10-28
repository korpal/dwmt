# dwmt (don't waste my time)

A Claude Code plugin that works like an agile team working for you. The team keeps a backlog and a roadmap, has a product owner and specialists such as an architect and a UX designer, and delivers in sprints.

You are the stakeholder: you bring ideas and bugs, take part in planning, answer the team's questions and accept what has been delivered.

Under the hood each sprint is planned, implemented task by task, reviewed and lands as one commit on your branch; the mechanics (state, tests, git) run in a Node script, not in the model.

## Requirements

Claude Code 2.1.283 or later, Node.js 22 or later, git.

## Install

```text
/plugin install dwmt --marketplace korpal/dwmt
```

Then, in the root of your project, run `/dwmt:setup` and restart the session.

## Update

```text
/plugin marketplace update dwmt
```

Or turn on auto-update for the `dwmt` marketplace in `/plugin` → Marketplaces.

## Commands

| Command | What it does |
|---|---|
| `/dwmt:setup` | Creates `.claude/dwmt.json` and the dwmt agents for your project. |
| `/dwmt:po` | The product owner: backlog, roadmap, triage and starting work. |
| `/dwmt:run` | A sprint from task to squash: preflight, planning, execution. |
| `/dwmt:execute` | Resumes a sprint run after a break. |
| `/dwmt:uat` | Your acceptance test of merged sprints, with defects recorded. |
| `/dwmt:expert`, `/dwmt:architect`, `/dwmt:ux` | Talk with a domain expert; decisions are recorded after your confirmation. |

`dwmt product import` can read existing plans from Markdown and from a GSD-style `.planning/` directory.

## Documentation

`/dwmt:setup` writes a minimal `.claude/dwmt.json`: the model, your test commands in `verify.full` (fill them in) and the target branch. Code comments refer to design documents that are not part of this repository.

## License

MIT
