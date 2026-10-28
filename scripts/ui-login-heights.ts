// Capturas del acceso en alturas cortas (800/700/620/560) contra la demo (puerto 5174).
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2]!;
mkdirSync(out, { recursive: true });
const root = join(process.env.LOCALAPPDATA!, 'ms-playwright');
const exe = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(root, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
for (const [width, height] of [[1440, 800], [1366, 700], [1280, 620], [1024, 560], [390, 620]]) {
  const page = await browser.newPage({ viewport: { width: width!, height: height! } });
  await page.goto('http://localhost:5174/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  console.log(`${width}x${height}: desborde vertical ${overflow}px`);
  await page.screenshot({ path: join(out, `login-${width}x${height}.png`) });
  await page.close();
}
await browser.close();
