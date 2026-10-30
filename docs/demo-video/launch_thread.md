# SceneFork launch thread (X)

Post the video with one of the hooks, then reply with the three thread posts. Replace nothing in the numbers: they come from `evals/results/` and the README.

## Video hooks (pick one)

1. I paused a video, pulled the mug off the table, and changed gravity by talking to it.
2. An AI wrote a physics rule for a video. A hidden copy of the world tested it before it was allowed to run. Then it refused the one I asked for that made no sense.
3. Every video you have watched is frozen. This one is not.

## Thread

**1/** SceneFork turns any paused video into a physics sandbox. Click an object and it leaves the frame with real weight and a real sound. The table behind it heals. Throw it. Then change the laws of physics by voice: zero gravity, Jupiter, "make this bouncy".

**2/** How it works, one Meta model per job:
- SAM 3.1 outlines the object from one click
- Muse Image paints the background back in
- Muse Spark estimates mass, material and bounce, and writes new rules as sandboxed code with its own tests
- Muse Voice turns speech into commands, about half a second from key-up to text

**3/** The part I care about most: a spoken rule never goes straight into the scene. A shadow copy of the world runs the rule's tests first, including a check that they fail without the rule. Infinite loops die in 300 ms, a frozen sim restarts from a snapshot. In my eval, 48 of 50 generated rules passed against the real physics. Built solo in four days for the Meta Global AI Developer Hackathon. Open source: github.com/suryafk/scenefork
