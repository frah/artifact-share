import {marked} from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
const base=document.querySelector('meta[name=base]').content,app=document.querySelector('#app');let me=null,csrf='',tab='artifacts',signup=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(s){const t=document.querySelector('#toast');t.textContent=s;t.style.display='block';clearTimeout(t.timer);t.timer=setTimeout(()=>t.style.display='none',5000)}
async function api(path,method='GET',body){const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||'リクエストに失敗しました');return v}
function run(fn){return async e=>{if(e)e.preventDefault();try{await fn(e)}catch(e){toast(e.message)}}}
function account(){document.querySelector('#account').innerHTML=me?`<span>${esc(me.name)} ${me.admin?'<span class="badge">ADMIN</span>':''}</span><button id="logout">ログアウト</button>`:`<a href="${base}/">ログイン</a>`;document.querySelector('#logout')?.addEventListener('click',run(async()=>{await api('/logout','POST');location.href=base+'/'}))}
function auth(register=false){app.innerHTML=`<div class="auth"><div class="eyebrow">YOUR TEAM’S ARTIFACTS, IN ONE PLACE</div><h1>${register?'アカウントを作成':'おかえりなさい'}</h1><p>コードから生まれたアイデアを、チームへ。</p><form class="card" id="login"><label>ユーザー名</label><input name="name" required autocomplete="username"><label>パスワード</label><input name="password" type="password" required minlength="8" maxlength="72" autocomplete="${register?'new-password':'current-password'}"><button class="primary">${register?'アカウントを作成':'ログイン'} →</button></form>${signup?`<p><button id="switch">${register?'ログインへ':'アカウントを作成する'}</button></p>`:''}<footer>Artifact Share · 社内共有ワークスペース</footer></div>`;document.querySelector('#login').onsubmit=run(async e=>{const body=Object.fromEntries(new FormData(e.target));if(register){await api('/signup','POST',body);toast('作成しました。ログインしてください');auth();return}const v=await api('/login','POST',body);csrf=v.csrf;await start()});document.querySelector('#switch')?.addEventListener('click',()=>auth(!register))}
function layout(){app.innerHTML=`<div class="intro"><div><div class="eyebrow">WORKSPACE / OVERVIEW</div><h1>アイデアを、共有しよう。</h1><p>HTML と Markdown をひとつの場所に。あなたのチームに。</p></div><button class="primary" id="new">＋ 新しく公開</button></div><nav class="tabs"><button data-tab="artifacts">自分のコンテンツ</button><button data-tab="keys">API キー</button>${me.admin?'<button data-tab="admin">管理者</button>':''}</nav><section id="panel"></section>`;document.querySelector('#new').onclick=()=>editor();document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.onclick=run(async()=>{tab=b.dataset.tab;await dashboard()})})}
async function dashboard(){layout();if(tab==='keys')return keys();if(tab==='admin')return admin();await artifactsTable('/artifacts')}
async function artifactsTable(path, root = document.querySelector('#panel')) {
  const list = await api(path);
  root.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:18px">
      <h2>${path.includes('admin') ? '全体のコンテンツ' : '公開したコンテンツ'}</h2>
      <span class="muted">${list.length} artifacts</span>
    </div>
    ${list.length ? `<div class="table-wrap"><table class="artifacts-table">
      <thead><tr><th scope="col">タイトル</th><th scope="col">形式</th><th scope="col">公開範囲</th><th scope="col">オーナー</th><th scope="col">更新日時</th><th scope="col">操作</th></tr></thead>
      <tbody>${list.map(v => `<tr data-artifact="${esc(v.id)}">
        <th scope="row" class="artifact-title"><a href="${esc(base + '/s/' + v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a></th>
        <td><span class="badge">${esc(v.kind.toUpperCase())}</span></td>
        <td>${v.visibility === 'link' ? 'リンク共有' : '指定ユーザー共有'}</td>
        <td>${esc(v.owner_name)}</td>
        <td><time datetime="${esc(v.updated)}">${esc(new Date(v.updated).toLocaleString('ja-JP'))}</time></td>
        <td><div class="artifact-actions">
          <button data-edit="${esc(v.id)}">編集</button>
          <button data-copy="${esc(v.id)}">リンク</button>
          <button class="danger" data-delete="${esc(v.id)}">削除</button>
        </div></td>
      </tr>`).join('')}</tbody>
    </table></div>` : `<div class="card empty"><div class="symbol">◈</div><h2>最初のアイデアを公開しましょう</h2><p>HTML レポート、Markdown ドキュメント、Mermaid の図。<br>画面または API からすぐに共有できます。</p><button class="primary" id="first">＋ コンテンツを作成</button></div>`}`;
  root.querySelector('#first')?.addEventListener('click', () => editor());
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = run(async () => editor(await api('/artifacts/' + b.dataset.edit))));
  root.querySelectorAll('[data-copy]').forEach(b => b.onclick = run(async () => {
    await navigator.clipboard.writeText(location.origin + base + '/s/' + b.dataset.copy);
    toast('リンクをコピーしました');
  }));
  root.querySelectorAll('[data-delete]').forEach(b => b.onclick = run(async () => {
    if (!confirm('このコンテンツを削除しますか？')) return;
    await api('/artifacts/' + b.dataset.delete, 'DELETE');
    await dashboard();
  }));
}
async function editor(v={title:'',kind:'md',content:'# Hello, team!\n\nここに共有したい内容を記入してください。\n\n```mermaid\ngraph LR\n  Idea --> Code --> Share\n```',visibility:'link',users:[]}){const users=await api('/users');app.innerHTML=`<div class="intro"><div><div class="eyebrow">WORKSPACE / PUBLISH</div><h1>${v.id?'コンテンツを編集':'新しく公開'}</h1><p>ファイルを読み込むか、内容を直接入力してください。</p></div><button id="back">← 一覧へ</button></div><form id="editor" class="editor"><div class="card"><label>タイトル</label><input name="title" required value="${esc(v.title)}"><label>元ファイルのパス（任意）</label><input name="source_path" placeholder="docs/report.md" value="${esc(v.source_path)}"><p class="muted">Markdown の相対リンクを解決するための、ドキュメントルートからのパスです。</p><label>形式</label><select name="kind"><option value="md">Markdown · Mermaid 対応</option><option value="html">HTML</option></select><label>ファイルを読み込む</label><input type="file" id="file" accept=".html,.htm,.md,.markdown"><label>コンテンツ</label><textarea name="content">${esc(v.content)}</textarea></div><div class="card"><h2>共有設定</h2><label>公開範囲</label><select name="visibility"><option value="link">リンクを知っている人</option><option value="users">指定ユーザーのみ</option></select><p class="muted">指定ユーザーはログインして閲覧します。作成者と管理者も閲覧できます。</p><div class="checklist" id="recipients">${users.map(u=>`<label><input type="checkbox" name="users" value="${u.id}" ${v.users?.includes(u.id)?'checked':''}> ${esc(u.name)}</label>`).join('')}</div><button class="primary">${v.id?'変更を保存':'公開してリンクを作成'} →</button></div></form>`;document.querySelector('#back').onclick=run(dashboard);const f=document.querySelector('#editor');f.elements.namedItem('kind').value=v.kind;f.elements.namedItem('visibility').value=v.visibility;const toggle=()=>document.querySelector('#recipients').style.display=f.elements.namedItem('visibility').value==='users'?'block':'none';toggle();f.elements.namedItem('visibility').onchange=toggle;document.querySelector('#file').onchange=run(async e=>{const file=e.target.files[0];if(!file)return;f.elements.namedItem('content').value=await file.text();f.elements.namedItem('kind').value=/\.html?$/.test(file.name)?'html':'md';if(!f.elements.namedItem('source_path').value)f.elements.namedItem('source_path').value=file.name;if(!f.elements.namedItem('title').value)f.elements.namedItem('title').value=file.name});f.onsubmit=run(async()=>{const out=await api(v.id?'/artifacts/'+v.id:'/artifacts',v.id?'PUT':'POST',{title:f.elements.namedItem('title').value,kind:f.elements.namedItem('kind').value,content:f.elements.namedItem('content').value,source_path:f.elements.namedItem('source_path').value,visibility:f.elements.namedItem('visibility').value,users:[...f.querySelectorAll('[name=users]:checked')].map(x=>x.value)});await dashboard();showLink(out)})}
function showLink(v){const d=document.createElement('dialog');d.innerHTML=`<h2>公開しました</h2><p>共有リンク</p><input readonly value="${esc(location.origin+v.url)}"><p><a href="${esc(v.url)}" target="_blank" rel="noopener">コンテンツを開く ↗</a></p><button>閉じる</button>`;document.body.append(d);d.querySelector('button').onclick=()=>{d.close();d.remove()};d.showModal()}
async function keys(){const list=await api('/keys');document.querySelector('#panel').innerHTML=`<h2>API キー</h2><p>Claude Code や curl から公開できます。キーは作成時に一度だけ表示します。</p><form id="keyform" class="row"><input name="name" required placeholder="キーの名前（例: Claude Code）"><button class="primary">キーを作成</button></form><div class="table-wrap spaced"><table><thead><tr><th>名前</th><th>作成日時</th><th></th></tr></thead><tbody>${list.map(k=>`<tr><td>${esc(k.name)}</td><td>${esc(k.created)}</td><td><button class="danger" data-revoke="${k.id}">失効</button></td></tr>`).join('')||'<tr><td colspan="3">API キーがありません。</td></tr>'}</tbody></table></div><h2 class="spaced">curl で公開</h2><pre>${esc(`jq -n --rawfile content report.md '{title:"Report",kind:"md",content:$content,visibility:"link",users:[]}' |\ncurl -sS '${location.origin+base}/api/artifacts' \\\n  -H "Authorization: Bearer $ARTIFACT_SHARE_KEY" \\\n  -H 'Content-Type: application/json' --data-binary @-`)}</pre>`;document.querySelector('#keyform').onsubmit=run(async e=>{const v=await api('/keys','POST',{name:e.target.elements.namedItem('name').value});await keys();const d=document.createElement('dialog');d.innerHTML=`<h2>API キーを作成しました</h2><p>この画面を閉じると再表示できません。安全な場所に保存してください。</p><input readonly value="${esc(v.key)}"><p><button>保存したので閉じる</button></p>`;document.body.append(d);d.querySelector('button').onclick=()=>{d.close();d.remove()};d.showModal()});document.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=run(async()=>{if(!confirm('この API キーを失効しますか？'))return;await api('/keys/'+b.dataset.revoke,'DELETE');await keys()}))}
async function admin(){const users=await api('/admin/users');document.querySelector('#panel').innerHTML=`<h2>ユーザー管理</h2><form class="card" id="userform"><div class="row"><input name="name" required placeholder="ユーザー名"><input name="password" required minlength="8" maxlength="72" type="password" placeholder="初期パスワード（8文字以上）"><button class="primary">作成</button></div><label><input type="checkbox" name="admin"> 管理者として作成</label></form><div class="table-wrap spaced"><table><thead><tr><th>ユーザー</th><th>権限</th><th></th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.name)}</td><td>${u.admin?'管理者':'ユーザー'}</td><td><button data-reset="${u.id}">パスワード再設定</button></td></tr>`).join('')}</tbody></table></div><div id="all" class="spaced"></div>`;document.querySelector('#userform').onsubmit=run(async e=>{await api('/admin/users','POST',{name:e.target.elements.namedItem('name').value,password:e.target.elements.namedItem('password').value,admin:e.target.elements.namedItem('admin').checked});toast('ユーザーを作成しました');await admin()});document.querySelectorAll('[data-reset]').forEach(b=>b.onclick=run(async()=>{const password=prompt('新しいパスワード（8〜72バイト）');if(!password)return;await api('/admin/users/'+b.dataset.reset,'PATCH',{password});toast('パスワードを更新し、既存のログインを失効しました')}));await artifactsTable('/admin/artifacts',document.querySelector('#all'))}
async function resolveMarkdownLinks(root, id) {
  const resolved = new Map();
  await Promise.all([...root.querySelectorAll('a[href]')].map(async anchor => {
    const href = anchor.getAttribute('href');
    // External URLs, origin-relative URLs, and in-document fragments keep their meaning.
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return;
    anchor.dataset.sourceHref = href;
    try {
      if (!resolved.has(href)) resolved.set(href, api('/resolve?id=' + encodeURIComponent(id) + '&href=' + encodeURIComponent(href)));
      const target = await resolved.get(href);
      anchor.setAttribute('href', target.url);
    } catch {
      anchor.classList.add('unresolved-link');
      anchor.title = 'リンク先が未公開、または閲覧権限がありません';
      const unavailable = event => { event.preventDefault(); toast(anchor.title); };
      anchor.addEventListener('click', unavailable);
      anchor.addEventListener('auxclick', unavailable);
    }
  }));
}

async function share(id){try{const v=await api('/share?id='+encodeURIComponent(id));document.title=v.title+' · Artifact Share';app.innerHTML=`<div class="share-head"><div class="eyebrow">SHARED ARTIFACT</div><h1>${esc(v.title)}</h1><p><span class="badge">${esc(v.kind.toUpperCase())}</span>${v.visibility==='link'?'リンク共有':'指定ユーザー共有'} · <span class="share-owner">オーナー: ${esc(v.owner_name)}</span> · ${esc(new Date(v.updated).toLocaleString('ja-JP'))}</p></div><article class="viewer" id="content"></article>`;const c=document.querySelector('#content');if(v.kind==='html'){const f=document.createElement('iframe');f.title=v.title;f.sandbox='allow-scripts';f.src=base+'/s/'+id+'/raw';c.append(f)}else{c.innerHTML=DOMPurify.sanitize(marked.parse(v.content));await resolveMarkdownLinks(c,id);mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral'});const codes=[...c.querySelectorAll('pre code.language-mermaid')];for(const code of codes){const node=document.createElement('div');node.className='mermaid';node.textContent=code.textContent;code.parentElement.replaceWith(node)}try{await mermaid.run({nodes:c.querySelectorAll('.mermaid')})}catch{toast('Mermaid の構文を確認してください')}}}catch(e){app.innerHTML=`<div class="card empty"><h1>コンテンツを表示できません</h1><p>リンクが無効、または閲覧権限がありません。指定ユーザー共有の場合はログインしてください。</p><a class="button primary" href="${base}/">ログイン画面へ</a></div>`}}
async function start(){const config=await api('/config');signup=config.signup;try{const v=await api('/me');me=v.user;csrf=v.csrf}catch{me=null}account();const p=location.pathname.slice(base.length);if(p.startsWith('/s/'))return share(p.slice(3));if(!me)return auth();await dashboard()}
start().catch(e=>{app.innerHTML='<p class="error">読み込みに失敗しました。</p>';toast(e.message)});
