# TODOS

## Infrastructure

### Offline fallback mode

**What:** `?offline=1` plus an automatic switch after a failed WebSocket handshake, a voice-disabled UI, and preset shortcuts on keys 1-6 (0 = reset).

**Why:** Lets SceneFork demo with no network (venue Wi-Fi, live stage rounds).

**Context:** Deferred by the eng review (D17, 2026-10-27), because judging is from a recorded video. Golden clips already play from static files through StaticGoldenSource (OV1), so most of the work is the switch logic and the UI state. The full spec is in the design doc's "Offline mode" bullet (`~/.gstack/projects/metaAIHack/surya-unknown-design-20261027-023736.md`). **Pros:** stage-proof demos. **Cons:** about 3h of work, plus another UI mode to test.

**Effort:** S
**Priority:** P3
**Depends on:** StaticGoldenSource (Phase 1-2)

### Per-connection rate limits on paid model calls

**What:** A token bucket on each WebSocket connection: 40 `free`/min, 4 `free_all`/min and 12 `voice`/min, configurable. Over the limit, reply `rate_limited`, and the UI shows "slow down, one sec".

**Why:** Caps worst-case Muse and Modal spend once anyone other than the builder can reach the backend.

**Context:** Approved as D7, then deferred (D18, 2026-10-27) because there is a single user and the D5 demo key already gates access. Build it before making SceneFork public. **Pros:** a known worst-case spend. **Cons:** limits need tuning so they never throttle a demo.

**Effort:** S
**Priority:** P2
**Depends on:** D5 demo key; the WebSocket handlers (Phase 2)

### SessionStore LRU memory cap

**What:** An LRU of live forks, capped at 40 forks or 600 MB, whichever comes first. An evicted fork answers `unknown_fork`, and the client re-sends its frame plus the current plate and masks.

**Why:** Keeps the single Modal container (`max_containers=1`) from running out of memory under multi-user traffic.

**Context:** Approved as D12, then deferred (D19, 2026-10-27) for the single-user hackathon. The 30-minute TTL stays. The re-send path (including plate and masks, from outside voice #11) is already in the design. **Pros:** bounded memory. **Cons:** a long-idle fork may need one re-upload.

**Effort:** S
**Priority:** P2
**Depends on:** SessionStore (Phase 2)

## Completed
