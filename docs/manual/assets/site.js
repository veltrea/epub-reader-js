// 動きは二つだけ。スクロールに合わせた節の現れ方と、マニュアルの柱の追従。
// どちらも無くても読める範囲に留める（JS を切っても内容は全部出る）。

(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 節が視界に入ったら出す。
  const targets = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-in'));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.06 }
    );
    targets.forEach((el) => io.observe(el));
  }

  // マニュアルの柱。いま読んでいる節に印を移す。
  const links = [...document.querySelectorAll('.toc a[href^="#"]')];
  if (!links.length) return;

  const sections = links
    .map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))))
    .filter(Boolean);

  const mark = () => {
    // 画面上端から少し下を基準線にして、それを最後に越えた節を現在地とする。
    const line = window.scrollY + window.innerHeight * 0.28;
    let current = sections[0];
    for (const section of sections) {
      if (section.offsetTop <= line) current = section;
    }
    links.forEach((a) => {
      a.classList.toggle('is-current', current && a.hash === `#${current.id}`);
    });
  };

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      mark();
      ticking = false;
    });
  };

  mark();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
})();
