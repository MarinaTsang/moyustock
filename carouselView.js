(function (global) {
  function syncViewportMode(viewportEl, isOverMax) {
    if (!viewportEl) return;
    viewportEl.classList.toggle('lt-viewport-fixed', !!isOverMax);
  }

  function rebuildDisplayRows(options = {}) {
    const listEl = options.listEl;
    if (!listEl) return;

    const isOverMax = !!options.isOverMax;
    const maxDisplay = options.maxDisplay || 3;
    const displayStocks = options.displayStocks || [];
    const blankCode = options.blankCode;
    const createIndexedRow = options.createIndexedRow;
    const createCodeRow = options.createCodeRow;

    listEl.innerHTML = '';
    if (isOverMax) {
      for (let i = 0; i < maxDisplay; i++) {
        listEl.appendChild(createIndexedRow(i));
      }
      return;
    }

    displayStocks.forEach((code, idx) => {
      listEl.appendChild(createCodeRow(code, idx, blankCode));
    });
  }

  function resetAnimatedList(listEl, maxDisplay) {
    while (listEl.children.length > maxDisplay) {
      listEl.removeChild(listEl.firstChild);
    }
    listEl.style.transform = '';
    listEl.style.transition = '';
  }

  function appendPrefixedRows(options = {}) {
    const listEl = options.listEl;
    const maxDisplay = options.maxDisplay || 3;
    const prefix = options.prefix || 'new';
    const createPrefixedRow = options.createPrefixedRow;
    for (let i = 0; i < maxDisplay; i++) {
      listEl.appendChild(createPrefixedRow(prefix, i));
    }
  }

  function startTranslateAnimation(listEl, offsetPx) {
    void listEl.offsetWidth;
    listEl.style.transition = 'transform 0.28s ease-out';
    listEl.style.transform = `translateY(-${offsetPx}px)`;
  }

  function finalizeRotationFrame(options = {}) {
    const listEl = options.listEl;
    const maxDisplay = options.maxDisplay || 3;
    const renumberIndexedRows = options.renumberIndexedRows || (() => {});
    for (let i = 0; i < maxDisplay; i++) {
      if (!listEl.firstChild) break;
      listEl.removeChild(listEl.firstChild);
    }
    listEl.style.transform = '';
    listEl.style.transition = '';
    renumberIndexedRows(listEl);
  }

  function reconcileRotationTimer(options = {}) {
    const needRotation = !!options.needRotation;
    const existingTimer = options.rotateTimer || null;
    const rotateInterval = options.rotateInterval || 5000;
    const rotateAndUpdate = options.rotateAndUpdate;

    if (needRotation) {
      if (existingTimer) return existingTimer;
      return setInterval(rotateAndUpdate, rotateInterval);
    }

    if (existingTimer) clearInterval(existingTimer);
    return null;
  }

  global.LTCarouselView = {
    syncViewportMode,
    rebuildDisplayRows,
    resetAnimatedList,
    appendPrefixedRows,
    startTranslateAnimation,
    finalizeRotationFrame,
    reconcileRotationTimer
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
