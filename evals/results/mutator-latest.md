# Mutator eval, 2026-10-28 19:03 UTC

5 runs per command on the demo street; model muse-spark-1.3 (minimal reasoning); bar 4/5.

| Command | Expect | Passed | Calls per run | Right on the first call | Typical failure |
|---|---|---|---|---|---|
| slingshot this | install | ✅ 4/5 | 1, 1, 1, 2, 3 | 3 | assertion 1: entity:truck vx at tick 30 was -2.16, expected > 5 (drag truck by (-2, 0) m and release) |
| make the gravity feel like on the moon | install | ✅ 5/5 | 1, 1, 1, 1, 1 | 5 |  |
| make everything super bouncy | install | ✅ 5/5 | 3, 1, 2, 1, 1 | 3 |  |
| spin the cones | install | ✅ 5/5 | 1, 1, 1, 1, 1 | 5 |  |
| make the truck ten times heavier | install | ✅ 5/5 | 1, 1, 1, 1, 1 | 5 |  |
| launch everything into the air | install | ✅ 5/5 | 1, 1, 1, 1, 1 | 5 |  |
| make gravity pull everything to the right | install | ✅ 4/5 | 1, 3, 1, 1, 1 | 4 | assertion 2: entity:cone_1 vx at tick 60 was -0.20, expected > 3 (60 ticks) |
| when the ball hits the ground, make it jump back up twice as high | install | ✅ 5/5 | 2, 1, 1, 1, 1 | 4 |  |
| make the bottle sound like a marimba | decline | ✅ 5/5 | 1, 1, 1, 1, 1 | 5 |  |
| paint the sky purple | decline | ✅ 5/5 | 1, 1, 1, 1, 1 | 5 |  |

Overall: 48/50 runs passed; 10/10 commands meet the bar. Model calls: 59. Spend: $0.0000 (re-runs replay from the dev cache for free). Wall time: 32 s.
