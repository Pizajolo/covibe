// node shoot.cjs stills 0.5 3.4 ...   -> work/stills/t-<time>.png
// node shoot.cjs video                -> streams 30fps PNG frames to ffmpeg (work/video.mp4, silent)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const FPS = 30, DURATION = 20.5;
const [mode, ...times] = process.argv.slice(2);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('console', (m) => console.log('page:', m.text()));
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto('http://127.0.0.1:8765/index.html');
  await page.evaluate(() => window.ready);
  if (mode === 'stills') {
    fs.mkdirSync(path.join(__dirname, 'stills'), { recursive: true });
    for (const t of times) {
      await page.evaluate((t) => window.render(t), Number(t));
      await page.screenshot({ path: path.join(__dirname, 'stills', `t-${t}.png`) });
    }
  } else {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', path.join(__dirname, 'video.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
    const n = Math.round(DURATION * FPS);
    for (let f = 0; f < n; f++) {
      await page.evaluate((t) => window.render(t), f / FPS);
      const buf = await page.screenshot({ type: 'png' });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (f % 60 === 0) console.log('frame', f, '/', n);
    }
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
  }
  await browser.close();
})();
