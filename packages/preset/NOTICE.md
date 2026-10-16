# Notices

`@nredd/pi-preset` bundles components under different licenses. The root `LICENSE` (MIT) covers
only the components marked MIT below. It does **not** relicense the theme files.

SPDX expression for the package as a whole: `MIT AND Apache-2.0 AND CC-BY-SA-4.0`.

## Component map

| Path | SPDX | Notes |
|---|---|---|
| `agents/`, `skills/`, `extensions/`, `lib/`, `settings/`, `README.md`, `NOTICE.md` | `MIT` | Original work, `LICENSE` |
| `themes/tokyonight-storm.json` | `Apache-2.0` | Adaptation of the tokyonight.nvim `storm` palette. Full text: `licenses/Apache-2.0-tokyonight.nvim.txt`. Also carries the MIT notice for the Enkia origin of that palette: `licenses/MIT-enkia-tokyo-night-vscode-theme.txt` |
| `themes/belafonte-day.json` | `CC-BY-SA-4.0` | Adaptation of Belafonte (Day) by Jan T. Sott. Full text: `licenses/CC-BY-SA-4.0.txt`. ShareAlike: the adapted theme stays `CC-BY-SA-4.0` |

Pi's theme schema rejects unknown top-level fields, so license and change metadata cannot live in
the theme JSON. This file and `licenses/` are the notice. Redistribute them with the themes.

## themes/tokyonight-storm.json

- Source: [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) at
  `cdc07ac78467a233fd62c493de29a17e0cf2b2b6`, `lua/tokyonight/colors/storm.lua`
- License of the source: Apache-2.0, `LICENSE` at that commit (verified, byte-identical copy in
  `licenses/Apache-2.0-tokyonight.nvim.txt`). The upstream copy leaves the appendix copyright
  placeholder unfilled and ships no `NOTICE` file, so no further notice text is carried
- Palette origin: that README states the colors derive from Enkia's
  [Tokyo Night](https://github.com/enkia/tokyo-night-vscode-theme) VS Code theme. Its `LICENSE.txt`
  at `7c0f11eaef322f293621ca7befe462214b7ea468` is MIT, "Copyright (c) 2018-present Enkia"
  (verified, byte-identical copy in `licenses/MIT-enkia-tokyo-night-vscode-theme.txt`)
- MODIFIED, per Apache-2.0 section 4(b). Changes from the source:
  - converted a Lua color table into a Pi theme (`vars` plus `colors` role mapping, `export`),
    with palette keys renamed (`bg_dark` -> `bgDark`, `fg_gutter` -> `fgGutter`, ...) and unused
    palette entries dropped
  - added locally derived backgrounds for the user message and tool states, and the export info
    panel (the Local row below)
  - set `$schema` to Pi's published theme schema

Colors in the theme file, by origin (the `Upstream` row is checked against `storm.lua` by hand;
tests check that this list and the file agree):

- Upstream: `#24283b`, `#1f2335`, `#1b1e2d`, `#292e42`, `#c0caf5`, `#a9b1d6`, `#565f89`, `#545c7e`, `#3b4261`, `#7aa2f7`, `#7dcfff`, `#9ece6a`, `#bb9af7`, `#ff007c`, `#9d7cd8`, `#ff9e64`, `#f7768e`, `#e0af68`
- Local: `#2e3452`, `#302c22`, `#1d3330`, `#3d2432`, `#332d1f`

The `Local` colors are hand-blended tints, not values from the source palette.

## themes/belafonte-day.json

- Source: [idleberg/Zissou-iTerm2](https://github.com/idleberg/Zissou-iTerm2) at
  `1a9279f6275656f165243e5a7289c45c296a4e15`, `Belafonte (Day).itermcolors`
  (sha256 `20a167745eb7fe3317030aefb84c2a5896b5f0532a8a5de38f62a66d52ed89cf`)
- Author and license: the source `README.md` says "This work by Jan T. Sott is licensed under a
  [Creative Commons Attribution-ShareAlike 4.0 Unported License](http://creativecommons.org/licenses/by-sa/4.0/deed.en_US)".
  The repository has no separate license file; that statement is the only license grant found
- The MIT license of the iTerm2-Color-Schemes collection does not replace the individual theme's
  license, and is not what applies here
- Attribution: Belafonte (Day), Jan T. Sott. Adapted without endorsement by the author
- MODIFIED, per CC-BY-SA-4.0 section 3(a)(1)(B). Changes from the source:
  - converted an iTerm2 palette into a Pi theme (`vars` plus `colors` role mapping, `export`)
  - darkened `green` (source ANSI 2 `#858162`, 2.48:1 on the background) to `#52502f` (5.17:1) and
    replaced `yellow` with `#6e4816` (5.06:1) so text clears 5:1 (WCAG relative luminance, computed
    here). The source ANSI 3 is `#eaa549` (1.32:1); the theme's earlier `yellow`, `#d08b30`, is not
    a value in the source file and its origin is unverified, but it no longer ships
  - added locally derived panel, tool-state, and export backgrounds (the Local row below)
  - set `$schema` to Pi's published theme schema

Colors in the theme file, by origin. Each `Upstream` value was compared against the source file's
RGB floats: all 8-bit hex values round-trip exactly (maximum deviation 0 of 255):

- Upstream: `#d5ccba` (background), `#45373c` (foreground), `#5e5252` (ANSI 8), `#20111b` (ANSI 0), `#426a79` (ANSI 4), `#be100e` (ANSI 1), `#97522c` (ANSI 5), `#968c83` (ANSI 7)
- Local: `#52502f`, `#6e4816`, `#c7bcaa`, `#e0d5c0`, `#b9ad99`, `#dccfa3`, `#c6cfae`, `#e4b6b0`, `#e8dcc4`, `#f0e9da`

The `Local` colors are not source values: two are the contrast-adjusted `green` and `yellow`
above, the rest are hand-blended tints. The upstream file the theme was first hand-mapped from
was a Ghostty-bundled copy; it was not inspected, so the comparison is against the origin
repository directly.

## External resources, not bundled

The agents depend on resources this package does not vendor and does not relicense. They are
declared in `package.json` under `piPreset.externalResources`:

- Skills `codebase-design`, `diagnosing-bugs`: [mattpocock/skills](https://github.com/mattpocock/skills)
  at `5b15a47f2d7150f545fbcacbfe381787fc0230dc`, MIT, "Copyright (c) 2026 Matt Pocock"
- Extension `pi-dev-tools` (`@nredd/pi-dev-tools`, this repository) and `pi-web-access` (npm)
