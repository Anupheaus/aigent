# Held-out run (once, after Round 3)

The held-out set (25 tasks in a fifth wording never used while tuning, on seeds 1000 (small) and 1001 (medium)) was
run once, after the rounds were closed:

```
npm run bench -- --held-out --policies reference --tools round0 --label held-out-reference
npm run bench -- --held-out --policies optimised --tools optimised --label held-out
```

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns |
|---|---|---|---|---|---|---|---|---|---|
| reference (Round-0 tools) | 50 | 100% | 100% | 100% | 0% | 3,871 | 14,890 | 2 | 3 |
| optimised (Round 3) | 50 | 100% | 100% | 100% | 20% | 3,426 | 3,767 | 2 | 2 |

The prompt reader understood every held-out wording, and the optimised policy's gains carry over at the same size
(median -11.5%, p90 -74.7%), including dead exports on a medium repository (≈930 exported functions), which no tuned
spec covered at that size.

Scripted tier only; real-model behaviour on the held-out set is unmeasured.
