// Keep layout independent of the rendering bundle and its build dependencies.
(() => {
  const app = document.querySelector('#app');
  const header = document.querySelector('body > header');
  if (!app || !header) return;

  const observer = new MutationObserver(update);
  function update() {
    const details = app.querySelector(':scope > .share-head');
    const content = app.querySelector(':scope > .viewer');
    if (!details || !content) return;
    header.append(details);
    header.classList.add('viewer-header');
    document.body.classList.add('artifact-view');
    content.classList.toggle('html-viewer', !!content.querySelector(':scope > iframe'));
    observer.disconnect();
  }
  observer.observe(app, { childList: true, subtree: true });
  update();
})();
