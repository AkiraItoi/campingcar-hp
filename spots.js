'use strict';
(async function () {
  const section = document.getElementById('recommended-spots');
  if (!section) return;
  let spots;
  try {
    const response = await fetch('/data/spots.json', {cache:'no-cache'});
    if (!response.ok) return;
    spots = await response.json();
  } catch { return; }
  if (!Array.isArray(spots)) return;

  const categories = {
    stay: {rail: document.getElementById('spots-stay'), group: document.getElementById('spots-stay-group'), label:'車中泊スポット・キャンプ場'},
    play: {rail: document.getElementById('spots-play'), group: document.getElementById('spots-play-group'), label:'日中の遊び場'}
  };
  const safeUrl = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  };
  const safeImage = value => typeof value === 'string' && /^\/?img\/spots\/[a-zA-Z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/i.test(value)
    ? '/' + value.replace(/^\//, '') : null;

  for (const item of spots) {
    if (!item || item.published !== true || !categories[item.category]) continue;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const comment = typeof item.comment === 'string' ? item.comment.trim() : '';
    const url = safeUrl(item.url), image = safeImage(item.image);
    if (!title || !comment || !url || !image) continue;

    const card = document.createElement('article');
    card.className = 'spots-card';
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', title + ' の公式サイトを開く');
    const photo = document.createElement('img');
    photo.src = image; photo.alt = title + ' の写真'; photo.loading = 'lazy'; photo.decoding = 'async';
    const body = document.createElement('div');
    body.className = 'spots-card-body';
    const tag = document.createElement('span');
    tag.className = 'spots-card-tag'; tag.textContent = categories[item.category].label;
    const heading = document.createElement('h4'); heading.textContent = title;
    const description = document.createElement('p'); description.textContent = comment;
    const more = document.createElement('span');
    more.className = 'spots-card-link'; more.textContent = '公式サイトを見る ↗';
    body.append(tag, heading, description, more);
    link.append(photo, body); card.append(link);
    categories[item.category].rail.append(card);
  }
  const active = Object.values(categories).filter(({rail}) => rail.children.length);
  if (!active.length) return;
  active.forEach(({group}) => { group.hidden = false; });
  section.hidden = false;

  // 操作中は自動送りを止める。動きを減らす設定も尊重する。
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  active.forEach(({rail}) => {
    if (rail.children.length < 2) return;
    let pauseUntil = 0;
    const pause = () => {pauseUntil = Date.now() + 10000;};
    ['pointerdown','touchstart','wheel','focusin','mouseenter'].forEach(type => rail.addEventListener(type, pause, {passive:true}));
    // タイマーは見えている間だけ進める。
    let visible = false;
    const visibility = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; }, {threshold:0.2});
    visibility.observe(rail);
    setInterval(() => {
      if (!visible || document.hidden || Date.now() < pauseUntil) return;
      const first = rail.firstElementChild;
      const step = first.getBoundingClientRect().width + parseFloat(getComputedStyle(rail).gap || '0');
      if (rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4) rail.scrollTo({left:0, behavior:'smooth'});
      else rail.scrollBy({left:step, behavior:'smooth'});
    }, 4500);
  });
})();
