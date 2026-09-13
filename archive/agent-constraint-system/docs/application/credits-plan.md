# Codex Open Source Fund — Credits Usage Plan

## Summary

We request **$25,000 in OpenAI API credits** to build the first open, reproducible safety evaluation suite for autonomous coding agents, powered by Codex CLI.

## How Credits Will Be Used

### 1. Adversarial Scenario Generation (30% — $7,500)

Generate and validate large-scale adversarial coding-agent scenarios:

- Use GPT-4-level models to synthesize realistic dangerous command variations
- Generate multi-step attack trajectories that semantic misunderstanding can trigger
- Create language-confused scenarios (Chinese→English, Japanese→English) where intent drift leads to danger
- Validate generated scenarios against Codex CLI behavior

### 2. Large-Scale Codex Safety Evaluation (35% — $8,750)

Run the ACS benchmark at scale against Codex CLI:

- Execute the 105-scenario benchmark across multiple Codex sessions
- Test bypass resistance across 10+ bypass vectors per dangerous command
- Measure false positive impact: what legitimate developer tasks does ACS incorrectly block?
- Profile runtime overhead: what's the latency cost of guard checks?
- Track session-level behavior: does Codex learn to avoid blocked commands?

### 3. Multi-Agent Safety Testing (20% — $5,000)

Test cross-agent interactions where ACS provides a unified safety layer:

- Deploy ACS on Codex + Claude Code + Gemini CLI simultaneously
- Test cross-agent confused deputy scenarios (agent A modifies agent B's config)
- Verify consistent blocking behavior across all agents
- Measure lock propagation: can one agent's violation trigger cross-agent safety?

### 4. Automated Regression Testing (15% — $3,750)

Build CI-integrated safety regression for new Codex releases:

- Automate benchmark runs on each Codex CLI update
- Detect safety regressions before production deployment
- Generate diff reports showing which scenarios newly pass/fail
- Publish regression results publicly with each ACS release

## Deliverables

1. **Public Benchmark Dataset** — 1,000+ validated adversarial coding-agent scenarios
2. **Cross-Agent Safety Report** — Comparative analysis of safety across 4+ coding agents
3. **ACS v7.0** — Hardened release with improved bypass resistance (target: 95%+)
4. **CI Regression Suite** — GitHub Actions workflow for automated safety testing
5. **Research Paper** — "Toward Cross-Agent Runtime Safety for Autonomous Coding Agents"

## Timeline

| Month | Focus | Credits |
|-------|-------|---------|
| 1-2 | Scenario generation + benchmark framework | 30% |
| 2-4 | Large-scale Codex evaluation + multi-agent testing | 55% |
| 4-6 | Regression suite + publication | 15% |

## Impact on Codex Ecosystem

- **Direct benefit**: Codex CLI becomes measurably safer against known attack vectors
- **Ecosystem benefit**: Open benchmark enables all coding agents to measure and improve safety
- **Research benefit**: First public dataset for coding-agent safety evaluation
- **Community benefit**: CI regression prevents safety regressions in future Codex releases
