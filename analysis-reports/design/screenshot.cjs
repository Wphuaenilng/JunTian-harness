const path = require('path');
const { chromium } = require('playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const HTML = 'F:\\workspace\\AI-Project\\AI-Harness\\Tianshu-harness\\analysis-reports\\design\\desktop-mockup.html';
const OUT = 'F:\\workspace\\AI-Project\\AI-Harness\\Tianshu-harness\\analysis-reports\\design\\tianshu-desktop-mockup.png';

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: OUT, fullPage: false });
  await browser.close();
  console.log('saved:', OUT);
})().catch(e => { console.error(e); process.exit(1); });
