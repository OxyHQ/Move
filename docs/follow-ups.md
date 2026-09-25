# Follow-ups outside Move

Work Move needs from other repos. Each item names the owner; Move does not
build app-side stand-ins for them.

## Bloom: brand icons for source platforms

Bloom's icon set (`@oxy.so/bloom/icons`, Remix) has `RiBlueskyFill` and
`RiTwitterXFill` but no Mastodon, Threads, Instagram, Medium or Substack glyph.
Move's platform cards therefore use Bloom's initials `Avatar` for every
platform (uneven marks would read worse than none). The icons belong in Bloom,
published, and then consumed by `components/PlatformCard.tsx` — never as
app-local SVGs.
