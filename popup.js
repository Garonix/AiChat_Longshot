const startButton = document.getElementById("start");
const statusText = document.getElementById("status");

function setStatus(text) {
  statusText.textContent = text;
}

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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendStartMessage(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "CL_START_SELECTION" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"]
    });
    return chrome.tabs.sendMessage(tab.id, { type: "CL_START_SELECTION" });
  }
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  setStatus("正在进入选择模式...");

  try {
    const tab = await getActiveTab();
    if (!tab || !isSupportedUrl(tab.url)) {
      setStatus("请先切到 ChatGPT 或 Gemini 对话页。");
      return;
    }

    const response = await sendStartMessage(tab);
    if (!response || !response.ok) {
      setStatus(response?.error || "页面暂时无法进入选择模式。");
      return;
    }

    setStatus("已进入选择模式，请回到页面设置起点和终点。");
    window.close();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    startButton.disabled = false;
  }
});
