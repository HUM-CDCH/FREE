const {createRequire}=require('node:module');
const {writeFileSync}=require('node:fs');
const {chromium,expect}=createRequire('/home/gebbaro/Progetti/FREE/prototypes/studio/package.json')('@playwright/test');
const output='/home/gebbaro/Progetti/FREE/docs/validation/2026-10-01-review-counter-evidence';
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:48792');
  const progress=page.getByRole('region',{name:'Review progress'});
  await expect(progress).toHaveText('2 of 2 required decisions remaining');
  await expect(page.getByText('24 ungrounded values are excluded from required review and remain recorded without Evidence.',{exact:true})).toBeVisible();
  const approval=page.getByRole('button',{name:'Approve remaining (2)',exact:true});
  await expect(approval).toHaveAccessibleDescription(/ungrounded values, are unchanged.*saves automatically/);
  await expect(page.getByText('Draft saved',{exact:true})).toHaveCount(0);
  await page.screenshot({path:output+'/01-required-review-desktop.png',fullPage:true});
  const viewports=[];
  for(const viewport of [{width:390,height:844},{width:360,height:800},{width:640,height:400}]) {
   await page.setViewportSize(viewport);
   for(const locator of [progress,approval]) {
    await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height);
   }
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   viewports.push(viewport);
   if(viewport.width===390) await page.screenshot({path:output+'/02-required-review-mobile.png',fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Reject place',exact:true}).click();
  await expect(progress).toContainText('1 of 2 required decisions remaining');
  await expect(page.getByText('Draft saved',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Approve remaining (1)',exact:true})).toBeEnabled();
  await page.screenshot({path:output+'/03-partial-review-mobile.png',fullPage:true});
  await page.reload();
  await expect(progress).toContainText('1 of 2 required decisions remaining');
  await expect(page.getByText('Draft saved',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Raw JSON',exact:true}).click();
  await expect(progress).toContainText('1 of 2 required decisions remaining');
  await expect(page.locator('pre').filter({hasText:'Value 0'})).toBeVisible();
  await page.getByRole('tab',{name:'Review',exact:true}).click();
  await page.getByRole('button',{name:'Edit year',exact:true}).click();
  const input=page.getByLabel('Reviewed value for year',{exact:true});
  await input.fill('2001');await input.press('Enter');
  await expect(progress).toHaveText('Review saved · 2 decisions');
  await expect(page.getByText('Draft saved',{exact:true})).toHaveCount(0);
  await page.screenshot({path:output+'/04-finalized-review-mobile.png',fullPage:true});
  expect(errors).toEqual([]);
  const result={status:'pass',scope:'Chromium ResultsTab + useExtraction against controlled in-memory responses; no auth or PostgreSQL',viewports,
   checks:['24 ungrounded values excluded from required count','accessible bulk action scope','viewport bounds and no page overflow','reject decrements remaining','draft acknowledgement','reload preserves partial review','result-view navigation preserves count','edit completes required review and auto-finalizes','no uncaught page errors']};
  writeFileSync(output+'/browser-check.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
