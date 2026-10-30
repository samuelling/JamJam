# Working on MEGAjam at the same time

A proposal from Matt, for Sam, written with Claude. Nothing here is in force until we both agree. Change anything.

## The short version

1. Nobody pushes to `main`. Every change goes through a small branch and a pull request (PR).
2. You open a **draft PR when you start**, not when you finish. It lists what you expect to touch. That draft is your flag to the other person, and it clears itself when the PR merges or closes.
3. Claude estimates what a change will touch, checks it against the other person's open PRs, and warns you before you begin.
4. Don't chase `main`. Bring it into your branch once, just before merging. If GitHub shows no conflicts and the checks pass, merge.
5. Split up the three files we keep colliding in, because that removes most conflicts before any process is needed.

## What happened

- **`main` moves fast:** 67 commits landed in two days, 61 of them authored by Claude. Almost none of that was in pull requests: the repo has never had one.
- **Merging became a chase:** Matt merged `main` into a branch five times to land one feature. One merge was stopped because a new commit arrived in the minutes between checking and merging.
- **Conflicts came from the same few places:** 15 conflict regions across those merges, all in `README.md`, `src/compose.js`, `src/main.js` and `src/stems.js`. Nearly all were two people adding something next to each other. They weren't real disagreements.
- **Work got duplicated:** Matt built an instrument picker for lanes while Sam built track instruments on `main`. The picker had to be deleted. No merge tool catches this. Only knowing what the other person is doing does.
- **`main` is the live site:** GitHub Pages deploys from `main`, so every push goes straight to players.

### Why these files collide

| File | Commits touching it (last 60) | Why |
|---|---:|---|
| `src/main.js` | 46 | 2,833 lines covering networking, the desk, the song, the mix and the UI |
| `index.html` | 46 | Lines 11 to 884 are one inline stylesheet, so nearly every feature edits it |
| `README.md` | 36 | Each feature is one line, up to 2,477 characters, so any edit conflicts with any other edit to that paragraph |
| `src/compose.js` | 17 | Long lines, and one `replaceChildren` line that every new panel edits |

## The rules

### Branches

- Name them `sam/short-name` or `matt/short-name`.
- Start from the latest `main`.
- Keep them small. Aim to merge within hours, a day at most.
- A big feature lands as several small PRs. A half-finished feature can sit behind a URL flag or stay hidden in the UI.

### Pull requests

- Open a draft PR right after your first commit, using the template below.
- No review is required by default. Merge your own PR when it's ready, so nobody waits for anyone. Ask for a review when you want one, and always for changes to timing, networking or the audio path.
- Squash when merging, so `main` gets one clean commit per change.
- Reverting is the safety net. If a merge breaks something, revert first and investigate after.

### Staying current without the chase

Update your branch from `main` once, just before merging. Also update if GitHub shows a conflict, or if the other person merges something in your area. Otherwise leave it alone.

We keep GitHub's "require branches to be up to date" **off**. With it on, every merge forces the other person to update and re-test, which is the chase we're trying to end. The small risk is two changes that merge cleanly but break together. The tests on `main` catch that, and a revert fixes it.

### When both of us are working

| Overlap | What it means | What to do |
|---|---|---|
| None | Different files | Carry on |
| Nearby | Same file, different functions | Carry on. Whoever merges second updates and tests |
| Direct | Same function or the same feature | Talk first. Decide who goes first, or combine the work |

Whoever merges second resolves the conflicts. Whoever is smaller goes first, because it's quicker to land.

Changes that affect everything, such as splitting a big file, get announced first and landed while nothing else is open.

## Conflict flags

The flag is the draft PR, so we need no server, no new tool, and nothing to remember to clear.

Each PR description carries a block like this:

```markdown
## Intent
What this changes and why, in a sentence or two.

## Touches
- areas: mix, compose-ui
- files: src/console.js, src/main.js, src/compose.js
- functions: routeMaster, trackBus, songTick, render

## Handoff
Where this stands, what's left, and what the other person should know.
```

`Touches` starts as Claude's estimate and gets corrected from the real diff on each push. `Handoff` is a natural home for Sam's handoff skills: the note lives on the PR and disappears from view when the work lands.

### Three skills

**`/start-work <what you want to do>`** runs before any code changes:

1. Fetches `main` and lists open PRs.
2. Reads the code and estimates the areas, files and functions the change will touch.
3. Compares that with each open PR's `Touches` block and its real diff.
4. Also compares it with the last few commits on `main`, to catch something that already exists. This is the check that would have saved the instrument picker.
5. Reports the overlap as none, nearby or direct, and names the PR and the person.
6. Creates the branch and the draft PR.

It warns and never blocks. You can always carry on.

**`/check-overlap`** runs before a push and at the start of a session. It re-runs the comparison using real diffs, updates your `Touches` block, and says what changed since you last looked.

**`/land`** finishes the work. It updates from `main`, resolves conflicts, runs the tests, writes the handoff note, marks the PR ready and merges. If `main` moved meanwhile, it only goes around again when GitHub reports a real conflict.

### How overlap is measured

Files alone are too coarse, since `src/main.js` would flag nearly everything. So:

1. `git diff -U0 origin/main...<branch>` gives the changed lines for each open PR.
2. Each line is mapped to the function around it.
3. Two PRs that change the same function are a direct overlap. The same file is nearby.
4. Named areas catch what line numbers can't, such as two features that both change how tracks work from different files.

A small list of areas is kept in the repo, each naming its files and functions. For example: `net`, `clock`, `engine`, `mix`, `song-playback`, `compose-ui`, `roll`, `instruments`, `export`, `gear`.

A GitHub Action could later post the same check as a PR comment, so a warning appears even if a session didn't run the skill.

### Telling Claude

Add a `CLAUDE.md` so both of our sessions follow the same rules without being asked:

- Never push to `main`.
- Run `/start-work` before changing code.
- Run `/check-overlap` when a session resumes.
- Keep each PR's `Touches` and `Handoff` current.

## Fix the hot files

This gives the biggest gain, because conflicts that can't happen need no process. Each is one short PR. Do them in this order, while nothing else is open:

1. **`README.md`: one sentence per line.** No change to how it reads, and two edits to one paragraph stop colliding.
2. **`index.html`: move the CSS out.** Split it into `styles/*.css` by area (`compose.css`, `desk.css`, and so on). There's no build step, so plain `<link>` tags are enough.
3. **`src/main.js`: move out song playback and the mix first.** `songTick`, `liveSchedule`, `bouncePart`, `trackBus` and `routeMaster` become `src/songplay.js` and `src/mix.js`. Later, take the desk and the panels. It's already divided into 23 labelled sections, which gives natural seams.
4. **`src/compose.js`: split out the panels.** The piano roll, master panel and stems panel each get a file. Make the list in `render()` one item per line, so adding a panel changes one line.

These are moves only, with no behaviour changes, so they're easy to check and easy to revert.

## Tests and checks

The repo has no automated checks yet, so nothing stops a broken change reaching the live site.

Add a GitHub Action that runs on every PR. Public repos get this free.

- **Fast tier, on every PR:** a syntax check, `presets.test.mjs`, and the browser suites that guard the core: `sync`, `console`, `tracks`, `stepentry`.
- **Full tier, on `main` after each merge:** everything.

Three fixes are needed first:

- **Direct links in tests:** some tests launch Chromium without `--disable-features=WebRtcHideLocalIpsWithMdns`, so they fall back to the relay. That's slower and misled us about a `tracks` failure. Both paths should be tested on purpose.
- **Fixture file:** `compose` and `loop` need `/tmp/songs/blue-dorian.json`, which isn't in the repo, so they can't run.
- **Timing:** `midi`'s tick-spacing check fails now and then on a busy machine. Loosen it or retry it, because a check that cries wolf gets ignored.

## GitHub settings

Sam owns the repo, so these are Sam's to set.

| Setting | Value | Why |
|---|---|---|
| Protect `main`: require a PR | On | This is what actually stops direct pushes, by people and by Claude |
| Required approvals | 0 | Nobody waits for anyone |
| Require status checks | On, fast tier, once the Action exists | Blocks a broken merge |
| Require branches to be up to date | **Off** | Keeps the chase from returning |
| Automatically delete head branches | On | Branches tidy themselves |
| Allow auto-merge | On | A PR merges itself when its checks pass |
| Squash merging | On | One commit per change |

## Getting started

**Today**

1. Sam turns on the settings above, apart from status checks.
2. We add `CLAUDE.md` and the PR template.
3. We start using draft PRs, writing `Touches` by hand if the skills aren't ready.

**This week**

4. Build `/start-work`, `/check-overlap` and `/land`.
5. Land the four hot-file splits, one person at a time.
6. Add the GitHub Action and the three test fixes.

**After two weeks**

7. Look at what still collided, and adjust.

## What a normal session looks like

1. Ask Claude for a change. It runs `/start-work` and says "Sam's `sam/tape-age` is nearby, same file, different function" or "clear".
2. Claude opens the branch and draft PR, and the other person can now see it.
3. Work and push. `Touches` stays current.
4. Say you're done. `/land` updates once, tests and merges.
5. The flag disappears, and the site deploys.

## Open questions for Sam

- Are you happy with no required reviews, or do you want a second pair of eyes on anything else?
- Which of your handoff skills overlap with these three, and which should win?
- Who does the hot-file splits, and when is a good quiet moment?
- Should the Stem Console's license question go in a PR of its own? `vendor/stems/stems.wasm` is GPLv3, and the README says the Lites are new code with none of SynthLand's.
