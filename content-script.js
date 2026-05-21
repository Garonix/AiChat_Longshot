(() => {
  if (window.__CHAT_LONGSHOT_LOADED__) {
    chrome.runtime.onMessage.removeListener(window.__CHAT_LONGSHOT_LISTENER__);
  }

  const APP_ID = "chat-longshot";
  const MAX_JPEG_HEIGHT = 12000;
  const JPEG_QUALITY = 0.92;
  const CAPTURE_OVERLAP = 160;
  const PINNED_MARKER_TOP = 60;
  const SELECTION_BLUE = "#2c7df0";
  const CHATGPT_TOP_INSET = 52;

  let state = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getPageHeight() {
    const body = document.body;
    const html = document.documentElement;
    return Math.max(
      body.scrollHeight,
      body.offsetHeight,
      html.clientHeight,
      html.scrollHeight,
      html.offsetHeight
    );
  }

  function isWindowScrollRoot(root) {
    return root === window || root === document || root === document.documentElement || root === document.body || root === document.scrollingElement;
  }

  function getScrollTop(root) {
    return isWindowScrollRoot(root) ? window.scrollY : root.scrollTop;
  }

  function getScrollHeight(root) {
    return isWindowScrollRoot(root) ? getPageHeight() : root.scrollHeight;
  }

  function getClientHeight(root) {
    return isWindowScrollRoot(root) ? window.innerHeight : root.clientHeight;
  }

  function scrollToPosition(root, top) {
    if (isWindowScrollRoot(root)) {
      window.scrollTo({ top, left: 0, behavior: "auto" });
    } else {
      root.scrollTop = top;
    }
  }

  async function waitForScrollSettled(root, expectedTop) {
    let lastTop = getScrollTop(root);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(90);
      const currentTop = getScrollTop(root);
      const closeEnough = Math.abs(currentTop - expectedTop) <= 2;
      const stable = Math.abs(currentTop - lastTop) <= 1;
      if (closeEnough && stable) {
        return currentTop;
      }
      lastTop = currentTop;
    }
    await sleep(120);
    return getScrollTop(root);
  }

  function scrollRootLabel(root) {
    if (isWindowScrollRoot(root)) {
      return "页面";
    }
    const id = root.id ? `#${root.id}` : "";
    const className = typeof root.className === "string" && root.className.trim()
      ? `.${root.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
    return `${root.tagName.toLowerCase()}${id}${className}`;
  }

  function intersectRects(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.left + a.width, b.left + b.width);
    const bottom = Math.min(a.top + a.height, b.top + b.height);
    return {
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    };
  }

  function getContentClipRect(root) {
    const elements = state?.points?.length
      ? state.points.map((point) => point.element)
      : state?.items?.slice(0, 12).map((item) => item.element) || [];
    const rects = elements
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 120 && rect.height > 20);

    if (!rects.length) {
      return null;
    }

    const viewportRect = {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight
    };
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const rootRect = isWindowScrollRoot(root) ? viewportRect : root.getBoundingClientRect();

    const padded = {
      left: clamp(left - 16, 0, window.innerWidth),
      top: clamp(rootRect.top, 0, window.innerHeight),
      width: clamp(right + 16, 0, window.innerWidth) - clamp(left - 16, 0, window.innerWidth),
      height: clamp(rootRect.bottom, 0, window.innerHeight) - clamp(rootRect.top, 0, window.innerHeight)
    };

    return intersectRects(viewportRect, padded);
  }

  function getCaptureRect(root, clipRect = null) {
    const baseRect = isWindowScrollRoot(root)
      ? {
          left: 0,
          top: 0,
          width: window.innerWidth,
          height: window.innerHeight
        }
      : (() => {
          const rect = root.getBoundingClientRect();
          const left = clamp(rect.left, 0, window.innerWidth);
          const top = clamp(rect.top, 0, window.innerHeight);
          const right = clamp(rect.right, 0, window.innerWidth);
          const bottom = clamp(rect.bottom, 0, window.innerHeight);
          return {
            left,
            top,
            width: Math.max(1, right - left),
            height: Math.max(1, bottom - top)
          };
        })();

    if (clipRect) {
      return intersectRects(baseRect, clipRect);
    }

    return baseRect;
  }

  function isScrollableElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    const style = getComputedStyle(element);
    const overflowY = style.overflowY;
    const canScroll = /(auto|scroll|overlay)/.test(overflowY);
    return canScroll && element.scrollHeight - element.clientHeight > 80;
  }

  function findScrollableAncestors(element) {
    const roots = [];
    let current = element;
    while (current && current !== document.body && current !== document.documentElement) {
      if (isScrollableElement(current)) {
        roots.push(current);
      }
      current = current.parentElement;
    }
    roots.push(document.scrollingElement || document.documentElement);
    return roots;
  }

  function chooseScrollRoot() {
    const selectedElements = state?.points?.map((point) => point.element).filter((element) => element?.isConnected) || [];
    const seedElements = selectedElements.length ? selectedElements : state?.items?.slice(0, 4).map((item) => item.element) || [];
    const candidates = new Set();

    state?.points?.forEach((point) => {
      point.ranges?.forEach((range) => candidates.add(range.root));
    });
    seedElements.forEach((element) => {
      findScrollableAncestors(element).forEach((root) => candidates.add(root));
    });
    candidates.add(document.scrollingElement || document.documentElement);

    let best = document.scrollingElement || document.documentElement;
    let bestScore = getScrollHeight(best) - getClientHeight(best);

    candidates.forEach((candidate) => {
      const scrollableDistance = getScrollHeight(candidate) - getClientHeight(candidate);
      if (scrollableDistance <= 80) {
        return;
      }

      const rect = isWindowScrollRoot(candidate)
        ? { top: 0, bottom: window.innerHeight, height: window.innerHeight }
        : candidate.getBoundingClientRect();
      const visibleEnough = rect.bottom > 80 && rect.top < window.innerHeight - 80 && rect.height > 180;
      if (visibleEnough && scrollableDistance > bestScore) {
        best = candidate;
        bestScore = scrollableDistance;
      }
    });

    return best;
  }

  function getPlatform() {
    const host = location.hostname;
    if (host.includes("gemini.google.com")) {
      return "gemini";
    }
    if (host.includes("grok.com") || (host.includes("x.com") && location.pathname.startsWith("/i/grok"))) {
      return "grok";
    }
    if (host.includes("doubao.com")) {
      return "doubao";
    }
    if (host.includes("deepseek.com")) {
      return "deepseek";
    }
    if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) {
      return "chatgpt";
    }
    return "web";
  }

  function uniqueElements(elements, platform = getPlatform()) {
    const normalized = normalizeCandidateElements(elements, platform);
    const visible = Array.from(new Set(normalized)).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 220 && rect.height > 24 && isMainContentElement(element, platform);
    });
    return keepRightmostCandidatePerRow(visible);
  }

  function normalizeCandidateElements(elements, platform) {
    const roots = elements
      .map((element) => getMessageCandidateRoot(element, platform))
      .filter(Boolean);
    return removeNestedCandidateElements(Array.from(new Set(roots)));
  }

  function getMessageCandidateRoot(element, platform) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const platformRootSelectors = {
      chatgpt: [
        "article[data-testid^='conversation-turn']",
        "[data-testid^='conversation-turn']"
      ],
      gemini: [
        "user-query",
        "model-response"
      ],
      deepseek: [
        ".ds-message",
        "[class~='ds-message']"
      ],
      grok: [
        "main article",
        "main [role='article']",
        "main [data-testid*='message' i]"
      ],
      doubao: [
        "main [data-testid*='message' i]",
        "main [class*='chat-message' i]",
        "main article"
      ]
    };

    const selectors = platformRootSelectors[platform] || [];
    for (const selector of selectors) {
      const root = element.closest(selector);
      if (root) {
        return root;
      }
    }

    return element;
  }

  function removeNestedCandidateElements(elements) {
    return elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return !elements.some((other) => {
        if (other === element || !other.contains(element)) {
          return false;
        }
        const otherRect = other.getBoundingClientRect();
        const sameMessageBand = Math.abs(otherRect.top - rect.top) < 120 || rect.top >= otherRect.top;
        const reasonableOuter = otherRect.height < window.innerHeight * 3.5;
        return sameMessageBand && reasonableOuter;
      });
    });
  }

  function keepRightmostCandidatePerRow(elements) {
    const sorted = [...elements].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const kept = [];

    sorted.forEach((element) => {
      const rect = element.getBoundingClientRect();
      const existingIndex = kept.findIndex((candidate) => {
        const candidateRect = candidate.getBoundingClientRect();
        return Math.abs(candidateRect.top - rect.top) < 28;
      });

      if (existingIndex === -1) {
        kept.push(element);
        return;
      }

      const existingRect = kept[existingIndex].getBoundingClientRect();
      if (rect.left > existingRect.left) {
        kept[existingIndex] = element;
      }
    });

    return kept.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function isMainContentElement(element, platform = getPlatform()) {
    if (!element || element.closest("nav, aside, header, footer")) {
      return false;
    }

    const main = document.querySelector("main");
    if (main && !main.contains(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const centerX = rect.left + rect.width / 2;

    if (platform === "chatgpt" || platform === "gemini") {
      return centerX >= viewportWidth * 0.15 && rect.right >= viewportWidth * 0.3;
    }

    const mainRect = main ? main.getBoundingClientRect() : null;
    const minimumContentLeft = viewportWidth >= 900
      ? Math.max(viewportWidth * 0.12, (mainRect?.left || 0) + 96)
      : 0;

    if (rect.left < minimumContentLeft) {
      return false;
    }

    if (centerX < viewportWidth * 0.22) {
      return false;
    }

    if (rect.right < viewportWidth * 0.35) {
      return false;
    }

    return true;
  }

  function findChatGptCandidates() {
    const selectors = [
      "article[data-testid^='conversation-turn']",
      "[data-testid^='conversation-turn']",
      "[data-message-author-role]",
      "main article"
    ];
    return uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))), "chatgpt");
  }

  function findGeminiCandidates() {
    const selectors = [
      "user-query",
      "model-response"
    ];
    return uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))), "gemini");
  }

  function findGrokCandidates() {
    const selectors = [
      "main article",
      "main [role='article']",
      "main [data-testid*='message' i]",
      "main [data-testid*='conversation' i]",
      "main [class*='message' i]",
      "main [class*='response' i]",
      "main [class*='chat' i]"
    ];
    return uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))), "grok");
  }

  function findDoubaoCandidates() {
    const selectors = [
      "main [data-testid*='message' i]",
      "main [data-testid*='conversation' i]",
      "main [class*='message' i]",
      "main [class*='chat-message' i]",
      "main [class*='conversation' i]",
      "main [class*='answer' i]",
      "main [class*='reply' i]",
      "main article"
    ];
    return uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))), "doubao");
  }

  function findDeepSeekCandidates() {
    const selectors = [
      ".ds-message",
      "[class~='ds-message']"
    ];
    return uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))), "deepseek");
  }

  function findFallbackCandidates() {
    const main = document.querySelector("main") || document.body;
    const elements = Array.from(main.querySelectorAll("article, section, [role='article'], div"));
    return uniqueElements(elements, "web").filter((element) => {
      const text = element.innerText || "";
      const rect = element.getBoundingClientRect();
      const childBlocks = Array.from(element.children).filter((child) => {
        const childRect = child.getBoundingClientRect();
        return childRect.width > 180 && childRect.height > 30;
      });
      return (
        text.trim().length > 20 &&
        rect.height > 35 &&
        rect.height < window.innerHeight * 2.5 &&
        childBlocks.length < 8
      );
    }).slice(0, 80);
  }

  function findCandidates() {
    const platform = getPlatform();
    const platformFinders = {
      chatgpt: findChatGptCandidates,
      gemini: findGeminiCandidates,
      grok: findGrokCandidates,
      doubao: findDoubaoCandidates,
      deepseek: findDeepSeekCandidates
    };
    const candidates = (platformFinders[platform] || findChatGptCandidates)();
    return candidates.length ? candidates : findFallbackCandidates();
  }

  function pageRectFor(element) {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top + window.scrollY,
      bottom: rect.bottom + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height
    };
  }

  function elementRangeInScrollRoot(element, root) {
    const rect = element.getBoundingClientRect();
    if (isWindowScrollRoot(root)) {
      return {
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY
      };
    }

    const rootRect = root.getBoundingClientRect();
    const scrollTop = getScrollTop(root);
    return {
      top: rect.top - rootRect.top + scrollTop,
      bottom: rect.bottom - rootRect.top + scrollTop
    };
  }

  function captureElementRanges(element) {
    return findScrollableAncestors(element).map((root) => ({
      root,
      top: elementRangeInScrollRoot(element, root).top,
      bottom: elementRangeInScrollRoot(element, root).bottom
    }));
  }

  function pointRangeInScrollRoot(point, root) {
    if (point.element?.isConnected) {
      const liveRange = elementRangeInScrollRoot(point.element, root);
      point.top = pageRectFor(point.element).top;
      point.bottom = pageRectFor(point.element).bottom;
      const cachedRange = point.ranges?.find((range) => range.root === root);
      if (cachedRange) {
        cachedRange.top = liveRange.top;
        cachedRange.bottom = liveRange.bottom;
      }
      return liveRange;
    }

    const cachedRange = point.ranges?.find((range) => range.root === root);
    if (cachedRange) {
      return cachedRange;
    }

    return {
      top: point.top,
      bottom: point.bottom
    };
  }

  function getSelectedScrollRange(root) {
    if (!state || state.points.length === 0) {
      return null;
    }

    const first = pointRangeInScrollRoot(state.points[0], root);
    const second = state.points.length > 1
      ? pointRangeInScrollRoot(state.points[1], root)
      : first;

    const startTop = Math.floor(first.top);
    const endTop = Math.ceil(second.bottom);

    if (endTop <= startTop) {
      return null;
    }

    return {
      startTop,
      endTop,
      length: endTop - startTop
    };
  }

  function ensureStyles() {
    if (document.getElementById(`${APP_ID}-styles`)) {
      return;
    }

    const style = document.createElement("style");
    style.id = `${APP_ID}-styles`;
    style.textContent = `
      .${APP_ID}-toolbar {
        position: fixed;
        left: 50%;
        bottom: 18px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: min(680px, calc(100vw - 24px));
        padding: 10px;
        border: 1px solid rgba(20, 26, 31, 0.18);
        border-radius: 8px;
        background: rgba(250, 251, 247, 0.96);
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.18);
        color: #172026;
        font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        transform: translateX(-50%);
      }
      .${APP_ID}-toolbar button {
        height: 32px;
        border: 1px solid #172026;
        border-radius: 6px;
        padding: 0 10px;
        color: #172026;
        background: #fff;
        font: 650 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }
      .${APP_ID}-toolbar button[data-primary="true"] {
        color: #fff;
        background: #172026;
      }
      .${APP_ID}-toolbar button:disabled {
        cursor: wait;
        opacity: 0.6;
      }
      .${APP_ID}-point {
        position: absolute;
        z-index: 2147483646;
        width: 18px;
        height: 18px;
        border: 2px solid ${SELECTION_BLUE};
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 4px 12px rgba(44, 125, 240, 0.26);
        cursor: pointer;
      }
      .${APP_ID}-point:hover {
        transform: scale(1.15);
      }
      .${APP_ID}-point[data-picked="1"] {
        border-color: ${SELECTION_BLUE};
        background: ${SELECTION_BLUE};
      }
      .${APP_ID}-point[data-picked="2"] {
        border-color: ${SELECTION_BLUE};
        background: ${SELECTION_BLUE};
      }
      .${APP_ID}-line {
        position: absolute;
        left: 0;
        right: 0;
        z-index: 2147483644;
        height: 2px;
        opacity: 1;
        pointer-events: none;
      }
      .${APP_ID}-line[data-picked="1"] {
        background: ${SELECTION_BLUE};
      }
      .${APP_ID}-line[data-picked="2"] {
        background: ${SELECTION_BLUE};
      }
      .${APP_ID}-range {
        position: absolute;
        z-index: 1;
        opacity: 1;
        pointer-events: none;
        border-radius: 8px;
        background: rgba(44, 125, 240, 0.035);
        box-shadow: inset 0 0 0 1px rgba(44, 125, 240, 0.12);
      }
      .${APP_ID}-preview-suspended .${APP_ID}-line,
      .${APP_ID}-preview-suspended .${APP_ID}-range {
        opacity: 0;
        transition: none;
      }
      .${APP_ID}-preview-revealing .${APP_ID}-line,
      .${APP_ID}-preview-revealing .${APP_ID}-range {
        transition: opacity 500ms ease;
      }
      .${APP_ID}-hidden {
        display: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text) {
      element.textContent = text;
    }
    return element;
  }

  function clearSelectionMode() {
    if (!state) {
      return;
    }

    window.removeEventListener("scroll", state.refreshPositions, true);
    window.removeEventListener("resize", state.refreshPositions, true);
    window.removeEventListener(`${APP_ID}-locationchange`, state.exitOnNavigation);
    window.removeEventListener("popstate", state.exitOnNavigation);
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
    }
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
    }
    if (state.layoutRefreshTimer) {
      clearTimeout(state.layoutRefreshTimer);
    }
    if (state.previewRevealTimer) {
      clearTimeout(state.previewRevealTimer);
    }
    if (state.navigationCheckInterval) {
      clearInterval(state.navigationCheckInterval);
    }
    state.root.remove();
    state = null;
  }

  function getSelectedLength() {
    if (!state || state.points.length === 0) {
      return 0;
    }

    const range = getSelectedScrollRange(chooseScrollRoot());
    return range?.length || 0;
  }

  function pickPoint(item) {
    const pageRect = pageRectFor(item.element);
    const point = {
      element: item.element,
      top: pageRect.top,
      bottom: pageRect.bottom,
      left: pageRect.left,
      right: pageRect.left + pageRect.width,
      ranges: captureElementRanges(item.element)
    };

    const existingIndex = state.points.findIndex((candidate) => candidate.element === item.element);
    if (existingIndex !== -1) {
      state.points.splice(existingIndex, 1);
    } else if (state.points.length === 0) {
      state.points.push(point);
    } else if (state.points.length === 1) {
      const current = state.points[0];
      state.points = point.top < current.top ? [point, current] : [current, point];
    } else {
      state.points[point.top < state.points[0].top ? 0 : 1] = point;
    }

    renderSelection();
  }

  function clearPickedPoints() {
    if (!state) {
      return;
    }
    state.points = [];
    renderSelection();
  }

  function updateToolbar() {
    if (!state) {
      return;
    }

    const length = getSelectedLength();
    if (state.points.length === 0) {
      state.captureButton.disabled = true;
      return;
    }

    if (state.points.length === 1) {
      state.captureButton.disabled = length < 50;
      return;
    }

    state.captureButton.disabled = length < 50;
  }

  function setStatus(text) {
    if (state?.status) {
      state.status.textContent = text;
    }
  }

  function renderSelection() {
    if (!state) {
      return;
    }

    state.items.forEach((item) => {
      delete item.marker.dataset.picked;
    });
    state.lines.forEach((line) => line.remove());
    state.lines = [];
    state.rangeOverlay.classList.add(`${APP_ID}-hidden`);

    state.points.forEach((point, index) => {
      const item = state.items.find((candidate) => candidate.element === point.element);
      if (item) {
        item.marker.dataset.picked = String(index + 1);
      }

      const line = createElement("div", `${APP_ID}-line`);
      line.dataset.picked = String(index + 1);
      const lineTop = index === 0
        ? getSelectionStartLineTop(point.top)
        : getSelectionVisualBottom(point.bottom);
      line.style.top = `${lineTop}px`;
      applySelectionWidth(line, state.points);
      state.root.appendChild(line);
      state.lines.push(line);
    });

    if (state.points.length === 1) {
      const top = state.points[0].top;
      const bottom = state.points[0].bottom;
      state.rangeOverlay.classList.remove(`${APP_ID}-hidden`);
      applySelectionRangeOverlay(top, bottom);
    } else if (state.points.length >= 2) {
      const top = state.points[0].top;
      const bottom = state.points[1].bottom;
      state.rangeOverlay.classList.remove(`${APP_ID}-hidden`);
      applySelectionRangeOverlay(top, bottom);
    }

    updateToolbar();
  }

  function getDocumentWidth() {
    const body = document.body;
    const html = document.documentElement;
    return Math.max(
      window.innerWidth,
      body.scrollWidth,
      body.offsetWidth,
      html.clientWidth,
      html.scrollWidth,
      html.offsetWidth
    );
  }

  function getPointVisualRect(point) {
    if (point.element?.isConnected) {
      const rect = pageRectFor(point.element);
      point.left = rect.left;
      point.right = rect.left + rect.width;
    }

    return {
      left: point.left ?? 0,
      right: point.right ?? window.innerWidth
    };
  }

  function getSelectionVisualBounds(points) {
    const platform = getPlatform();
    const contentBounds = getContentTrackVisualBounds(points, platform);
    if (platform === "gemini" && contentBounds) {
      return contentBounds;
    }

    const composerRect = findComposerVisualRect();
    if (composerRect) {
      return applyPlatformSelectionInset({
        left: Math.max(0, composerRect.left + window.scrollX),
        width: Math.max(1, composerRect.width)
      }, platform);
    }

    if (platform === "chatgpt" && contentBounds) {
      return applyPlatformSelectionInset(contentBounds, platform);
    }

    if (contentBounds) {
      return applyPlatformSelectionInset(contentBounds, platform);
    }

    const rects = points.map(getPointVisualRect).filter((rect) => rect.right > rect.left);
    if (!rects.length) {
      return {
        left: 0,
        width: window.innerWidth
      };
    }

    const left = Math.max(0, Math.min(...rects.map((rect) => rect.left)) - 22);
    const right = Math.min(getDocumentWidth(), Math.max(...rects.map((rect) => rect.right)) + 22);
    return applyPlatformSelectionInset({
      left,
      width: Math.max(1, right - left)
    }, platform);
  }

  function applyPlatformSelectionInset(bounds, platform = getPlatform()) {
    if (!bounds || platform !== "chatgpt") {
      return bounds;
    }

    const inset = getChatGptHorizontalInset(bounds.width);
    if (bounds.width - inset * 2 < 160) {
      return bounds;
    }

    return {
      left: bounds.left + inset,
      width: bounds.width - inset * 2
    };
  }

  function getChatGptHorizontalInset(width) {
    return Math.round(clamp(width * 0.07, 36, 88));
  }

  function getContentTrackVisualBounds(points, platform = getPlatform()) {
    const elements = getContentTrackElements(points, platform);
    const rects = elements
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 120 && rect.height > 20 && rect.bottom > 0 && rect.top < window.innerHeight);

    if (!rects.length) {
      return null;
    }

    const leftPadding = platform === "gemini" ? 0 : 22;
    const rightPadding = platform === "gemini" ? 0 : 22;
    const left = clamp(Math.min(...rects.map((rect) => rect.left)) - leftPadding, 0, window.innerWidth);
    const right = clamp(Math.max(...rects.map((rect) => rect.right)) + rightPadding, 0, getDocumentWidth());

    if (right - left < 160) {
      return null;
    }

    return {
      left: left + window.scrollX,
      width: Math.max(1, right - left)
    };
  }

  function getContentTrackElements(points, platform) {
    const selected = points
      .map((point) => point.element)
      .filter((element) => element?.isConnected);
    const source = selected.length
      ? selected
      : state?.items
        ?.filter((item) => {
          const rect = item.element.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight;
        })
        .slice(0, 20)
        .map((item) => item.element) || [];

    return source.map((element) => getContentTrackElement(element, platform)).filter(Boolean);
  }

  function getContentTrackElement(element, platform) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }
    if (platform !== "gemini") {
      return element;
    }

    const main = document.querySelector("main");
    const baseRect = element.getBoundingClientRect();
    let current = element;
    let best = element;
    let bestWidth = baseRect.width;

    for (let depth = 0; current && depth < 8; depth += 1) {
      const rect = current.getBoundingClientRect();
      const style = getComputedStyle(current);
      const inMain = !main || main.contains(current);
      const saneWidth = rect.width >= baseRect.width && rect.width > window.innerWidth * 0.42 && rect.width < window.innerWidth * 0.9;
      const saneHeight = rect.height >= baseRect.height && rect.height < window.innerHeight * 1.8;
      const visible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";

      if (inMain && saneWidth && saneHeight && visible && rect.width >= bestWidth) {
        best = current;
        bestWidth = rect.width;
      }

      current = current.parentElement;
    }

    return best;
  }

  function getMarkerVisualLeft() {
    const bounds = getSelectionVisualBounds(state?.points || []);
    if (bounds.width > 1 && bounds.left > 0) {
      return Math.max(8, Math.floor(bounds.left - 34));
    }
    return state?.markerLeft || 8;
  }

  function getItemSelectionIndex(item) {
    if (!state) {
      return -1;
    }
    return state.points.findIndex((point) => point.element === item.element);
  }

  function getCandidateMarkerCenterTop(item, selectionIndex) {
    if (selectionIndex !== -1) {
      const point = state.points[selectionIndex];
      return selectionIndex === 0
        ? getSelectionStartLineTop(point.top)
        : getSelectionVisualBottom(point.bottom);
    }

    const viewportRect = item.element.getBoundingClientRect();
    return window.scrollY + clamp(viewportRect.top - 5, PINNED_MARKER_TOP, window.innerHeight - 34);
  }

  function applySelectionWidth(element, points) {
    const bounds = getSelectionVisualBounds(points);
    element.style.left = `${bounds.left}px`;
    element.style.right = "auto";
    element.style.width = `${bounds.width}px`;
  }

  function applySelectionRangeOverlay(top, bottom) {
    const bounds = getSelectionVisualBounds(state.points);
    const adjustedTop = getSelectionStartLineTop(top);
    const visualBottom = getSelectionVisualBottom(bottom);
    state.rangeOverlay.style.top = `${adjustedTop}px`;
    state.rangeOverlay.style.left = `${bounds.left}px`;
    state.rangeOverlay.style.width = `${bounds.width}px`;
    state.rangeOverlay.style.height = `${Math.max(0, visualBottom - adjustedTop)}px`;
  }

  function getSelectionVisualTop(logicalTop) {
    const root = chooseScrollRoot();
    const rootRect = isWindowScrollRoot(root)
      ? { top: 0 }
      : root.getBoundingClientRect();
    return Math.max(logicalTop, window.scrollY + Math.max(0, rootRect.top));
  }

  function getSelectionStartLineTop(pointTop) {
    const baseTop = getSelectionVisualTop(pointTop - 5);
    return getPlatform() === "chatgpt"
      ? baseTop + CHATGPT_TOP_INSET
      : baseTop;
  }

  function getSelectionVisualBottom(logicalBottom) {
    const composerRect = findComposerVisualRect();
    if (!composerRect) {
      return logicalBottom;
    }

    const composerTop = window.scrollY + composerRect.top;
    return Math.min(logicalBottom, composerTop);
  }

  function findComposerVisualRect() {
    const candidates = [];
    const selectors = [
      "#prompt-textarea",
      "textarea",
      "input[type='text']",
      "[placeholder]",
      "[contenteditable='true']",
      "[role='textbox']",
      "form",
      "form[data-type='unified-composer']",
      "[data-testid='composer']",
      "[data-testid='composer-root']",
      "[data-testid='prompt-textarea']",
      "[class*='composer' i]",
      "[class*='prompt' i]",
      "[class*='chat-input' i]",
      "[class*='message-input' i]",
      "[class*='input-area' i]",
      "[class*='input-box' i]",
      "[class*='inputBox' i]",
      "[class*='sender' i]",
      "[class*='send-box' i]",
      "[aria-label*='prompt' i]",
      "[aria-label*='message' i]",
      "[aria-label*='发送' i]",
      "[aria-label*='輸入' i]"
    ];

    document.querySelectorAll(selectors.join(",")).forEach((element) => {
      let current = element;
      for (let depth = 0; current && depth < 9; depth += 1) {
        if (isComposerVisualCandidate(current)) {
          candidates.push({ element: current, rect: current.getBoundingClientRect() });
        }
        current = current.parentElement;
      }
    });

    if (!candidates.length) {
      return null;
    }

    candidates.sort((a, b) => {
      const aScore = composerVisualScore(a.rect);
      const bScore = composerVisualScore(b.rect);
      return aScore - bScore;
    });

    return candidates[0].rect;
  }

  function isComposerVisualCandidate(element) {
    if (!element || element === document.body || element === document.documentElement) {
      return false;
    }
    if (element === state?.root || state?.root?.contains(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > window.innerWidth * 0.35
      && rect.width < window.innerWidth * 0.94
      && rect.height >= 56
      && rect.height < window.innerHeight * 0.45
      && rect.bottom > window.innerHeight * 0.62
      && rect.top < window.innerHeight
      && style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0";
  }

  function composerVisualScore(rect) {
    const visibleBottom = Math.min(rect.bottom, window.innerHeight);
    const bottomDistance = Math.abs(window.innerHeight - visibleBottom);
    const centerDistance = Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2);
    const widthRatio = rect.width / window.innerWidth;
    const tooWidePenalty = widthRatio > 0.86 ? (widthRatio - 0.86) * window.innerWidth * 1.8 : 0;
    const tooTallPenalty = rect.height > 260 ? (rect.height - 260) * 1.2 : 0;
    return bottomDistance * 2
      + centerDistance * 0.05
      + tooWidePenalty
      + tooTallPenalty
      - rect.width * 0.08
      - rect.height * 0.25;
  }

  function createCandidateItem(element) {
    if (!state || state.items.some((item) => item.element === element)) {
      return null;
    }

    const marker = createElement("button", `${APP_ID}-point`);
    marker.type = "button";
    marker.title = "选择这个高度点";
    state.root.appendChild(marker);

    const item = { element, marker };
    state.items.push(item);
    marker.addEventListener("click", () => pickPoint(item));
    return item;
  }

  function discoverVisibleCandidates() {
    if (!state) {
      return;
    }

    const now = Date.now();
    if (state.lastCandidateScanAt && now - state.lastCandidateScanAt < 350) {
      return;
    }
    state.lastCandidateScanAt = now;

    const known = new Set(state.items.map((item) => item.element));
    const fresh = findCandidates().filter((element) => !known.has(element));
    if (!fresh.length) {
      return;
    }

    fresh.forEach((element) => createCandidateItem(element));
  }

  function refreshMarkerPositions() {
    if (!state) {
      return;
    }

    discoverVisibleCandidates();

    state.points = state.points.map((point) => ({
      ...point,
      element: point.element,
      top: point.element.isConnected ? pageRectFor(point.element).top : point.top,
      bottom: point.element.isConnected ? pageRectFor(point.element).bottom : point.bottom,
      left: point.element.isConnected ? pageRectFor(point.element).left : point.left,
      right: point.element.isConnected ? pageRectFor(point.element).left + pageRectFor(point.element).width : point.right
    }));

    const markerLeft = getMarkerVisualLeft();
    state.items.forEach((item) => {
      const viewportRect = item.element.getBoundingClientRect();
      const selectionIndex = getItemSelectionIndex(item);
      const markerCenterTop = getCandidateMarkerCenterTop(item, selectionIndex);
      const markerViewportCenter = markerCenterTop - window.scrollY;
      const intersectsViewport = viewportRect.bottom > 0 && viewportRect.top < window.innerHeight;
      const selectedLineVisible = selectionIndex !== -1 && markerViewportCenter >= 0 && markerViewportCenter <= window.innerHeight;
      item.marker.classList.toggle(`${APP_ID}-hidden`, !(intersectsViewport || selectedLineVisible));
      item.marker.style.top = `${markerCenterTop - 9}px`;
      item.marker.style.left = `${markerLeft}px`;
    });

    renderSelection();
    observeSelectionLayoutTargets();
  }

  function getLocationKey() {
    return `${location.origin}${location.pathname}${location.search}${location.hash}`;
  }

  function handlePossibleConversationChange() {
    if (!state) {
      return;
    }

    if (state.locationKey !== getLocationKey()) {
      clearSelectionMode();
    }
  }

  function installNavigationWatcher() {
    if (window.__CHAT_LONGSHOT_NAV_WATCHER__) {
      return;
    }

    window.__CHAT_LONGSHOT_NAV_WATCHER__ = true;
    ["pushState", "replaceState"].forEach((method) => {
      const original = history[method];
      history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event(`${APP_ID}-locationchange`));
        return result;
      };
    });
  }

  function scheduleLayoutRefresh() {
    if (!state) {
      return;
    }

    if (shouldDelayPreviewRefresh()) {
      suspendSelectionPreview();
      if (state.layoutRefreshTimer) {
        clearTimeout(state.layoutRefreshTimer);
      }
      state.layoutRefreshTimer = setTimeout(() => {
        if (!state) {
          return;
        }
        state.layoutRefreshTimer = 0;
        refreshMarkerPositions();
        revealSelectionPreview();
      }, 300);
      return;
    }

    if (state.layoutRefreshTimer) {
      return;
    }

    state.layoutRefreshTimer = setTimeout(() => {
      if (!state) {
        return;
      }
      state.layoutRefreshTimer = 0;
      refreshMarkerPositions();
    }, 32);
  }

  function shouldDelayPreviewRefresh() {
    const platform = getPlatform();
    return state?.points.length > 0 && (platform === "gemini" || platform === "deepseek");
  }

  function suspendSelectionPreview() {
    if (!state?.root || state.points.length === 0) {
      return;
    }
    if (state.previewRevealTimer) {
      clearTimeout(state.previewRevealTimer);
      state.previewRevealTimer = 0;
    }
    state.root.classList.remove(`${APP_ID}-preview-revealing`);
    state.root.classList.add(`${APP_ID}-preview-suspended`);
  }

  function revealSelectionPreview() {
    if (!state?.root || !state.root.classList.contains(`${APP_ID}-preview-suspended`)) {
      return;
    }

    state.root.classList.add(`${APP_ID}-preview-revealing`);
    requestAnimationFrame(() => {
      if (!state?.root) {
        return;
      }
      state.root.classList.remove(`${APP_ID}-preview-suspended`);
      state.previewRevealTimer = setTimeout(() => {
        if (!state?.root) {
          return;
        }
        state.root.classList.remove(`${APP_ID}-preview-revealing`);
        state.previewRevealTimer = 0;
      }, 520);
    });
  }

  function observeSelectionLayoutTargets() {
    if (!state?.resizeObserver) {
      return;
    }

    const targets = new Set([
      document.documentElement,
      document.body,
      document.querySelector("main"),
      chooseScrollRoot()
    ]);

    findComposerVisualElements().forEach((element) => targets.add(element));
    state.items.slice(0, 12).forEach((item) => targets.add(item.element));
    state.points.forEach((point) => targets.add(point.element));

    targets.forEach((element) => {
      if (element && element.nodeType === Node.ELEMENT_NODE && !state.observedLayoutTargets.has(element)) {
        state.resizeObserver.observe(element);
        state.observedLayoutTargets.add(element);
      }
    });
  }

  function observeLayoutMutations() {
    if (!state || state.mutationObserver) {
      return;
    }

    state.mutationObserver = new MutationObserver((mutations) => {
      const affectsLayout = mutations.some((mutation) => {
        const target = mutation.target;
        if (!target || target.nodeType !== Node.ELEMENT_NODE) {
          return false;
        }
        if (target === state.root || state.root?.contains(target)) {
          return false;
        }
        if (mutation.type === "attributes") {
          return mutation.attributeName === "class" || mutation.attributeName === "style";
        }
        return mutation.type === "childList";
      });

      if (affectsLayout) {
        scheduleLayoutRefresh();
      }
    });

    state.mutationObserver.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class", "style"]
    });
  }

  function findComposerVisualElements() {
    const selectors = [
      "textarea",
      "input[type='text']",
      "[placeholder]",
      "[contenteditable='true']",
      "[role='textbox']",
      "form",
      "[class*='composer' i]",
      "[class*='prompt' i]",
      "[class*='chat-input' i]",
      "[class*='message-input' i]",
      "[class*='input-area' i]",
      "[class*='input-box' i]",
      "[class*='inputBox' i]",
      "[class*='sender' i]",
      "[class*='send-box' i]",
      "[aria-label*='prompt' i]",
      "[aria-label*='message' i]"
    ];

    const elements = [];
    document.querySelectorAll(selectors.join(",")).forEach((element) => {
      let current = element;
      for (let depth = 0; current && depth < 4; depth += 1) {
        elements.push(current);
        current = current.parentElement;
      }
    });
    return Array.from(new Set(elements));
  }

  function startSelectionMode() {
    clearSelectionMode();
    ensureStyles();
    installNavigationWatcher();

    const candidates = findCandidates();
    if (!candidates.length) {
      return { ok: false, error: "没有识别到可选位置。可以稍微滚动页面后再试。" };
    }

    const markerLeft = Math.max(
      8,
      Math.floor(Math.min(...candidates.map((element) => pageRectFor(element).left)) - 34)
    );

    const root = createElement("div", `${APP_ID}-root`);
    const toolbar = createElement("div", `${APP_ID}-toolbar`);
    const clearButton = createElement("button", "", "清空");
    const cancelButton = createElement("button", "", "取消");
    const captureButton = createElement("button", "", "截图");
    const rangeOverlay = createElement("div", `${APP_ID}-range ${APP_ID}-hidden`);

    captureButton.dataset.primary = "true";
    captureButton.disabled = true;
    toolbar.append(clearButton, cancelButton, captureButton);
    root.append(rangeOverlay, toolbar);
    document.documentElement.appendChild(root);

    state = {
      root,
      captureButton,
      rangeOverlay,
      markerLeft,
      items: [],
      points: [],
      lines: [],
      locationKey: getLocationKey(),
      resizeObserver: null,
      mutationObserver: null,
      observedLayoutTargets: new Set(),
      layoutRefreshTimer: 0,
      previewRevealTimer: 0,
      navigationCheckInterval: 0,
      exitOnNavigation: handlePossibleConversationChange,
      lastCandidateScanAt: 0,
      refreshPositions: refreshMarkerPositions
    };

    candidates.forEach((element) => createCandidateItem(element));

    clearButton.addEventListener("click", clearPickedPoints);
    cancelButton.addEventListener("click", clearSelectionMode);
    captureButton.addEventListener("click", () => captureSelectedLengthFromCurrentViewport());

    window.addEventListener("scroll", state.refreshPositions, true);
    window.addEventListener("resize", state.refreshPositions, true);
    window.addEventListener(`${APP_ID}-locationchange`, state.exitOnNavigation);
    window.addEventListener("popstate", state.exitOnNavigation);
    state.navigationCheckInterval = setInterval(state.exitOnNavigation, 500);
    state.resizeObserver = new ResizeObserver(scheduleLayoutRefresh);
    observeSelectionLayoutTargets();
    observeLayoutMutations();
    refreshMarkerPositions();

    return { ok: true };
  }

  function setOverlayHidden(hidden) {
    if (state?.root) {
      state.root.classList.toggle(`${APP_ID}-hidden`, hidden);
    }
  }

  function shouldHideDuringCapture(element, clipRect) {
    if (!element || element === document.documentElement || element === document.body) {
      return false;
    }
    if (state?.root?.contains(element)) {
      return true;
    }
    if (state?.points?.some((point) => point.element === element || point.element.contains(element))) {
      return false;
    }

    const tag = element.tagName?.toLowerCase();
    if (getPlatform() === "gemini" && isGeminiChromeElement(element, clipRect)) {
      return true;
    }
    if (getPlatform() === "deepseek" && isDeepSeekChromeElement(element, clipRect)) {
      return true;
    }

    if (["nav", "aside", "header", "footer"].includes(tag)) {
      return true;
    }
    if (element.closest("nav, aside")) {
      return true;
    }

    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }
    if (style.position === "fixed" || style.position === "sticky") {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const outsideContent = centerX < clipRect.left || centerX > clipRect.left + clipRect.width;
      const largeChrome = rect.width > window.innerWidth * 0.35 || rect.height > 40;
      return outsideContent || largeChrome;
    }

    return false;
  }

  function isGeminiChromeElement(element, clipRect) {
    const tag = element.tagName?.toLowerCase() || "";
    const text = [
      element.id || "",
      typeof element.className === "string" ? element.className : "",
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("role") || ""
    ].join(" ").toLowerCase();
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const centerX = rect.left + rect.width / 2;
    const outsideContent = centerX < clipRect.left || centerX > clipRect.left + clipRect.width;
    const nearBottom = rect.top > window.innerHeight * 0.72;
    const nearTop = rect.bottom < window.innerHeight * 0.22;
    const shellName = /(sidenav|side-nav|drawer|navigation|nav|rail|toolbar|topbar|app-bar|header|bard|gemini|logo|menu|prompt|composer|input)/.test(text);

    if (["mat-sidenav", "bard-sidenav", "side-nav", "mat-toolbar"].includes(tag)) {
      return true;
    }

    if (element.closest?.("mat-sidenav, bard-sidenav, side-nav, mat-toolbar")) {
      return true;
    }

    if (shellName && outsideContent) {
      return true;
    }

    if (shellName && (style.position === "fixed" || style.position === "sticky") && (nearTop || nearBottom || outsideContent)) {
      return true;
    }

    if (nearBottom && rect.height > 44 && rect.width > window.innerWidth * 0.35 && /prompt|composer|input|textarea|rich-textarea/.test(text)) {
      return true;
    }

    return false;
  }

  function isDeepSeekChromeElement(element, clipRect) {
    const text = [
      element.id || "",
      typeof element.className === "string" ? element.className : "",
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("role") || ""
    ].join(" ").toLowerCase();
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inSelectedMessage = state?.points?.some((point) => point.element === element || point.element.contains(element) || element.contains(point.element));
    if (inSelectedMessage) {
      return false;
    }

    const sidebarLike = rect.right < clipRect.left - 24 || /(sidebar|sider|nav|history|conversation-list|chat-list)/.test(text);
    const inputLike = /(input|textarea|composer|sender|prompt|chat-input|message-input)/.test(text);
    const outsideContentColumn = rect.right < clipRect.left - 12 || rect.left > clipRect.left + clipRect.width + 12;
    const fixedChrome = style.position === "fixed" || style.position === "sticky";
    const nearBottom = rect.top > window.innerHeight * 0.68;
    const nearTop = rect.bottom < window.innerHeight * 0.18;

    if (sidebarLike && rect.width > 120) {
      return true;
    }

    if (outsideContentColumn && rect.width > 32 && rect.height > 32) {
      return true;
    }

    if (inputLike && nearBottom && rect.width > window.innerWidth * 0.35) {
      return true;
    }

    if (fixedChrome && (nearTop || nearBottom || outsideContentColumn)) {
      return true;
    }

    return false;
  }

  function enterCleanCaptureMode(scrollRoot, clipRect) {
    const hidden = [];
    const candidates = Array.from(document.body.querySelectorAll("nav, aside, header, footer, mat-sidenav, bard-sidenav, side-nav, mat-toolbar, [role='navigation'], [role='banner'], [role='complementary'], [class*='sidebar'], [class*='Sidebar'], [class*='sider'], [class*='Sider'], [class*='sidenav'], [class*='Sidenav'], [class*='drawer'], [class*='Drawer'], [class*='composer'], [class*='Composer'], [class*='prompt'], [class*='Prompt'], [class*='input'], [class*='Input'], [class*='chat-input'], [class*='message-input'], [aria-label*='menu' i], [aria-label*='navigation' i], [aria-label*='prompt' i]"));

    if (getPlatform() === "deepseek") {
      candidates.push(...Array.from(document.body.querySelectorAll("*")));
    }

    Array.from(document.body.children).forEach((child) => {
      if (child !== document.querySelector("main")) {
        candidates.push(child);
      }
    });

    Array.from(document.body.querySelectorAll("*")).forEach((element) => {
      const style = getComputedStyle(element);
      if (style.position === "fixed" || style.position === "sticky") {
        candidates.push(element);
      }
    });

    Array.from(new Set(candidates)).forEach((element) => {
      if (!shouldHideDuringCapture(element, clipRect)) {
        return;
      }
      if (!isWindowScrollRoot(scrollRoot) && element === scrollRoot) {
        return;
      }
      hidden.push({
        element,
        visibility: element.style.visibility,
        pointerEvents: element.style.pointerEvents
      });
      element.style.visibility = "hidden";
      element.style.pointerEvents = "none";
    });

    return () => {
      hidden.reverse().forEach((item) => {
        item.element.style.visibility = item.visibility;
        item.element.style.pointerEvents = item.pointerEvents;
      });
    };
  }

  async function captureVisible() {
    const response = await sendRuntimeMessage({
      type: "CL_CAPTURE_VISIBLE",
      options: { format: "png" }
    });
    if (!response?.ok) {
      throw new Error(response?.error || "截图失败。");
    }
    return response.dataUrl;
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片数据无法读取。"));
      image.src = dataUrl;
    });
  }

  async function collectFramesFromCurrentViewport(targetLength, forcedScrollRoot = null) {
    const frames = [];
    const scrollRoot = forcedScrollRoot || chooseScrollRoot();
    const contentClipRect = getContentClipRect(scrollRoot);
    const restoreCleanMode = contentClipRect ? enterCleanCaptureMode(scrollRoot, contentClipRect) : () => {};
    const originalWindowY = window.scrollY;
    const originalScrollTop = getScrollTop(scrollRoot);

    try {
      await sleep(120);
      const scrollHeight = getScrollHeight(scrollRoot);
      const clientHeight = getClientHeight(scrollRoot);
      const initialCaptureRect = getCaptureRect(scrollRoot, contentClipRect);
      const captureHeight = Math.max(120, Math.min(clientHeight, initialCaptureRect.height));
      const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
      const captureStartTop = originalScrollTop;
      const captureEndTop = Math.min(captureStartTop + targetLength, scrollHeight);
      const finalTop = clamp(captureEndTop - captureHeight, 0, maxScrollTop);
      const step = Math.max(120, captureHeight - CAPTURE_OVERLAP);
      const positions = [];

      if (captureEndTop <= captureStartTop + captureHeight) {
        positions.push(Math.round(clamp(captureStartTop, 0, maxScrollTop)));
      } else {
        for (let top = captureStartTop; top < finalTop; top += step) {
          positions.push(Math.round(clamp(top, 0, maxScrollTop)));
        }
        positions.push(Math.round(finalTop));
      }

      const uniquePositions = Array.from(new Set(positions)).sort((a, b) => a - b);

      for (const top of uniquePositions) {
        scrollToPosition(scrollRoot, top);
        const actualTop = await waitForScrollSettled(scrollRoot, top);
        const captureRect = getCaptureRect(scrollRoot, contentClipRect);
        await sleep(120);
        const dataUrl = await captureVisible();
        const image = await loadImage(dataUrl);
        frames.push({
          offset: Math.max(0, actualTop - captureStartTop),
          captureRect,
          image,
          width: image.width,
          height: image.height
        });

        if (actualTop >= maxScrollTop || actualTop + captureRect.height >= captureEndTop) {
          break;
        }
      }

      return {
        frames,
        range: {
          startY: 0,
          endY: Math.min(targetLength, captureEndTop - captureStartTop)
        },
        reachedPageEnd: captureEndTop >= scrollHeight,
        scrollRootName: scrollRootLabel(scrollRoot)
      };
    } finally {
      scrollToPosition(scrollRoot, originalScrollTop);
      if (!isWindowScrollRoot(scrollRoot)) {
        window.scrollTo({ top: originalWindowY, left: 0, behavior: "auto" });
      }
      restoreCleanMode();
    }
  }

  function createOutputImages(frames, range) {
    if (!frames.length) {
      throw new Error("没有可拼接的截图帧。");
    }

    const scale = frames[0].width / window.innerWidth;
    const outputWidth = Math.round(frames[0].captureRect.width * scale);
    const totalCssHeight = range.endY - range.startY;
    const maxSliceCssHeight = Math.max(800, Math.floor(MAX_JPEG_HEIGHT / scale));
    const slices = [];
    const orderedFrames = [...frames].sort((a, b) => a.offset - b.offset);

    for (let cssOffset = 0; cssOffset < totalCssHeight; cssOffset += maxSliceCssHeight) {
      const sliceCssTop = range.startY + cssOffset;
      const sliceCssBottom = Math.min(range.endY, sliceCssTop + maxSliceCssHeight);
      const canvas = document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = Math.ceil((sliceCssBottom - sliceCssTop) * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let coveredUntil = sliceCssTop;
      orderedFrames.forEach((frame) => {
        const frameCssTop = frame.offset;
        const frameCssBottom = frame.offset + frame.captureRect.height;
        const drawTop = Math.max(sliceCssTop, frameCssTop, coveredUntil);
        const drawBottom = Math.min(sliceCssBottom, frameCssBottom);
        if (drawBottom <= drawTop) {
          return;
        }

        const sx = Math.round(frame.captureRect.left * scale);
        const sy = Math.round((frame.captureRect.top + drawTop - frameCssTop) * scale);
        const sw = outputWidth;
        const sh = Math.round((drawBottom - drawTop) * scale);
        const dx = 0;
        const dy = Math.round((drawTop - sliceCssTop) * scale);
        ctx.drawImage(frame.image, sx, sy, sw, sh, dx, dy, outputWidth, sh);
        coveredUntil = Math.max(coveredUntil, drawBottom);
      });

      slices.push({
        width: canvas.width,
        height: canvas.height,
        dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY)
      });
    }

    return slices;
  }

  function timestamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-") + "-" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
  }

  async function downloadDataUrl(dataUrl, filename) {
    const response = await sendRuntimeMessage({
      type: "CL_DOWNLOAD",
      payload: { dataUrl, filename, saveAs: false }
    });
    if (!response?.ok) {
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = filename;
      link.click();
    }
    return response;
  }

  async function removeDownloadedFiles(downloadIds) {
    if (!downloadIds.length) {
      return;
    }

    try {
      await sendRuntimeMessage({
        type: "CL_REMOVE_DOWNLOAD_FILES",
        payload: { downloadIds }
      });
    } catch (error) {
      // Cleanup is best-effort and intentionally silent.
    }
  }

  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(",")[1] || "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      result.set(part, offset);
      offset += part.length;
    });
    return result;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  function makePdfDataUrl(images) {
    const encoder = new TextEncoder();
    const objects = [];
    const pageIds = [];

    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";

    images.forEach((image, index) => {
      const pageId = 3 + index * 3;
      const imageId = pageId + 1;
      const contentId = pageId + 2;
      pageIds.push(pageId);

      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width} ${image.height}] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`;
      const imageBytes = dataUrlToBytes(image.dataUrl);
      objects[imageId] = {
        prefix: `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`,
        bytes: imageBytes,
        suffix: "\nendstream"
      };
      const content = `q\n${image.width} 0 0 ${image.height} 0 0 cm\n/Im${index} Do\nQ\n`;
      objects[contentId] = `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`;
    });

    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

    const parts = [encoder.encode("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
    const offsets = [0];

    for (let id = 1; id < objects.length; id += 1) {
      offsets[id] = parts.reduce((sum, part) => sum + part.length, 0);
      parts.push(encoder.encode(`${id} 0 obj\n`));
      const object = objects[id];
      if (typeof object === "string") {
        parts.push(encoder.encode(`${object}\n`));
      } else {
        parts.push(encoder.encode(object.prefix));
        parts.push(object.bytes);
        parts.push(encoder.encode(`${object.suffix}\n`));
      }
      parts.push(encoder.encode("endobj\n"));
    }

    const xrefOffset = parts.reduce((sum, part) => sum + part.length, 0);
    const xref = [
      "xref",
      `0 ${objects.length}`,
      "0000000000 65535 f "
    ];
    for (let id = 1; id < objects.length; id += 1) {
      xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
    }
    xref.push("trailer");
    xref.push(`<< /Size ${objects.length} /Root 1 0 R >>`);
    xref.push("startxref");
    xref.push(String(xrefOffset));
    xref.push("%%EOF");
    parts.push(encoder.encode(`${xref.join("\n")}\n`));

    const pdfBytes = concatBytes(parts);
    return `data:application/pdf;base64,${bytesToBase64(pdfBytes)}`;
  }

  async function alignScrollToSelectedStart(scrollRoot, selectedRange) {
    scrollToPosition(scrollRoot, selectedRange.startTop);
    let actualStartTop = await waitForScrollSettled(scrollRoot, selectedRange.startTop);
    let startDelta = Math.abs(actualStartTop - selectedRange.startTop);

    if (startDelta <= 2 || !state?.points?.[0]?.element?.isConnected) {
      return { scrollRoot, selectedRange, startDelta };
    }

    state.points[0].element.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
    await sleep(160);

    const fallbackRoot = chooseScrollRoot();
    const fallbackRange = getSelectedScrollRange(fallbackRoot) || selectedRange;
    actualStartTop = await waitForScrollSettled(fallbackRoot, fallbackRange.startTop);
    startDelta = Math.abs(actualStartTop - fallbackRange.startTop);

    return {
      scrollRoot: fallbackRoot,
      selectedRange: fallbackRange,
      startDelta
    };
  }

  async function captureSelectedLengthFromCurrentViewport() {
    if (!state) {
      return;
    }

    let scrollRoot = chooseScrollRoot();
    let selectedRange = getSelectedScrollRange(scrollRoot);
    if (!selectedRange || selectedRange.length < 50) {
      setStatus("选择范围无效：终点需要在起点下方。");
      return;
    }

    const baseName = `${getPlatform()}-${timestamp()}`;
    state.captureButton.disabled = true;
    setStatus("正在跳到截图起点，请不要操作页面...");

    try {
      setOverlayHidden(true);
      await sleep(80);
      const alignment = await alignScrollToSelectedStart(scrollRoot, selectedRange);
      scrollRoot = alignment.scrollRoot;
      selectedRange = alignment.selectedRange;
      const selectedLength = selectedRange.length;
      const startDelta = alignment.startDelta;
      await sleep(160);

      const result = await collectFramesFromCurrentViewport(selectedLength, scrollRoot);
      const images = createOutputImages(result.frames, result.range);
      const jpgDownloadIds = [];

      setOverlayHidden(false);
      setStatus(`拼接完成${startDelta > 1 ? `，起点偏差 ${Math.round(startDelta)}px` : ""}，正在保存 ${images.length} 张 JPG...`);

      for (let index = 0; index < images.length; index += 1) {
        const suffix = String(index + 1).padStart(3, "0");
        const downloadResponse = await downloadDataUrl(images[index].dataUrl, `${baseName}-${suffix}.jpg`);
        if (downloadResponse?.downloadId) {
          jpgDownloadIds.push(downloadResponse.downloadId);
        }
      }

      if (images.length > 1 && window.confirm(`已生成 ${images.length} 张 JPG。是否合成为 PDF？确认后会保存 PDF，并自动清理这些 JPG。`)) {
        const pdfUrl = makePdfDataUrl(images);
        await downloadDataUrl(pdfUrl, `${baseName}.pdf`);
        setStatus("PDF 已保存，正在清理临时 JPG...");
        await sleep(800);
        await removeDownloadedFiles(jpgDownloadIds);
      }

      setStatus(result.reachedPageEnd
        ? `已截到${result.scrollRootName}底部，保存 ${images.length} 张 JPG。`
        : `已完成，滚动${result.scrollRootName}并保存 ${images.length} 张 JPG。`);
      clearSelectionMode();
    } catch (error) {
      setOverlayHidden(false);
      setStatus(error.message || String(error));
    } finally {
      if (state) {
        state.captureButton.disabled = false;
      }
    }
  }

  const listener = (message, sender, sendResponse) => {
    if (message?.type === "CL_START_SELECTION") {
      sendResponse(startSelectionMode());
      return true;
    }
    return false;
  };

  window.__CHAT_LONGSHOT_LISTENER__ = listener;
  window.__CHAT_LONGSHOT_LOADED__ = true;
  chrome.runtime.onMessage.addListener(listener);
})();
