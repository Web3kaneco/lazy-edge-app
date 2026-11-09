// Prints guide.html to Lazy-Edge-Quick-Start.pdf, plus a PNG of each page to
// check the layout.  npx electron docs/quick-start/render.cjs
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const dir = __dirname
const out = path.join(dir, '..', 'Lazy-Edge-Quick-Start.pdf')
const previews = process.argv.includes('--previews')
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  // 8.5in by 11in at 96 dpi.
  const win = new BrowserWindow({ width: 816, height: 1056, show: false, useContentSize: true, webPreferences: { offscreen: previews }, backgroundColor: '#0a0a0a' })
  await win.loadFile(path.join(dir, 'guide.html'))
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => document.fonts.size)')
  fs.writeFileSync(out, await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } }))
  console.log('PDF', out)
  if (previews) {
    const pages = await win.webContents.executeJavaScript('document.querySelectorAll(".sheet").length')
    for (let i = 0; i < pages; i++) {
      await win.webContents.executeJavaScript(`window.scrollTo(0, ${i * 1056})`)
      for (let tries = 0; tries < 5; tries++) {
        await new Promise((r) => setTimeout(r, 800))
        try { fs.writeFileSync(path.join(dir, `page-${i + 1}.png`), (await win.webContents.capturePage()).toPNG()); break } catch { /* surface not ready yet */ }
      }
    }
    console.log('PREVIEWS', pages)
  }
  app.exit(0)
})
