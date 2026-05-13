const CAPTURE_THROTTLE_MS = 560;
let lastCaptureAt = 0;

function isSupportedUrl(url = "") {
  return (
    url.startsWith("https://chatgpt.com/") ||
    url.startsWith("https://chat.openai.com/") ||
    url.startsWith("https://gemini.google.com/") ||
    url.startsWith("https://grok.com/") ||
    url.startsWith("https://x.com/i/grok") ||
    url.startsWith("https://doubao.com/") ||
    url.startsWith("https://www.doubao.com/") ||
    url.startsWith("https://chat.deepseek.com/") ||
    url.startsWith("https://www.deepseek.com/") ||
    url.startsWith("https://deepseek.com/")
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureVisibleTab(options = {}) {
  const now = Date.now();
  const waitFor = Math.max(0, CAPTURE_THROTTLE_MS - (now - lastCaptureAt));
  if (waitFor > 0) {
    await wait(waitFor);
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
    format: options.format || "png",
    quality: options.quality || 92
  });
  lastCaptureAt = Date.now();
  return dataUrl;
}

async function downloadDataUrl({ dataUrl, filename, saveAs = false }) {
  return chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs,
    conflictAction: "uniquify"
  });
}

async function removeDownloadedFiles(downloadIds = []) {
  await Promise.all(downloadIds.map(async (downloadId) => {
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const items = await chrome.downloads.search({ id: downloadId });
        if (!items.length || items[0].state === "complete") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await chrome.downloads.removeFile(downloadId);
      await chrome.downloads.erase({ id: downloadId });
    } catch (error) {
      // Best-effort cleanup only.
    }
  }));
}

async function startSelection(tab) {
  if (!tab?.id || !isSupportedUrl(tab.url)) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "CL_START_SELECTION" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"]
    });
    await chrome.tabs.sendMessage(tab.id, { type: "CL_START_SELECTION" });
  }
}

chrome.action.onClicked.addListener((tab) => {
  startSelection(tab).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "CL_CAPTURE_VISIBLE") {
    captureVisibleTab(message.options)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "CL_DOWNLOAD") {
    downloadDataUrl(message.payload)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "CL_REMOVE_DOWNLOAD_FILES") {
    removeDownloadedFiles(message.payload?.downloadIds || [])
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
