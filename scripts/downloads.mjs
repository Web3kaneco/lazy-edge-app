// Download counts for every public release, read from GitHub's own counters.
// No token needed: the repository and its releases are public.
// Run with: npm run downloads

const REPO = 'Web3kaneco/lazy-edge-app'

const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
  headers: { accept: 'application/vnd.github+json', 'user-agent': 'lazy-edge-downloads' }
})
if (!res.ok) {
  console.error(`GitHub answered ${res.status}: ${await res.text()}`)
  process.exit(1)
}
const releases = await res.json()
if (releases.length === 0) {
  console.log('No releases yet.')
  process.exit(0)
}

const kind = (name) =>
  name === 'latest.yml' ? 'checks'
    : /^Lazy-Edge-Setup-.*\.exe$/.test(name) ? 'installer'
    : /^Lazy-Edge-.*\.exe$/.test(name) ? 'portable'
    : null

const rows = releases.map((r) => {
  const row = { release: r.tag_name, date: (r.published_at ?? '').slice(0, 10), installer: 0, portable: 0, checks: 0 }
  for (const a of r.assets) {
    const k = kind(a.name)
    if (k) row[k] += a.download_count
  }
  row.downloads = row.installer + row.portable
  return row
})

console.table(rows.map(({ release, date, installer, portable, downloads, checks }) =>
  ({ release, date, installer, portable, 'exe downloads': downloads, 'update checks': checks })))

const total = rows.reduce((n, r) => n + r.downloads, 0)
console.log(`Total exe downloads across all releases: ${total}`)
console.log('Exe downloads count every download, repeats and bots included. Update checks count app startups reading latest.yml, not new users.')
