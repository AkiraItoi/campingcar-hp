'use strict';

(async function () {
  const section = document.getElementById('recommended-spots');
  if (!section) return;

  let spots;
  try {
    const response = await fetch('/data/spots.json', { cache: 'no-cache' });
    if (!response.ok) return;
    spots = await response.json();
  } catch {
    return;
  }
  if (!Array.isArray(spots)) return;

  const categories = {
    stay: {
      rail: document.getElementById('spots-stay'),
      group: document.getElementById('spots-stay-group'),
      label: '車中泊スポット'
    },
    camp: {
      rail: document.getElementById('spots-camp'),
      group: document.getElementById('spots-camp-group'),
      label: 'キャンプ場'
    },
    play: {
      rail: document.getElementById('spots-play'),
      group: document.getElementById('spots-play-group'),
      label: '遊び場'
    },
    gourmet: {
      rail: document.getElementById('spots-gourmet'),
      group: document.getElementById('spots-gourmet-group'),
      label: '足で知った、本当のグルメ情報'
    }
  };

  const safeUrl = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };

  const safeImage = value =>
    typeof value === 'string' &&
    /^\/?img\/spots\/[a-zA-Z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/i.test(value)
      ? '/' + value.replace(/^\//, '')
      : null;

  const getImages = item => {
    const values = Array.isArray(item.images)
      ? item.images
      : (typeof item.image === 'string' ? [item.image] : []);

    return values.map(safeImage).filter(Boolean).slice(0, 6);
  };

  for (const item of spots) {
    if (!item || item.published !== true || !categories[item.category]) continue;

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const comment = typeof item.comment === 'string' ? item.comment.trim() : '';
    const url = safeUrl(item.url);
    const images = getImages(item);
    if (!title || !comment || !url || !images.length) continue;

    const card = document.createElement('article');
    card.className = 'spots-card';
    card.dataset.commentToggle = 'true';
    card.tabIndex = 0;
    card.setAttribute('aria-expanded', 'false');
    if (item.private === true) card.classList.add('is-private');

    const gallery = document.createElement('div');
    gallery.className = 'spots-card-gallery';
    gallery.dataset.index = '0';

    const photoFrame = document.createElement('div');
    photoFrame.className = 'spots-card-photo-frame';

    const photoStack = document.createElement('div');
    photoStack.className = 'spots-card-photos';

    images.forEach((image, index) => {
      const photo = document.createElement('img');
      if (index === 0) {
        photo.src = image;
        photo.classList.add('is-active');
      } else {
        photo.dataset.src = image;
      }
      photo.alt = title + ' の写真 ' + (index + 1);
      photo.loading = 'lazy';
      photo.decoding = 'async';
      photoStack.append(photo);
    });

    photoFrame.append(photoStack);
    gallery.append(photoFrame);

    if (images.length > 1) {
      const previous = document.createElement('button');
      previous.className = 'spots-gallery-button is-previous';
      previous.type = 'button';
      previous.dataset.galleryMove = '-1';
      previous.setAttribute('aria-label', title + ' の前の写真');
      previous.textContent = '‹';

      const next = document.createElement('button');
      next.className = 'spots-gallery-button is-next';
      next.type = 'button';
      next.dataset.galleryMove = '1';
      next.setAttribute('aria-label', title + ' の次の写真');
      next.textContent = '›';

      const count = document.createElement('span');
      count.className = 'spots-gallery-count';
      count.setAttribute('aria-live', 'polite');
      count.textContent = '1 / ' + images.length;

      gallery.append(previous, next, count);
    }

    const body = document.createElement('div');
    body.className = 'spots-card-body';

    const tag = document.createElement('span');
    tag.className = 'spots-card-tag';
    tag.textContent = categories[item.category].label;
    body.append(tag);

    if (item.private === true) {
      const privateTag = document.createElement('span');
      privateTag.className = 'spots-card-private';
      privateTag.textContent = 'プライベートキャンプ場';
      body.append(privateTag);
    }

    const heading = document.createElement('h4');
    heading.textContent = title;

    const hint = document.createElement('span');
    hint.className = 'spots-card-comment-toggle';
    hint.textContent = 'コメントを見る';

    const description = document.createElement('p');
    description.className = 'spots-card-comment';
    description.textContent = comment;
    description.hidden = true;

    const more = document.createElement('a');
    more.className = 'spots-card-link';
    more.href = url;
    more.target = '_blank';
    more.rel = 'noopener noreferrer';
    more.setAttribute('aria-label', title + ' の公式サイトを開く');
    more.textContent = '公式サイトを見る ↗';

    body.append(heading, hint, description, more);
    card.append(gallery, body);
    categories[item.category].rail.append(card);
  }

  const active = Object.values(categories).filter(({ rail }) => rail && rail.children.length);
  if (!active.length) return;

  active.forEach(({ group }) => {
    group.hidden = false;
  });
  section.hidden = false;

  const toggleComment = card => {
    const comment = card.querySelector('.spots-card-comment');
    const hint = card.querySelector('.spots-card-comment-toggle');
    if (!comment || !hint) return;

    const opening = comment.hidden;
    comment.hidden = !opening;
    card.classList.toggle('is-comment-open', opening);
    card.setAttribute('aria-expanded', String(opening));
    hint.textContent = opening ? 'コメントを閉じる' : 'コメントを見る';
  };

  section.addEventListener('click', event => {
    const galleryButton = event.target.closest('[data-gallery-move]');
    if (galleryButton) {
      const gallery = galleryButton.closest('.spots-card-gallery');
      const photos = Array.from(gallery.querySelectorAll('img'));
      const count = gallery.querySelector('.spots-gallery-count');
      const currentIndex = Number(gallery.dataset.index || 0);
      const nextIndex = (currentIndex + Number(galleryButton.dataset.galleryMove) + photos.length) % photos.length;
      const nextPhoto = photos[nextIndex];

      if (!nextPhoto.src && nextPhoto.dataset.src) {
        nextPhoto.src = nextPhoto.dataset.src;
      }

      photos[currentIndex].classList.remove('is-active');
      nextPhoto.classList.add('is-active');
      gallery.dataset.index = String(nextIndex);
      if (count) count.textContent = (nextIndex + 1) + ' / ' + photos.length;
      return;
    }

    if (event.target.closest('a')) return;
    const card = event.target.closest('.spots-card[data-comment-toggle]');
    if (card) toggleComment(card);
  });

  section.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('a, button')) return;

    const card = event.target.closest('.spots-card[data-comment-toggle]');
    if (!card) return;
    event.preventDefault();
    toggleComment(card);
  });

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  active.forEach(({ rail }) => {
    const originals = Array.from(rail.children);
    const continuous = originals.length >= 4;
    let loopDistance = 0;

    if (continuous) {
      const clones = originals.map(card => {
        const clone = card.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        clone.tabIndex = -1;
        clone.querySelectorAll('a, button').forEach(control => {
          control.tabIndex = -1;
        });
        rail.append(clone);
        return clone;
      });

      loopDistance = clones[0].offsetLeft - originals[0].offsetLeft;
      if (loopDistance <= 0) return;
    }

    const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
    if (!continuous && maxScroll <= 0) return;

    let stopped = false;
    let visible = false;
    let frameId = 0;
    let lastTime = performance.now();
    const pixelsPerSecond = 24;

    const stopAutoMove = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frameId);
    };

    rail.addEventListener('pointerdown', stopAutoMove, { passive: true });
    rail.addEventListener('touchstart', stopAutoMove, { passive: true });
    rail.addEventListener('focusin', stopAutoMove);
    rail.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') stopAutoMove();
    });
    rail.addEventListener('wheel', event => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
        stopAutoMove();
      }
    }, { passive: true });

    const animate = now => {
      if (stopped) return;
      const elapsed = Math.min(now - lastTime, 50);
      lastTime = now;

      if (visible && !document.hidden) {
        rail.scrollLeft += pixelsPerSecond * elapsed / 1000;

        if (continuous && rail.scrollLeft >= loopDistance) {
          rail.scrollLeft -= loopDistance;
        } else if (!continuous && rail.scrollLeft >= maxScroll - 1) {
          stopped = true;
          return;
        }
      }
      frameId = requestAnimationFrame(animate);
    };

    const observer = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      lastTime = performance.now();
    }, { threshold: 0.2 });
    observer.observe(rail);

    document.addEventListener('visibilitychange', () => {
      lastTime = performance.now();
    });

    frameId = requestAnimationFrame(animate);
  });
})();
