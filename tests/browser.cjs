// Run against a fresh test server: BASE_PATH=/artifacts PORT=18080 ADMIN_PASSWORD=initial-password.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
async function assertViewerLayout(page, html = false) {
 for (const viewport of [{width:1440,height:1000},{width:375,height:812}]) {
  await page.setViewportSize(viewport);
  await page.waitForFunction(()=>document.body.classList.contains('artifact-view'));
  assert.equal(await page.locator('body > header .share-head').count(),1);
  assert.equal(await page.locator('#app .share-head').count(),0);
  const bounds=await page.evaluate(()=>{
   const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,width:r.width,height:r.height}};
   return {header:rect('body > header'),main:rect('#app'),content:rect('#content'),width:innerWidth,height:innerHeight,bodyWidth:document.body.scrollWidth};
  });
  assert.ok(Math.abs(bounds.header.top)<1);
  assert.ok(Math.abs(bounds.main.top-bounds.header.bottom)<1);
  assert.ok(Math.abs(bounds.main.bottom-bounds.height)<1);
  assert.ok(Math.abs(bounds.main.width-bounds.width)<1);
  assert.ok(Math.abs(bounds.content.width-bounds.width)<1);
  assert.ok(Math.abs(bounds.content.height-bounds.main.height)<1);
  assert.ok(bounds.main.height>bounds.height/2,'metadata leaves room for content');
  assert.ok(bounds.bodyWidth<=bounds.width+1,'no page-level horizontal overflow');
  if(html) {
   const iframe=await page.locator('#content > iframe').boundingBox();
   assert.ok(Math.abs(iframe.width-bounds.content.width)<1);
   assert.ok(Math.abs(iframe.height-bounds.content.height)<1);
  } else {
   await page.locator('#content').evaluate(node=>{
    const spacer=document.createElement('div');spacer.dataset.layoutTest='true';spacer.style.height='2000px';node.append(spacer);node.scrollTop=250;
   });
   assert.ok(await page.locator('#content').evaluate(node=>node.scrollTop)>0);
   assert.ok(Math.abs((await page.locator('body > header').boundingBox()).y)<1,'header remains at the top during content scroll');
   await page.locator('#content').evaluate(node=>{node.querySelector('[data-layout-test]').remove();node.scrollTop=0});
  }
 }
 await page.setViewportSize({width:1440,height:1000});
}

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||chromium.executablePath(),headless:true,args:['--no-sandbox']});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const username='browser-user-'+Date.now();
 const base=process.env.TEST_URL||'http://127.0.0.1:18080/artifacts';
 await page.goto(base+'/');await page.locator('#login input[name=name]').fill('admin');await page.locator('#login input[name=password]').fill('initial-password');await page.locator('#login button').click();await page.locator('#new').waitFor();
 await page.locator('[data-tab=admin]').click();await page.locator('#userform input[name=name]').fill(username);await page.locator('#userform input[name=password]').fill('initial-password');await page.locator('#userform button').click();await page.getByRole('cell',{name:username,exact:true}).waitFor();
 await page.locator('[data-tab=keys]').click();await page.locator('#keyform input').fill('Browser test');await page.locator('#keyform button').click();await page.locator('dialog').waitFor();const key=await page.locator('dialog input').inputValue();assert.ok(key.startsWith('ash_'));await page.locator('dialog button').click();
 await page.locator('#new').click();await page.locator('#editor input[name=title]').fill('Mermaid rendering test');await page.locator('#editor button.primary').click();await page.locator('dialog').waitFor();const share=await page.locator('dialog input').inputValue();await page.locator('dialog button').click();await page.locator('[data-tab=artifacts]').click();await page.locator('.artifacts-table').waitFor();await page.screenshot({path:path.join(__dirname,'../docs/dashboard.png'),fullPage:true});
 const anonymous=await browser.newContext();const viewer=await anonymous.newPage();viewer.on('pageerror',e=>errors.push(e.message));await viewer.goto(share);await viewer.locator('.mermaid svg').waitFor();assert.equal(await viewer.locator('.mermaid svg').count(),1);assert.equal(await viewer.title(),'Mermaid rendering test · Artifact Share');assert.equal(await viewer.locator('.share-owner').textContent(),'オーナー: admin');await assertViewerLayout(viewer);await viewer.screenshot({path:path.join(__dirname,'../docs/markdown.png'),fullPage:true});
 const api=await ctx.request.post(base+'/api/artifacts',{headers:{Authorization:'Bearer '+key},data:{title:'Interactive HTML',kind:'html',content:'<h1 id="output">Before</h1><script>document.querySelector("#output").textContent="Script works"</script>',visibility:'link',users:[]}});assert.equal(api.status(),201);const html=await api.json();await viewer.goto(new URL(base).origin+html.url);await viewer.frameLocator('iframe').locator('#output').waitFor();assert.equal(await viewer.frameLocator('iframe').locator('#output').textContent(),'Script works');await assertViewerLayout(viewer,true);
 const users=await (await ctx.request.get(base+'/api/users',{headers:{Authorization:'Bearer '+key}})).json();const recipient=users.find(x=>x.name===username);const restricted=await (await ctx.request.post(base+'/api/artifacts',{headers:{Authorization:'Bearer '+key},data:{title:'Private HTML',kind:'html',content:'<h1>Private content</h1>',visibility:'users',users:[recipient.id]}})).json();await viewer.goto(new URL(base).origin+restricted.url);await viewer.getByRole('heading',{name:'コンテンツを表示できません'}).waitFor();await viewer.goto(base+'/');await viewer.locator('#login input[name=name]').fill(username);await viewer.locator('#login input[name=password]').fill('initial-password');await viewer.locator('#login button').click();await viewer.locator('#new').waitFor();await viewer.goto(new URL(base).origin+restricted.url);await viewer.frameLocator('iframe').getByRole('heading',{name:'Private content'}).waitFor();

 const publish=async data=>{const response=await ctx.request.post(base+'/api/artifacts',{headers:{Authorization:'Bearer '+key},data:{kind:'md',visibility:'link',users:[],...data}});assert.equal(response.status(),201);return response.json()};
 const links=await publish({title:'Document <links> & guide',content:[
 '[Relative](./hoge/piyo.md)', '[Parent](../intro.md)', '[Root](/docs/report.md)', '[Protocol relative](//example.com/docs)', '[Fragment](#local)', '[Query](?view=1)', '[Email](mailto:alice@example.com)', '[FTP](ftp://example.com/file)', '[Invalid](https://)',
 '[**Strong relative**](./bold.md)', '<a href="./raw.md"><em>Raw relative</em></a>',
 '[HTTPS](https://example.com/docs?q=1#part)', '[HTTP](http://example.com/path)',
 'https://example.org/auto', '<https://example.net/angle>', 'www.example.com', 'alice@example.com',
 '[Reference][ref]', '[ref]: https://example.edu/reference'
 ].join('\n\n')});
 const publicContext=await browser.newContext();const linkPage=await publicContext.newPage();let resolveRequests=0;
 linkPage.on('request',r=>{if(r.url().includes('/api/resolve'))resolveRequests++});linkPage.on('pageerror',e=>errors.push(e.message));await linkPage.goto(new URL(base).origin+links.url);
 await linkPage.locator('#content').waitFor();assert.equal(await linkPage.title(),'Document <links> & guide · Artifact Share');assert.equal(await linkPage.locator('.share-owner').textContent(),'オーナー: admin');
 const hrefs=await linkPage.locator('#content a').evaluateAll(anchors=>anchors.map(a=>a.getAttribute('href')));
 assert.deepEqual(hrefs,['https://example.com/docs?q=1#part','http://example.com/path','https://example.org/auto','https://example.net/angle','https://example.edu/reference']);
 for(const label of ['Relative','Parent','Root','Protocol relative','Fragment','Query','Email','FTP','Invalid','Strong relative','Raw relative']) {
  assert.equal(await linkPage.locator('#content').getByRole('link',{name:label,exact:true}).count(),0);
  assert.ok((await linkPage.locator('#content').textContent()).includes(label));
 }
 assert.equal(await linkPage.locator('#content strong').textContent(),'Strong relative');assert.equal(await linkPage.locator('#content em').textContent(),'Raw relative');assert.equal(resolveRequests,0);
 await page.goto(base+'/');await page.locator('.artifacts-table').waitFor();const ownRows=await page.locator('.artifacts-table tbody tr').count();assert.ok(ownRows>=4);assert.equal(await page.locator('.artifacts-table thead th').count(),6);
 await page.locator('.artifacts-table [data-edit="'+links.id+'"]').click();await page.locator('#editor input[name=title]').waitFor();assert.equal(await page.locator('#editor input[name=source_path]').count(),0);await page.locator('#editor input[name=title]').fill('Updated link guide');await page.locator('#editor button.primary').click();await page.locator('dialog').waitFor();await page.locator('dialog button').click();
 await page.locator('[data-tab=admin]').click();await page.locator('#all .artifacts-table').waitFor();assert.ok(await page.locator('#all .artifacts-table tbody tr').count()>=ownRows);
 await page.locator('[data-tab=artifacts]').click();await page.locator('.artifacts-table').waitFor();await page.screenshot({path:path.join(__dirname,'../docs/dashboard.png'),fullPage:true});
 const longDocument=await publish({title:'長いドキュメント名 '.repeat(30),content:'# Long document\\n\\n'+'A paragraph of text.\\n\\n'.repeat(100)});
 await linkPage.goto(new URL(base).origin+longDocument.url);await assertViewerLayout(linkPage);
 await publicContext.close();
 assert.deepEqual(errors,[]);console.log('PASS: browser login, admin creation, API key, publish, Mermaid SVG, HTML JavaScript, recipient-only HTML, table lists, title, owner, absolute-only Markdown links, full viewport layout and persistent metadata header');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
