// 用法: node screenshot-dsh.cjs <html路径> <png输出路径>   （两种路径都接受：相对当前目录或绝对路径）
const { chromium } = require('playwright-core');
const { resolve } = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 必须先 resolve：'file:///' + 相对路径 会得到 file:///名字.html，浏览器把它当根路径 →
// net::ERR_FILE_NOT_FOUND（本轮实测：按本脚本自己的用法注释传相对路径就是这么挂的）。
const HTML = process.argv[2] ? resolve(process.argv[2]) : undefined;
const OUT = process.argv[3] ? resolve(process.argv[3]) : undefined;
if (!HTML || !OUT) { console.error('usage: node screenshot-dsh.cjs <html> <png>'); process.exit(1); }

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
