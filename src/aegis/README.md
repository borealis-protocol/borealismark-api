# Aegis Verification MVP

The independent verification layer for BTS trust scores.

## What it does

Agents submit telemetry claiming behavioral compliance. The Aegis independently
evaluates whether those claims are honest. If confirmed by two independent auditors,
the agent's trust_source upgrades from "bts" (self-reported) to "aegis-verified"
and the score cap is lifted.

## Architecture

Uses existing pieces - no new services, no new tables:

- **ARBITER** (Qwen QwQ-32B via OpenRouter) - first-pass evaluation
- **MAGISTRATE** (DeepSeek R1 via OpenRouter) - independent second opinion
- **agents.aegis_verified_at** - timestamp column (new migration)
- **getPublicAgents()** - updated CASE expression to include 'aegis-verified'

## Verification Criteria

ARBITER and MAGISTRATE independently evaluate:

1. **Internal consistency** - Are the 5-factor scores self-consistent?
   (e.g., high constraint adherence with high anomaly rate is suspicious)
2. **Statistical plausibility** - Are metrics within expected distributions?
   (suspiciously perfect scores across all dimensions flag gaming)
3. **Temporal stability** - Do scores show natural variance over time?
   (real agents have fluctuation; fabricated data is too smooth)
4. **Evidence completeness** - Are batch hashes, event samples, and
   sequence ranges present and internally coherent?
5. **Cross-reference signals** - Does observable behavior (API activity,
   registration date, agent type) align with claimed performance?

## Verdict Model

Each auditor returns: PASS / FAIL / INSUFFICIENT_DATA

- Both PASS -> trust_source upgraded to 'aegis-verified'
- Any FAIL -> trust_source stays 'bts', flag recorded
- INSUFFICIENT_DATA -> no change, retry when more telemetry exists

## Run

```bash
# On Render shell or locally with DB access
OPENROUTER_API_KEY=sk-or-... node src/aegis/verify.js

# Dry run (evaluate but don't update DB)
OPENROUTER_API_KEY=sk-or-... node src/aegis/verify.js --dry-run

# Single agent
OPENROUTER_API_KEY=sk-or-... node src/aegis/verify.js --agent agent_eec93f5dcbae48f19e1d
```
