# Benchmark report

Decision rule: Say Pi is more token-efficient only if both complete eligible provider pairs have Pi pass rate greater than or equal to native pass rate and Pi successful-run median combined tokens lower than native successful-run median combined tokens.

Global decision: **No global Pi efficiency claim**

**Auxiliary accounting limitation:** Native Pi tool-result, Claude sidechain, and Codex rollout schemas do not guarantee equivalent complete classifier/subagent discovery; token medians include detected auxiliary usage but are not complete cross-harness efficiency measurements.

| Provider pair | Eligible | Complete | Harness | Visible pass | Hidden pass | Success | Successful token median [range] (n) | Plan token share (n) | Turns (n) | Tool calls (n) | Blocked calls (n) | Elapsed s (n) | Cache ratio (n) |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| anthropic | False | True | pi-anthropic | 1.000 (n=9) | 0.889 (n=9) | 0.889 (n=9) | 323169.0 [187210.0, 784323.0] (n=8) | 0.378 (n=8) | 14.500 (n=8) | 21.000 (n=8) | 1.000 (n=8) | 117.814 (n=8) | 1.000 (n=8) |
| anthropic | False | True | claude | 1.000 (n=9) | 0.889 (n=9) | 0.778 (n=9) | 1208063.0 [714606.0, 2333068.0] (n=7) | 0.470 (n=7) | 20.000 (n=7) | 24.000 (n=7) | 0.000 (n=7) | 114.398 (n=7) | 1.000 (n=7) |
| openai | False | True | pi-openai | 1.000 (n=9) | 0.889 (n=9) | 0.889 (n=9) | 398906.0 [351452.0, 587763.0] (n=8) | 0.108 (n=8) | 26.500 (n=8) | 34.500 (n=8) | 1.000 (n=8) | 161.207 (n=8) | 0.865 (n=8) |
| openai | False | True | codex | 0.889 (n=9) | 1.000 (n=9) | 0.889 (n=9) | 605211.0 [500816.0, 797650.0] (n=8) | 0.194 (n=8) | 11.000 (n=8) | 15.500 (n=8) | 0.500 (n=8) | 175.148 (n=8) | 0.899 (n=8) |

Matched native - Pi median deltas:
- anthropic: combined_tokens=686607.500 (n=6), plan_token_share=0.050 (n=6), turns=2.500 (n=6), tool_calls=3.000 (n=6), blocked_calls=-1.000 (n=6), elapsed_seconds=5.350 (n=6), cache_hit_ratio=0.000 (n=6)
- openai: combined_tokens=191868.000 (n=7), plan_token_share=0.104 (n=7), turns=-17.000 (n=7), tool_calls=-18.000 (n=7), blocked_calls=0.000 (n=7), elapsed_seconds=15.620 (n=7), cache_hit_ratio=-0.011 (n=7)

Limitations:
- anthropic: Protocol-invalid run '34-anthropic-ambiguity-heavy-change-r3-claude': Operator selected 'Before filter/order', contradicting the predetermined answer requiring the limit after filtering and ordering.
- anthropic: Equivalent complete auxiliary accounting cannot be established across native formats; Pi tool-result auxiliary usage is included only when optional native usage fields are present.
- anthropic: Equivalent complete auxiliary accounting cannot be established across native formats; Claude sidechain usage is included when discovered, but native linkage cannot prove that every auxiliary session was retained.
- openai: Protocol-invalid run '35-openai-ambiguity-heavy-change-r3-pi-openai': Operator selected 'Raw input rows', contradicting the predetermined answer requiring the limit after filtering and ordering.
- openai: Protocol-invalid run '07-openai-cross-file-feature-r1-codex': Operator supplied an unapproved real-environment precedence clarification in a cross-file-feature run with no predetermined answer.
- openai: Protocol-invalid run '03-openai-localized-bug-r1-pi-openai': Operator supplied an unapproved Unicode-policy product clarification in a localized-bug run with no predetermined answer.
- openai: Protocol-invalid run '04-openai-localized-bug-r1-codex': Operator supplied an unapproved Unicode-policy product clarification in a localized-bug run with no predetermined answer.
- openai: Protocol-invalid run '15-openai-localized-bug-r2-codex': Operator supplied an unapproved Unicode-policy product clarification in a localized-bug run with no predetermined answer.
- openai: Protocol-invalid run '28-openai-localized-bug-r3-codex': Operator supplied an unapproved Unicode-policy product clarification in a localized-bug run with no predetermined answer.
- openai: Equivalent complete auxiliary accounting cannot be established across native formats; Pi tool-result auxiliary usage is included only when optional native usage fields are present.
- openai: Equivalent complete auxiliary accounting cannot be established across native formats; Codex subagent usage uses native interval counts when exposed and otherwise excludes each rollout's first cumulative snapshot as a possible inherited baseline, but rollout discovery and fallback first-turn usage cannot be proven complete.
